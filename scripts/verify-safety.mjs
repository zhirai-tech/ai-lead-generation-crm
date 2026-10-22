#!/usr/bin/env node
/**
 * End-to-end safety verification against a running server (default 4173).
 *
 *   node scripts/verify-safety.mjs [baseUrl]
 *
 * Covers: approval -> worker send, human takeover blocking, suppression blocking,
 * public unsubscribe link, and cleanup. Uses the seeded demo workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.mjs';
import { signToken } from '../server/core/crypto.mjs';
import { loadSecret } from '../server/core/crypto.mjs';

const base = (process.argv[2] || 'http://127.0.0.1:4173').replace(/\/$/, '');
let cookie = '';
let csrf = '';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, apiPath, body = null, { anonymous = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (!anonymous && cookie) headers.Cookie = cookie;
  if (!anonymous && csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(`${base}${apiPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie();
  for (const entry of setCookies) {
    const pair = entry.split(';')[0];
    if (pair.startsWith('zr_session=')) cookie = pair;
    if (pair.startsWith('zr_csrf=')) csrf = decodeURIComponent(pair.split('=')[1] || '');
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, data: json?.data, error: json?.error, text };
}

async function waitFor(fn, { timeoutMs = 12000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function main() {
  const login = await request('POST', '/api/v1/auth/login', { email: 'demo@zhirai.test', password: 'Zhirai2026demo' });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  record('login demo workspace', true);

  const originalSettings = (await request('GET', '/api/v1/settings')).data.settings.outreach;
  const windowPatch = await request('PATCH', '/api/v1/settings', {
    outreach: { sendWindow: { start: 0, end: 23, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' } },
  });
  if (windowPatch.status !== 200) throw new Error('failed to widen send window');
  record('prepare send window for verification', true);

  // 1. approval -> worker -> sent
  const approve = await request('POST', '/api/v1/drafts/demo_draft_atlas/approve', {});
  record('draft approval', approve.status === 200, approve.status === 200 ? approve.data.status : approve.error?.message);
  const queued = await request('POST', '/api/v1/drafts/demo_draft_atlas/send', {});
  record('approved draft enters send queue', queued.status === 200 && queued.data?.queued === true, `jobId=${queued.data?.jobId || queued.error?.message}`);
  const sent = await waitFor(async () => {
    const detail = await request('GET', '/api/v1/drafts/demo_draft_atlas');
    return detail.data?.draft?.status === 'sent' ? detail.data.draft : null;
  });
  record('worker sends approved draft', Boolean(sent), sent ? `message=${sent.sentMessageId}` : 'timeout');

  // 2. takeover blocks further sending
  const takeover = await request('POST', '/api/v1/automation/demo_cmp_atlas/takeover', { reason: 'safety verification' });
  record('human takeover', takeover.status === 200 && takeover.data?.state === 'HUMAN_TAKEOVER', `cancelledJobs=${takeover.data?.cancelledJobs}`);
  const draft = await request('POST', '/api/v1/drafts', {
    companyId: 'demo_cmp_atlas',
    contactId: 'demo_ct_atlas_1',
    subject: 'verification — must be blocked',
    bodyText: 'This draft must never be sent while the customer is under human takeover.',
    language: 'en',
  });
  const draftId = draft.data?.id;
  record('create verification draft', Boolean(draftId), draft.error?.message || '');
  if (draftId) {
    const approve2 = await request('POST', `/api/v1/drafts/${draftId}/approve`, {});
    record('approve under takeover', approve2.status === 200, approve2.error?.message || approve2.data?.status);
    const blocked = await request('POST', `/api/v1/drafts/${draftId}/send`, {});
    record('takeover blocks sending', blocked.status === 409 || blocked.data?.queued === false, `status=${blocked.status} code=${blocked.error?.code || 'queued'}`);
  }

  // 3. suppression blocks sending
  await request('POST', '/api/v1/automation/demo_cmp_atlas/resume', { reason: 'safety verification cleanup' });
  const suppression = await request('POST', '/api/v1/suppression', {
    scope: 'email',
    value: 'daan.devries@atlas-auto-components.example',
    reason: 'manual',
    note: 'safety verification',
  });
  record('add suppression', suppression.status === 200, suppression.error?.message || '');
  if (draftId) {
    const blocked = await request('POST', `/api/v1/drafts/${draftId}/send`, {});
    record('suppression blocks sending', blocked.status === 409, `status=${blocked.status} code=${blocked.error?.code || 'queued'}`);
  }
  const suppressionId = suppression.data?.item?.id || suppression.data?.id;
  if (suppressionId) await request('DELETE', `/api/v1/suppression/${suppressionId}`);

  // 4. public unsubscribe
  const secret = loadSecret(config.secretFile);
  const token = signToken(secret, { w: 'wsp_demo', c: 'demo_ct_lyon_1', e: 'camille.moreau@lyon-electro-parts.example', co: 'demo_cmp_lyon' }, { expiresInDays: 30 });
  const preview = await request('GET', `/api/v1/public/unsubscribe/${encodeURIComponent(token)}`, null, { anonymous: true });
  record('unsubscribe preview', preview.status === 200 && preview.data?.valid === true, preview.data?.email || preview.error?.message);
  const unsub = await request('POST', `/api/v1/public/unsubscribe/${encodeURIComponent(token)}`, {}, { anonymous: true });
  record('unsubscribe recorded', unsub.status === 200 && unsub.data?.unsubscribed === true, unsub.error?.message || '');
  const lookup = await request('GET', '/api/v1/suppression?q=camille.moreau');
  const found = (lookup.data?.items || []).some((item) => item.valueNormalized === 'camille.moreau@lyon-electro-parts.example' || item.value_normalized === 'camille.moreau@lyon-electro-parts.example');
  record('suppression visible after unsubscribe', found);

  // cleanup
  await request('PATCH', '/api/v1/settings', { outreach: { sendWindow: originalSettings.sendWindow } });
  record('restore send window', true);

  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log(`Result: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failures:', failed.map((item) => item.name).join(', '));
    process.exitCode = 1;
  }
  void fs;
  void path;
}

main().catch((error) => {
  console.error('verification crashed:', error);
  process.exitCode = 1;
});
