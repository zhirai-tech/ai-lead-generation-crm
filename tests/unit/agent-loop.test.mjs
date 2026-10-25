/**
 * Phase 1 Agent loop tests. These are deterministic and use a fake provider.
 * No network model or email is used.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { createCompany } from '../../server/services/companies.mjs';
import { createContact } from '../../server/services/contacts.mjs';
import { all, get, run } from '../../server/core/db.mjs';
import { cancelJob, enqueueJob } from '../../server/jobs/queue.mjs';
import { AGENT_LIMITS, cancelTask, claimTask, createAgentTask, getTask, listEvents, recoverExpiredAgentTasks, runAgentTask } from '../../server/agents/loop.mjs';
import { executeReadTool } from '../../server/agents/tool-registry.mjs';
import { browserSearch } from '../../server/services/browser-contact.mjs';
import { config } from '../../server/config.mjs';

const ctx = await createTestContext();
after(() => ctx.close());

function fakeProvider(responses) {
  const calls = [];
  return {
    key: 'fake-provider',
    providerKey: 'fake-provider',
    model: 'fake-model',
    isSimulation: false,
    pricing: { inputPer1k: 0, outputPer1k: 0 },
    calls,
    async complete(request) {
      calls.push(request);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      const value = typeof next === 'function' ? next(request, calls.length) : next;
      return { text: JSON.stringify(value), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'fake-model' };
    },
  };
}

function createSmallCompany(name = 'Agent Test GmbH') {
  return createCompany(
    ctx.owner.workspaceId,
    { name, domain: `agent-test-${Math.random().toString(36).slice(2)}.example`, website: 'https://example.com', country: 'DE', industry: 'Automotive Aftermarket' },
    { actorId: ctx.owner.userId },
  );
}

async function makeTask(goal = '列出当前企业') {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_test_agent' });
  assert.ok(token, 'task must be claimed');
  return { task, token };
}

test('Phase 1 migration is additive and present in a fresh database', () => {
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_tasks', 'agent_events')").map((row) => row.name);
  assert.deepEqual(tables.sort(), ['agent_events', 'agent_tasks']);
  const migrations = all('SELECT name FROM schema_migrations ORDER BY name').map((row) => row.name);
  assert.ok(migrations.includes('005_agent_tasks.sql'));
});

test('fake provider chooses a read-only tool; real result reaches the next decision', async () => {
  createSmallCompany('Decision Evidence GmbH');
  const before = get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ?', [ctx.owner.workspaceId]).c;
  const provider = fakeProvider([
    { action: 'call_tool', tool: 'company.list', reason: '先读取企业列表', arguments: { pageSize: 5 } },
    (request) => {
      const result = request.input?.lastToolResult?.result;
      const total = result?.total;
      assert.equal(total >= 1, true, 'second decision must receive real tool result');
      return { action: 'finish', reason: '已取得真实结果', answer: `工具返回 ${total} 家企业，数据来自 company.list。` };
    },
  ]);
  const { task, token } = await makeTask('列出当前企业并说明依据');
  const result = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_test_agent', providerOverride: provider });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].input.lastToolResult.tool, 'company.list');
  assert.equal(typeof provider.calls[1].input.lastToolResult.result.total, 'number');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['model_decision', 'tool_call', 'tool_result', 'model_decision', 'final_answer']);
  const stored = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(stored.status, 'completed');
  assert.match(stored.result.answer, new RegExp(String(provider.calls[1].input.lastToolResult.result.total)));
  const afterCount = get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ?', [ctx.owner.workspaceId]).c;
  assert.equal(afterCount, before, 'read-only Agent must not create/delete companies');
});

test('write and unknown tools are rejected before execution', async () => {
  await assert.rejects(
    () => executeReadTool({ workspaceId: ctx.owner.workspaceId, toolName: 'draft.send', args: { draftId: 'x' } }),
    (error) => error.code === 'TOOL_NOT_ALLOWED',
  );
  await assert.rejects(
    () => executeReadTool({ workspaceId: ctx.owner.workspaceId, toolName: 'company.list', args: { unknown: true } }),
    (error) => error.code === 'TOOL_INVALID_ARGUMENT',
  );
  const provider = fakeProvider([
    { action: 'call_tool', tool: 'draft.send', reason: '错误工具', arguments: {} },
  ]);
  const { task, token } = await makeTask('测试错误工具');
  const result = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_test_invalid_or_duplicate', providerOverride: provider });
  assert.equal(result.status, 'failed');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'error'));
});

test('duplicate tool + arguments stops the loop', async () => {
  createSmallCompany('Duplicate Guard GmbH');
  const provider = fakeProvider([
    { action: 'call_tool', tool: 'company.list', reason: '第一次', arguments: { pageSize: 5 } },
    { action: 'call_tool', tool: 'company.list', reason: '重复', arguments: { pageSize: 5 } },
  ]);
  const { task, token } = await makeTask('重复工具测试');
  const result = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_test_invalid_or_duplicate', providerOverride: provider });
  assert.equal(result.status, 'failed');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'error' && /重复调用/.test(event.error || '')));
});

test('cancelled task cannot be claimed or executed', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '取消测试' });
  assert.equal(cancelTask(ctx.owner.workspaceId, task.id, 'test_cancel'), true);
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_cancel' });
  assert.equal(token, null);
  assert.equal(getTask(ctx.owner.workspaceId, task.id).status, 'cancelled');
});

test('expired task lease can be reclaimed but the old token cannot continue', async () => {
  const { task, token: firstToken } = await makeTask('lease 测试');
  const past = new Date(Date.now() - 60_000).toISOString();
  run('UPDATE agent_tasks SET run_lease_until = ? WHERE id = ?', [past, task.id]);
  const secondToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_lease' });
  assert.ok(secondToken);
  assert.notEqual(secondToken, firstToken);
  const stale = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: firstToken, jobId: 'job_test_lease_old', providerOverride: fakeProvider([{ action: 'finish', reason: '旧 token', answer: '不应执行' }]) });
  assert.equal(stale.status, 'stale');
  const fresh = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: secondToken, jobId: 'job_test_lease_new', providerOverride: fakeProvider([{ action: 'finish', reason: '新 token', answer: '安全结束' }]) });
  assert.equal(fresh.status, 'completed');
});

test('max event steps stops the task', async () => {
  const { task, token } = await makeTask('步骤上限测试');
  const now = new Date().toISOString();
  for (let stepNo = 1; stepNo <= AGENT_LIMITS.maxSteps; stepNo += 1) {
    run(
      'INSERT INTO agent_events (id, workspace_id, task_id, step_no, type, input_json, output_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [`evt_step_${task.id}_${stepNo}`, ctx.owner.workspaceId, task.id, stepNo, 'status', '{}', '{}', 'ok', now],
    );
  }
  const result = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_test_max_steps', providerOverride: fakeProvider([{ action: 'finish', reason: '不应调用', answer: '不应完成' }]) });
  assert.equal(result.status, 'failed');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'error' && /最大执行步骤/.test(event.error || '')));
});

test('events are workspace scoped', async () => {
  const other = ctx.createWorkspace({ name: 'Agent 隔离空间' });
  const { task, token } = await makeTask('隔离测试');
  assert.equal(getTask(other.workspaceId, task.id), null);
  assert.equal(listEvents(other.workspaceId, task.id), null);
  const result = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_test_scope', providerOverride: fakeProvider([{ action: 'finish', reason: '结束', answer: '无操作' }]) });
  assert.equal(result.status, 'completed');
});

test('feature flag defaults off', async () => {
  assert.equal(config.features.agentLoop, false);
  const response = await ctx.request('POST', '/api/v1/agent/tasks', { body: { goal: '不应创建任务' } });
  assert.equal(response.status, 404);
});

function gatedProvider(action) {
  const calls = [];
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    calls,
    started: startedPromise,
    release,
    provider: {
      key: 'fake-gated',
      providerKey: 'fake-gated',
      model: 'fake-model',
      isSimulation: false,
      pricing: { inputPer1k: 0, outputPer1k: 0 },
      async complete(request) {
        calls.push(request);
        started();
        await gate;
        return {
          text: JSON.stringify(action),
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: 'fake-model',
        };
      },
    },
  };
}

function expireTaskLease(taskId) {
  run('UPDATE agent_tasks SET run_lease_until = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), taskId]);
}

function hasToolEvents(taskId) {
  return listEvents(ctx.owner.workspaceId, taskId, { after: 0, limit: 100 }).items
    .some((event) => ['tool_call', 'tool_result'].includes(event.type));
}

test('authority: cancellation during model call prevents every tool execution', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '取消期间不执行工具' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_authority_cancel' });
  const gated = gatedProvider({ action: 'call_tool', tool: 'company.list', reason: '不应执行', arguments: { pageSize: 5 } });
  const tool = countingToolExecutor();
  const running = runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_authority_cancel',
    providerOverride: gated.provider,
    toolExecutor: tool.execute,
  });
  await gated.started;
  assert.equal(cancelTask(ctx.owner.workspaceId, task.id, 'test_cancel_during_model'), true);
  gated.release();
  const result = await running;
  assert.equal(result.status, 'stale');
  assert.equal(tool.state.calls, 0);
  assert.equal(hasToolEvents(task.id), false, 'stale worker must not persist or execute tool events');
  assert.equal(getTask(ctx.owner.workspaceId, task.id).status, 'cancelled');
});

test('authority: expired lease during model call prevents tool execution', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'lease 失效不执行工具' });
  const oldToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_authority_lease' });
  const gated = gatedProvider({ action: 'call_tool', tool: 'company.list', reason: '不应执行', arguments: { pageSize: 5 } });
  const tool = countingToolExecutor();
  const running = runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: oldToken,
    jobId: 'job_authority_lease',
    providerOverride: gated.provider,
    toolExecutor: tool.execute,
  });
  await gated.started;
  expireTaskLease(task.id);
  const newToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_authority_lease_new' });
  assert.ok(newToken);
  gated.release();
  const result = await running;
  assert.equal(result.status, 'stale');
  assert.equal(tool.state.calls, 0);
  assert.equal(hasToolEvents(task.id), false, 'old lease must not execute tools');
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, newToken);
});

test('authority: new worker claim prevents old worker from overwriting new state', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '新 worker 接管' });
  const oldToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_authority_takeover' });
  const gated = gatedProvider({ action: 'call_tool', tool: 'company.list', reason: '旧 worker 不应执行', arguments: { pageSize: 5 } });
  const tool = countingToolExecutor();
  const running = runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: oldToken,
    jobId: 'job_authority_takeover',
    providerOverride: gated.provider,
    toolExecutor: tool.execute,
  });
  await gated.started;
  expireTaskLease(task.id);
  const newToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_authority_takeover_new' });
  assert.ok(newToken);
  gated.release();
  const oldResult = await running;
  assert.equal(oldResult.status, 'stale');
  assert.equal(tool.state.calls, 0);
  assert.equal(hasToolEvents(task.id), false);
  const afterOld = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(afterOld.status, 'running');
  assert.equal(afterOld.runToken, newToken);

  const newResult = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: newToken,
    jobId: 'job_authority_takeover_new',
    providerOverride: fakeProvider([{ action: 'finish', reason: '新 worker 完成', answer: '新 worker 的有效完成' }]),
  });
  assert.equal(newResult.status, 'completed');
  assert.match(getTask(ctx.owner.workspaceId, task.id).result.answer, /新 worker/);
});

function countingToolExecutor(handler = null) {
  const state = { calls: 0 };
  return {
    state,
    execute: async ({ toolName, args }) => {
      state.calls += 1;
      if (handler) return handler({ toolName, args, calls: state.calls });
      return { tool: toolName, arguments: args, result: { total: 0, items: [] } };
    },
  };
}

test('authority: jobId is required and missing jobId never calls model or tool', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '缺少 jobId' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_missing_contract' });
  const tool = countingToolExecutor();
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: null,
    providerOverride: fakeProvider([{ action: 'call_tool', tool: 'company.list', reason: '不应执行', arguments: {} }]),
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'invalid');
  assert.equal(tool.state.calls, 0);
});

test('authority: expired task lease without new claim prevents tool execution', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '纯 lease 过期' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_lease_no_reclaim' });
  const gated = gatedProvider({ action: 'call_tool', tool: 'company.list', reason: '不应执行', arguments: { pageSize: 2 } });
  const tool = countingToolExecutor();
  const running = runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_lease_no_reclaim',
    providerOverride: gated.provider,
    toolExecutor: tool.execute,
  });
  await gated.started;
  expireTaskLease(task.id);
  gated.release();
  const result = await running;
  assert.equal(result.status, 'stale');
  assert.equal(tool.state.calls, 0, 'expired task lease must not execute tool');
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, token);
  assert.equal(hasToolEvents(task.id), false);
});

test('authority: job cancel intent during model call prevents tool execution', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'job cancel intent' });
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId: task.id }, createdBy: ctx.owner.userId });
  run("UPDATE background_jobs SET status = 'running', lease_until = ? WHERE id = ?", [new Date(Date.now() + 120000).toISOString(), job.id]);
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  const gated = gatedProvider({ action: 'call_tool', tool: 'company.list', reason: 'job 已取消', arguments: { pageSize: 2 } });
  const tool = countingToolExecutor();
  const running = runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: job.id,
    providerOverride: gated.provider,
    toolExecutor: tool.execute,
  });
  await gated.started;
  cancelJob(ctx.owner.workspaceId, job.id, 'test_job_cancel');
  gated.release();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(tool.state.calls, 0);
  assert.equal(hasToolEvents(task.id), false);
  assert.equal(getTask(ctx.owner.workspaceId, task.id).status, 'cancelled');
});

test('authority: valid lease without cancellation executes the fake tool exactly once', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '正常执行' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_valid_execution' });
  const tool = countingToolExecutor();
  const provider = fakeProvider([
    { action: 'call_tool', tool: 'company.list', reason: '正常调用', arguments: { pageSize: 2 } },
    { action: 'finish', reason: '完成', answer: '已完成' },
  ]);
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_valid_execution',
    providerOverride: provider,
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'completed');
  assert.equal(tool.state.calls, 1);
  assert.equal(getTask(ctx.owner.workspaceId, task.id).status, 'completed');
});

test('authority: tool started then lost authority is executed once but cannot overwrite new state', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '工具执行期间失去执行权' });
  const oldToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_tool_running_old' });
  let newToken = null;
  const tool = countingToolExecutor(async ({ toolName, args }) => {
    expireTaskLease(task.id);
    newToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_tool_running_new' });
    return { tool: toolName, arguments: args, result: { total: 999, items: [{ name: 'stale worker result' }] } };
  });
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: oldToken,
    jobId: 'job_tool_running_old',
    providerOverride: fakeProvider([{ action: 'call_tool', tool: 'company.list', reason: '工具启动后失去权限', arguments: { pageSize: 2 } }]),
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'stale');
  assert.equal(tool.state.calls, 1, 'tool was started; it cannot be described as never executed');
  assert.ok(newToken);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, newToken);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.some((event) => event.type === 'tool_result'), false, 'stale worker must not persist tool_result');
  assert.equal(events.some((event) => event.type === 'final_answer'), false);
});

test('multi-tool: company.list → company.get → company.evidence → finish completes', async () => {
  const company = createCompany(
    ctx.owner.workspaceId,
    { name: 'Multi Tool Acceptance GmbH', domain: 'multi-tool-acceptance.example', website: 'https://example.com', country: 'DE', industry: 'Automotive Aftermarket' },
    { actorId: ctx.owner.userId },
  );
  createContact(ctx.owner.workspaceId, {
    companyId: company.id,
    firstName: 'Anna',
    lastName: 'Schmidt',
    email: 'anna@multi-tool-acceptance.example',
    title: 'Purchasing Manager',
  }, { actorId: ctx.owner.userId });
  const beforeCompanies = get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ?', [ctx.owner.workspaceId]).c;
  const beforeContacts = get('SELECT COUNT(*) AS c FROM contacts WHERE workspace_id = ?', [ctx.owner.workspaceId]).c;
  const provider = fakeProvider([
    { action: 'call_tool', tool: 'company.list', reason: '列出目标企业', arguments: { q: 'Multi Tool Acceptance', pageSize: 5 } },
    (request) => ({ action: 'call_tool', tool: 'company.get', reason: '读取企业资料', arguments: { companyId: request.input.lastToolResult.result.items[0].id } }),
    (request) => ({ action: 'call_tool', tool: 'company.evidence', reason: '读取证据', arguments: { companyId: request.input.lastToolResult.result.company.id } }),
    (request) => ({ action: 'finish', reason: '三工具结果已足够', answer: `已读取 ${request.input.lastToolResult.result.company.name} 的企业资料和证据。` }),
  ]);
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '三工具组合验收' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_multi_tool' });
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_multi_tool',
    providerOverride: provider,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(provider.calls.length, 4);
  assert.equal(provider.calls[1].input.lastToolResult.tool, 'company.list');
  assert.equal(provider.calls[1].input.lastToolResult.result.items[0].id, company.id);
  assert.equal(provider.calls[2].input.lastToolResult.tool, 'company.get');
  assert.equal(provider.calls[2].input.lastToolResult.result.company.id, company.id);
  assert.equal(provider.calls[3].input.lastToolResult.tool, 'company.evidence');
  assert.equal(provider.calls[3].input.lastToolResult.result.company.id, company.id);
  const stored = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.toolCalls, 3);
  assert.match(stored.result.answer, /Multi Tool Acceptance/);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.deepEqual(events.map((event) => event.type), [
    'model_decision', 'tool_call', 'tool_result',
    'model_decision', 'tool_call', 'tool_result',
    'model_decision', 'tool_call', 'tool_result',
    'model_decision', 'final_answer',
  ]);
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 3);
  assert.equal(get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ?', [ctx.owner.workspaceId]).c, beforeCompanies);
  assert.equal(get('SELECT COUNT(*) AS c FROM contacts WHERE workspace_id = ?', [ctx.owner.workspaceId]).c, beforeContacts);
  assert.equal(get('SELECT COUNT(*) AS c FROM email_messages WHERE workspace_id = ?', [ctx.owner.workspaceId]).c, 0);
});

test('limits: tool call cap still stops a sixth-plus unique tool loop', async () => {
  const tool = countingToolExecutor();
  const provider = fakeProvider([
    (request, callNumber) => ({
      action: 'call_tool',
      tool: 'company.list',
      reason: `第 ${callNumber} 次工具调用`,
      arguments: { pageSize: Math.min(20, callNumber) },
    }),
  ]);
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '工具数量限制' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_tool_cap' });
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_tool_cap',
    providerOverride: provider,
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'failed');
  assert.equal(tool.state.calls, AGENT_LIMITS.maxToolCalls);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'error' && /模型或工具调用上限/.test(event.error || '')));
});

test('limits: token budget still stops the loop after real tool execution budget is exhausted', async () => {
  const tool = countingToolExecutor();
  let calls = 0;
  const provider = {
    key: 'fake-budget',
    providerKey: 'fake-budget',
    model: 'fake-budget',
    isSimulation: false,
    pricing: { inputPer1k: 0, outputPer1k: 0 },
    async complete() {
      calls += 1;
      return {
        text: JSON.stringify({ action: 'call_tool', tool: 'company.list', reason: '预算测试', arguments: { pageSize: 2 } }),
        usage: { promptTokens: 600, completionTokens: 400, totalTokens: 1000 },
        model: 'fake-budget',
      };
    },
  };
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '预算仍然有效', budgetTokens: 1000 });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_budget' });
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_budget',
    providerOverride: provider,
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
  assert.equal(tool.state.calls, 1);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.ok(events.some((event) => event.type === 'error' && /token 预算/.test(event.error || '')));
});

function insertAgentEvent(taskId, stepNo, type, extra = {}) {
  run(
    `INSERT INTO agent_events
       (id, workspace_id, task_id, step_no, type, tool_name, input_json, output_json, status, error, execution_id, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `evt_test_${taskId}_${stepNo}`,
      ctx.owner.workspaceId,
      taskId,
      stepNo,
      type,
      extra.toolName || null,
      JSON.stringify(extra.input || {}),
      JSON.stringify(extra.output || {}),
      extra.status || 'ok',
      extra.error || null,
      null,
      null,
      new Date().toISOString(),
    ],
  );
}

test('orphan: tool_call without tool_result fails safely without replaying tool', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '孤儿调用测试' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_orphan_a' });
  insertAgentEvent(task.id, 1, 'tool_call', { toolName: 'company.list', input: { pageSize: 2 }, status: 'running' });
  const tool = countingToolExecutor();
  let providerCalls = 0;
  const provider = {
    key: 'fake',
    providerKey: 'fake',
    model: 'fake',
    isSimulation: false,
    pricing: { inputPer1k: 0, outputPer1k: 0 },
    async complete() { providerCalls += 1; throw new Error('orphan must not call model'); },
  };
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_orphan_a',
    providerOverride: provider,
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /AGENT_ORPHANED_TOOL_CALL/);
  assert.equal(providerCalls, 0);
  assert.equal(tool.state.calls, 0);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'failed');
  assert.match(current.error, /AGENT_ORPHANED_TOOL_CALL/);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
  assert.ok(events.some((event) => event.type === 'error' && /AGENT_ORPHANED_TOOL_CALL/.test(event.error || '')));
});

test('orphan: completed tool call + tool result is not replayed or overwritten', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '已有结果恢复测试' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_orphan_b' });
  insertAgentEvent(task.id, 1, 'model_decision', { output: { action: 'call_tool', tool: 'company.list', arguments: { pageSize: 2 } } });
  insertAgentEvent(task.id, 2, 'tool_call', { toolName: 'company.list', input: { pageSize: 2 }, status: 'running' });
  insertAgentEvent(task.id, 3, 'tool_result', { toolName: 'company.list', output: { total: 7, items: [{ name: 'Existing Evidence GmbH' }] }, status: 'ok' });
  const before = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  const tool = countingToolExecutor();
  const provider = fakeProvider([{ action: 'finish', reason: '已有结果', answer: '已使用已持久化的工具结果。' }]);
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_orphan_b',
    providerOverride: provider,
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'completed');
  assert.equal(tool.state.calls, 0, 'persisted tool result must not be replayed');
  const after = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(after.filter((event) => event.type === 'tool_result').length, 1);
  assert.equal(after.filter((event) => event.type === 'tool_call').length, 1);
  assert.deepEqual(after.find((event) => event.type === 'tool_result').output, before.find((event) => event.type === 'tool_result').output);
});

test('orphan: old worker cannot recover or modify a task taken by a new worker', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '孤儿调用旧 worker' });
  const oldToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_orphan_c_old' });
  insertAgentEvent(task.id, 1, 'tool_call', { toolName: 'company.list', input: { pageSize: 2 }, status: 'running' });
  expireTaskLease(task.id);
  const newToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_orphan_c_new' });
  assert.ok(newToken);
  const tool = countingToolExecutor();
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: oldToken,
    jobId: 'job_orphan_c_old',
    providerOverride: fakeProvider([{ action: 'finish', reason: '不应执行', answer: '不应执行' }]),
    toolExecutor: tool.execute,
  });
  assert.equal(result.status, 'stale');
  assert.equal(tool.state.calls, 0);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, newToken);
  assert.equal(current.error, null);
});

test('orphan: repeated recovery is idempotent and does not replay tool or duplicate error state', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '重复恢复' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_orphan_d' });
  insertAgentEvent(task.id, 1, 'tool_call', { toolName: 'company.list', input: { pageSize: 2 }, status: 'running' });
  const tool = countingToolExecutor();
  const first = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_orphan_d', providerOverride: fakeProvider([{ action: 'finish', reason: '不应调用', answer: '不应调用' }]), toolExecutor: tool.execute });
  const second = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_orphan_d', providerOverride: fakeProvider([{ action: 'finish', reason: '不应调用', answer: '不应调用' }]), toolExecutor: tool.execute });
  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'stale');
  assert.equal(tool.state.calls, 0);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'failed');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
});

test('orphan: cancelled task with orphan call stays cancelled and never executes tool', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '取消中的孤儿调用' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_orphan_e' });
  insertAgentEvent(task.id, 1, 'tool_call', { toolName: 'company.list', input: { pageSize: 2 }, status: 'running' });
  cancelTask(ctx.owner.workspaceId, task.id, 'test_cancel_orphan');
  const tool = countingToolExecutor();
  const result = await runAgentTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, runToken: token, jobId: 'job_orphan_e', providerOverride: fakeProvider([{ action: 'finish', reason: '不应调用', answer: '不应调用' }]), toolExecutor: tool.execute });
  assert.equal(result.status, 'cancelled');
  assert.equal(tool.state.calls, 0);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'cancelled');
  assert.equal(current.result.answer, undefined);
});

function createTerminalJob(taskId, status = 'failed') {
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId }, createdBy: ctx.owner.userId });
  run('UPDATE background_jobs SET status = ? WHERE id = ?', [status, job.id]);
  return job.id;
}

test('recovery: expired task lease with terminal job is failed without runAgentTask or tool execution', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '租约过期恢复' });
  const jobId = createTerminalJob(task.id, 'failed');
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId });
  assert.ok(token);
  expireTaskLease(task.id);
  const result = recoverExpiredAgentTasks({ now: new Date().toISOString() });
  assert.ok(result.recovered >= 1, JSON.stringify(result));
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'failed');
  assert.match(current.error, /AGENT_TASK_LEASE_EXPIRED/);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
  assert.equal(events.filter((event) => event.type === 'tool_call').length, 0);
  assert.ok(events.some((event) => event.type === 'error' && /租约|LEASE/.test(event.error || '')));
});

test('recovery: a new worker with a valid lease is not touched by repair scan', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '新 worker 租约保护' });
  const oldToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_recovery_old' });
  assert.ok(oldToken);
  expireTaskLease(task.id);
  const newToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_recovery_new' });
  assert.ok(newToken);
  const result = recoverExpiredAgentTasks({ now: new Date().toISOString() });
  assert.equal(result.recovered, 0);
  assert.ok(result.scanned === 0 || result.skipped >= 1);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, newToken);
  assert.equal(current.error, null);
  assert.equal(listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items.filter((event) => event.type === 'error').length, 0);
});

test('recovery: cancelled and completed tasks are never rewritten', async () => {
  const cancelled = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '取消任务恢复' });
  const cancelledToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: cancelled.id, jobId: 'job_recovery_cancelled' });
  cancelTask(ctx.owner.workspaceId, cancelled.id, 'cancel_before_recovery');
  expireTaskLease(cancelled.id);
  const completed = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '完成任务恢复' });
  const completedToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: completed.id, jobId: 'job_recovery_completed' });
  const completedResult = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: completed.id,
    runToken: completedToken,
    jobId: 'job_recovery_completed',
    providerOverride: fakeProvider([{ action: 'finish', reason: '完成', answer: '已完成' }]),
  });
  assert.equal(completedResult.status, 'completed');
  expireTaskLease(completed.id);
  assert.equal(getTask(ctx.owner.workspaceId, cancelled.id).status, 'cancelled');
  assert.equal(getTask(ctx.owner.workspaceId, completed.id).status, 'completed');
  assert.equal(listEvents(ctx.owner.workspaceId, cancelled.id, { after: 0, limit: 100 }).items.filter((event) => event.type === 'error').length, 0);
  const completedEvents = listEvents(ctx.owner.workspaceId, completed.id, { after: 0, limit: 100 }).items;
  assert.equal(completedEvents.filter((event) => event.type === 'error').length, 0);
  assert.equal(completedEvents.filter((event) => event.type === 'final_answer').length, 1);
  assert.ok(cancelledToken && completedToken);
});

test('recovery: repeated repair is idempotent and creates one diagnostic event', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '重复租约恢复' });
  const jobId = createTerminalJob(task.id, 'dead');
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId });
  assert.ok(token);
  expireTaskLease(task.id);
  const first = recoverExpiredAgentTasks({ now: new Date().toISOString() });
  const second = recoverExpiredAgentTasks({ now: new Date().toISOString() });
  assert.ok(first.recovered >= 1);
  assert.equal(second.recovered, 0);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'failed');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
});

test('recovery: expired task with orphan tool_call becomes diagnosable failure, not replay', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '孤儿租约恢复' });
  const jobId = createTerminalJob(task.id, 'failed');
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId });
  assert.ok(token);
  insertAgentEvent(task.id, 1, 'tool_call', { toolName: 'company.list', input: { pageSize: 2 }, status: 'running' });
  expireTaskLease(task.id);
  const result = recoverExpiredAgentTasks({ now: new Date().toISOString() });
  assert.ok(result.recovered >= 1);
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'failed');
  assert.match(current.error, /AGENT_ORPHANED_TOOL_CALL/);
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
  assert.equal(events.filter((event) => event.type === 'tool_call').length, 1);
  assert.ok(events.some((event) => event.type === 'error' && /AGENT_ORPHANED_TOOL_CALL/.test(event.error || '')));
});

test('recovery: queued job with expired task lease is left for normal claim', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'queued job 不应被提前终止' });
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId: task.id }, createdBy: ctx.owner.userId });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  assert.ok(token);
  expireTaskLease(task.id);
  const before = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items.length;
  const result = recoverExpiredAgentTasks({ now: new Date().toISOString() });
  assert.ok(result.skipped >= 1, JSON.stringify(result));
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, token);
  assert.equal(current.error, null);
  assert.equal(get('SELECT status FROM background_jobs WHERE id = ?', [job.id]).status, 'queued');
  assert.equal(listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items.length, before);
});

test('recovery: queued job can still be claimed after repair scan skips it', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'queued job 后续领取' });
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId: task.id }, createdBy: ctx.owner.userId });
  const oldToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  assert.ok(oldToken);
  expireTaskLease(task.id);
  recoverExpiredAgentTasks({ now: new Date().toISOString() });
  const newToken = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  assert.ok(newToken, 'queued job must be able to reclaim an expired, non-terminal task');
  const result = await runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: newToken,
    jobId: job.id,
    providerOverride: fakeProvider([{ action: 'finish', reason: '后续领取完成', answer: 'queued 任务恢复完成' }]),
  });
  assert.equal(result.status, 'completed');
  assert.equal(getTask(ctx.owner.workspaceId, task.id).status, 'completed');
  assert.ok(listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items.some((event) => event.type === 'final_answer'));
});

test('recovery: repeated scan of queued job remains non-destructive', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: 'queued job 重复扫描' });
  const job = enqueueJob({ workspaceId: ctx.owner.workspaceId, type: 'agent.task', payload: { taskId: task.id }, createdBy: ctx.owner.userId });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: job.id });
  assert.ok(token);
  expireTaskLease(task.id);
  const before = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items.length;
  recoverExpiredAgentTasks({ now: new Date().toISOString() });
  recoverExpiredAgentTasks({ now: new Date().toISOString() });
  const current = getTask(ctx.owner.workspaceId, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.runToken, token);
  assert.equal(get('SELECT status FROM background_jobs WHERE id = ?', [job.id]).status, 'queued');
  assert.equal(listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items.length, before);
});

test('browser cancellation: task cancellation aborts in-flight tool signal and suppresses result events', async () => {
  const task = createAgentTask({ workspaceId: ctx.owner.workspaceId, userId: ctx.owner.userId, goal: '浏览器取消传播' });
  const token = claimTask({ workspaceId: ctx.owner.workspaceId, taskId: task.id, jobId: 'job_browser_cancel' });
  let releaseStarted;
  const started = new Promise((resolve) => { releaseStarted = resolve; });
  let receivedSignal = null;
  const tool = {
    calls: 0,
    async execute({ signal }) {
      tool.calls += 1;
      receivedSignal = signal;
      releaseStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('browser aborted')), { once: true });
      });
    },
  };
  const provider = fakeProvider([
    { action: 'call_tool', tool: 'browser.search', reason: '测试取消', arguments: { query: 'test query', maxResults: 2 } },
  ]);
  const running = runAgentTask({
    workspaceId: ctx.owner.workspaceId,
    taskId: task.id,
    runToken: token,
    jobId: 'job_browser_cancel',
    providerOverride: provider,
    toolExecutor: tool.execute,
  });
  await started;
  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, false);
  cancelTask(ctx.owner.workspaceId, task.id, 'cancel_during_browser_tool');
  const result = await running;
  assert.equal(receivedSignal.aborted, true);
  assert.equal(tool.calls, 1);
  assert.ok(['stale', 'cancelled'].includes(result.status));
  assert.equal(getTask(ctx.owner.workspaceId, task.id).status, 'cancelled');
  const events = listEvents(ctx.owner.workspaceId, task.id, { after: 0, limit: 100 }).items;
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
  assert.equal(events.filter((event) => event.type === 'final_answer').length, 0);
});

test('browser queue: hard timeout quarantines a hung operation and lets the next task run (simulated)', async () => {
  let calls = 0;
  const fakeBrowserSearch = (query) => {
    calls += 1;
    if (query === 'hung') {
      return new Promise((resolve) => setTimeout(() => resolve({ results: [], error: null }), 200));
    }
    return Promise.resolve({ results: [{ title: 'B result', url: 'https://b.example' }], error: null });
  };
  const a = executeReadTool({
    workspaceId: 'wsp_queue_test',
    toolName: 'browser.search',
    args: { query: 'hung', maxResults: 1 },
    browserSearchImpl: fakeBrowserSearch,
    browserHardTimeoutMs: 40,
  }).then((value) => ({ value })).catch((error) => ({ error: error.code || error.message }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const b = executeReadTool({
    workspaceId: 'wsp_queue_test',
    toolName: 'browser.search',
    args: { query: 'healthy', maxResults: 1 },
    browserSearchImpl: fakeBrowserSearch,
    browserHardTimeoutMs: 500,
  }).then((value) => ({ value })).catch((error) => ({ error: error.code || error.message }));
  const [ar, br] = await Promise.all([a, b]);
  assert.equal(ar.error, 'TOOL_QUEUE_TIMEOUT');
  assert.equal(br.value?.result?.results?.[0]?.title, 'B result');
  assert.equal(calls, 2);
});

test('browser startup: cancellation during launch closes the late dedicated browser', async () => {
  let resolveLaunch = null;
  let closeCount = 0;
  const fakeLaunch = () => new Promise((resolve) => {
    resolveLaunch = () => resolve({ close: async () => { closeCount += 1; } });
  });
  const controller = new AbortController();
  const running = browserSearch('startup cancel', {
    dedicated: true,
    signal: controller.signal,
    launchBrowserImpl: fakeLaunch,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  resolveLaunch();
  const result = await running;
  assert.equal(result.error, 'aborted');
  assert.equal(closeCount, 1, 'late launch result must be closed after cancellation');
});
