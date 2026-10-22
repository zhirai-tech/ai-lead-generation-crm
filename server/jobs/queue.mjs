/**
 * OWNER: t-worker. Durable background job queue backed by SQLite.
 *
 * Design notes
 * - One shared SQLite connection (node:sqlite) is used by the whole process.
 *   `claimNextJob` runs inside `BEGIN IMMEDIATE`, so two workers/processes can
 *   never claim the same row.
 * - A lease (`lease_until`, default 120s) makes crash recovery deterministic:
 *   the worker requeues expired leases on its next tick.
 * - `dedupe_key` is a partial unique index. Enqueue is idempotent: when a job
 *   with the same key already exists the existing id is returned with
 *   `deduped: true` and no second job is created.
 * - Cancelling a *running* job cannot interrupt JS synchronously, so a cancel
 *   intent is stored in `result_json` and handlers poll `isCancelRequested()`
 *   between side effects. Queued jobs are cancelled immediately.
 * - Payloads must be small (<= 64 KiB serialised) and are always objects.
 */
import { all, get, json, parseJson, run, tx, upsertSetting } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { addMs, nowIso } from '../core/time.mjs';
import { validationError } from '../core/errors.mjs';
import { escapeLike } from '../core/validate.mjs';

export const JOB_TYPES = Object.freeze([
  'discovery.search',
  'company.crawl',
  'company.enrich',
  'contact.verify',
  'lead.score',
  'draft.generate',
  'email.send',
  'email.sync',
  'reply.classify',
  'followup.plan',
  'campaign.tick',
  'maintenance.retention',
]);

export const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled', 'dead']);

export const LEASE_SECONDS = 120;
export const PAYLOAD_MAX_BYTES = 64 * 1024;
export const PAUSE_SETTING_KEY = 'jobs.globalPaused';
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 3600;
const ERROR_MAX_LENGTH = 2000;

function clampInt(value, { fallback, min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) throw validationError(`${label}必须是整数`);
  return Math.min(max, Math.max(min, number));
}

function assertWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw validationError('workspaceId 不能为空');
  }
  return workspaceId;
}

function assertJobType(type) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{1,30}(\.[a-z][a-z0-9_]{1,30})+$/.test(type)) {
    throw validationError('任务类型不合法');
  }
  if (type.length > 80) throw validationError('任务类型过长');
  return type;
}

function normalizePayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw validationError('任务 payload 必须是对象');
  }
  let serialised;
  try {
    serialised = JSON.stringify(payload);
  } catch {
    throw validationError('任务 payload 无法序列化');
  }
  if (Buffer.byteLength(serialised, 'utf8') > PAYLOAD_MAX_BYTES) {
    throw validationError(`任务 payload 不能超过 ${Math.floor(PAYLOAD_MAX_BYTES / 1024)}KB`);
  }
  return payload;
}

function truncateError(error) {
  const message =
    error && typeof error === 'object'
      ? String(error.message || error.code || '').trim() || String(error)
      : String(error ?? '');
  return message.slice(0, ERROR_MAX_LENGTH);
}

/** Map a `background_jobs` row to the internal/public camelCase job shape. */
export function mapJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    leaseUntil: row.lease_until,
    workerId: row.worker_id,
    dedupeKey: row.dedupe_key,
    lastError: row.last_error,
    result: parseJson(row.result_json, {}),
    costEstimate: row.cost_estimate,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Re-arm a terminal job that shares a dedupe key. Reusing the same row keeps
 * `dedupe_key` globally unique while letting callers (e.g. "send this draft"
 * after a failed attempt) enqueue the same logical intent again.
 */
function reviveTerminalJob(row) {
  if (!row || !['failed', 'dead', 'cancelled'].includes(row.status)) return null;
  const now = nowIso();
  const updated = run(
    `UPDATE background_jobs
        SET status = 'queued', attempts = 0, run_at = ?, started_at = NULL, finished_at = NULL,
            lease_until = NULL, worker_id = NULL, last_error = NULL, result_json = '{}', updated_at = ?
      WHERE id = ? AND status = ?`,
    [now, now, row.id, row.status],
  );
  return updated.changes > 0 ? { id: row.id, deduped: false, requeued: true } : null;
}

/**
 * Enqueue a job. Idempotent when `dedupeKey` is supplied.
 * @returns {{id: string, deduped: boolean, requeued?: boolean}}
 */
export function enqueueJob({
  workspaceId,
  type,
  payload = {},
  dedupeKey = null,
  runAt = null,
  priority = 100,
  maxAttempts = 3,
  createdBy = null,
} = {}) {
  assertWorkspaceId(workspaceId);
  assertJobType(type);
  const safePayload = normalizePayload(payload);
  const priorityValue = clampInt(priority, { fallback: 100, min: 0, max: 1000, label: '任务优先级' });
  const attemptsLimit = clampInt(maxAttempts, { fallback: 3, min: 1, max: 10, label: '最大尝试次数' });
  const now = nowIso();
  let runAtValue = now;
  if (runAt) {
    const parsed = new Date(runAt);
    if (Number.isNaN(parsed.getTime())) throw validationError('runAt 不是合法时间');
    runAtValue = parsed.toISOString();
  }
  let key = null;
  if (dedupeKey !== undefined && dedupeKey !== null && dedupeKey !== '') {
    if (typeof dedupeKey !== 'string' || dedupeKey.length > 200) throw validationError('dedupeKey 不合法');
    key = dedupeKey.trim();
  }

  if (key) {
    const existing = get('SELECT id, status FROM background_jobs WHERE dedupe_key = ?', [key]);
    if (existing) {
      const revived = reviveTerminalJob(existing);
      if (revived) return revived;
      return { id: existing.id, deduped: true };
    }
  }

  const jobId = id('job');
  try {
    run(
      `INSERT INTO background_jobs
         (id, workspace_id, type, payload_json, status, priority, attempts, max_attempts, run_at,
          dedupe_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?)`,
      [jobId, workspaceId, type, json(safePayload, '{}'), priorityValue, attemptsLimit, runAtValue, key, createdBy, now, now],
    );
  } catch (error) {
    // Lost a race on the partial unique index: return the winner (idempotent).
    if (key && /UNIQUE constraint failed/i.test(String(error && error.message))) {
      const existing = get('SELECT id, status FROM background_jobs WHERE dedupe_key = ?', [key]);
      if (existing) {
        const revived = reviveTerminalJob(existing);
        if (revived) return revived;
        return { id: existing.id, deduped: true };
      }
    }
    throw error;
  }
  return { id: jobId, deduped: false };
}

/**
 * Atomically claim the next due job. Ordering: priority ASC (lower number =
 * more important), then run_at, then created_at. Paused workspaces are skipped.
 * @returns {object|null} claimed job
 */
export function claimNextJob(workerId, { now = null, workspaceId = null, leaseSeconds = LEASE_SECONDS } = {}) {
  if (typeof workerId !== 'string' || !workerId.trim()) throw new Error('workerId is required');
  const at = now || nowIso();
  const leaseUntil = addMs(Math.max(5, leaseSeconds) * 1000, new Date(at).getTime());
  const scope = workspaceId ? 'AND workspace_id = ?' : '';
  const scopeParams = workspaceId ? [workspaceId] : [];

  return tx(() => {
    const row = get(
      `SELECT * FROM background_jobs
        WHERE status = 'queued'
          AND run_at <= ?
          ${scope}
          AND NOT EXISTS (
            SELECT 1 FROM settings s
             WHERE s.workspace_id = background_jobs.workspace_id
               AND s.key = ?
               AND s.value_json = 'true'
          )
        ORDER BY priority ASC, run_at ASC, created_at ASC
        LIMIT 1`,
      [at, ...scopeParams, PAUSE_SETTING_KEY],
    );
    if (!row) return null;
    const updated = run(
      `UPDATE background_jobs
          SET status = 'running', attempts = attempts + 1, started_at = ?, lease_until = ?,
              worker_id = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'`,
      [at, leaseUntil, workerId, at, row.id],
    );
    if (updated.changes !== 1) return null;
    return mapJobRow(get('SELECT * FROM background_jobs WHERE id = ?', [row.id]));
  });
}

/** Mark a running job succeeded. Returns false when it is no longer running. */
export function completeJob(jobId, { result = {} } = {}) {
  if (!jobId) throw new Error('jobId is required');
  const now = nowIso();
  const updated = run(
    `UPDATE background_jobs
        SET status = 'succeeded', finished_at = ?, lease_until = NULL, worker_id = NULL,
            last_error = NULL, result_json = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [now, json(result && typeof result === 'object' ? result : { value: result }, '{}'), now, jobId],
  );
  return updated.changes > 0;
}

/**
 * Mark a job failed. Retryable failures become `queued` again with exponential
 * backoff while attempts remain, otherwise the job becomes `dead`. Permanent
 * (non-retryable) failures become `failed` immediately.
 * @returns {{status: string, attempts: number, runAt: string|null}}
 */
export function failJob(jobId, error, { retryable = true, now = null, retryDelayMs = null } = {}) {
  if (!jobId) throw new Error('jobId is required');
  const at = now || nowIso();
  const row = get('SELECT * FROM background_jobs WHERE id = ?', [jobId]);
  if (!row) return { status: 'missing', attempts: 0, runAt: null };
  if (TERMINAL_STATUSES.includes(row.status)) {
    return { status: row.status, attempts: row.attempts, runAt: null };
  }
  const message = truncateError(error);
  const canRetry = Boolean(retryable) && row.attempts < row.max_attempts;
  if (canRetry) {
    const delayMs =
      retryDelayMs !== null && Number.isFinite(retryDelayMs)
        ? Math.max(0, retryDelayMs)
        : Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, row.attempts - 1)) * 1000;
    const nextRunAt = addMs(delayMs, new Date(at).getTime());
    run(
      `UPDATE background_jobs
          SET status = 'queued', run_at = ?, last_error = ?, worker_id = NULL, lease_until = NULL,
              started_at = NULL, updated_at = ?
        WHERE id = ?`,
      [nextRunAt, message, at, row.id],
    );
    return { status: 'queued', attempts: row.attempts, runAt: nextRunAt };
  }
  const terminal = retryable ? 'dead' : 'failed';
  run(
    `UPDATE background_jobs
        SET status = ?, finished_at = ?, last_error = ?, worker_id = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ?`,
    [terminal, at, message, at, row.id],
  );
  return { status: terminal, attempts: row.attempts, runAt: null };
}

/** Cancel one job. Running jobs get a cancellation intent instead. */
export function cancelJob(workspaceId, jobId, reason = 'cancelled_by_user') {
  assertWorkspaceId(workspaceId);
  if (!jobId) return { cancelled: false, status: 'missing', deletionRequested: false };
  const row = get('SELECT * FROM background_jobs WHERE id = ? AND workspace_id = ?', [jobId, workspaceId]);
  if (!row) return { cancelled: false, status: 'missing', deletionRequested: false };
  const now = nowIso();
  const note = String(reason || 'cancelled').slice(0, 200);
  if (row.status === 'queued') {
    run(
      `UPDATE background_jobs SET status = 'cancelled', finished_at = ?, last_error = ?, lease_until = NULL,
              worker_id = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`,
      [now, note, now, jobId],
    );
    return { cancelled: true, status: 'cancelled', deletionRequested: false };
  }
  if (row.status === 'running') {
    const result = parseJson(row.result_json, {});
    run('UPDATE background_jobs SET result_json = ?, updated_at = ? WHERE id = ? AND status = \'running\'', [
      json({ ...(result && typeof result === 'object' ? result : {}), cancelRequested: true, cancelReason: note }),
      now,
      jobId,
    ]);
    return { cancelled: false, status: 'running', deletionRequested: true };
  }
  return { cancelled: false, status: row.status, deletionRequested: false };
}

/** Terminate a running job as cancelled (worker honours a cancel intent). */
export function finishCancelled(jobId, reason = 'cancel_requested') {
  if (!jobId) return false;
  const now = nowIso();
  const updated = run(
    `UPDATE background_jobs
        SET status = 'cancelled', finished_at = ?, last_error = ?, lease_until = NULL, worker_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [now, String(reason || 'cancel_requested').slice(0, 200), now, jobId],
  );
  return updated.changes > 0;
}

/** True when a cancel request was recorded while the job was running. */
export function isCancelRequested(jobId) {
  if (!jobId) return false;
  const row = get('SELECT result_json FROM background_jobs WHERE id = ?', [jobId]);
  if (!row) return false;
  const result = parseJson(row.result_json, {});
  return Boolean(result && result.cancelRequested);
}

/**
 * Cancel every not-yet-finished job that belongs to a company. Matching is done
 * on the payload JSON: company id, contact ids, draft ids, thread ids and
 * follow-up task ids all count as "belongs to this company".
 * @returns {number} number of queued jobs cancelled immediately
 */
export function cancelJobsForCompany(workspaceId, companyId, reason = 'automation_takeover') {
  assertWorkspaceId(workspaceId);
  if (!companyId) return 0;
  const tokens = new Set([companyId]);
  const collect = (rows, key) => {
    for (const row of rows) {
      const value = row[key];
      if (value) tokens.add(value);
    }
  };
  collect(all('SELECT id FROM contacts WHERE workspace_id = ? AND company_id = ? LIMIT 500', [workspaceId, companyId]), 'id');
  collect(all('SELECT id FROM message_drafts WHERE workspace_id = ? AND company_id = ? LIMIT 500', [workspaceId, companyId]), 'id');
  collect(all('SELECT id FROM email_threads WHERE workspace_id = ? AND company_id = ? LIMIT 500', [workspaceId, companyId]), 'id');
  collect(all('SELECT id FROM follow_up_tasks WHERE workspace_id = ? AND company_id = ? LIMIT 500', [workspaceId, companyId]), 'id');

  const patterns = [];
  const params = [];
  for (const token of tokens) {
    patterns.push("payload_json LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(token)}"%`);
  }
  if (!patterns.length) return 0;
  const now = nowIso();
  const note = String(reason || 'company_cancelled').slice(0, 200);
  const where = `workspace_id = ? AND status = 'queued' AND (${patterns.join(' OR ')})`;
  const cancelled = run(
    `UPDATE background_jobs SET status = 'cancelled', finished_at = ?, last_error = ?, lease_until = NULL,
            worker_id = NULL, updated_at = ?
      WHERE ${where}`,
    [now, note, now, workspaceId, ...params],
  );
  run(
    `UPDATE background_jobs SET result_json = ?, updated_at = ?
      WHERE ${`workspace_id = ? AND status = 'running' AND (${patterns.join(' OR ')})`}`,
    [json({ cancelRequested: true, cancelReason: note }), now, workspaceId, ...params],
  );
  return cancelled.changes || 0;
}

/** Requeue jobs whose worker lease expired (crash / restart recovery). */
export function recoverExpiredLeases({ now = null } = {}) {
  const at = now || nowIso();
  const expired = all("SELECT * FROM background_jobs WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?", [at]);
  if (!expired.length) return { recovered: 0, dead: 0 };
  let recovered = 0;
  let dead = 0;
  tx(() => {
    for (const row of expired) {
      if (row.attempts >= row.max_attempts) {
        run(
          `UPDATE background_jobs SET status = 'dead', finished_at = ?, last_error = ?, lease_until = NULL,
                  worker_id = NULL, updated_at = ? WHERE id = ? AND status = 'running'`,
          [at, 'worker lease expired and retries exhausted', at, row.id],
        );
        dead += 1;
      } else {
        run(
          `UPDATE background_jobs SET status = 'queued', run_at = ?, last_error = ?, lease_until = NULL,
                  worker_id = NULL, started_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'`,
          [at, 'worker lease expired; requeued', at, row.id],
        );
        recovered += 1;
      }
    }
  });
  return { recovered, dead };
}

/** Reset a failed/dead/cancelled job so the worker can run it again. */
export function retryJob(workspaceId, jobId) {
  assertWorkspaceId(workspaceId);
  const row = get('SELECT * FROM background_jobs WHERE id = ? AND workspace_id = ?', [jobId, workspaceId]);
  if (!row) return { retried: false, status: 'missing' };
  if (!TERMINAL_STATUSES.includes(row.status)) {
    return { retried: false, status: row.status };
  }
  const now = nowIso();
  run(
    `UPDATE background_jobs
        SET status = 'queued', attempts = 0, run_at = ?, started_at = NULL, finished_at = NULL,
            lease_until = NULL, worker_id = NULL, last_error = NULL, result_json = '{}', updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    [now, now, jobId, workspaceId],
  );
  return { retried: true, status: 'queued' };
}

// ---------------------------------------------------------------- workspaces
export function setJobsPaused(workspaceId, paused, { actorId = null } = {}) {
  assertWorkspaceId(workspaceId);
  const enabled = Boolean(paused);
  upsertSetting(workspaceId, PAUSE_SETTING_KEY, enabled);
  const now = nowIso();
  if (actorId) {
    // Keep an audit trail even when called outside HTTP (worker/scheduler).
    run(
      `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, entity_type, entity_id, after_json, created_at)
       VALUES (?, ?, 'user', ?, ?, 'workspace', ?, ?, ?)`,
      [id('aud'), workspaceId, actorId, enabled ? 'jobs.pause_all' : 'jobs.resume_all', workspaceId, json({ paused: enabled }), now],
    );
  }
  return { paused: enabled };
}

export function isJobsPaused(workspaceId) {
  assertWorkspaceId(workspaceId);
  const row = get('SELECT value_json FROM settings WHERE workspace_id = ? AND key = ?', [workspaceId, PAUSE_SETTING_KEY]);
  if (!row) return false;
  return parseJson(row.value_json, false) === true;
}

export function pauseAll(workspaceId, options = {}) {
  return setJobsPaused(workspaceId, true, options);
}

export function resumeAll(workspaceId, options = {}) {
  return setJobsPaused(workspaceId, false, options);
}

// -------------------------------------------------------------------- queries
export function getJob(workspaceId, jobId) {
  assertWorkspaceId(workspaceId);
  return mapJobRow(get('SELECT * FROM background_jobs WHERE id = ? AND workspace_id = ?', [jobId, workspaceId]));
}

export function listJobs(workspaceId, { page = 1, pageSize = 25, status = '', type = '', q = '' } = {}) {
  assertWorkspaceId(workspaceId);
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (status) {
    where.push('status = ?');
    params.push(String(status));
  }
  if (type) {
    where.push('type = ?');
    params.push(String(type));
  }
  if (q) {
    where.push("(type LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(String(q).slice(0, 80))}%`;
    params.push(pattern, pattern);
  }
  const clause = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS c FROM background_jobs WHERE ${clause}`, params)?.c ?? 0;
  const rows = all(
    `SELECT * FROM background_jobs WHERE ${clause}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items: rows.map(mapJobRow), total, page, pageSize };
}

export function getJobStats(workspaceId) {
  assertWorkspaceId(workspaceId);
  const rows = all('SELECT status, COUNT(*) AS c FROM background_jobs WHERE workspace_id = ? GROUP BY status', [workspaceId]);
  const stats = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, dead: 0, total: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(stats, row.status)) stats[row.status] = row.c;
    stats.total += row.c;
  }
  const now = nowIso();
  const oldestQueued = get(
    "SELECT run_at FROM background_jobs WHERE workspace_id = ? AND status = 'queued' ORDER BY run_at ASC LIMIT 1",
    [workspaceId],
  );
  const last24h = get(
    `SELECT
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM background_jobs WHERE workspace_id = ? AND updated_at >= ?`,
    [workspaceId, addMs(-24 * 3600 * 1000, new Date(now).getTime())],
  );
  return {
    ...stats,
    paused: isJobsPaused(workspaceId),
    oldestQueuedAt: oldestQueued?.run_at || null,
    last24h: { succeeded: last24h?.succeeded ?? 0, failed: last24h?.failed ?? 0 },
    now,
  };
}

export default {
  JOB_TYPES,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  cancelJob,
  finishCancelled,
  isCancelRequested,
  cancelJobsForCompany,
  recoverExpiredLeases,
  retryJob,
  setJobsPaused,
  isJobsPaused,
  pauseAll,
  resumeAll,
  getJob,
  listJobs,
  getJobStats,
  mapJobRow,
};
