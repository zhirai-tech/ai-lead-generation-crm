/**
 * OWNER: t-crm.
 *
 * Suppression (do-not-contact) list persistence. Matching and permission rules
 * live in services/suppression.mjs.
 */
import { all, get, run } from '../core/db.mjs';
import { paged } from './helpers.mjs';

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function mapSuppression(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    valueNormalized: row.value_normalized,
    reason: row.reason,
    source: row.source,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function listSuppression(workspaceId, { scope = null, reason = null, search = '', page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (scope) {
    where.push('scope = ?');
    params.push(scope);
  }
  if (reason) {
    where.push('reason = ?');
    params.push(reason);
  }
  if (search) {
    where.push("value_normalized LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(search)}%`);
  }
  const clause = where.join(' AND ');
  const rows = all(`SELECT * FROM suppression_records WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]).map(mapSuppression);
  const total = get(`SELECT COUNT(*) AS c FROM suppression_records WHERE ${clause}`, params)?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getSuppression(workspaceId, suppressionId) {
  return mapSuppression(get('SELECT * FROM suppression_records WHERE workspace_id = ? AND id = ?', [workspaceId, suppressionId]));
}

export function findSuppression(workspaceId, scope, valueNormalized) {
  return mapSuppression(
    get('SELECT * FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?', [
      workspaceId,
      scope,
      valueNormalized,
    ]),
  );
}

/** Insert if absent; returns { record, created }. */
export function insertSuppression(workspaceId, data) {
  const existing = findSuppression(workspaceId, data.scope, data.valueNormalized);
  if (existing) return { record: existing, created: false };
  run(
    `INSERT OR IGNORE INTO suppression_records
      (id, workspace_id, scope, value_normalized, reason, source, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.scope,
      data.valueNormalized,
      data.reason,
      data.source ?? null,
      data.note ?? null,
      data.createdBy ?? null,
      data.createdAt,
    ],
  );
  return { record: findSuppression(workspaceId, data.scope, data.valueNormalized), created: true };
}

export function deleteSuppression(workspaceId, suppressionId) {
  const record = getSuppression(workspaceId, suppressionId);
  if (!record) return null;
  run('DELETE FROM suppression_records WHERE workspace_id = ? AND id = ?', [workspaceId, suppressionId]);
  return record;
}

/** Find suppression hits for an email address and/or its domain. */
export function matchSuppression(workspaceId, { email = null, domain = null } = {}) {
  const matches = [];
  if (email) {
    const hit = findSuppression(workspaceId, 'email', String(email).toLowerCase());
    if (hit) matches.push(hit);
  }
  const normalizedDomain = domain ? String(domain).toLowerCase().replace(/^www\./, '') : email && String(email).includes('@') ? String(email).split('@').pop().toLowerCase() : null;
  if (normalizedDomain) {
    const hit = findSuppression(workspaceId, 'domain', normalizedDomain);
    if (hit) matches.push(hit);
  }
  return matches;
}

/**
 * True when the company still has any suppression hit (domain or any of its
 * contact emails). Used before allowing DO_NOT_CONTACT -> resume.
 */
export function companyHasSuppression(workspaceId, companyId) {
  const row = get(
    `SELECT 1 AS ok FROM suppression_records s
      WHERE s.workspace_id = ?
        AND (
          (s.scope = 'domain' AND s.value_normalized = (
             SELECT LOWER(REPLACE(COALESCE(domain, ''), 'www.', '')) FROM companies
              WHERE id = ? AND workspace_id = ?))
          OR
          (s.scope = 'email' AND s.value_normalized IN (
             SELECT email_normalized FROM contacts
              WHERE company_id = ? AND workspace_id = ? AND email_normalized IS NOT NULL AND email_normalized <> ''))
        )
      LIMIT 1`,
    [workspaceId, companyId, workspaceId, companyId, workspaceId],
  );
  return Boolean(row);
}

export function countSuppression(workspaceId) {
  return get('SELECT COUNT(*) AS c FROM suppression_records WHERE workspace_id = ?', [workspaceId])?.c ?? 0;
}
