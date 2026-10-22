/**
 * OWNER: t-worker. Usage / audit helpers shared by background handlers.
 * Every job writes a usage record (cost tracking) and key actions are audited.
 */
import { run } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';

/**
 * @param {object} input
 * @param {'ai_tokens'|'email_sent'|'data_lookup'|'agent_run'|'crawl'} input.category
 */
export function recordJobUsage({
  workspaceId,
  category,
  quantity = 1,
  unit = 'count',
  costEstimate = 0,
  currency = 'USD',
  jobId = null,
  agentExecutionId = null,
  agentRole = null,
  provider = null,
  model = null,
} = {}) {
  if (!workspaceId || !category) return null;
  const now = nowIso();
  const usageId = id('usg');
  run(
    `INSERT INTO usage_records
       (id, workspace_id, category, agent_role, provider, model, quantity, unit, cost_estimate, currency,
        job_id, agent_execution_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      usageId,
      workspaceId,
      category,
      agentRole,
      provider,
      model,
      Number(quantity) || 0,
      unit,
      Number(costEstimate) || 0,
      currency,
      jobId,
      agentExecutionId,
      now,
      now,
    ],
  );
  return usageId;
}

export function recordJobAudit({
  workspaceId,
  action,
  entityType = 'background_job',
  entityId = null,
  before = null,
  after = null,
  actorType = 'system',
  actorId = null,
}) {
  if (!workspaceId || !action) return null;
  return recordAudit({ workspaceId, actorType, actorId, action, entityType, entityId, before, after });
}

export default { recordJobUsage, recordJobAudit };
