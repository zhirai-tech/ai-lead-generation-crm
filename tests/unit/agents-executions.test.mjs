/**
 * Execution persistence, accounting and tenant isolation.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_INPUTS, createAgentTestEnv, createFakeProvider } from './agents-support.mjs';
import { getExecution, listExecutions, runAgent } from '../../server/agents/index.mjs';
import { simulateRole } from '../../server/agents/simulation.mjs';
import { all, get } from '../../server/core/db.mjs';

const env = createAgentTestEnv({ settingsPatch: { limits: { dailyAiTokens: 500000 } } });
after(() => env.cleanup());

test('executions are scoped to the workspace (tenant isolation)', async () => {
  const other = env.createWorkspace('隔离 Agent 工作空间');

  const runA = await runAgent({
    workspaceId: env.workspaceId,
    role: 'company_qualification',
    input: SAMPLE_INPUTS.company_qualification,
    actorType: 'user',
    actorId: env.userId,
  });

  const listB = listExecutions(other.workspaceId, { page: 1, pageSize: 25 });
  assert.equal(listB.total, 0);
  assert.equal(getExecution(other.workspaceId, runA.executionId), null);

  const runB = await runAgent({
    workspaceId: other.workspaceId,
    role: 'market_research',
    input: SAMPLE_INPUTS.market_research,
    actorType: 'user',
    actorId: other.userId,
  });

  const listA = listExecutions(env.workspaceId, { page: 1, pageSize: 100 });
  const listBAfter = listExecutions(other.workspaceId, { page: 1, pageSize: 100 });
  assert.ok(listA.items.some((item) => item.id === runA.executionId));
  assert.equal(listA.items.some((item) => item.id === runB.executionId), false);
  assert.ok(listBAfter.items.some((item) => item.id === runB.executionId));
  assert.equal(listBAfter.items.some((item) => item.id === runA.executionId), false);

  // Usage records stay in their own workspace as well.
  const usageA = all('SELECT * FROM usage_records WHERE workspace_id = ?', [env.workspaceId]);
  const usageB = all('SELECT * FROM usage_records WHERE workspace_id = ?', [other.workspaceId]);
  assert.ok(usageA.length >= 2);
  assert.ok(usageB.length >= 2);
  for (const row of usageA) assert.equal(row.workspace_id, env.workspaceId);
  for (const row of usageB) assert.equal(row.workspace_id, other.workspaceId);
});

test('execution detail exposes parsed input/output and no cross-workspace data', async () => {
  const result = await runAgent({
    workspaceId: env.workspaceId,
    role: 'reply_classification',
    input: SAMPLE_INPUTS.reply_classification,
  });
  const execution = getExecution(env.workspaceId, result.executionId);
  assert.equal(execution.role, 'reply_classification');
  assert.equal(execution.input.message.body, SAMPLE_INPUTS.reply_classification.message.body);
  assert.equal(execution.output.label, result.output.label);
  assert.equal(execution.status, 'succeeded');
  assert.ok(execution.promptVersion);

  const other = env.createWorkspace('详情隔离空间');
  assert.equal(getExecution(other.workspaceId, result.executionId), null);
});

test('failed executions are persisted with error code and usage', async () => {
  const valid = simulateRole('reply_classification', SAMPLE_INPUTS.reply_classification);
  const fake = createFakeProvider([{ ...valid, label: 'bad' }, { ...valid, confidence: 9 }]);
  await assert.rejects(
    runAgent({
      workspaceId: env.workspaceId,
      role: 'reply_classification',
      input: SAMPLE_INPUTS.reply_classification,
      provider: fake,
    }),
    (error) => error.code === 'AGENT_INVALID_OUTPUT',
  );

  const failed = listExecutions(env.workspaceId, { status: 'failed', page: 1, pageSize: 50 });
  assert.ok(failed.total >= 1);
  const failedItem = failed.items[0];
  const detail = getExecution(env.workspaceId, failedItem.id);
  assert.equal(detail.status, 'failed');
  assert.match(detail.error, /AGENT_INVALID_OUTPUT/);
  assert.equal(detail.provider, 'fake-provider');
  const usage = get('SELECT COUNT(*) AS c FROM usage_records WHERE workspace_id = ? AND agent_execution_id = ?', [
    env.workspaceId,
    failedItem.id,
  ]);
  assert.equal(usage.c, 2);
});

test('execution list supports pagination and role filtering', async () => {
  for (let index = 0; index < 3; index += 1) {
    await runAgent({
      workspaceId: env.workspaceId,
      role: 'follow_up_planning',
      input: SAMPLE_INPUTS.follow_up_planning,
    });
  }
  const pageOne = listExecutions(env.workspaceId, { page: 1, pageSize: 2 });
  assert.equal(pageOne.page, 1);
  assert.equal(pageOne.pageSize, 2);
  assert.ok(pageOne.total >= 3);
  assert.equal(pageOne.items.length, 2);
  const pageTwo = listExecutions(env.workspaceId, { page: 2, pageSize: 2 });
  assert.equal(pageTwo.items.length, 2);
  assert.notEqual(pageOne.items[0].id, pageTwo.items[0].id);

  const filtered = listExecutions(env.workspaceId, { role: 'follow_up_planning', page: 1, pageSize: 100 });
  assert.ok(filtered.total >= 3);
  for (const item of filtered.items) assert.equal(item.role, 'follow_up_planning');
});

test('executions record creator and job linkage', async () => {
  const result = await runAgent({
    workspaceId: env.workspaceId,
    role: 'orchestrator',
    input: { goal: '计划一次德国市场外呼' },
    actorType: 'agent',
    actorId: 't-worker',
    jobId: 'job_test_123',
    createdBy: env.userId,
  });
  const execution = getExecution(env.workspaceId, result.executionId);
  assert.equal(execution.jobId, 'job_test_123');
  assert.equal(execution.createdBy, env.userId);
  assert.equal(result.usage.jobId, 'job_test_123');

  const audit = get(
    `SELECT * FROM audit_events WHERE workspace_id = ? AND action = 'agent.run' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`,
    [env.workspaceId, result.executionId],
  );
  assert.ok(audit, 'agent.run audit event must be written');
  assert.equal(audit.actor_type, 'agent');
});
