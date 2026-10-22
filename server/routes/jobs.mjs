/**
 * OWNER: t-worker. Background job API (`/api/v1/jobs`).
 *
 * All reads require `jobs.read`; pause/resume/cancel/retry require
 * `jobs.manage` (admin/owner). Every mutation is audited. Responses only expose
 * the job's own metadata/payload — never credentials.
 */
import { parsePagination, asEnum, asString } from '../core/validate.mjs';
import { badRequest, notFound } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import {
  JOB_TYPES,
  cancelJob,
  getJob,
  getJobStats,
  listJobs,
  pauseAll,
  resumeAll,
  retryJob,
} from '../jobs/queue.mjs';
import { listHandlerTypes } from '../jobs/handlers/index.mjs';

const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead'];

function jobOrThrow(ctx) {
  const jobId = asString(ctx.params.id, { required: true, max: 80, label: '任务 ID' });
  const job = getJob(ctx.workspace.id, jobId);
  if (!job) throw notFound('任务不存在');
  return job;
}

export function mount(router) {
  router.get(
    '/api/v1/jobs',
    async (ctx) => {
      const { page, pageSize } = parsePagination(ctx.query);
      const status = asEnum(ctx.query.get('status'), JOB_STATUSES, { fallback: '' });
      const type = asString(ctx.query.get('type'), { max: 80 });
      const q = asString(ctx.query.get('q'), { max: 80 });
      return listJobs(ctx.workspace.id, { page, pageSize, status: status || '', type, q });
    },
    { auth: 'required', capability: 'jobs.read' },
  );

  // Registered before `/jobs/:id` so `stats` is not treated as an id.
  router.get(
    '/api/v1/jobs/stats',
    async (ctx) => {
      const stats = getJobStats(ctx.workspace.id);
      return { ...stats, types: JOB_TYPES, registeredHandlers: listHandlerTypes() };
    },
    { auth: 'required', capability: 'jobs.read' },
  );

  router.post(
    '/api/v1/jobs/pause',
    async (ctx) => {
      pauseAll(ctx.workspace.id);
      recordAudit({
        workspaceId: ctx.workspace.id,
        actorType: ctx.authType === 'api_key' ? 'api_key' : 'user',
        actorId: ctx.user.id,
        action: 'jobs.pause_all',
        entityType: 'workspace',
        entityId: ctx.workspace.id,
        after: { paused: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return { paused: true, ...getJobStats(ctx.workspace.id) };
    },
    { auth: 'required', capability: 'jobs.manage' },
  );

  router.post(
    '/api/v1/jobs/resume',
    async (ctx) => {
      resumeAll(ctx.workspace.id);
      recordAudit({
        workspaceId: ctx.workspace.id,
        actorType: ctx.authType === 'api_key' ? 'api_key' : 'user',
        actorId: ctx.user.id,
        action: 'jobs.resume_all',
        entityType: 'workspace',
        entityId: ctx.workspace.id,
        after: { paused: false },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return { paused: false, ...getJobStats(ctx.workspace.id) };
    },
    { auth: 'required', capability: 'jobs.manage' },
  );

  router.post(
    '/api/v1/jobs/:id/cancel',
    async (ctx) => {
      const job = jobOrThrow(ctx);
      const reason = asString(ctx.body?.reason, { max: 200 }) || 'cancelled_by_user';
      const result = cancelJob(ctx.workspace.id, job.id, reason);
      recordAudit({
        workspaceId: ctx.workspace.id,
        actorType: ctx.authType === 'api_key' ? 'api_key' : 'user',
        actorId: ctx.user.id,
        action: 'job.cancel',
        entityType: 'background_job',
        entityId: job.id,
        before: { status: job.status, type: job.type },
        after: { ...result, reason },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return { jobId: job.id, ...result };
    },
    { auth: 'required', capability: 'jobs.manage' },
  );

  router.post(
    '/api/v1/jobs/:id/retry',
    async (ctx) => {
      const job = jobOrThrow(ctx);
      const result = retryJob(ctx.workspace.id, job.id);
      if (!result.retried) {
        throw badRequest(`当前任务状态（${result.status}）不可重试，只有失败/取消/死信任务可以重试`);
      }
      recordAudit({
        workspaceId: ctx.workspace.id,
        actorType: ctx.authType === 'api_key' ? 'api_key' : 'user',
        actorId: ctx.user.id,
        action: 'job.retry',
        entityType: 'background_job',
        entityId: job.id,
        before: { status: job.status, type: job.type, attempts: job.attempts },
        after: { status: result.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return { jobId: job.id, ...result };
    },
    { auth: 'required', capability: 'jobs.manage' },
  );

  router.get(
    '/api/v1/jobs/:id',
    async (ctx) => jobOrThrow(ctx),
    { auth: 'required', capability: 'jobs.read' },
  );
}

export default { mount };
