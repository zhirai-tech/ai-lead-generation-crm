/**
 * Phase 1 read-only Agent task API.
 *
 * All routes are disabled unless AGENT_LOOP_ENABLED=1. Authentication,
 * workspace scoping and capabilities are the existing HTTP framework's job;
 * task/event IDs are always queried with ctx.workspace.id.
 */
import { AppError, notFound } from '../core/errors.mjs';
import { asInt, asString, parsePagination } from '../core/validate.mjs';
import { get, run } from '../core/db.mjs';
import { nowIso } from '../core/time.mjs';
import { config } from '../config.mjs';
import { enqueueJob, cancelJob } from '../jobs/queue.mjs';
import {
  cancelTask,
  createAgentTask,
  getTask,
  listEvents,
  listTasks,
} from '../agents/loop.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const RUN = {
  auth: 'required',
  capability: 'data.read',
  rateLimit: { windowMs: 60_000, max: 5 },
};

function requireAgentLoop() {
  if (!config.features?.agentLoop) {
    throw new AppError('NOT_FOUND', 'Agent 模式未启用', { status: 404 });
  }
}

function taskOrThrow(ctx) {
  const task = getTask(ctx.workspace.id, ctx.params.id);
  if (!task) throw notFound('Agent 任务不存在');
  return task;
}

export function mount(router) {
  router.post(
    '/api/v1/agent/tasks',
    async (ctx) => {
      requireAgentLoop();
      const body = ctx.body || {};
      const goal = asString(body.goal, { required: true, min: 2, max: 4000, label: '任务目标' });
      const budgetTokens = body.budgetTokens === undefined
        ? undefined
        : asInt(body.budgetTokens, { min: 1000, max: 16000, label: 'token 预算' });
      const task = createAgentTask({
        workspaceId: ctx.workspace.id,
        userId: ctx.user?.id || null,
        goal,
        budgetTokens,
      });
      try {
        const job = enqueueJob({
          workspaceId: ctx.workspace.id,
          type: 'agent.task',
          payload: { taskId: task.id },
          dedupeKey: `agent.task:${ctx.workspace.id}:${task.id}`,
          createdBy: ctx.user?.id || null,
          maxAttempts: 2,
          priority: 90,
        });
        run(
          'UPDATE agent_tasks SET job_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
          [job.id, nowIso(), task.id, ctx.workspace.id],
        );
      } catch (error) {
        run(
          "UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
          ['任务入队失败', nowIso(), nowIso(), task.id, ctx.workspace.id],
        );
        throw new AppError('AGENT_ENQUEUE_FAILED', `任务入队失败：${error?.message || '未知错误'}`, { status: 503 });
      }
      return { task: getTask(ctx.workspace.id, task.id) };
    },
    RUN,
  );

  router.get(
    '/api/v1/agent/tasks',
    async (ctx) => {
      requireAgentLoop();
      const { page, pageSize } = parsePagination(ctx.query, { defaultPageSize: 20, maxPageSize: 50 });
      return listTasks(ctx.workspace.id, { page, pageSize });
    },
    READ,
  );

  router.get(
    '/api/v1/agent/tasks/:id/events',
    async (ctx) => {
      requireAgentLoop();
      taskOrThrow(ctx);
      const after = Number(ctx.query.get('after') || 0);
      const limit = Math.max(1, Math.min(200, Number(ctx.query.get('limit') || 100)));
      return listEvents(ctx.workspace.id, ctx.params.id, { after: Number.isFinite(after) ? after : 0, limit });
    },
    READ,
  );

  router.get(
    '/api/v1/agent/tasks/:id',
    async (ctx) => {
      requireAgentLoop();
      return { task: taskOrThrow(ctx) };
    },
    READ,
  );

  router.post(
    '/api/v1/agent/tasks/:id/cancel',
    async (ctx) => {
      requireAgentLoop();
      const task = taskOrThrow(ctx);
      const cancelled = cancelTask(ctx.workspace.id, task.id, 'cancelled_by_user');
      if (task.jobId) {
        try { cancelJob(ctx.workspace.id, task.jobId, 'cancelled_by_user'); } catch { /* task state already wins */ }
      }
      return { task: getTask(ctx.workspace.id, task.id), cancelled };
    },
    RUN,
  );
}

export default { mount };
