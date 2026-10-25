/** Discovery run repository. */
import { all, get, run } from '../core/db.mjs';
import { paged } from './helpers.mjs';

/** Whitelisted ORDER BY builder (accepts qualified columns). */
function orderSql(column, direction) {
  const safeColumn = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column) ? column : 'created_at';
  const safeDirection = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${safeColumn} ${safeDirection}`;
}

function parseJsonSafe(value, fallback) {
  try {
    return JSON.parse(value ?? '');
  } catch {
    return fallback;
  }
}

export function mapDiscoveryRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    query: parseJsonSafe(row.query_json, {}),
    provider: row.provider || null,
    status: row.status,
    resultCount: row.result_count,
    companiesCreated: row.companies_created,
    qualificationStatus: row.qualification_status || 'not_applicable',
    qualifiedCount: row.qualified_count || 0,
    rejectedCount: row.rejected_count || 0,
    insufficientCount: row.insufficient_count || 0,
    unclassifiedCount: row.unclassified_count || 0,
    qualificationFinalizedAt: row.qualification_finalized_at || null,
    qualificationEvaluation: row.qualification_evaluation || null,
    error: row.error || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
  };
}

export function insertDiscoveryRun(data) {
  run(
    `INSERT INTO discovery_runs (id, workspace_id, query_json, provider, status, result_count, companies_created, error, started_at, finished_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?)`,
    [
      data.id,
      data.workspace_id,
      JSON.stringify(data.query || {}),
      data.provider || null,
      data.status || 'queued',
      data.created_by || null,
      data.created_at,
    ],
  );
  return findDiscoveryRun(data.workspace_id, data.id);
}

export function findDiscoveryRun(workspaceId, runId) {
  return mapDiscoveryRun(get('SELECT * FROM discovery_runs WHERE id = ? AND workspace_id = ?', [runId, workspaceId]));
}

export function listDiscoveryRuns(workspaceId, filters = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.provider) {
    where.push('provider = ?');
    params.push(filters.provider);
  }
  const sqlWhere = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS c FROM discovery_runs WHERE ${sqlWhere}`, params)?.c ?? 0;
  const orderBy = orderSql('created_at', filters.sortDirection);
  const rows = all(`SELECT * FROM discovery_runs WHERE ${sqlWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...params,
    filters.limit,
    filters.offset,
  ]);
  return paged(rows.map(mapDiscoveryRun), total, filters.page, filters.pageSize);
}

const UPDATE_COLUMNS = new Set([
  'status', 'result_count', 'companies_created', 'error', 'started_at', 'finished_at',
  'qualification_status', 'qualified_count', 'rejected_count', 'insufficient_count', 'unclassified_count',
  'qualification_finalized_at', 'qualification_evaluation',
]);

export function updateDiscoveryRun(workspaceId, runId, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findDiscoveryRun(workspaceId, runId);
  run(
    `UPDATE discovery_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND workspace_id = ?`,
    [...entries.map(([, value]) => value), runId, workspaceId],
  );
  return findDiscoveryRun(workspaceId, runId);
}

/** Count queued/running runs for a workspace (limits abuse of discovery). */
export function countActiveRuns(workspaceId) {
  return get(
    "SELECT COUNT(*) AS c FROM discovery_runs WHERE workspace_id = ? AND status IN ('queued', 'running')",
    [workspaceId],
  )?.c ?? 0;
}
