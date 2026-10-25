/**
 * Phase 1 worker handler for read-only Agent tasks.
 *
 * The handler is only a transport boundary: it claims the task, runs the
 * bounded loop, and returns a structured result. It never sends email, writes
 * customer data, or exposes model identity.
 */
import { config } from '../../config.mjs';
import { claimTask, getTask, runAgentTask } from '../../agents/loop.mjs';
import { JobError, requirePayloadField } from './errors.mjs';

async function agentTask({ job, workspaceId, payload, logger }) {
  if (!config.features?.agentLoop) {
    throw new JobError('Agent 模式未启用', { retryable: false, code: 'AGENT_LOOP_DISABLED' });
  }
  const taskId = requirePayloadField(payload, 'taskId');
  const token = claimTask({ workspaceId, taskId, jobId: job.id });
  if (!token) {
    const task = getTask(workspaceId, taskId);
    return { taskId, status: task?.status || 'missing', skipped: true };
  }
  const result = await runAgentTask({
    workspaceId,
    taskId,
    runToken: token,
    jobId: job.id,
    logger,
  });
  return { taskId, ...result };
}

export const handlers = {
  'agent.task': agentTask,
};

export default handlers;
