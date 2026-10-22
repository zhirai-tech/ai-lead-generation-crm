/** Ideal customer profile repository. */
import { all, get, run } from '../core/db.mjs';
import { jsonArray, paged } from './helpers.mjs';

/** Whitelisted ORDER BY builder that also accepts qualified columns (e.g. i.created_at). */
function orderSql(column, direction) {
  const safeColumn = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column) ? column : 'created_at';
  const safeDirection = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${safeColumn} ${safeDirection}`;
}

const ICP_SELECT = `
  SELECT i.*, p.name AS product_name
    FROM icps i
    LEFT JOIN products p ON p.id = i.product_id AND p.workspace_id = i.workspace_id`;

export function mapIcp(row) {
  if (!row) return null;
  const icp = {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id || null,
    name: row.name,
    description: row.description || null,
    targetCountries: jsonArray(row.target_countries_json),
    targetRegions: jsonArray(row.target_regions_json),
    targetCompanyTypes: jsonArray(row.target_company_types_json),
    targetSizes: jsonArray(row.target_sizes_json),
    targetRoles: jsonArray(row.target_roles_json),
    includeKeywords: jsonArray(row.include_keywords_json),
    excludeKeywords: jsonArray(row.exclude_keywords_json),
    minScore: row.min_score,
    isActive: Boolean(row.is_active),
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.product_name !== undefined) icp.productName = row.product_name || null;
  return icp;
}

export function listIcps(workspaceId, filters = {}) {
  const where = ['i.workspace_id = ?'];
  const params = [workspaceId];
  if (filters.q) {
    where.push(`(i.name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\')`);
    const needle = `%${String(filters.q).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    params.push(needle, needle);
  }
  if (filters.isActive !== undefined && filters.isActive !== null) {
    where.push('i.is_active = ?');
    params.push(filters.isActive ? 1 : 0);
  }
  if (filters.productId) {
    where.push('i.product_id = ?');
    params.push(filters.productId);
  }
  const sqlWhere = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS c FROM icps i WHERE ${sqlWhere}`, params)?.c ?? 0;
  const orderBy = orderSql(filters.sortKey === 'name' ? 'i.name' : 'i.created_at', filters.sortDirection);
  const rows = all(`${ICP_SELECT} WHERE ${sqlWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...params,
    filters.limit,
    filters.offset,
  ]);
  return paged(rows.map(mapIcp), total, filters.page, filters.pageSize);
}

export function findIcp(workspaceId, icpId) {
  return mapIcp(get(`${ICP_SELECT} WHERE i.id = ? AND i.workspace_id = ?`, [icpId, workspaceId]));
}

export function listActiveIcps(workspaceId) {
  return all(`${ICP_SELECT} WHERE i.workspace_id = ? AND i.is_active = 1 ORDER BY i.name ASC`, [workspaceId]).map(mapIcp);
}

const INSERT_COLUMNS = [
  'id', 'workspace_id', 'product_id', 'name', 'description', 'target_countries_json', 'target_regions_json',
  'target_company_types_json', 'target_sizes_json', 'target_roles_json', 'include_keywords_json',
  'exclude_keywords_json', 'min_score', 'is_active', 'created_by', 'created_at', 'updated_at',
];

export function insertIcp(data) {
  run(
    `INSERT INTO icps (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    INSERT_COLUMNS.map((column) => (data[column] === undefined ? null : data[column])),
  );
  return findIcp(data.workspace_id, data.id);
}

const UPDATE_COLUMNS = new Set([
  'product_id', 'name', 'description', 'target_countries_json', 'target_regions_json', 'target_company_types_json',
  'target_sizes_json', 'target_roles_json', 'include_keywords_json', 'exclude_keywords_json', 'min_score',
  'is_active', 'updated_at',
]);

export function updateIcp(workspaceId, icpId, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findIcp(workspaceId, icpId);
  run(
    `UPDATE icps SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND workspace_id = ?`,
    [...entries.map(([, value]) => value), icpId, workspaceId],
  );
  return findIcp(workspaceId, icpId);
}

export function deleteIcp(workspaceId, icpId) {
  return run('DELETE FROM icps WHERE id = ? AND workspace_id = ?', [icpId, workspaceId]).changes > 0;
}

export function countCompaniesUsingIcp(workspaceId, icpId) {
  return get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ? AND icp_id = ? AND deleted_at IS NULL', [
    workspaceId,
    icpId,
  ])?.c ?? 0;
}
