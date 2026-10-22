/**
 * Drafts + approvals integration: generation with a stubbed agent layer,
 * approval state machine, send queueing guards and tenancy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { seedCompany, seedContact } from '../unit/crm-fixtures.mjs';
import { setAgentImplementation, resetAgentImplementations } from '../../server/services/agent-client.mjs';

const DRAFT_BODY = 'Dear Anna, we supply aluminium battery pack brackets for EV platforms.';

async function createDraft(ctx, company, contact, extra = {}) {
  const response = await ctx.request('POST', '/api/v1/drafts', {
    body: { companyId: company.id, contactId: contact.id, subject: 'Partnership', bodyText: DRAFT_BODY, language: 'en', ...extra },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

test('drafts: generation persists validated agent output and requires approval', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);

  setAgentImplementation('generateOutreachDraft', async () => ({
    subject: 'Battery pack brackets for Test Autoteile',
    bodyText: `${DRAFT_BODY} Could we send you our catalogue?`,
    language: 'de',
    quality: { score: 88, issues: [] },
    guard: { unsubscribeLink: true, claimsVerified: true },
  }));

  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  assert.equal(generated.body.data.draft.status, 'pending_approval');
  assert.equal(generated.body.data.draft.language, 'de');
  assert.equal(generated.body.data.draft.subject, 'Battery pack brackets for Test Autoteile');
  assert.equal(generated.body.data.draft.quality.score, 88);
  assert.equal(generated.body.data.draft.guard.unsubscribeLink, true);

  const detail = await ctx.request('GET', `/api/v1/drafts/${draft.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.data.draft);
  assert.deepEqual(detail.body.data.quality, { score: 88, issues: [] });
  assert.deepEqual(detail.body.data.guard, { unsubscribeLink: true, claimsVerified: true });
  assert.equal(detail.body.data.company.id, company.id);
  assert.equal(detail.body.data.contact.id, contact.id);

  // Unapproved drafts cannot be sent/queued.
  const unapproved = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(unapproved.status, 409);
  assert.equal(unapproved.body.error.details.code, 'DRAFT_NOT_APPROVED');

  const approved = await ctx.request('POST', `/api/v1/drafts/${draft.id}/approve`, { body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.data.status, 'approved');
  assert.equal(approved.body.data.approvedBy, ctx.owner.userId);

  const sent = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.data.draft.status, 'scheduled');
  assert.equal(typeof sent.body.data.queued, 'boolean');
  assert.ok(sent.body.data.draft.scheduledAt);

  const secondSend = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(secondSend.status, 409);
  assert.equal(secondSend.body.error.details.code, 'DRAFT_ALREADY_QUEUED');
});

test('drafts: reject, batch approve and pending approvals list', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const first = await createDraft(ctx, company, contact);
  const second = await createDraft(ctx, company, contact, { subject: 'Second' });
  const third = await createDraft(ctx, company, contact, { subject: 'Third' });

  const rejected = await ctx.request('POST', `/api/v1/drafts/${first.id}/reject`, { body: { reason: '语气太生硬' } });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.body.data.status, 'rejected');
  assert.equal(rejected.body.data.rejectionReason, '语气太生硬');

  const batch = await ctx.request('POST', '/api/v1/drafts/batch-approve', { body: { ids: [second.id, third.id, 'drf_missing'] } });
  assert.equal(batch.status, 200, batch.text);
  assert.equal(batch.body.data.approved.length, 2);
  assert.equal(batch.body.data.failed.length, 1);
  assert.equal(batch.body.data.failed[0].draftId, 'drf_missing');

  const pending = await ctx.request('GET', '/api/v1/approvals/pending');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.count, 0);
  assert.equal(pending.body.data.items.length, 0);
});

test('drafts: human takeover blocks campaign drafts but approval is still audited', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  await ctx.request('POST', `/api/v1/drafts/${draft.id}/approve`, { body: {} });
  await ctx.request('POST', `/api/v1/automation/${company.id}/takeover`, { body: { reason: '人工接管' } });

  const blocked = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.code, 'AUTOMATION_BLOCKED');
  assert.equal(blocked.body.error.details.state, 'HUMAN_TAKEOVER');
});

test('drafts: real agent layer (simulation) generates a valid draft end-to-end', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  let agentsAvailable = true;
  try {
    await import('../../server/agents/index.mjs');
  } catch {
    agentsAvailable = false;
  }
  if (!agentsAvailable) {
    t.skip('agents layer not implemented yet');
    return;
  }
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  resetAgentImplementations();
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  const result = generated.body.data.draft;
  assert.ok(result.subject.length > 0);
  assert.ok(result.bodyText.length >= 20, 'generated body must be validated as non-empty');
  assert.equal(result.status, 'pending_approval');
  assert.ok(result.quality && typeof result.quality === 'object');
  assert.ok(result.guard && typeof result.guard === 'object');
  assert.ok(result.generatedBy, 'generated_by should reference the agent execution for traceability');
});

test('drafts: AI layer unavailable yields a clear 503 instead of crashing', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  let agentsAvailable = true;
  try {
    await import('../../server/agents/index.mjs');
  } catch {
    agentsAvailable = false;
  }
  if (agentsAvailable) {
    t.skip('agents layer already implemented; AGENT_UNAVAILABLE fallback not exercised');
    return;
  }
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  resetAgentImplementations();
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 503);
  assert.equal(generated.body.error.code, 'AGENT_UNAVAILABLE');
});

test('drafts: tenant isolation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  const other = ctx.createWorkspace({ name: '隔离空间' });

  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/drafts/${draft.id}`)).status, 404);
  assert.equal((await ctx.request('POST', `/api/v1/drafts/${draft.id}/approve`, { body: {} })).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/drafts')).body.data.items.length, 0);
});
