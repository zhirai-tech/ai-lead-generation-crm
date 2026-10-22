/**
 * OWNER: t-worker. Periodic scheduler.
 *
 * The worker polls the queue frequently; the scheduler decides when to create
 * *new* repeating jobs. It runs on a slower interval and is idempotent: every
 * enqueue uses a time-bucketed `dedupe_key`, so a duplicate tick never creates a
 * second job for the same period.
 */
import { all, get } from '../core/db.mjs';
import { dayKey, nowIso } from '../core/time.mjs';
import { enqueueJob, isJobsPaused } from './queue.mjs';

const CAMPAIGN_TICK_BUCKET_MINUTES = 5;
const EMAIL_SYNC_BUCKET_MINUTES = 10;

function bucket(value, minutes) {
  const ms = Number.isFinite(value) ? value : new Date(value).getTime();
  const size = minutes * 60_000;
  return Math.floor(ms / size);
}

/** @returns {{campaignTicks:number, emailSyncs:number, retentionJobs:number, workspaces:number, skippedPaused:number}} */
export function runSchedulerTick({ now = null, logger = null, enqueue = enqueueJob } = {}) {
  const at = now || nowIso();
  const atMs = new Date(at).getTime();
  const summary = { campaignTicks: 0, emailSyncs: 0, retentionJobs: 0, workspaces: 0, skippedPaused: 0 };
  const workspaces = all("SELECT id FROM workspaces WHERE status = 'active' AND deleted_at IS NULL");
  for (const workspace of workspaces) {
    const workspaceId = workspace.id;
    if (isJobsPaused(workspaceId)) {
      summary.skippedPaused += 1;
      continue;
    }
    summary.workspaces += 1;

    // --- campaign.tick: advance every active campaign we do not have a tick for
    const campaigns = all(
      "SELECT id FROM campaigns WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL",
      [workspaceId],
    );
    for (const campaign of campaigns) {
      const key = `campaign.tick:${workspaceId}:${campaign.id}:${bucket(atMs, CAMPAIGN_TICK_BUCKET_MINUTES)}`;
      const result = enqueue({ workspaceId, type: 'campaign.tick', payload: { campaignId: campaign.id }, dedupeKey: key, priority: 120 });
      if (!result.deduped) summary.campaignTicks += 1;
    }

    // --- email.sync: active mail accounts, at most once per bucket
    const accounts = all(
      "SELECT id, protocol FROM email_accounts WHERE workspace_id = ? AND status = 'active'",
      [workspaceId],
    );
    for (const account of accounts) {
      const key = `email.sync:${workspaceId}:${account.id}:${bucket(atMs, EMAIL_SYNC_BUCKET_MINUTES)}`;
      const result = enqueue({ workspaceId, type: 'email.sync', payload: { accountId: account.id }, dedupeKey: key, priority: 150 });
      if (!result.deduped) summary.emailSyncs += 1;
    }

    // --- maintenance.retention: once per UTC day per workspace
    const retentionKey = `maintenance.retention:${workspaceId}:${dayKey(atMs)}`;
    const retention = enqueue({ workspaceId, type: 'maintenance.retention', payload: {}, dedupeKey: retentionKey, priority: 900 });
    if (!retention.deduped) summary.retentionJobs += 1;
  }

  // Repeating jobs are deduplicated by key, which is globally unique across all
  // time. Prune the scheduler's own dedupe keys once they are terminal so the
  // table does not grow forever (retention also handles this daily).
  if (summary.campaignTicks + summary.emailSyncs + summary.retentionJobs > 0 && logger) {
    logger.debug('scheduler tick', summary);
  }
  return summary;
}

/** Number of runnable queued jobs (used by /ops/system and diagnostics). */
export function countDueJobs(now = nowIso()) {
  return get("SELECT COUNT(*) AS c FROM background_jobs WHERE status = 'queued' AND run_at <= ?", [now])?.c ?? 0;
}

export default { runSchedulerTick, countDueJobs };
