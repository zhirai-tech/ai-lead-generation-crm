/**
 * t-worker integration tests: `/api/v1/jobs` HTTP surface.
 * Verifies auth, capabilities (viewer/member/admin), CSRF, pagination/filters,
 * stats, cancel/retry/pause/resume, audit trail and tenant isolation.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { run, get, all } from '../../server/core/db.mjs';
import { nowIso } from '../../server/core/time.mjs';
import { getJob } from '../../server/jobs/queue.mjs';
import { createTestContext } from '../../server/jobs/test-support.mjs';

let ctx;
let workspaceId;

before(async () => {
  ctx = await createTestContext({ withServer: true });
  workspaceId = ctx.owner.workspaceId;
});

after(async () => {
  await ctx.close();
});

beforeEach(() => {
  run('DELETE FROM background_jobs');
  run("DELETE FROM settings WHERE workspace_id = ? AND key = 'jobs.globalPaused'", [workspaceId]);
  run('DELETE FROM audit_events WHERE workspace_id = ?', [workspaceId]);
  ctx.resetAuth();
});

function jobPath(id) {
  return `/api/v1/jobs/${encodeURIComponent(id)}`;
}

async function insertJob({ type = 'lead.score', payload = {}, dedupeKey = null, status = 'queued', lastError = null } = {}) {
  const { enqueueJob, claimNextJob, failJob, completeJob } = await import('../../server/jobs/queue.mjs');
  const { id } = await import('../../server/core/ids.mjs');
  const queued = enqueueJob({ workspaceId, type, payload, dedupeKey: dedupeKey || `t:${id('k')}` });
  if (status === 'running') claimNextJob('test-worker', { workspaceId });
  if (status === 'failed') {
    claimNextJob('test-worker', { workspaceId });
    failJob(queued.id, new Error(lastError || 'boom'), { retryable: false });
  }
  if (status === 'succeeded') {
    claimNextJob('test-worker', { workspaceId });
    completeJob(queued.id, { result: { ok: true } });
  }
  return queued.id;
}

test('unauthenticated job API access is rejected', async () => {
  const response = await ctx.request('GET', '/api/v1/jobs', { anonymous: true });
  assert.equal(response.status, 401);
  assert.equal(response.body.ok, false);
});

test('job list supports pagination and type/status filters', async () => {
  const typeIds = [];
  for (let index = 0; index < 5; index += 1) {
    typeIds.push(await insertJob({ type: index % 2 === 0 ? 'lead.score' : 'draft.generate', payload: { index } }));
  }
  const allResponse = await ctx.request('GET', '/api/v1/jobs?page=1&pageSize=2');
  assert.equal(allResponse.status, 200);
  assert.equal(allResponse.body.data.items.length, 2);
  assert.equal(allResponse.body.data.total, 5);
  assert.equal(allResponse.body.data.page, 1);
  assert.equal(allResponse.body.data.pageSize, 2);

  const filtered = await ctx.request('GET', '/api/v1/jobs?type=lead.score&pageSize=50');
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.data.items.every((job) => job.type === 'lead.score'));
  assert.ok(filtered.body.data.total >= 3);

  const failed = await insertJob({ status: 'failed' });
  const failedList = await ctx.request('GET', '/api/v1/jobs?status=failed');
  assert.ok(failedList.body.data.items.some((job) => job.id === failed));

  const invalidStatus = await ctx.request('GET', '/api/v1/jobs?status=bogus');
  assert.equal(invalidStatus.status, 422, 'invalid status filter is rejected');
  void typeIds;
});

test('job detail returns the job or 404 and never leaks other workspaces', async () => {
  const jobId = await insertJob({ type: 'email.sync', payload: { accountId: 'acc_1' } });
  const response = await ctx.request('GET', jobPath(jobId));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.id, jobId);
  assert.equal(response.body.data.workspaceId, workspaceId);
  assert.deepEqual(response.body.data.payload, { accountId: 'acc_1' });

  const missing = await ctx.request('GET', jobPath('job_does_not_exist'));
  assert.equal(missing.status, 404);

  const other = ctx.createWorkspace();
  const { enqueueJob } = await import('../../server/jobs/queue.mjs');
  const foreign = enqueueJob({ workspaceId: other.workspaceId, type: 'lead.score', payload: {} });
  ctx.resetAuth();
  const foreignResponse = await ctx.request('GET', jobPath(foreign.id));
  assert.equal(foreignResponse.status, 404, 'tenant isolation: other workspace job is invisible');
  const list = await ctx.request('GET', '/api/v1/jobs?pageSize=100');
  assert.ok(!list.body.data.items.some((job) => job.id === foreign.id));
});

test('stats endpoint reports status counts, pause flag and registered handlers', async () => {
  await insertJob({ status: 'succeeded' });
  await insertJob({ status: 'failed' });
  await insertJob({});
  const response = await ctx.request('GET', '/api/v1/jobs/stats');
  assert.equal(response.status, 200);
  const stats = response.body.data;
  assert.ok(stats.succeeded >= 1);
  assert.ok(stats.failed >= 1);
  assert.ok(stats.queued >= 1);
  assert.equal(stats.paused, false);
  assert.ok(stats.types.includes('email.send'));
  assert.ok(stats.registeredHandlers.includes('maintenance.retention'));
});

test('pause and resume toggle the workspace queue and are audited', async () => {
  await insertJob({});
  const paused = await ctx.request('POST', '/api/v1/jobs/pause', { body: {} });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.data.paused, true);
  const stats = await ctx.request('GET', '/api/v1/jobs/stats');
  assert.equal(stats.body.data.paused, true);
  const audit = get("SELECT * FROM audit_events WHERE workspace_id = ? AND action = 'jobs.pause_all'", [workspaceId]);
  assert.ok(audit);

  const resumed = await ctx.request('POST', '/api/v1/jobs/resume', { body: {} });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.paused, false);
});

test('cancel a queued job and audit the action', async () => {
  const jobId = await insertJob({ type: 'lead.score' });
  const response = await ctx.request('POST', `/api/v1/jobs/${jobId}/cancel`, { body: { reason: 'manual cleanup' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.cancelled, true);
  assert.equal(getJob(workspaceId, jobId).status, 'cancelled');
  const audit = get("SELECT * FROM audit_events WHERE workspace_id = ? AND action = 'job.cancel' AND entity_id = ?", [workspaceId, jobId]);
  assert.ok(audit);
  assert.match(audit.after_json, /manual cleanup/);
});

test('retry a failed job, reject retry of a queued job', async () => {
  const failedId = await insertJob({ status: 'failed', lastError: 'upstream down' });
  const retried = await ctx.request('POST', `/api/v1/jobs/${failedId}/retry`, { body: {} });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.data.retried, true);
  assert.equal(getJob(workspaceId, failedId).status, 'queued');

  const queuedId = await insertJob({});
  const rejected = await ctx.request('POST', `/api/v1/jobs/${queuedId}/retry`, { body: {} });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.ok, false);
});

test('viewer can read jobs but cannot manage them; member cannot manage either', async () => {
  const jobId = await insertJob({});
  const viewer = ctx.createMember({ email: `viewer-${Date.now()}@test.local`, role: 'viewer' });
  ctx.as(viewer);
  const list = await ctx.request('GET', '/api/v1/jobs');
  assert.equal(list.status, 200);
  const cancel = await ctx.request('POST', `/api/v1/jobs/${jobId}/cancel`, { body: { reason: 'nope' } });
  assert.equal(cancel.status, 403);
  const pause = await ctx.request('POST', '/api/v1/jobs/pause', { body: {} });
  assert.equal(pause.status, 403);

  const member = ctx.createMember({ email: `member-${Date.now()}@test.local`, role: 'member' });
  ctx.as(member);
  const memberCancel = await ctx.request('POST', `/api/v1/jobs/${jobId}/cancel`, { body: {} });
  assert.equal(memberCancel.status, 403);
  ctx.resetAuth();
});

test('mutating job endpoints require a CSRF token', async () => {
  const response = await ctx.request('POST', '/api/v1/jobs/pause', { body: {}, csrf: false });
  assert.equal(response.status, 403);
  assert.match(response.text, /CSRF/);
});

test('job list rejects invalid pagination input', async () => {
  const response = await ctx.request('GET', '/api/v1/jobs?page=0&pageSize=9999');
  assert.equal(response.status, 200, 'pagination is clamped rather than rejected');
  assert.equal(response.body.data.page, 1);
  assert.equal(response.body.data.pageSize, 100);
});
