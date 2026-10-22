/** Import run repository (CSV imports keep an auditable error report). */
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

export function mapImportRun(row, { includeErrors = true } = {}) {
  if (!row) return null;
  const mapped = {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    filename: row.filename || null,
    totalRows: row.total_rows,
    createdCount: row.created_count,
    updatedCount: row.updated_count,
    skippedCount: row.skipped_count,
    errorCount: row.error_count,
    status: row.status,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    finishedAt: row.finished_at || null,
  };
  if (includeErrors) mapped.errors = parseJsonSafe(row.errors_json, []);
  return mapped;
}

export function insertImportRun(data) {
  run(
    `INSERT INTO import_runs (id, workspace_id, kind, filename, total_rows, created_count, updated_count, skipped_count, error_count, errors_json, status, created_by, created_at, finished_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, '[]', ?, ?, ?, NULL)`,
    [data.id, data.workspace_id, data.kind, data.filename || null, data.status || 'running', data.created_by || null, data.created_at],
  );
  return findImportRun(data.workspace_id, data.id);
}

export function findImportRun(workspaceId, runId) {
  return mapImportRun(get('SELECT * FROM import_runs WHERE id = ? AND workspace_id = ?', [runId, workspaceId]));
}

export function listImportRuns(workspaceId, filters = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (filters.kind) {
    where.push('kind = ?');
    params.push(filters.kind);
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  const sqlWhere = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS c FROM import_runs WHERE ${sqlWhere}`, params)?.c ?? 0;
  const orderBy = orderSql('created_at', filters.sortDirection);
  const rows = all(`SELECT * FROM import_runs WHERE ${sqlWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...params,
    filters.limit,
    filters.offset,
  ]);
  return paged(rows.map((row) => mapImportRun(row, { includeErrors: false })), total, filters.page, filters.pageSize);
}

export function finishImportRun(workspaceId, runId, result) {
  run(
    `UPDATE import_runs
        SET total_rows = ?, created_count = ?, updated_count = ?, skipped_count = ?, error_count = ?,
            errors_json = ?, status = ?, finished_at = ?
      WHERE id = ? AND workspace_id = ?`,
    [
      result.totalRows || 0,
      result.createdCount || 0,
      result.updatedCount || 0,
      result.skippedCount || 0,
      result.errorCount || 0,
      JSON.stringify((result.errors || []).slice(0, 200)),
      result.status || 'completed',
      result.finishedAt,
      runId,
      workspaceId,
    ],
  );
  return findImportRun(workspaceId, runId);
}
