/**
 * OWNER: t-worker. maintenance.retention handler.
 *
 * Deletes *old operational records only*:
 *  - terminal background jobs (succeeded / failed / cancelled / dead)
 *  - audit events
 *  - usage records
 *
 * Business data (email messages, contacts, companies, deals) is deliberately
 * NOT deleted here. The default retention values are product defaults, not an
 * explicit user request to destroy correspondence; message/contact retention is
 * owned by the CRM module and must be an admin-confirmed action.
 */
import { run } from '../../core/db.mjs';
import { addDays, nowIso } from '../../core/time.mjs';
import { getSettings } from '../../services/settings.mjs';
import { recordJobAudit } from '../job-log.mjs';

function days(value, fallback, { min = 1, max = 3650 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function runRetention(workspaceId, { now = null } = {}) {
  const at = now ? new Date(now) : new Date();
  const nowIsoValue = at.toISOString();
  const settings = getSettings(workspaceId);
  const retention = settings.retention || {};
  const jobDays = days(retention.jobDays, 30);
  const auditDays = days(retention.auditDays, 730);
  const usageDays = days(retention.usageDays, 730);
  const jobCutoff = addDays(-jobDays, at.getTime());
  const auditCutoff = addDays(-auditDays, at.getTime());
  const usageCutoff = addDays(-usageDays, at.getTime());

  const jobs = run(
    `DELETE FROM background_jobs
      WHERE workspace_id = ? AND status IN ('succeeded', 'failed', 'cancelled', 'dead') AND updated_at < ?`,
    [workspaceId, jobCutoff],
  );
  const audits = run('DELETE FROM audit_events WHERE workspace_id = ? AND created_at < ?', [workspaceId, auditCutoff]);
  const usage = run('DELETE FROM usage_records WHERE workspace_id = ? AND occurred_at < ?', [workspaceId, usageCutoff]);

  const result = {
    deletedJobs: jobs.changes || 0,
    deletedAuditEvents: audits.changes || 0,
    deletedUsageRecords: usage.changes || 0,
    cutoffs: { jobCutoff, auditCutoff, usageCutoff, now: nowIsoValue },
    retention: { jobDays, auditDays, usageDays, messageRetention: 'skipped (CRM-owned)' },
  };
  recordJobAudit({ workspaceId, action: 'maintenance.retention.completed', entityType: 'workspace', entityId: workspaceId, after: result });
  return result;
}

export const handlers = {
  'maintenance.retention': async ({ workspaceId }) => runRetention(workspaceId),
};

export default handlers;
