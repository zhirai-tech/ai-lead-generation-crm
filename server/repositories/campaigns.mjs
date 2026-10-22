/**
 * OWNER: t-crm.
 *
 * Campaign / campaign step / campaign target persistence. SQL + row mapping
 * only; business rules live in services/campaigns.mjs. Every statement is
 * scoped by workspace_id.
 */
import { all, get, run } from '../core/db.mjs';
import { bool, jsonObject, paged } from './helpers.mjs';

// ------------------------------------------------------------------ campaigns
export function mapCampaign(row, extras = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    productId: row.product_id,
    icpId: row.icp_id,
    goal: row.goal,
    status: row.status,
    dailyLimit: row.daily_limit,
    sendWindow: jsonObject(row.send_window_json),
    requireApproval: bool(row.require_approval),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    targetCount: row.target_count !== undefined ? Number(row.target_count || 0) : undefined,
    sentCount: row.sent_count !== undefined ? Number(row.sent_count || 0) : undefined,
    stepCount: row.step_count !== undefined ? Number(row.step_count || 0) : undefined,
    repliedCount: row.replied_count !== undefined ? Number(row.replied_count || 0) : undefined,
    pendingApprovalCount: row.pending_approval_count !== undefined ? Number(row.pending_approval_count || 0) : undefined,
    productName: row.product_name ?? null,
    icpName: row.icp_name ?? null,
    ...extras,
  };
}

function campaignFilters(workspaceId, { status = null, search = '', productId = null } = {}) {
  const where = ['c.workspace_id = ?', 'c.deleted_at IS NULL'];
  const params = [workspaceId];
  if (status) {
    where.push('c.status = ?');
    params.push(status);
  }
  if (productId) {
    where.push('c.product_id = ?');
    params.push(productId);
  }
  if (search) {
    where.push('c.name LIKE ? ESCAPE \'\\\'');
    params.push(`%${escapeLike(search)}%`);
  }
  return { clause: where.join(' AND '), params };
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function listCampaigns(workspaceId, { status = null, search = '', productId = null, page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const { clause, params } = campaignFilters(workspaceId, { status, search, productId });
  const rows = all(
    `SELECT c.*,
            p.name AS product_name,
            i.name AS icp_name,
            (SELECT COUNT(*) FROM campaign_targets t WHERE t.campaign_id = c.id AND t.workspace_id = c.workspace_id) AS target_count,
            (SELECT COUNT(*) FROM campaign_targets t WHERE t.campaign_id = c.id AND t.workspace_id = c.workspace_id AND t.status = 'replied') AS replied_count,
            (SELECT COUNT(*) FROM message_drafts d WHERE d.campaign_id = c.id AND d.workspace_id = c.workspace_id AND d.status = 'sent') AS sent_count,
            (SELECT COUNT(*) FROM message_drafts d WHERE d.campaign_id = c.id AND d.workspace_id = c.workspace_id AND d.status = 'pending_approval') AS pending_approval_count,
            (SELECT COUNT(*) FROM campaign_steps s WHERE s.campaign_id = c.id AND s.workspace_id = c.workspace_id) AS step_count
       FROM campaigns c
       LEFT JOIN products p ON p.id = c.product_id AND p.workspace_id = c.workspace_id
       LEFT JOIN icps i ON i.id = c.icp_id AND i.workspace_id = c.workspace_id
      WHERE ${clause}
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map((row) => mapCampaign(row));
  const total = get(`SELECT COUNT(*) AS c FROM campaigns c WHERE ${clause}`, params)?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getCampaign(workspaceId, campaignId, { includeDeleted = false } = {}) {
  if (!campaignId) return null;
  const row = get(
    `SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
    [workspaceId, campaignId],
  );
  return mapCampaign(row);
}

export function createCampaign(workspaceId, data) {
  run(
    `INSERT INTO campaigns
      (id, workspace_id, name, product_id, icp_id, goal, status, daily_limit, send_window_json, require_approval, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.name,
      data.productId ?? null,
      data.icpId ?? null,
      data.goal ?? null,
      data.status || 'draft',
      data.dailyLimit ?? 30,
      JSON.stringify(data.sendWindow || {}),
      data.requireApproval === false ? 0 : 1,
      data.createdBy ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return getCampaign(workspaceId, data.id);
}

const CAMPAIGN_UPDATE_COLUMNS = {
  name: 'name',
  productId: 'product_id',
  icpId: 'icp_id',
  goal: 'goal',
  status: 'status',
  dailyLimit: 'daily_limit',
  sendWindow: 'send_window_json',
  requireApproval: 'require_approval',
};

export function updateCampaign(workspaceId, campaignId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(CAMPAIGN_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (key === 'sendWindow') params.push(JSON.stringify(patch[key] || {}));
    else if (key === 'requireApproval') params.push(patch[key] ? 1 : 0);
    else params.push(patch[key]);
  }
  if (!sets.length) return getCampaign(workspaceId, campaignId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE campaigns SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, campaignId]);
  return getCampaign(workspaceId, campaignId);
}

export function softDeleteCampaign(workspaceId, campaignId, { updatedAt }) {
  return run(
    'UPDATE campaigns SET status = ?, deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL',
    ['archived', updatedAt, updatedAt, workspaceId, campaignId],
  ).changes;
}

// ---------------------------------------------------------------------- steps
export function mapStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    stepNo: row.step_no,
    name: row.name,
    channel: row.channel,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    language: row.language,
    delayDays: row.delay_days,
    conditions: jsonObject(row.conditions_json),
    isActive: bool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSteps(workspaceId, campaignId, { activeOnly = false } = {}) {
  const rows = all(
    `SELECT * FROM campaign_steps
      WHERE workspace_id = ? AND campaign_id = ?${activeOnly ? ' AND is_active = 1' : ''}
      ORDER BY step_no ASC`,
    [workspaceId, campaignId],
  );
  return rows.map(mapStep);
}

export function getStep(workspaceId, campaignId, stepId) {
  const row = get('SELECT * FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ? AND id = ?', [workspaceId, campaignId, stepId]);
  return mapStep(row);
}

export function getStepByNo(workspaceId, campaignId, stepNo) {
  const row = get('SELECT * FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ? AND step_no = ?', [workspaceId, campaignId, stepNo]);
  return mapStep(row);
}

export function maxStepNo(workspaceId, campaignId) {
  return get('SELECT COALESCE(MAX(step_no), 0) AS n FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ?', [workspaceId, campaignId])?.n ?? 0;
}

export function createStep(workspaceId, data) {
  run(
    `INSERT INTO campaign_steps
      (id, workspace_id, campaign_id, step_no, name, channel, subject_template, body_template, language, delay_days, conditions_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.campaignId,
      data.stepNo,
      data.name,
      data.channel || 'email',
      data.subjectTemplate || '',
      data.bodyTemplate || '',
      data.language || 'en',
      data.delayDays ?? 0,
      JSON.stringify(data.conditions || {}),
      data.isActive === false ? 0 : 1,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return getStep(workspaceId, data.campaignId, data.id);
}

const STEP_UPDATE_COLUMNS = {
  stepNo: 'step_no',
  name: 'name',
  channel: 'channel',
  subjectTemplate: 'subject_template',
  bodyTemplate: 'body_template',
  language: 'language',
  delayDays: 'delay_days',
  conditions: 'conditions_json',
  isActive: 'is_active',
};

export function updateStep(workspaceId, campaignId, stepId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(STEP_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (key === 'conditions') params.push(JSON.stringify(patch[key] || {}));
    else if (key === 'isActive') params.push(patch[key] ? 1 : 0);
    else params.push(patch[key]);
  }
  if (!sets.length) return getStep(workspaceId, campaignId, stepId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE campaign_steps SET ${sets.join(', ')} WHERE workspace_id = ? AND campaign_id = ? AND id = ?`, [
    ...params,
    workspaceId,
    campaignId,
    stepId,
  ]);
  return getStep(workspaceId, campaignId, stepId);
}

export function deleteStep(workspaceId, campaignId, stepId) {
  return run('DELETE FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ? AND id = ?', [workspaceId, campaignId, stepId]).changes;
}

// -------------------------------------------------------------------- targets
export function mapTarget(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    status: row.status,
    currentStep: row.current_step,
    enrolledAt: row.enrolled_at,
    nextRunAt: row.next_run_at,
    lastContactedAt: row.last_contacted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    companyName: row.company_name ?? null,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
  };
}

export function listTargets(workspaceId, campaignId, { status = null, page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const where = ['t.workspace_id = ?', 't.campaign_id = ?'];
  const params = [workspaceId, campaignId];
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  const clause = where.join(' AND ');
  const rows = all(
    `SELECT t.*, c.name AS company_name, ct.full_name AS contact_name, ct.email AS contact_email
       FROM campaign_targets t
       LEFT JOIN companies c ON c.id = t.company_id AND c.workspace_id = t.workspace_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id AND ct.workspace_id = t.workspace_id
      WHERE ${clause}
      ORDER BY t.enrolled_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(mapTarget);
  const total = get(`SELECT COUNT(*) AS c FROM campaign_targets t WHERE ${clause}`, params)?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getTarget(workspaceId, campaignId, contactId) {
  const row = get('SELECT * FROM campaign_targets WHERE workspace_id = ? AND campaign_id = ? AND contact_id = ?', [
    workspaceId,
    campaignId,
    contactId,
  ]);
  return mapTarget(row);
}

/** Insert a target; returns true only when a new row was created (dedupe by unique key). */
export function insertTarget(workspaceId, data) {
  const result = run(
    `INSERT OR IGNORE INTO campaign_targets
      (id, workspace_id, campaign_id, company_id, contact_id, status, current_step, enrolled_at, next_run_at, last_contacted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.campaignId,
      data.companyId,
      data.contactId,
      data.status || 'enrolled',
      data.currentStep ?? 0,
      data.enrolledAt,
      data.nextRunAt ?? null,
      data.lastContactedAt ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return result.changes > 0;
}

const TARGET_UPDATE_COLUMNS = {
  status: 'status',
  currentStep: 'current_step',
  nextRunAt: 'next_run_at',
  lastContactedAt: 'last_contacted_at',
};

export function updateTarget(workspaceId, targetId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(TARGET_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  return run(`UPDATE campaign_targets SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, targetId]).changes;
}

export function countTargetsByStatus(workspaceId, campaignId) {
  const rows = all(
    'SELECT status, COUNT(*) AS c FROM campaign_targets WHERE workspace_id = ? AND campaign_id = ? GROUP BY status',
    [workspaceId, campaignId],
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.c)]));
}

export function countCampaignDraftsByStatus(workspaceId, campaignId, status) {
  return (
    get('SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND campaign_id = ? AND status = ?', [
      workspaceId,
      campaignId,
      status,
    ])?.c ?? 0
  );
}

/** Mark open targets of a company/contact as replied after an inbound reply. */
export function markTargetsReplied(workspaceId, { companyId, contactId = null, updatedAt }) {
  if (!companyId) return 0;
  if (contactId) {
    return run(
      `UPDATE campaign_targets SET status = 'replied', next_run_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND contact_id = ? AND status IN ('enrolled', 'active')`,
      [updatedAt, workspaceId, contactId],
    ).changes;
  }
  return run(
    `UPDATE campaign_targets SET status = 'replied', next_run_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND company_id = ? AND status IN ('enrolled', 'active')`,
    [updatedAt, workspaceId, companyId],
  ).changes;
}

export function markTargetsUnsubscribed(workspaceId, { companyId, contactId = null, updatedAt }) {
  if (contactId) {
    return run(
      `UPDATE campaign_targets SET status = 'unsubscribed', next_run_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND contact_id = ? AND status IN ('enrolled', 'active', 'paused', 'replied')`,
      [updatedAt, workspaceId, contactId],
    ).changes;
  }
  if (!companyId) return 0;
  return run(
    `UPDATE campaign_targets SET status = 'unsubscribed', next_run_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND company_id = ? AND status IN ('enrolled', 'active', 'paused', 'replied')`,
    [updatedAt, workspaceId, companyId],
  ).changes;
}

export function countActiveCampaigns(workspaceId) {
  return get("SELECT COUNT(*) AS c FROM campaigns WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL", [workspaceId])?.c ?? 0;
}

export function countCampaigns(workspaceId) {
  return get('SELECT COUNT(*) AS c FROM campaigns WHERE workspace_id = ? AND deleted_at IS NULL', [workspaceId])?.c ?? 0;
}
