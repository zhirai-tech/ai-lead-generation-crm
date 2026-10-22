/**
 * OWNER: t-crm.
 *
 * Message draft persistence (message_drafts) plus the read-only joins the
 * drafts / approvals UI needs. All statements are scoped by workspace_id.
 */
import { all, get, run } from '../core/db.mjs';
import { jsonObject, paged } from './helpers.mjs';

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

const DRAFT_SELECT = `
  SELECT d.*,
         c.name AS company_name,
         c.domain AS company_domain,
         ct.full_name AS contact_name,
         ct.email AS contact_email,
         ct.title AS contact_title,
         cmp.name AS campaign_name
    FROM message_drafts d
    LEFT JOIN companies c ON c.id = d.company_id AND c.workspace_id = d.workspace_id
    LEFT JOIN contacts ct ON ct.id = d.contact_id AND ct.workspace_id = d.workspace_id
    LEFT JOIN campaigns cmp ON cmp.id = d.campaign_id AND cmp.workspace_id = d.workspace_id`;

export function mapDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    campaignId: row.campaign_id,
    campaignStepId: row.campaign_step_id,
    accountId: row.account_id,
    subject: row.subject,
    bodyText: row.body_text,
    language: row.language,
    status: row.status,
    generatedBy: row.generated_by,
    quality: jsonObject(row.quality_json),
    guard: jsonObject(row.guard_json),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    scheduledAt: row.scheduled_at,
    sentMessageId: row.sent_message_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    companyName: row.company_name ?? null,
    companyDomain: row.company_domain ?? null,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    contactTitle: row.contact_title ?? null,
    campaignName: row.campaign_name ?? null,
  };
}

export function draftFilters(workspaceId, { status = null, statuses = null, campaignId = null, companyId = null, contactId = null, accountId = null, search = '', language = null } = {}) {
  const where = ['d.workspace_id = ?'];
  const params = [workspaceId];
  if (status) {
    where.push('d.status = ?');
    params.push(status);
  } else if (statuses && statuses.length) {
    where.push(`d.status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  if (campaignId) {
    where.push('d.campaign_id = ?');
    params.push(campaignId);
  }
  if (companyId) {
    where.push('d.company_id = ?');
    params.push(companyId);
  }
  if (contactId) {
    where.push('d.contact_id = ?');
    params.push(contactId);
  }
  if (accountId) {
    where.push('d.account_id = ?');
    params.push(accountId);
  }
  if (language) {
    where.push('d.language = ?');
    params.push(language);
  }
  if (search) {
    where.push("(d.subject LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR ct.email LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like);
  }
  return { clause: where.join(' AND '), params };
}

export function listDrafts(workspaceId, filters = {}, { page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const { clause, params } = draftFilters(workspaceId, filters);
  const rows = all(
    `${DRAFT_SELECT}
      WHERE ${clause}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(mapDraft);
  const total = get(
    `SELECT COUNT(*) AS c
       FROM message_drafts d
       LEFT JOIN companies c ON c.id = d.company_id AND c.workspace_id = d.workspace_id
       LEFT JOIN contacts ct ON ct.id = d.contact_id AND ct.workspace_id = d.workspace_id
      WHERE ${clause}`,
    params,
  )?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getDraft(workspaceId, draftId) {
  if (!draftId) return null;
  return mapDraft(get(`${DRAFT_SELECT} WHERE d.workspace_id = ? AND d.id = ?`, [workspaceId, draftId]));
}

export function getDraftsByIds(workspaceId, draftIds) {
  const ids = [...new Set((draftIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return all(`${DRAFT_SELECT} WHERE d.workspace_id = ? AND d.id IN (${placeholders(ids.length)})`, [workspaceId, ...ids]).map(mapDraft);
}

export function createDraft(workspaceId, data) {
  run(
    `INSERT INTO message_drafts
      (id, workspace_id, company_id, contact_id, campaign_id, campaign_step_id, account_id, subject, body_text,
       language, status, generated_by, quality_json, guard_json, approved_by, approved_at, scheduled_at,
       sent_message_id, rejection_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.companyId,
      data.contactId,
      data.campaignId ?? null,
      data.campaignStepId ?? null,
      data.accountId ?? null,
      data.subject || '',
      data.bodyText || '',
      data.language || 'en',
      data.status || 'draft',
      data.generatedBy ?? null,
      JSON.stringify(data.quality || {}),
      JSON.stringify(data.guard || {}),
      data.approvedBy ?? null,
      data.approvedAt ?? null,
      data.scheduledAt ?? null,
      data.sentMessageId ?? null,
      data.rejectionReason ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return getDraft(workspaceId, data.id);
}

const DRAFT_UPDATE_COLUMNS = {
  subject: 'subject',
  bodyText: 'body_text',
  language: 'language',
  status: 'status',
  generatedBy: 'generated_by',
  quality: 'quality_json',
  guard: 'guard_json',
  approvedBy: 'approved_by',
  approvedAt: 'approved_at',
  scheduledAt: 'scheduled_at',
  sentMessageId: 'sent_message_id',
  rejectionReason: 'rejection_reason',
  accountId: 'account_id',
  campaignStepId: 'campaign_step_id',
};

export function updateDraft(workspaceId, draftId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(DRAFT_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (key === 'quality' || key === 'guard') params.push(JSON.stringify(patch[key] || {}));
    else params.push(patch[key]);
  }
  if (!sets.length) return getDraft(workspaceId, draftId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE message_drafts SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, draftId]);
  return getDraft(workspaceId, draftId);
}

export function countDraftsByStatus(workspaceId, status = null) {
  if (status) {
    return get('SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = ?', [workspaceId, status])?.c ?? 0;
  }
  return get('SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ?', [workspaceId])?.c ?? 0;
}

export function countApprovedSince(workspaceId, sinceIso) {
  return (
    get('SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND approved_at IS NOT NULL AND approved_at >= ?', [
      workspaceId,
      sinceIso,
    ])?.c ?? 0
  );
}

export function countScheduledSince(workspaceId, sinceIso) {
  return (
    get('SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = ? AND scheduled_at >= ?', [
      workspaceId,
      'scheduled',
      sinceIso,
    ])?.c ?? 0
  );
}

/** Validate that a generated_by candidate really exists (FK safety). */
export function agentExecutionExists(executionId) {
  if (!executionId) return false;
  return Boolean(get('SELECT 1 AS ok FROM agent_executions WHERE id = ?', [executionId]));
}

export function listPendingApprovals(workspaceId, { page = 1, pageSize = 25, offset = 0, limit = 25, search = '', campaignId = null } = {}) {
  return listDrafts(
    workspaceId,
    { status: 'pending_approval', search, campaignId },
    { page, pageSize, offset, limit },
  );
}

/** Recent sent drafts and inbound classifications for a company (draft context). */
export function listCompanyDraftHistory(workspaceId, companyId, limit = 5) {
  return all(
    `SELECT * FROM message_drafts
      WHERE workspace_id = ? AND company_id = ? AND status IN ('sent', 'scheduled', 'approved')
      ORDER BY updated_at DESC LIMIT ?`,
    [workspaceId, companyId, limit],
  ).map(mapDraft);
}
