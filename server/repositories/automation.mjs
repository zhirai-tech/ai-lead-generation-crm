/**
 * OWNER: t-crm.
 *
 * Automation state persistence. The state machine itself lives in
 * services/automation.mjs so that every transition is transactional + audited.
 */
import { all, get, run } from '../core/db.mjs';

export const AUTOMATION_STATES = [
  'AUTOMATION_ACTIVE',
  'NEEDS_HUMAN_REVIEW',
  'HUMAN_TAKEOVER',
  'PAUSED',
  'DO_NOT_CONTACT',
  'CLOSED',
];

export function mapState(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    state: row.state,
    reason: row.reason,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    companyName: row.company_name ?? null,
  };
}

export function getStateRow(workspaceId, companyId) {
  if (!companyId) return null;
  return mapState(
    get('SELECT * FROM automation_states WHERE workspace_id = ? AND company_id = ?', [workspaceId, companyId]),
  );
}

const STATE_SELECT = `
  SELECT s.*, c.name AS company_name
    FROM automation_states s
    LEFT JOIN companies c ON c.id = s.company_id AND c.workspace_id = s.workspace_id`;

export function listStates(workspaceId, { state = null, companyId = null, page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const where = ['s.workspace_id = ?'];
  const params = [workspaceId];
  if (state) {
    where.push('s.state = ?');
    params.push(state);
  }
  if (companyId) {
    where.push('s.company_id = ?');
    params.push(companyId);
  }
  const clause = where.join(' AND ');
  const rows = all(`${STATE_SELECT} WHERE ${clause} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(mapState);
  const total = get(`SELECT COUNT(*) AS c FROM automation_states s WHERE ${clause}`, params)?.c ?? 0;
  return { items: rows, total, page, pageSize };
}

export function countStates(workspaceId) {
  const rows = all('SELECT state, COUNT(*) AS c FROM automation_states WHERE workspace_id = ? GROUP BY state', [workspaceId]);
  const counts = Object.fromEntries(AUTOMATION_STATES.map((state) => [state, 0]));
  for (const row of rows) counts[row.state] = Number(row.c);
  return counts;
}

/** Insert or update the state row for one company (caller wraps in a transaction). */
export function upsertState(workspaceId, companyId, { id, state, reason, changedBy, changedAt }) {
  run(
    `INSERT INTO automation_states (id, workspace_id, company_id, state, reason, changed_by, changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, company_id) DO UPDATE SET
       state = excluded.state,
       reason = excluded.reason,
       changed_by = excluded.changed_by,
       changed_at = excluded.changed_at,
       updated_at = excluded.updated_at`,
    [id, workspaceId, companyId, state, reason ?? null, changedBy ?? null, changedAt, changedAt, changedAt],
  );
  return getStateRow(workspaceId, companyId);
}
