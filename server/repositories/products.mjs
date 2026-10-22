/**
 * Product catalogue repository. Certifications, capacity, MOQ and pricing are
 * stored exactly as the user supplied them; nothing is ever generated.
 */
import { all, get, run } from '../core/db.mjs';
import { jsonArray, jsonObject, paged } from './helpers.mjs';

/** Whitelisted ORDER BY builder that also accepts qualified columns (e.g. p.created_at). */
function orderSql(column, direction) {
  const safeColumn = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column) ? column : 'created_at';
  const safeDirection = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${safeColumn} ${safeDirection}`;
}

const PRODUCT_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM company_product_matches m WHERE m.product_id = p.id AND m.workspace_id = p.workspace_id) AS match_count,
    (SELECT COUNT(*) FROM lead_scores s WHERE s.product_id = p.id AND s.workspace_id = p.workspace_id) AS score_count
  FROM products p`;

export function mapProduct(row) {
  if (!row) return null;
  const product = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    category: row.category || null,
    sku: row.sku || null,
    description: row.description || null,
    specs: jsonObject(row.specs_json),
    applications: jsonArray(row.applications_json),
    materials: row.materials || null,
    certifications: jsonArray(row.certifications_json),
    capacity: row.capacity || null,
    moq: row.moq || null,
    pricingTerms: row.pricing_terms || null,
    samples: row.samples || null,
    leadTime: row.lead_time || null,
    status: row.status,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
  if (row.match_count !== undefined) product.matchCount = row.match_count;
  if (row.score_count !== undefined) product.scoreCount = row.score_count;
  return product;
}

function like(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export function listProducts(workspaceId, filters = {}) {
  const where = ['p.workspace_id = ?', 'p.deleted_at IS NULL'];
  const params = [workspaceId];
  if (filters.q) {
    const needle = like(filters.q);
    where.push(`(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`);
    params.push(needle, needle, needle, needle);
  }
  if (filters.status) {
    where.push('p.status = ?');
    params.push(filters.status);
  }
  if (filters.category) {
    where.push('p.category = ?');
    params.push(filters.category);
  }
  const sqlWhere = where.join(' AND ');
  const total = get(`SELECT COUNT(*) AS c FROM products p WHERE ${sqlWhere}`, params)?.c ?? 0;
  const orderBy = orderSql(filters.sortKey === 'name' ? 'p.name' : 'p.created_at', filters.sortDirection);
  const rows = all(`${PRODUCT_SELECT} WHERE ${sqlWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...params,
    filters.limit,
    filters.offset,
  ]);
  return paged(rows.map(mapProduct), total, filters.page, filters.pageSize);
}

export function findProduct(workspaceId, productId, { includeDeleted = false } = {}) {
  const extra = includeDeleted ? '' : 'AND p.deleted_at IS NULL';
  return mapProduct(get(`${PRODUCT_SELECT} WHERE p.id = ? AND p.workspace_id = ? ${extra}`, [productId, workspaceId]));
}

export function listActiveProducts(workspaceId, { limit = 500 } = {}) {
  return all(
    `${PRODUCT_SELECT} WHERE p.workspace_id = ? AND p.deleted_at IS NULL ORDER BY p.name ASC LIMIT ?`,
    [workspaceId, limit],
  ).map(mapProduct);
}

const INSERT_COLUMNS = [
  'id', 'workspace_id', 'name', 'category', 'sku', 'description', 'specs_json', 'applications_json', 'materials',
  'certifications_json', 'capacity', 'moq', 'pricing_terms', 'samples', 'lead_time', 'status', 'created_by',
  'created_at', 'updated_at',
];

export function insertProduct(data) {
  run(
    `INSERT INTO products (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    INSERT_COLUMNS.map((column) => (data[column] === undefined ? null : data[column])),
  );
  return findProduct(data.workspace_id, data.id);
}

const UPDATE_COLUMNS = new Set([
  'name', 'category', 'sku', 'description', 'specs_json', 'applications_json', 'materials', 'certifications_json',
  'capacity', 'moq', 'pricing_terms', 'samples', 'lead_time', 'status', 'updated_at',
]);

export function updateProduct(workspaceId, productId, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findProduct(workspaceId, productId);
  run(
    `UPDATE products SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [...entries.map(([, value]) => value), productId, workspaceId],
  );
  return findProduct(workspaceId, productId);
}

export function softDeleteProduct(workspaceId, productId) {
  const now = new Date().toISOString();
  return (
    run(`UPDATE products SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [
      now,
      now,
      productId,
      workspaceId,
    ]).changes > 0
  );
}
