/**
 * t-worker unit tests: worker loop, handler registry, retry/backoff wiring,
 * scheduler ticks, campaign.tick fallback and simulation inbox sync.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, get, upsertSetting } from '../../server/core/db.mjs';
import { id } from '../../server/core/ids.mjs';
import { nowIso, addDays } from '../../server/core/time.mjs';
import {
  enqueueJob,
  claimNextJob,
  cancelJob,
  getJob,
  isJobsPaused,
  pauseAll,
} from '../../server/jobs/queue.mjs';
import {
  processJob,
  runWorkerTick,
  startWorker,
  stopWorker,
  getWorkerStatus,
  resetWorkerStateForTests,
} from '../../server/jobs/worker.mjs';
import { getHandler, listHandlerTypes, registerHandler } from '../../server/jobs/handlers/index.mjs';
import { advanceCampaignFallback } from '../../server/jobs/handlers/crm-handlers.mjs';
import { runSchedulerTick } from '../../server/jobs/scheduler.mjs';
import { createTestContext } from '../../server/jobs/test-support.mjs';
import { JOB_TYPES } from '../../server/jobs/queue.mjs';

let ctx;
let workspaceId;
let seq = 0;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];

before(async () => {
  ctx = await createTestContext({ withServer: false });
  workspaceId = ctx.owner.workspaceId;
});

after(async () => {
  await stopWorker({ timeoutMs: 2000 });
  await ctx.close();
});

beforeEach(() => {
  resetWorkerStateForTests();
  for (const table of [
    'background_jobs',
    'email_messages',
    'message_drafts',
    'campaign_targets',
    'campaign_steps',
    'campaigns',
    'email_accounts',
    'automation_states',
    'suppression_records',
    'contacts',
    'companies',
    'usage_records',
    'audit_events',
    'discovery_runs',
  ]) {
    run(`DELETE FROM ${table} WHERE workspace_id = ?`, [workspaceId]);
  }
  run("DELETE FROM settings WHERE workspace_id = ? AND key = 'jobs.globalPaused'", [workspaceId]);
  upsertSetting(workspaceId, 'outreach', {
    requireApproval: true,
    autoSendEnabled: false,
    dailySendLimit: 50,
    sendWindow: { start: 0, end: 24, weekdays: ALL_WEEK, timezone: 'UTC' },
    signature: '',
  });
  upsertSetting(workspaceId, 'limits', { dailyEmailLimit: 1000 });
  upsertSetting(workspaceId, 'retention', { jobDays: 30, auditDays: 730, usageDays: 730 });
});

function seedSendable({ automationState = null, suppression = null, contactEmail = null } = {}) {
  seq += 1;
  const now = nowIso();
  const companyId = id('cmp');
  const contactId = id('con');
  const accountId = id('acc');
  const draftId = id('drf');
  const email = contactEmail || `buyer${seq}@company${seq}.example`;
  run(
    `INSERT INTO companies (id, workspace_id, name, normalized_name, domain, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [companyId, workspaceId, `Company ${seq}`, `company ${seq}`, `company${seq}.example`, now, now],
  );
  run(
    `INSERT INTO contacts (id, workspace_id, company_id, full_name, email, email_normalized, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [contactId, workspaceId, companyId, `Buyer ${seq}`, email, email, now, now],
  );
  run(
    `INSERT INTO email_accounts (id, workspace_id, name, address, display_name, protocol, daily_limit, status, created_at, updated_at)
     VALUES (?, ?, 'Sim', ?, 'ZHIRAI', 'simulation', 50, 'active', ?, ?)`,
    [accountId, workspaceId, `sender${seq}@zhirai.example`, now, now],
  );
  run(
    `INSERT INTO message_drafts (id, workspace_id, company_id, contact_id, account_id, subject, body_text, language, status, quality_json, guard_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Worker test subject', 'Worker test body', 'en', 'approved', '{}', '{}', ?, ?)`,
    [draftId, workspaceId, companyId, contactId, accountId, now, now],
  );
  if (automationState) {
    run(
      `INSERT INTO automation_states (id, workspace_id, company_id, state, reason, changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', ?, ?, ?)`,
      [id('aut'), workspaceId, companyId, automationState, now, now, now],
    );
  }
  if (suppression) {
    run(
      `INSERT INTO suppression_records (id, workspace_id, scope, value_normalized, reason, created_at)
       VALUES (?, ?, ?, ?, 'unsubscribe', ?)`,
      [id('sup'), workspaceId, suppression.scope, suppression.value, now],
    );
  }
  return { companyId, contactId, accountId, draftId, email };
}

test('all documented job types have a registered handler', () => {
  const registered = listHandlerTypes();
  for (const type of JOB_TYPES) {
    assert.ok(registered.includes(type), `missing handler for ${type}`);
    assert.equal(typeof getHandler(type), 'function');
  }
});

test('runWorkerTick processes a claimed job through its handler and completes it', async () => {
  registerHandler('test.echo', async ({ payload }) => ({ echo: payload.value }));
  const { id: jobId } = enqueueJob({ workspaceId, type: 'test.echo', payload: { value: 42 } });
  const summary = await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  assert.equal(summary.claimed, 1);
  assert.equal(summary.processed, 1);
  const job = getJob(workspaceId, jobId);
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result, { echo: 42 });
  const status = getWorkerStatus();
  assert.equal(status.processed, 1);
  assert.equal(status.failed, 0);
});

test('handler failure is retried with backoff, then dead-letters at maxAttempts', async () => {
  let calls = 0;
  registerHandler('test.flaky', async () => {
    calls += 1;
    const error = new Error('transient upstream down');
    error.retryDelayMs = 0;
    throw error;
  });
  const { id: jobId } = enqueueJob({ workspaceId, type: 'test.flaky', payload: {}, maxAttempts: 2 });
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  let job = getJob(workspaceId, jobId);
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 1);
  assert.match(job.lastError, /transient upstream down/);
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  job = getJob(workspaceId, jobId);
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, 2);
  assert.equal(calls, 2);
  const status = getWorkerStatus();
  assert.equal(status.failed, 2);
});

test('permanent handler errors are not retried', async () => {
  registerHandler('test.permanent', async () => {
    const error = new Error('bad payload');
    error.retryable = false;
    throw error;
  });
  const { id: jobId } = enqueueJob({ workspaceId, type: 'test.permanent', payload: {} });
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  assert.equal(getJob(workspaceId, jobId).status, 'failed');
});

test('unknown job type fails permanently instead of crashing the worker', async () => {
  const { id: jobId } = enqueueJob({ workspaceId, type: 'unknown.type', payload: {} });
  const summary = await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  assert.equal(summary.failed, 1);
  const job = getJob(workspaceId, jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.lastError, /未注册的任务类型/);
});

test('cancel intent recorded before processing cancels the job', async () => {
  registerHandler('test.slow', async () => ({ ok: true }));
  enqueueJob({ workspaceId, type: 'test.slow', payload: {} });
  const claimed = claimNextJob('worker-test');
  cancelJob(workspaceId, claimed.id, 'takeover');
  const result = await processJob(claimed, { config: ctx.config });
  assert.equal(result.status, 'cancelled');
  assert.equal(getJob(workspaceId, claimed.id).status, 'cancelled');
});

test('email.send job sends through the pipeline and records success', async () => {
  const seeded = seedSendable();
  const { id: jobId } = enqueueJob({
    workspaceId,
    type: 'email.send',
    payload: { draftId: seeded.draftId, trigger: 'manual' },
  });
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  const job = getJob(workspaceId, jobId);
  assert.equal(job.status, 'succeeded', job.lastError || '');
  assert.equal(job.result.sent, true);
  assert.ok(job.result.outboxPath && fs.existsSync(job.result.outboxPath));
  const draft = get('SELECT status FROM message_drafts WHERE id = ?', [seeded.draftId]);
  assert.equal(draft.status, 'sent');
});

test('email.send job fails permanently when the pipeline blocks (suppression)', async () => {
  const seeded = seedSendable();
  run(
    `INSERT INTO suppression_records (id, workspace_id, scope, value_normalized, reason, created_at)
     VALUES (?, ?, 'email', ?, 'unsubscribe', ?)`,
    [id('sup'), workspaceId, seeded.email, nowIso()],
  );
  const { id: jobId } = enqueueJob({
    workspaceId,
    type: 'email.send',
    payload: { draftId: seeded.draftId, trigger: 'manual' },
  });
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  const job = getJob(workspaceId, jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.lastError, /suppression/);
  assert.equal(get('SELECT status FROM message_drafts WHERE id = ?', [seeded.draftId]).status, 'approved');
});

test('email.sync (simulation) stores a clearly-labelled demo reply and enqueues classification', async () => {
  const seeded = seedSendable();
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' }); // no-op tick
  // Send one outbound message first so the simulation has something to reply to.
  const { id: sendJobId } = enqueueJob({
    workspaceId,
    type: 'email.send',
    payload: { draftId: seeded.draftId, trigger: 'manual' },
  });
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  assert.equal(getJob(workspaceId, sendJobId).status, 'succeeded');

  const { id: syncJobId } = enqueueJob({ workspaceId, type: 'email.sync', payload: { accountId: seeded.accountId } });
  await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  const syncJob = getJob(workspaceId, syncJobId);
  assert.equal(syncJob.status, 'succeeded', syncJob.lastError || '');
  assert.equal(syncJob.result.inserted, 1);
  assert.equal(syncJob.result.demo, true);

  const inbound = get(
    "SELECT * FROM email_messages WHERE workspace_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
    [workspaceId],
  );
  assert.ok(inbound);
  assert.equal(inbound.from_address, 'demo-inbound@simulation.zhirai.invalid');
  assert.match(inbound.subject, /^Re: /);
  assert.match(inbound.body_text, /演示/);
  assert.match(inbound.raw_headers_json, /"demo":true/);
  const classification = get(
    "SELECT id, status FROM background_jobs WHERE workspace_id = ? AND type = 'reply.classify'",
    [workspaceId],
  );
  assert.ok(classification, 'reply.classify enqueued for the demo inbound message');
  assert.equal(classification.status, 'queued');

  // A second sync must not fabricate a second demo reply for the same message.
  const { id: syncJob2 } = enqueueJob({ workspaceId, type: 'email.sync', payload: { accountId: seeded.accountId } });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = getJob(workspaceId, syncJob2);
    if (['succeeded', 'failed', 'dead', 'cancelled'].includes(current.status)) break;
    await runWorkerTick({ config: ctx.config, workerId: 'worker-test' });
  }
  assert.equal(getJob(workspaceId, syncJob2).status, 'succeeded');
  assert.equal(getJob(workspaceId, syncJob2).result.inserted, 0);
});

test('scheduler enqueues campaign ticks, inbox syncs and daily retention exactly once per bucket', () => {
  const now = nowIso();
  const campaignId = id('cmp');
  run(
    `INSERT INTO campaigns (id, workspace_id, name, status, daily_limit, send_window_json, require_approval, created_at, updated_at)
     VALUES (?, ?, 'Active campaign', 'active', 30, '{}', 1, ?, ?)`,
    [campaignId, workspaceId, now, now],
  );
  run(
    `INSERT INTO email_accounts (id, workspace_id, name, address, protocol, daily_limit, status, created_at, updated_at)
     VALUES (?, ?, 'Sim', 'scheduler@zhirai.example', 'simulation', 50, 'active', ?, ?)`,
    [id('acc'), workspaceId, now, now],
  );
  const first = runSchedulerTick({ now });
  assert.equal(first.campaignTicks, 1);
  assert.equal(first.emailSyncs, 1);
  assert.equal(first.retentionJobs, 1);
  const second = runSchedulerTick({ now });
  assert.equal(second.campaignTicks, 0);
  assert.equal(second.emailSyncs, 0);
  assert.equal(second.retentionJobs, 0);
  const types = get('SELECT COUNT(*) AS c FROM background_jobs WHERE workspace_id = ?', [workspaceId]).c;
  assert.equal(types, 3);
});

test('scheduler skips paused workspaces', () => {
  pauseAll(workspaceId);
  const summary = runSchedulerTick({ now: nowIso() });
  assert.equal(summary.skippedPaused, 1);
  assert.equal(summary.campaignTicks, 0);
  assert.equal(get('SELECT COUNT(*) AS c FROM background_jobs WHERE workspace_id = ?', [workspaceId]).c, 0);
});

test('campaign.tick SQL fallback advances due targets and never sends directly', () => {
  seq += 1;
  const now = nowIso();
  const companyId = id('cmp');
  const contactId = id('con');
  const campaignId = id('cmp');
  const stepId = id('stp');
  run(
    `INSERT INTO companies (id, workspace_id, name, normalized_name, domain, created_at, updated_at)
     VALUES (?, ?, 'Target GmbH', 'target gmbh', 'target.example', ?, ?)`,
    [companyId, workspaceId, now, now],
  );
  run(
    `INSERT INTO contacts (id, workspace_id, company_id, full_name, email, email_normalized, created_at, updated_at)
     VALUES (?, ?, ?, 'Max Buyer', 'max@target.example', 'max@target.example', ?, ?)`,
    [contactId, workspaceId, companyId, now, now],
  );
  run(
    `INSERT INTO campaigns (id, workspace_id, name, status, daily_limit, send_window_json, require_approval, created_at, updated_at)
     VALUES (?, ?, 'Fallback campaign', 'active', 30, '{}', 1, ?, ?)`,
    [campaignId, workspaceId, now, now],
  );
  run(
    `INSERT INTO campaign_steps (id, workspace_id, campaign_id, step_no, name, subject_template, body_template, language, delay_days, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'Intro', 'Hello {{company}}', 'Dear {{contact_name}}, welcome.', 'en', 0, 1, ?, ?)`,
    [stepId, workspaceId, campaignId, now, now],
  );
  run(
    `INSERT INTO campaign_targets (id, workspace_id, campaign_id, company_id, contact_id, status, current_step, enrolled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'enrolled', 0, ?, ?, ?)`,
    [id('tgt'), workspaceId, campaignId, companyId, contactId, now, now, now],
  );
  const summary = advanceCampaignFallback({ workspaceId, campaignId, jobId: 'job_test' });
  assert.equal(summary.due, 1);
  assert.equal(summary.draftsCreated, 1);
  assert.equal(summary.enqueued, 1);
  const draft = get('SELECT * FROM message_drafts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1', [workspaceId]);
  assert.equal(draft.subject, 'Hello Target GmbH');
  assert.equal(draft.body_text, 'Dear Max Buyer, welcome.');
  const target = get('SELECT * FROM campaign_targets WHERE campaign_id = ?', [campaignId]);
  // current_step is advanced only after the draft is actually sent (by t-crm's
  // advanceAfterSend); the fallback just schedules the next scan in the future.
  assert.equal(target.current_step, 0);
  assert.equal(target.status, 'active');
  assert.ok(target.next_run_at > nowIso());
  // Only a draft.generate job is enqueued — email.send stays behind approval.
  const sendJobs = get("SELECT COUNT(*) AS c FROM background_jobs WHERE workspace_id = ? AND type = 'email.send'", [workspaceId]).c;
  assert.equal(sendJobs, 0);
});

test('campaign.tick fallback pauses a target under HUMAN_TAKEOVER', () => {
  const now = nowIso();
  const companyId = id('cmp');
  const contactId = id('con');
  const campaignId = id('cmp');
  const stepId = id('stp');
  run(
    `INSERT INTO companies (id, workspace_id, name, normalized_name, domain, created_at, updated_at)
     VALUES (?, ?, 'Taken GmbH', 'taken gmbh', 'taken.example', ?, ?)`,
    [companyId, workspaceId, now, now],
  );
  run(
    `INSERT INTO contacts (id, workspace_id, company_id, email, email_normalized, created_at, updated_at)
     VALUES (?, ?, ?, 'c@taken.example', 'c@taken.example', ?, ?)`,
    [contactId, workspaceId, companyId, now, now],
  );
  run(
    `INSERT INTO campaigns (id, workspace_id, name, status, daily_limit, send_window_json, require_approval, created_at, updated_at)
     VALUES (?, ?, 'C', 'active', 30, '{}', 1, ?, ?)`,
    [campaignId, workspaceId, now, now],
  );
  run(
    `INSERT INTO campaign_steps (id, workspace_id, campaign_id, step_no, name, subject_template, body_template, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'S1', 's', 'b', ?, ?)`,
    [stepId, workspaceId, campaignId, now, now],
  );
  run(
    `INSERT INTO campaign_targets (id, workspace_id, campaign_id, company_id, contact_id, status, current_step, enrolled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'enrolled', 0, ?, ?, ?)`,
    [id('tgt'), workspaceId, campaignId, companyId, contactId, now, now, now],
  );
  run(
    `INSERT INTO automation_states (id, workspace_id, company_id, state, changed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'HUMAN_TAKEOVER', ?, ?, ?)`,
    [id('aut'), workspaceId, companyId, now, now, now],
  );
  const summary = advanceCampaignFallback({ workspaceId, campaignId, jobId: 'job_test' });
  assert.equal(summary.paused, 1);
  assert.equal(summary.draftsCreated, 0);
  assert.equal(get('SELECT status FROM campaign_targets WHERE campaign_id = ?', [campaignId]).status, 'paused');
});

test('maintenance.retention removes only old operational records', async () => {
  const handler = getHandler('maintenance.retention');
  const oldJob = enqueueJob({ workspaceId, type: 'lead.score', payload: {} });
  run("UPDATE background_jobs SET status = 'succeeded', updated_at = ? WHERE id = ?", [addDays(-60), oldJob.id]);
  const freshJob = enqueueJob({ workspaceId, type: 'lead.score', payload: {} });
  run("UPDATE background_jobs SET status = 'succeeded' WHERE id = ?", [freshJob.id]);
  run(
    `INSERT INTO audit_events (id, workspace_id, actor_type, action, created_at) VALUES (?, ?, 'system', 'old.action', ?)`,
    [id('aud'), workspaceId, addDays(-800)],
  );
  run(
    `INSERT INTO usage_records (id, workspace_id, category, quantity, unit, occurred_at, created_at) VALUES (?, ?, 'email_sent', 1, 'count', ?, ?)`,
    [id('usg'), workspaceId, addDays(-800), addDays(-800)],
  );
  const result = await handler({ workspaceId, job: { id: 'job_retention' }, payload: {}, config: ctx.config });
  assert.equal(result.deletedJobs, 1);
  assert.equal(result.deletedAuditEvents, 1);
  assert.equal(result.deletedUsageRecords, 1);
  assert.ok(get('SELECT id FROM background_jobs WHERE id = ?', [freshJob.id]), 'fresh job kept');
  assert.equal(result.retention.messageRetention, 'skipped (CRM-owned)');
});

test('startWorker processes queued jobs and stops gracefully', async () => {
  registerHandler('test.lifecycle', async () => ({ ok: true }));
  enqueueJob({ workspaceId, type: 'test.lifecycle', payload: {} });
  const status = await startWorker({
    config: { ...ctx.config, worker: { enabled: true, pollMs: 50, schedulerIntervalMs: 600_000, concurrency: 1 } },
  });
  assert.equal(status.running, true);
  assert.ok(status.workerId);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (getWorkerStatus().processed >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(getWorkerStatus().processed >= 1, 'worker processed the queued job');
  const stopped = await stopWorker({ timeoutMs: 2000 });
  assert.equal(stopped.running, false);
  assert.equal(getJob(workspaceId, get('SELECT id FROM background_jobs WHERE type = ? LIMIT 1', ['test.lifecycle']).id).status, 'succeeded');
  assert.equal(isJobsPaused(workspaceId), false);
});
