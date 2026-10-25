/**
 * HTTP-level tests for the Phase 1 Agent task API.
 *
 * This file must be run with AGENT_LOOP_ENABLED=1 (or with the variable set
 * before the dynamic import below). It never starts the worker, so the task
 * remains queued; no model, email or customer write is executed.
 */
process.env.AGENT_LOOP_ENABLED = '1';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { createTestContext } = await import('../helpers.mjs');
const { get, run } = await import('../../server/core/db.mjs');
const { config } = await import('../../server/config.mjs');
const { runWorkerTick } = await import('../../server/jobs/worker.mjs');
const { enqueueJob } = await import('../../server/jobs/queue.mjs');
const { claimTask, createAgentTask, getTask, listEvents } = await import('../../server/agents/loop.mjs');

const ctx = await createTestContext();
after(() => ctx.close());

test('feature flag is enabled for this isolated test process', () => {
  assert.equal(config.features.agentLoop, true);
});

test('authenticated owner can create a read-only task and a queued agent.task job', async () => {
  const response = await ctx.request('POST', '/api/v1/agent/tasks', { body: { goal: '列出当前企业' } });
  assert.equal(response.status, 200, response.text);
  const task = response.body.data.task;
  assert.equal(task.mode, 'read_only');
  assert.equal(task.status, 'queued');
  assert.ok(task.id.startsWith('agt_'));
  const job = get('SELECT type, status, payload_json FROM background_jobs WHERE workspace_id = ? AND type = ?', [ctx.owner.workspaceId, 'agent.task']);
  assert.ok(job);
  assert.equal(job.status, 'queued');
  assert.match(job.payload_json, new RegExp(task.id));
});

test('event endpoint and task endpoint are workspace scoped and readable', async () => {
  const created = await ctx.request('POST', '/api/v1/agent/tasks', { body: { goal: '读取任务事件' } });
  const taskId = created.body.data.task.id;
  const events = await ctx.request('GET', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/events`);
  assert.equal(events.status, 200, events.text);
  assert.equal(events.body.data.task.id, taskId);
  assert.ok(Array.isArray(events.body.data.items));

  const other = ctx.createWorkspace({ name: 'Agent API 隔离空间' });
  ctx.as(other);
  const foreign = await ctx.request('GET', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}`);
  assert.equal(foreign.status, 404);
  ctx.as(ctx.owner);
});

test('cancel is persisted and cancels the queued job', async () => {
  const created = await ctx.request('POST', '/api/v1/agent/tasks', { body: { goal: '取消任务测试' } });
  const task = created.body.data.task;
  const response = await ctx.request('POST', `/api/v1/agent/tasks/${encodeURIComponent(task.id)}/cancel`, { body: {} });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.data.cancelled, true);
  assert.equal(response.body.data.task.status, 'cancelled');
  const job = get('SELECT status FROM background_jobs WHERE workspace_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1', [ctx.owner.workspaceId, 'agent.task']);
  assert.equal(job.status, 'cancelled');
});

test('anonymous access is rejected', async () => {
  const response = await ctx.request('GET', '/api/v1/agent/tasks', { anonymous: true });
  assert.equal(response.status, 401);
});

test('worker executes a queued task through the real handler without email or customer writes', async () => {
  const created = await ctx.request('POST', '/api/v1/agent/tasks', { body: { goal: '模拟 Provider 下的只读任务' } });
  const taskId = created.body.data.task.id;
  let task = await ctx.request('GET', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}`);
  for (let tick = 0; tick < 6 && !['completed', 'failed', 'cancelled'].includes(task.body.data.task.status); tick += 1) {
    await runWorkerTick({ config: ctx.config });
    task = await ctx.request('GET', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}`);
  }
  assert.ok(['completed', 'failed'].includes(task.body.data.task.status), JSON.stringify(task.body));
  const events = await ctx.request('GET', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/events`);
  assert.equal(events.status, 200);
  assert.ok(events.body.data.items.length >= 1);
  const outbound = get('SELECT COUNT(*) AS c FROM email_messages WHERE workspace_id = ?', [ctx.owner.workspaceId]);
  assert.equal(outbound.c, 0, 'Agent task must not send email');
});

test('worker tick repairs an expired Agent task without runAgentTask', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'worker 自动修复过期任务' });
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId: task.id }, createdBy: ctx.owner.userId });
  run("UPDATE background_jobs SET status = 'failed' WHERE id = ?", [job.id]);
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  assert.ok(token);
  run('UPDATE agent_tasks SET run_lease_until = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), task.id]);
  await runWorkerTick({ config: ctx.config });
  const repaired = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(repaired.status, 'failed');
  assert.match(repaired.error, /AGENT_TASK_LEASE_EXPIRED/);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'error' && /AGENT_TASK_LEASE_EXPIRED/.test(event.error || '')));
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
});

test('worker processes a queued job after recovery scan leaves it claimable', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'queued job 后续正常领取' });
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId: task.id }, createdBy: ctx.owner.userId });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  assert.ok(token);
  run('UPDATE agent_tasks SET run_lease_until = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), task.id]);
  let repaired = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(repaired.status, 'running');
  for (let tick = 0; tick < 8 && !['completed', 'failed', 'cancelled'].includes(repaired.status); tick += 1) {
    await runWorkerTick({ config: ctx.config });
    repaired = getTask(ctx.owner.workspaceId, task.id);
  }
  assert.equal(repaired.status, 'completed', JSON.stringify(repaired));
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'final_answer'));
  assert.equal(events.some((event) => event.type === 'error'), false);
});
