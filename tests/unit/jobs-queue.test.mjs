/**
 * t-worker unit tests: durable job queue (enqueue dedupe, atomic claim, lease
 * recovery, retry/backoff, dead letters, cancel, per-company cancellation,
 * pause/resume, stats). Uses an isolated temp DB via tests/helpers.mjs.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { run, all, get } from '../../server/core/db.mjs';
import { nowIso, addMinutes, addHours } from '../../server/core/time.mjs';
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  finishCancelled,
  cancelJob,
  cancelJobsForCompany,
  recoverExpiredLeases,
  retryJob,
  pauseAll,
  resumeAll,
  isJobsPaused,
  getJob,
  getJobStats,
  isCancelRequested,
} from '../../server/jobs/queue.mjs';
import { createTestContext } from '../../server/jobs/test-support.mjs';

let ctx;
let workspaceId;

before(async () => {
  ctx = await createTestContext();
  workspaceId = ctx.owner.workspaceId;
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  run('DELETE FROM background_jobs');
  run("DELETE FROM settings WHERE workspace_id = ? AND key = 'jobs.globalPaused'", [workspaceId]);
});

function queueOf(type, payload = {}, extra = {}) {
  return enqueueJob({ workspaceId, type, payload, ...extra });
}

test('enqueueJob persists a queued job and returns {id, deduped:false}', () => {
  const { id, deduped } = queueOf('lead.score', { companyId: 'cmp_1' });
  assert.equal(deduped, false);
  const job = getJob(workspaceId, id);
  assert.equal(job.status, 'queued');
  assert.equal(job.type, 'lead.score');
  assert.equal(job.attempts, 0);
  assert.deepEqual(job.payload, { companyId: 'cmp_1' });
  assert.ok(job.runAt <= nowIso());
});

test('enqueueJob is idempotent with dedupeKey and returns the existing job', () => {
  const first = queueOf('draft.generate', { draftId: 'drf_1' }, { dedupeKey: 'draft.generate:w:drf_1' });
  const second = queueOf('draft.generate', { draftId: 'drf_1' }, { dedupeKey: 'draft.generate:w:drf_1' });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  const count = get('SELECT COUNT(*) AS c FROM background_jobs WHERE dedupe_key = ?', ['draft.generate:w:drf_1']).c;
  assert.equal(count, 1);
});

test('enqueueJob re-arms a terminal job that shares the dedupe key', () => {
  const first = queueOf('email.send', { draftId: 'drf_re' }, { dedupeKey: 'email.send:w:drf_re' });
  claimNextJob('worker-A');
  failJob(first.id, new Error('smtp down'), { retryable: false });
  assert.equal(getJob(workspaceId, first.id).status, 'failed');
  const again = queueOf('email.send', { draftId: 'drf_re' }, { dedupeKey: 'email.send:w:drf_re' });
  assert.equal(again.id, first.id);
  assert.equal(again.deduped, false);
  assert.equal(again.requeued, true);
  const revived = getJob(workspaceId, first.id);
  assert.equal(revived.status, 'queued');
  assert.equal(revived.attempts, 0);
  assert.equal(revived.lastError, null);
  // A running/queued duplicate is still deduplicated, not requeued.
  const queuedAgain = queueOf('email.send', { draftId: 'drf_re' }, { dedupeKey: 'email.send:w:drf_re' });
  assert.equal(queuedAgain.deduped, true);
});

test('enqueueJob rejects invalid input and oversized payloads', () => {
  assert.throws(() => enqueueJob({ workspaceId: '', type: 'lead.score' }), /workspaceId/);
  assert.throws(() => enqueueJob({ workspaceId, type: 'Not A Type' }), /任务类型不合法/);
  assert.throws(() => enqueueJob({ workspaceId, type: 'lead.score', payload: [] }), /payload 必须是对象/);
  const big = { blob: 'x'.repeat(70 * 1024) };
  assert.throws(() => enqueueJob({ workspaceId, type: 'lead.score', payload: big }), /payload/);
});

test('claimNextJob is atomic: the same job cannot be claimed twice', () => {
  queueOf('lead.score', { companyId: 'cmp_atomic' });
  const first = claimNextJob('worker-A');
  const second = claimNextJob('worker-B');
  assert.ok(first);
  assert.equal(first.status, 'running');
  assert.equal(first.attempts, 1);
  assert.equal(first.workerId, 'worker-A');
  assert.ok(first.leaseUntil > nowIso());
  assert.equal(second, null);
});

test('claimNextJob orders by priority then run_at and honours run_at in the future', () => {
  const later = queueOf('lead.score', { tag: 'later' }, { priority: 200 });
  const sooner = queueOf('lead.score', { tag: 'sooner' }, { priority: 10 });
  const future = queueOf('lead.score', { tag: 'future' }, { runAt: addMinutes(30), priority: 1 });
  const claimed = claimNextJob('worker-A');
  assert.equal(claimed.id, sooner.id);
  const second = claimNextJob('worker-A');
  assert.equal(second.id, later.id);
  assert.equal(claimNextJob('worker-A'), null, 'future job must not be claimed yet');
  const afterFuture = claimNextJob('worker-A', { now: addMinutes(31) });
  assert.equal(afterFuture.id, future.id);
});

test('paused workspace jobs are not claimed until resumed', () => {
  queueOf('lead.score', { companyId: 'cmp_pause' });
  pauseAll(workspaceId);
  assert.equal(isJobsPaused(workspaceId), true);
  assert.equal(claimNextJob('worker-A'), null);
  resumeAll(workspaceId);
  assert.equal(isJobsPaused(workspaceId), false);
  assert.ok(claimNextJob('worker-A'));
});

test('completeJob marks succeeded with a result; failJob retries with backoff then dead-letters', () => {
  const completed = queueOf('lead.score', { companyId: 'cmp_done' });
  claimNextJob('worker-A');
  assert.equal(completeJob(completed.id, { result: { score: 88 } }), true);
  const done = getJob(workspaceId, completed.id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result, { score: 88 });
  assert.equal(done.leaseUntil, null);
  assert.equal(completeJob(completed.id, { result: {} }), false, 'no longer running');

  const failing = queueOf('lead.score', { companyId: 'cmp_fail' }, { maxAttempts: 3 });
  claimNextJob('worker-A');
  const retry1 = failJob(failing.id, new Error('upstream timeout'), { retryable: true });
  assert.equal(retry1.status, 'queued');
  assert.ok(new Date(retry1.runAt).getTime() > Date.now(), 'backoff run_at is in the future');
  let job = getJob(workspaceId, failing.id);
  assert.match(job.lastError, /upstream timeout/);
  assert.equal(job.attempts, 1);

  // attempt 2
  claimNextJob('worker-A', { now: retry1.runAt });
  const retry2 = failJob(failing.id, new Error('still failing'), { retryable: true });
  assert.equal(retry2.status, 'queued');
  assert.ok(new Date(retry2.runAt).getTime() >= new Date(retry1.runAt).getTime());

  // attempt 3 exhausts max_attempts -> dead
  claimNextJob('worker-A', { now: retry2.runAt });
  const dead = failJob(failing.id, new Error('final failure'), { retryable: true });
  assert.equal(dead.status, 'dead');
  job = getJob(workspaceId, failing.id);
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, 3);

  // permanent error fails immediately
  const permanent = queueOf('lead.score', { companyId: 'cmp_perm' });
  claimNextJob('worker-A');
  const failed = failJob(permanent.id, new Error('bad payload'), { retryable: false });
  assert.equal(failed.status, 'failed');
});

test('failJob with a custom retryDelayMs controls the next run_at', () => {
  const job = queueOf('email.send', { draftId: 'drf_x' });
  claimNextJob('worker-A');
  const outcome = failJob(job.id, new Error('outside window'), { retryable: true, retryDelayMs: 90_000 });
  const delay = new Date(outcome.runAt).getTime() - Date.now();
  assert.ok(delay > 60_000 && delay <= 95_000, `delay ${delay}`);
});

test('cancelJob cancels a queued job and records an intent for a running job', () => {
  const queued = queueOf('lead.score', { companyId: 'cmp_c1' });
  const queuedResult = cancelJob(workspaceId, queued.id, 'user cancelled');
  assert.equal(queuedResult.cancelled, true);
  assert.equal(getJob(workspaceId, queued.id).status, 'cancelled');
  assert.equal(claimNextJob('worker-A'), null);

  const running = queueOf('lead.score', { companyId: 'cmp_c2' });
  claimNextJob('worker-A');
  const runningResult = cancelJob(workspaceId, running.id, 'takeover');
  assert.equal(runningResult.cancelled, false);
  assert.equal(runningResult.deletionRequested, true);
  assert.equal(isCancelRequested(running.id), true);
  assert.equal(finishCancelled(running.id, 'cancel requested'), true);
  assert.equal(getJob(workspaceId, running.id).status, 'cancelled');
});

test('cancelJobsForCompany cancels company-related pending jobs only', () => {
  const companyId = 'cmp_test_company';
  const contactId = 'con_test_contact';
  const draftId = 'drf_test_draft';
  const threadId = 'thr_test_thread';
  run(
    `INSERT INTO companies (id, workspace_id, name, normalized_name, domain, created_at, updated_at)
     VALUES (?, ?, 'Test GmbH', 'test gmbh', 'test-company.example', ?, ?)`,
    [companyId, workspaceId, nowIso(), nowIso()],
  );
  run(
    `INSERT INTO contacts (id, workspace_id, company_id, full_name, email, email_normalized, created_at, updated_at)
     VALUES (?, ?, ?, 'Max Mustermann', 'max@test-company.example', 'max@test-company.example', ?, ?)`,
    [contactId, workspaceId, companyId, nowIso(), nowIso()],
  );
  run(
    `INSERT INTO message_drafts (id, workspace_id, company_id, contact_id, subject, body_text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Hello', 'Body', 'approved', ?, ?)`,
    [draftId, workspaceId, companyId, contactId, nowIso(), nowIso()],
  );
  run(
    `INSERT INTO email_threads (id, workspace_id, company_id, contact_id, subject, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Hello', ?, ?)`,
    [threadId, workspaceId, companyId, contactId, nowIso(), nowIso()],
  );

  const sendJob = queueOf('email.send', { draftId });
  const draftJob = queueOf('draft.generate', { draftId });
  const followupJob = queueOf('followup.plan', { threadId, messageId: 'msg_1' });
  const unrelated = queueOf('maintenance.retention', {});
  const unrelatedCampaign = queueOf('campaign.tick', { campaignId: 'cmp_unrelated' });

  const cancelled = cancelJobsForCompany(workspaceId, companyId, 'automation_takeover');
  assert.equal(cancelled, 3);
  assert.equal(getJob(workspaceId, sendJob.id).status, 'cancelled');
  assert.equal(getJob(workspaceId, draftJob.id).status, 'cancelled');
  assert.equal(getJob(workspaceId, followupJob.id).status, 'cancelled');
  assert.equal(getJob(workspaceId, unrelated.id).status, 'queued');
  assert.equal(getJob(workspaceId, unrelatedCampaign.id).status, 'queued');
  const reasons = all('SELECT last_error FROM background_jobs WHERE status = ?', ['cancelled']);
  assert.ok(reasons.every((row) => row.last_error === 'automation_takeover'));
});

test('recoverExpiredLeases requeues a crashed worker job without losing attempts', () => {
  const job = queueOf('lead.score', { companyId: 'cmp_lease' });
  claimNextJob('worker-crashed');
  run('UPDATE background_jobs SET lease_until = ? WHERE id = ?', [addMinutes(-5), job.id]);
  const recovered = recoverExpiredLeases();
  assert.equal(recovered.recovered, 1);
  const requeued = getJob(workspaceId, job.id);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.attempts, 1);
  assert.match(requeued.lastError, /lease expired/);
  const reclaimed = claimNextJob('worker-new');
  assert.equal(reclaimed.id, job.id);
  assert.equal(reclaimed.attempts, 2);
});

test('recoverExpiredLeases dead-letters a job that exhausted its attempts', () => {
  const job = queueOf('lead.score', { companyId: 'cmp_lease_dead' }, { maxAttempts: 1 });
  claimNextJob('worker-crashed');
  run('UPDATE background_jobs SET lease_until = ? WHERE id = ?', [addMinutes(-5), job.id]);
  const recovered = recoverExpiredLeases();
  assert.equal(recovered.dead, 1);
  assert.equal(getJob(workspaceId, job.id).status, 'dead');
});

test('retryJob requeues failed/dead jobs and resets attempts', () => {
  const job = queueOf('lead.score', { companyId: 'cmp_retry' });
  claimNextJob('worker-A');
  failJob(job.id, new Error('boom'), { retryable: false });
  const result = retryJob(workspaceId, job.id);
  assert.equal(result.retried, true);
  const requeued = getJob(workspaceId, job.id);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.attempts, 0);
  assert.equal(requeued.lastError, null);

  const running = queueOf('lead.score', { companyId: 'cmp_retry_running' });
  claimNextJob('worker-A');
  assert.equal(retryJob(workspaceId, running.id).retried, false);
});

test('getJobStats aggregates statuses, pause flag and last-24h counters', () => {
  const a = queueOf('lead.score', {});
  const b = queueOf('lead.score', {});
  claimNextJob('worker-A');
  completeJob(a.id, { result: {} });
  claimNextJob('worker-A');
  failJob(b.id, new Error('x'), { retryable: false });
  queueOf('email.sync', { accountId: 'acc_1' });
  const stats = getJobStats(workspaceId);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.queued, 1);
  assert.equal(stats.total, 3);
  assert.equal(stats.paused, false);
  assert.equal(stats.last24h.succeeded, 1);
});

test('claimNextJob is scoped by workspace and respects paused workspaces', async () => {
  const other = ctx.createWorkspace({ email: `other-${Date.now()}@test.local` });
  pauseAll(workspaceId);
  const otherJob = enqueueJob({ workspaceId: other.workspaceId, type: 'lead.score', payload: { companyId: 'cmp_other' } });
  const mine = queueOf('lead.score', { companyId: 'cmp_mine' });
  const claimed = claimNextJob('worker-A');
  assert.equal(claimed.id, otherJob.id, 'paused workspace is skipped, other workspace job claimed');
  assert.equal(claimNextJob('worker-A'), null);
  assert.equal(getJob(workspaceId, mine.id).status, 'queued');
  const scoped = claimNextJob('worker-A', { workspaceId: other.workspaceId });
  assert.equal(scoped, null);
  // cleanup so later tests are unaffected
  run('DELETE FROM background_jobs WHERE workspace_id = ?', [other.workspaceId]);
  resumeAll(workspaceId);
});

test('lease_until is at least the configured lease window', () => {
  queueOf('lead.score', {});
  const claimed = claimNextJob('worker-A', { leaseSeconds: 300 });
  const remaining = new Date(claimed.leaseUntil).getTime() - Date.now();
  assert.ok(remaining > 250_000, `lease remaining ${remaining}`);
  void addHours;
  void get;
});
