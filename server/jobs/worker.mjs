/**
 * OWNER: t-worker. Background worker lifecycle.
 *
 * A single-process, SQLite-backed worker:
 *  - polls the queue (default 1s), claiming jobs atomically with a 120s lease;
 *  - recovers expired leases left by a crashed/restarted worker;
 *  - runs the scheduler on a slower interval (campaign ticks, inbox sync,
 *    retention);
 *  - processes 1–2 jobs concurrently, never crashing the HTTP server when a
 *    handler fails (failures are recorded on the job and retried with backoff);
 *  - stops gracefully on SIGINT/SIGTERM: `stopWorker` waits for in-flight jobs.
 *
 * `server/index.mjs` calls `startWorker`, `stopWorker` and `getWorkerStatus`.
 */
import { getDb } from '../core/db.mjs';
import { AppError } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import {
  claimNextJob,
  completeJob,
  failJob,
  finishCancelled,
  isCancelRequested,
  isJobsPaused,
  recoverExpiredLeases,
} from './queue.mjs';
import { getHandler } from './handlers/index.mjs';
import { runSchedulerTick } from './scheduler.mjs';

const DEFAULT_POLL_MS = 1000;
const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;
const MAX_CONCURRENCY = 2;
const STOP_TIMEOUT_MS = 20_000;

const state = {
  running: false,
  workerId: null,
  startedAt: null,
  lastTickAt: null,
  lastSchedulerAt: null,
  processed: 0,
  failed: 0,
  currentJob: null,
  activeJobs: 0,
  lastError: null,
};

let stopRequested = false;
let loopPromise = null;
let activeTimer = null;

function pause(ms) {
  return new Promise((resolve) => {
    activeTimer = setTimeout(() => {
      activeTimer = null;
      resolve();
    }, Math.max(0, ms));
  });
}

async function sleepInterruptible(ms) {
  const deadline = Date.now() + Math.max(0, ms);
  while (!stopRequested && Date.now() < deadline) {
    await pause(Math.min(250, deadline - Date.now()));
  }
}

/**
 * Permanent (do not retry) vs transient (retry with backoff) classification.
 * Handlers may override with `error.retryable = true/false`.
 */
export function isRetryableJobError(error) {
  if (error && typeof error.retryable === 'boolean') return error.retryable;
  if (error instanceof AppError) {
    if (error.code === 'UPSTREAM_NOT_READY') return true;
    if (error.status >= 400 && error.status < 500) return false;
    return true;
  }
  return true;
}

export function getWorkerStatus() {
  return {
    running: state.running,
    workerId: state.workerId,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    lastSchedulerAt: state.lastSchedulerAt,
    processed: state.processed,
    failed: state.failed,
    currentJob: state.currentJob,
    activeJobs: state.activeJobs,
    lastError: state.lastError,
  };
}

/**
 * Execute one claimed job. Exported so tests can drive a job deterministically
 * without starting the timer loop.
 */
export async function processJob(job, { config = null, logger = null } = {}) {
  if (!job || !job.id) throw new Error('processJob requires a claimed job');
  const startedAt = Date.now();
  state.currentJob = { id: job.id, type: job.type, workspaceId: job.workspaceId, startedAt: nowIso() };
  state.activeJobs += 1;
  try {
    if (isCancelRequested(job.id)) {
      finishCancelled(job.id, 'cancel_requested_before_start');
      return { id: job.id, status: 'cancelled' };
    }
    if (isJobsPaused(job.workspaceId)) {
      // Workspace paused after the job was claimed: requeue it without burning an attempt.
      failJob(job.id, 'workspace jobs paused', { retryable: true, retryDelayMs: 0 });
      return { id: job.id, status: 'paused' };
    }
    const handler = getHandler(job.type);
    if (!handler) {
      failJob(job.id, `未注册的任务类型：${job.type}`, { retryable: false });
      state.failed += 1;
      if (logger) logger.warn('job type not registered', { jobId: job.id, type: job.type });
      return { id: job.id, status: 'failed', error: 'handler_not_registered' };
    }
    const result = await handler({
      db: getDb(),
      job,
      config,
      logger,
      workspaceId: job.workspaceId,
      payload: job.payload || {},
    });
    if (isCancelRequested(job.id)) {
      finishCancelled(job.id, 'cancel_requested_during_run');
      return { id: job.id, status: 'cancelled' };
    }
    completeJob(job.id, { result: result && typeof result === 'object' ? result : { value: result } });
    state.processed += 1;
    if (logger) {
      logger.debug('job succeeded', { jobId: job.id, type: job.type, ms: Date.now() - startedAt });
    }
    return { id: job.id, status: 'succeeded', result };
  } catch (error) {
    const retryable = isRetryableJobError(error);
    const retryDelayMs = Number.isFinite(error && error.retryDelayMs) ? Math.max(0, error.retryDelayMs) : null;
    const outcome = failJob(job.id, error, { retryable, retryDelayMs });
    state.failed += 1;
    state.lastError = { jobId: job.id, message: String(error && error.message ? error.message : error).slice(0, 500), at: nowIso() };
    if (logger) {
      logger.error('job failed', {
        jobId: job.id,
        type: job.type,
        retryable,
        jobStatus: outcome.status,
        attempts: job.attempts,
        error: error instanceof AppError ? { code: error.code, message: error.message } : error,
      });
    }
    return { id: job.id, status: outcome.status, error: String(error && error.message ? error.message : error) };
  } finally {
    state.activeJobs = Math.max(0, state.activeJobs - 1);
    state.currentJob = null;
  }
}

function concurrencyOf(config) {
  const requested = Number(config?.worker?.concurrency ?? 1);
  if (!Number.isFinite(requested)) return 1;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(requested)));
}

/**
 * One worker tick: recover leases, maybe run the scheduler, claim and process
 * up to `concurrency` jobs.
 */
export async function runWorkerTick({ config = null, logger = null, workerId = state.workerId || 'wrk_manual', forceScheduler = false } = {}) {
  state.lastTickAt = nowIso();
  const recovered = recoverExpiredLeases();
  if (recovered.recovered || recovered.dead) {
    if (logger) logger.warn('recovered expired job leases', recovered);
  }

  const schedulerInterval = Math.max(5_000, Number(config?.worker?.schedulerIntervalMs || DEFAULT_SCHEDULER_INTERVAL_MS));
  const lastScheduler = state.lastSchedulerAt ? new Date(state.lastSchedulerAt).getTime() : 0;
  if (forceScheduler || Date.now() - lastScheduler >= schedulerInterval) {
    try {
      const summary = runSchedulerTick({ logger });
      state.lastSchedulerAt = nowIso();
      if (logger) logger.debug('scheduler ran', summary);
    } catch (error) {
      if (logger) logger.error('scheduler failed', { error });
    }
  }

  let processed = 0;
  let failed = 0;
  const concurrency = concurrencyOf(config);
  const claimed = [];
  for (let slot = 0; slot < concurrency; slot += 1) {
    const job = claimNextJob(workerId);
    if (!job) break;
    claimed.push(job);
  }
  if (claimed.length) {
    const results = await Promise.all(claimed.map((job) => processJob(job, { config, logger })));
    for (const result of results) {
      if (result.status === 'succeeded' || result.status === 'cancelled' || result.status === 'paused') processed += 1;
      else failed += 1;
    }
  }
  return { claimed: claimed.length, processed, failed, recovered };
}

async function loop({ config, logger, workerId }) {
  const pollMs = Math.max(100, Math.min(60_000, Number(config?.worker?.pollMs || DEFAULT_POLL_MS)));
  while (!stopRequested) {
    const startedAt = Date.now();
    try {
      await runWorkerTick({ config, logger, workerId });
    } catch (error) {
      state.lastError = { message: String(error && error.message ? error.message : error), at: nowIso() };
      if (logger) logger.error('worker tick failed', { error });
    }
    const elapsed = Date.now() - startedAt;
    await sleepInterruptible(Math.max(0, pollMs - elapsed));
  }
}

/**
 * Start the worker loop. Safe to call twice (idempotent). Never throws on a
 * handler error; callers only await the initial status.
 */
export async function startWorker({ config = null, logger = null } = {}) {
  if (state.running) return getWorkerStatus();
  stopRequested = false;
  const workerId = `wrk_${process.pid}_${id('w').slice(-12)}`;
  Object.assign(state, {
    running: true,
    workerId,
    startedAt: nowIso(),
    lastTickAt: null,
    lastSchedulerAt: null,
    currentJob: null,
    activeJobs: 0,
    lastError: null,
  });
  loopPromise = loop({ config, logger, workerId });
  // Let startup (lease recovery) happen before returning; ignore loop errors.
  loopPromise.catch(() => {});
  if (logger) logger.info('worker started', { workerId, pollMs: config?.worker?.pollMs ?? DEFAULT_POLL_MS });
  return getWorkerStatus();
}

/** Stop the worker gracefully. Waits for the current tick (bounded timeout). */
export async function stopWorker({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
  if (!state.running) {
    stopRequested = true;
    return getWorkerStatus();
  }
  stopRequested = true;
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  const running = loopPromise;
  loopPromise = null;
  if (running) {
    await Promise.race([
      running.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, Math.max(500, timeoutMs))),
    ]);
  }
  state.running = false;
  state.currentJob = null;
  state.activeJobs = 0;
  return getWorkerStatus();
}

/** Test helper: reset counters between cases without touching the queue. */
export function resetWorkerStateForTests() {
  Object.assign(state, {
    running: false,
    workerId: null,
    startedAt: null,
    lastTickAt: null,
    lastSchedulerAt: null,
    processed: 0,
    failed: 0,
    currentJob: null,
    activeJobs: 0,
    lastError: null,
  });
  stopRequested = false;
}

export default { startWorker, stopWorker, getWorkerStatus, processJob, runWorkerTick, isRetryableJobError };
