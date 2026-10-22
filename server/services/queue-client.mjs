/**
 * OWNER: t-crm.
 *
 * Queue bridge (queue implementation owner: t-worker). The CRM domain only
 * enqueues jobs and cancels per-company jobs; it never executes them. While the
 * worker queue is still a stub (or during partial deployments) enqueue failures
 * are reported to the caller instead of breaking the user-facing action.
 */
import { enqueueJob, cancelJobsForCompany } from '../jobs/queue.mjs';

function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function';
}

/**
 * Safely enqueue a background job.
 * @returns {Promise<{queued:boolean, jobId:string|null, deduped:boolean, error:string|null}>}
 */
export async function enqueueJobSafe(params) {
  try {
    const result = enqueueJob(params);
    const resolved = isThenable(result) ? await result : result;
    return {
      queued: true,
      jobId: resolved?.id ?? resolved?.jobId ?? null,
      deduped: Boolean(resolved?.deduped),
      error: null,
    };
  } catch (error) {
    return { queued: false, jobId: null, deduped: false, error: String(error?.message || error) };
  }
}

/**
 * Safely cancel all pending jobs for a company. Cancellation is best-effort in
 * the sense that it never throws; the automation state itself is the source of
 * truth and every send pipeline re-checks it.
 */
export function cancelCompanyJobsSafe(workspaceId, companyId, reason) {
  try {
    const result = cancelJobsForCompany(workspaceId, companyId, reason);
    if (isThenable(result)) {
      result.catch(() => {});
      return 0;
    }
    return Number(result) || 0;
  } catch {
    return 0;
  }
}
