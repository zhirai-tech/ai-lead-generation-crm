/**
 * Phase 1 bounded read-only Agent loop.
 *
 * The loop is deliberately small:
 *   model action -> server validation -> real read-only tool -> persisted result
 *   -> next model action -> ... -> finish or hard limit.
 *
 * It never executes a write tool, never trusts model-provided identity, and
 * never treats model prose as evidence. Every model decision and tool result is
 * persisted before the next step.
 */
import { all, get, run, tx } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { isCancelRequested } from '../jobs/queue.mjs';
import { runAgent } from './index.mjs';
import { executeReadTool, listReadTools, ToolValidationError } from './tool-registry.mjs';

export const AGENT_TASK_STATUSES = Object.freeze(['queued', 'running', 'waiting_user', 'completed', 'failed', 'cancelled']);
export const AGENT_EVENT_TYPES = Object.freeze(['model_decision', 'tool_call', 'tool_result', 'error', 'final_answer', 'status']);
export const AGENT_LIMITS = Object.freeze({
  // This is a recorded-event-step cap, not a model-round cap. Model rounds and
  // tool calls have independent caps below. One tool round creates three
  // events (model_decision + tool_call + tool_result), so 24 allows the
  // maximum six tool calls plus their decisions and a final answer.
  maxSteps: 24,
  maxModelCalls: 8,
  maxToolCalls: 6,
  maxWallMs: 120000,
  maxTokens: 16000,
  maxHistoryEvents: 10,
  maxSameAction: 1,
});

const TASK_COLUMNS = 'id, workspace_id, user_id, goal, mode, status, step_count, model_calls, tool_calls, budget_tokens, run_token, run_lease_until, job_id, result_json, error, created_at, updated_at, finished_at';

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    goal: row.goal,
    mode: row.mode,
    status: row.status,
    stepCount: Number(row.step_count || 0),
    modelCalls: Number(row.model_calls || 0),
    toolCalls: Number(row.tool_calls || 0),
    budgetTokens: Number(row.budget_tokens || AGENT_LIMITS.maxTokens),
    runToken: row.run_token || null,
    jobId: row.job_id || null,
    result: safeJson(row.result_json, {}),
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    stepNo: Number(row.step_no || 0),
    type: row.type,
    toolName: row.tool_name || null,
    input: safeJson(row.input_json, {}),
    output: safeJson(row.output_json, {}),
    status: row.status,
    error: row.error || null,
    executionId: row.execution_id || null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    createdAt: row.created_at,
  };
}

function safeJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function cappedJson(value, max = 12000) {
  let text;
  try { text = JSON.stringify(value ?? null); } catch { return { truncated: true, note: '无法序列化' }; }
  if (text.length <= max) return value ?? null;
  return { truncated: true, note: `结果超过 ${max} 字符，已截断`, preview: text.slice(0, max) };
}

export function createAgentTask({ workspaceId, userId, goal, budgetTokens = AGENT_LIMITS.maxTokens }) {
  const taskId = id('agt');
  const now = nowIso();
  run(
    `INSERT INTO agent_tasks
       (id, workspace_id, user_id, goal, mode, status, step_count, model_calls, tool_calls,
        budget_tokens, run_token, job_id, result_json, error, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, 'read_only', 'queued', 0, 0, 0, ?, NULL, NULL, '{}', NULL, ?, ?, NULL)`,
    [taskId, workspaceId, userId || null, String(goal).slice(0, 4000), Math.max(1000, Math.min(AGENT_LIMITS.maxTokens, Number(budgetTokens) || AGENT_LIMITS.maxTokens)), now, now],
  );
  return getTask(workspaceId, taskId);
}

export function getTask(workspaceId, taskId) {
  return mapTask(get(`SELECT ${TASK_COLUMNS} FROM agent_tasks WHERE workspace_id = ? AND id = ?`, [workspaceId, taskId]));
}

export function listTasks(workspaceId, { page = 1, pageSize = 20 } = {}) {
  const limit = Math.max(1, Math.min(50, Number(pageSize) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const total = Number(get('SELECT COUNT(*) AS c FROM agent_tasks WHERE workspace_id = ?', [workspaceId])?.c || 0);
  const rows = all(`SELECT ${TASK_COLUMNS} FROM agent_tasks WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`, [workspaceId, limit, offset]);
  return { items: rows.map(mapTask), total, page: Math.max(1, Number(page) || 1), pageSize: limit };
}

export function listEvents(workspaceId, taskId, { after = 0, limit = 100 } = {}) {
  const task = getTask(workspaceId, taskId);
  if (!task) return null;
  const rows = all(
    `SELECT * FROM agent_events
      WHERE workspace_id = ? AND task_id = ? AND step_no > ?
      ORDER BY step_no ASC LIMIT ?`,
    [workspaceId, taskId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(200, Number(limit) || 100))],
  );
  return { task, items: rows.map(mapEvent) };
}

function nextStep(taskId) {
  return Number(get('SELECT COALESCE(MAX(step_no), 0) AS n FROM agent_events WHERE task_id = ?', [taskId])?.n || 0) + 1;
}

function isActive(taskId, workspaceId, token) {
  const row = get(
    'SELECT status, run_token, run_lease_until FROM agent_tasks WHERE id = ? AND workspace_id = ?',
    [taskId, workspaceId],
  );
  if (!row || row.status !== 'running' || row.run_token !== token) return false;
  const leaseUntil = row.run_lease_until ? new Date(row.run_lease_until).getTime() : NaN;
  return Number.isFinite(leaseUntil) && leaseUntil > Date.now();
}

/**
 * Execution authority is checked immediately before any tool is executed.
 * A model call can take seconds; during that window the task may have been
 * cancelled, its lease may have expired, or a new worker may have claimed it.
 * The task lease is the task-level authority; the background-job lease remains
 * the worker transport lease and is not used to extend the task lease.
 */
function hasExecutionAuthority(taskId, workspaceId, token, jobId) {
  if (!jobId) return false;
  if (!isActive(taskId, workspaceId, token)) return false;
  if (isCancelRequested(jobId)) return false;
  return true;
}

function appendEvent({ workspaceId, taskId, token, type, toolName = null, input = {}, output = {}, status = 'ok', error = null, executionId = null, durationMs = null }) {
  if (token && !isActive(taskId, workspaceId, token)) return null;
  const stepNo = nextStep(taskId);
  const eventId = id('agev');
  try {
    run(
      `INSERT INTO agent_events
         (id, workspace_id, task_id, step_no, type, tool_name, input_json, output_json, status, error, execution_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, workspaceId, taskId, stepNo, type, toolName, JSON.stringify(cappedJson(input)), JSON.stringify(cappedJson(output)), status, error ? String(error).slice(0, 2000) : null, executionId, durationMs, nowIso()],
    );
  } catch (cause) {
    // A duplicate step number is a sign of two workers racing; stop this loop.
    return null;
  }
  run('UPDATE agent_tasks SET step_count = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [stepNo, nowIso(), taskId, workspaceId]);
  return stepNo;
}

function updateActiveTask(taskId, workspaceId, token, patch) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  fields.push('updated_at = ?');
  params.push(nowIso());
  fields.push('run_lease_until = ?');
  params.push(new Date(Date.now() + 120000).toISOString());
  params.push(taskId, workspaceId, token);
  return run(
    `UPDATE agent_tasks SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ? AND status = 'running' AND run_token = ?`,
    params,
  ).changes > 0;
}

export function claimTask({ workspaceId, taskId, userId = null, jobId = null }) {
  const token = id('run');
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + 120000).toISOString();
  const changed = run(
    `UPDATE agent_tasks
        SET status = 'running', run_token = ?, run_lease_until = ?, job_id = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
        AND (status = 'queued'
          OR (status = 'running' AND (run_lease_until IS NULL OR run_lease_until < ?)))`,
    [token, leaseUntil, jobId, now, taskId, workspaceId, now],
  ).changes;
  if (!changed) return null;
  const task = getTask(workspaceId, taskId);
  if (!task || (task.userId && userId && task.userId !== userId)) return null;
  return token;
}

export function cancelTask(workspaceId, taskId, reason = 'cancelled_by_user') {
  const now = nowIso();
  const changed = run(
    `UPDATE agent_tasks
        SET status = 'cancelled', error = ?, updated_at = ?, finished_at = ?, run_lease_until = NULL
      WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'waiting_user')`,
    [String(reason).slice(0, 500), now, now, taskId, workspaceId],
  ).changes;
  if (changed) {
    appendEvent({ workspaceId, taskId, type: 'status', status: 'cancelled', output: { status: 'cancelled', reason } });
  }
  return changed > 0;
}

function compactEvent(event) {
  return {
    stepNo: event.stepNo,
    type: event.type,
    toolName: event.toolName,
    status: event.status,
    input: event.input,
    output: event.output,
    error: event.error,
  };
}

function resultSummary(result) {
  if (!result || typeof result !== 'object') return result;
  return result.result && typeof result.result === 'object' ? result.result : result;
}

function isSameAction(previousAction, nextAction) {
  if (!previousAction || !nextAction) return false;
  return previousAction.tool === nextAction.tool
    && JSON.stringify(previousAction.arguments || {}) === JSON.stringify(nextAction.arguments || {});
}

/**
 * A tool_call must be followed immediately by its tool_result. If it is not,
 * the worker may have crashed after persisting the call but before persisting
 * the result. We cannot know whether the external tool ran, so recovery must
 * never replay it; it must move the task to a diagnosable failed state.
 */
function findOrphanedToolCall(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== 'tool_call') continue;
    const next = events[index + 1];
    if (!next || next.type !== 'tool_result') return event;
    if (event.toolName && next.toolName && event.toolName !== next.toolName) return event;
  }
  return null;
}

function orphanedToolCallMessage(event) {
  return `AGENT_ORPHANED_TOOL_CALL: 工具 ${event.toolName || 'unknown'} 的调用记录存在，但没有可确认的执行结果；为避免重复执行，任务已中断`;
}

const LEASE_EXPIRED_MESSAGE = 'AGENT_TASK_LEASE_EXPIRED: 任务租约已过期且没有有效执行者；为避免重复执行工具，任务已中断';

/**
 * Recover Agent tasks whose task lease expired without a live executor.
 *
 * This is called by the existing worker tick, not by a new scheduler. It never
 * replays a tool: if the last tool_call has no result, the existing orphan rule
 * applies; otherwise the task is failed with an explicit lease-expired reason.
 * A queued job is left to the normal queue; a running job with a live lease is
 * left to its worker. Terminal/missing jobs and expired job leases are treated
 * as no valid executor.
 */
export function recoverExpiredAgentTasks({ now = nowIso(), limit = 50 } = {}) {
  const at = now;
  const rows = all(
    `SELECT ${TASK_COLUMNS} FROM agent_tasks
      WHERE status = 'running'
        AND (run_lease_until IS NULL OR run_lease_until < ?)
      ORDER BY created_at ASC LIMIT ?`,
    [at, Math.max(1, Math.min(200, Number(limit) || 50))],
  );
  let recovered = 0;
  let skipped = 0;
  for (const row of rows) {
    const job = row.job_id
      ? get('SELECT status, lease_until FROM background_jobs WHERE workspace_id = ? AND id = ?', [row.workspace_id, row.job_id])
      : null;
    // A queued job is still claimable; expiry of the previous task lease does
    // not make the task invalid. Leave it for the normal queue claim, which
    // will re-check token/lease/cancel before doing any work. A running job
    // with a live lease also has its own executor.
    if (job && job.status === 'queued') { skipped += 1; continue; }
    if (job && job.status === 'running' && job.lease_until && job.lease_until > at) { skipped += 1; continue; }
    const events = listEvents(row.workspace_id, row.id, { after: 0, limit: 200 })?.items || [];
    const orphan = findOrphanedToolCall(events);
    const message = orphan ? orphanedToolCallMessage(orphan) : LEASE_EXPIRED_MESSAGE;
    const changed = tx(() => {
      const updated = run(
        `UPDATE agent_tasks
            SET status = 'failed', error = ?, updated_at = ?, finished_at = ?, run_lease_until = NULL
          WHERE id = ? AND workspace_id = ? AND status = 'running'
            AND (run_lease_until IS NULL OR run_lease_until < ?)`,
        [message, at, at, row.id, row.workspace_id, at],
      ).changes;
      if (!updated) return false;
      const stepNo = nextStep(row.id);
      run(
        `INSERT INTO agent_events
           (id, workspace_id, task_id, step_no, type, tool_name, input_json, output_json, status, error, execution_id, duration_ms, created_at)
         VALUES (?, ?, ?, ?, 'error', ?, '{}', ?, 'failed', ?, NULL, NULL, ?)`,
        [
          id('agev'),
          row.workspace_id,
          row.id,
          stepNo,
          orphan?.toolName || null,
          JSON.stringify(orphan
            ? { code: 'AGENT_ORPHANED_TOOL_CALL', tool: orphan.toolName || null, stepNo: orphan.stepNo }
            : { code: 'AGENT_TASK_LEASE_EXPIRED' }),
          message,
          at,
        ],
      );
      run('UPDATE agent_tasks SET step_count = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [stepNo, at, row.id, row.workspace_id]);
      return true;
    });
    if (changed) recovered += 1;
    else skipped += 1;
  }
  return { recovered, skipped, scanned: rows.length };
}

/**
 * Run one claimed task. providerOverride exists only for deterministic tests.
 * Production calls provider resolution through runAgent.
 */
export async function runAgentTask({ workspaceId, taskId, runToken, jobId = null, userId = null, providerOverride = null, toolExecutor = null, logger = null }) {
  if (!jobId) {
    return { status: 'invalid', taskId, error: 'jobId is required for Agent task execution authority' };
  }
  const task = getTask(workspaceId, taskId);
  if (!task) return { status: 'missing', taskId };
  if (task.status === 'cancelled') return { status: 'cancelled', taskId };
  if (task.status !== 'running' || task.runToken !== runToken) return { status: 'stale', taskId };

  const allEvents = listEvents(workspaceId, taskId, { after: 0, limit: 200 })?.items || [];
  const orphan = findOrphanedToolCall(allEvents);
  if (orphan) {
    if (!isActive(taskId, workspaceId, runToken)) return { status: 'stale', taskId };
    if (isCancelRequested(jobId)) return { status: 'cancelled', taskId };
    const message = orphanedToolCallMessage(orphan);
    const eventStep = appendEvent({
      workspaceId,
      taskId,
      token: runToken,
      type: 'error',
      status: 'failed',
      error: message,
      output: { code: 'AGENT_ORPHANED_TOOL_CALL', tool: orphan.toolName || null, stepNo: orphan.stepNo },
    });
    if (!eventStep) return { status: 'stale', taskId };
    const updated = updateActiveTask(taskId, workspaceId, runToken, {
      status: 'failed',
      error: message,
      finished_at: nowIso(),
    });
    if (!updated) return { status: 'stale', taskId };
    return { status: 'failed', taskId, error: message };
  }

  const startedAt = Date.now();
  let modelCalls = Number(task.modelCalls || 0);
  let toolCalls = Number(task.toolCalls || 0);
  let lastAction = null;
  let consecutiveToolErrors = 0;
  let finalAnswer = '';
  let lastStatus = 'running';
  let tokensUsed = 0;
  const seenActions = new Set();

  const recent = (listEvents(workspaceId, taskId, { after: 0, limit: 200 })?.items || []).slice(-AGENT_LIMITS.maxHistoryEvents);
  let lastToolResult = null;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].type === 'tool_result') {
      lastToolResult = { tool: recent[index].toolName, result: recent[index].output };
      break;
    }
  }
  for (const event of recent) {
    if (event.type === 'tool_call') {
      const actionKey = `${event.toolName}:${JSON.stringify(event.input || {})}`;
      seenActions.add(actionKey);
      lastAction = { tool: event.toolName, arguments: event.input || {} };
    }
  }

  try {
    while (true) {
      if (!isActive(taskId, workspaceId, runToken)) {
        lastStatus = 'stale';
        break;
      }
      if (Date.now() - startedAt > AGENT_LIMITS.maxWallMs) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '任务超过最大执行时长' });
        break;
      }
      const currentStep = Number(get('SELECT COALESCE(MAX(step_no), 0) AS n FROM agent_events WHERE task_id = ?', [taskId])?.n || 0);
      if (currentStep >= AGENT_LIMITS.maxSteps) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '达到最大执行步骤' });
        break;
      }
      if (tokensUsed >= Number(task.budgetTokens || AGENT_LIMITS.maxTokens)) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '达到任务 token 预算' });
        break;
      }
      if (modelCalls >= AGENT_LIMITS.maxModelCalls || toolCalls >= AGENT_LIMITS.maxToolCalls) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '达到模型或工具调用上限' });
        break;
      }
      if (jobId && isCancelRequested(jobId)) {
        lastStatus = 'cancelled';
        break;
      }

      const modelStarted = Date.now();
      const history = (listEvents(workspaceId, taskId, { after: 0, limit: 200 })?.items || [])
        .slice(-AGENT_LIMITS.maxHistoryEvents)
        .map(compactEvent);
      const input = {
        goal: task.goal,
        toolCatalog: listReadTools(),
        history,
        lastToolResult,
        limits: {
          maxSteps: AGENT_LIMITS.maxSteps,
          maxToolCalls: AGENT_LIMITS.maxToolCalls,
          maxModelCalls: AGENT_LIMITS.maxModelCalls,
          maxTokens: task.budgetTokens,
        },
      };

      const decision = await runAgent({
        workspaceId,
        role: 'tool_agent',
        input,
        actorType: 'user',
        actorId: userId || task.userId || null,
        jobId,
        createdBy: userId || task.userId || null,
        provider: providerOverride || undefined,
      });
      // Re-check authority after the model call, before recording a decision or
      // executing any tool. A stale worker must not touch the new worker's task.
      if (!hasExecutionAuthority(taskId, workspaceId, runToken, jobId)) {
        lastStatus = jobId && isCancelRequested(jobId) ? 'cancelled' : 'stale';
        break;
      }
      modelCalls += 1;
      tokensUsed += Number(decision?.usage?.totalTokens || 0);
      updateActiveTask(taskId, workspaceId, runToken, { model_calls: modelCalls });
      const output = decision.output || {};
      appendEvent({
        workspaceId,
        taskId,
        token: runToken,
        type: 'model_decision',
        input: { goal: task.goal, history: input.history, lastToolResult: input.lastToolResult },
        output,
        status: 'ok',
        executionId: decision.executionId,
        durationMs: Date.now() - modelStarted,
      });

      if (output.action === 'finish') {
        finalAnswer = String(output.answer || '').trim();
        if (!finalAnswer) {
          lastStatus = 'failed';
          appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '模型选择结束但没有给出答案' });
          break;
        }
        appendEvent({
          workspaceId,
          taskId,
          token: runToken,
          type: 'final_answer',
          output: { answer: finalAnswer, reason: output.reason || '' },
          status: 'ok',
        });
        updateActiveTask(taskId, workspaceId, runToken, {
          status: 'completed',
          result_json: JSON.stringify({ answer: finalAnswer, reason: output.reason || '' }),
          finished_at: nowIso(),
        });
        lastStatus = 'completed';
        return { status: 'completed', taskId, answer: finalAnswer, modelCalls, toolCalls };
      }

      if (output.action !== 'call_tool') {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: `非法 action：${String(output.action || '')}` });
        break;
      }

      const toolName = String(output.tool || '');
      if (!listReadTools().some((tool) => tool.name === toolName)) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: `工具不在白名单：${toolName}` });
        break;
      }
      const action = { tool: toolName, arguments: output.arguments || {} };
      const actionKey = `${toolName}:${JSON.stringify(action.arguments)}`;
      if (lastAction && isSameAction(lastAction, action)) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '检测到相同工具和参数的重复调用，任务停止' });
        break;
      }
      if (seenActions.has(actionKey)) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '检测到历史重复工具调用，任务停止' });
        break;
      }
      seenActions.add(actionKey);
      lastAction = action;
      // The tool_call event and the actual execution must both be gated by
      // authority; the token may have changed after the model decision.
      if (!hasExecutionAuthority(taskId, workspaceId, runToken, jobId)) {
        lastStatus = jobId && isCancelRequested(jobId) ? 'cancelled' : 'stale';
        break;
      }
      toolCalls += 1;
      updateActiveTask(taskId, workspaceId, runToken, { tool_calls: toolCalls });
      appendEvent({
        workspaceId,
        taskId,
        token: runToken,
        type: 'tool_call',
        toolName,
        input: action.arguments,
        status: 'running',
      });

      const toolStarted = Date.now();
      let toolOutput;
      let toolError = null;
      let toolAbortTimer = null;
      const toolController = new AbortController();
      if (!hasExecutionAuthority(taskId, workspaceId, runToken, jobId)) {
        lastStatus = isCancelRequested(jobId) ? 'cancelled' : 'stale';
        break;
      }
      // Cancellation/lease loss must reach an in-flight browser operation, not
      // only be noticed after it returns.
      if (toolName === 'browser.search') {
        toolAbortTimer = setInterval(() => {
          if (!hasExecutionAuthority(taskId, workspaceId, runToken, jobId)) {
            try { toolController.abort(); } catch { /* best effort */ }
          }
        }, 250);
      }
      try {
        toolOutput = await (toolExecutor || executeReadTool)({
          workspaceId,
          toolName,
          args: action.arguments,
          signal: toolController.signal,
        });
        consecutiveToolErrors = 0;
      } catch (error) {
        toolError = error;
        consecutiveToolErrors += 1;
        toolOutput = { error: String(error?.message || error), code: error?.code || 'TOOL_ERROR' };
      } finally {
        if (toolAbortTimer) clearInterval(toolAbortTimer);
        if (!toolController.signal.aborted) {
          try { toolController.abort(); } catch { /* best effort */ }
        }
      }
      // The tool may have been running while authority changed. It cannot be
      // rolled back, but the stale worker must not persist results or advance
      // the task once it no longer owns the execution.
      if (!hasExecutionAuthority(taskId, workspaceId, runToken, jobId)) {
        lastStatus = isCancelRequested(jobId) ? 'cancelled' : 'stale';
        break;
      }
      appendEvent({
        workspaceId,
        taskId,
        token: runToken,
        type: 'tool_result',
        toolName,
        output: toolError ? { error: toolOutput } : resultSummary(toolOutput),
        status: toolError ? 'error' : 'ok',
        error: toolError ? String(toolError.message || toolError) : null,
        durationMs: Date.now() - toolStarted,
      });
      lastToolResult = { tool: toolName, result: toolError ? toolOutput : (toolOutput?.result ?? toolOutput) };
      if (toolError && consecutiveToolErrors >= 2) {
        lastStatus = 'failed';
        appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: '连续两次工具调用失败，任务停止' });
        break;
      }
    }

    if (lastStatus === 'cancelled') {
      updateActiveTask(taskId, workspaceId, runToken, { status: 'cancelled', finished_at: nowIso() });
    } else if (lastStatus === 'failed') {
      updateActiveTask(taskId, workspaceId, runToken, {
        status: 'failed',
        error: 'Agent 任务失败，详见 agent_events',
        finished_at: nowIso(),
      });
    }
    return { status: lastStatus, taskId, modelCalls, toolCalls, answer: finalAnswer };
  } catch (error) {
    const code = error?.code || 'AGENT_LOOP_ERROR';
    appendEvent({ workspaceId, taskId, token: runToken, type: 'error', status: 'failed', error: `${code}: ${String(error?.message || error)}` });
    updateActiveTask(taskId, workspaceId, runToken, {
      status: 'failed',
      error: `${code}: ${String(error?.message || error).slice(0, 1000)}`,
      finished_at: nowIso(),
    });
    if (logger) logger.error('agent task failed', { taskId, error: String(error?.message || error).slice(0, 500) });
    return { status: 'failed', taskId, error: String(error?.message || error) };
  }
}

export default {
  AGENT_LIMITS,
  createAgentTask,
  getTask,
  listTasks,
  listEvents,
  claimTask,
  cancelTask,
  recoverExpiredAgentTasks,
  runAgentTask,
};
