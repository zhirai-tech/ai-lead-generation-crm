/**
 * OWNER: t-data. Product-level email template repository (versioned).
 * SQL only, always scoped by workspace_id.
 */
import { all, get, run } from '../core/db.mjs';
import { jsonArray } from './helpers.mjs';

const TEMPLATE_SELECT = 'SELECT * FROM product_email_templates';

export function mapProductTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id,
    version: row.version,
    subject: row.subject,
    bodyText: row.body_text,
    language: row.language,
    status: row.status,
    variables: jsonArray(row.variables_json),
    attachments: jsonArray(row.attachments_json),
    generatedBy: row.generated_by || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProductTemplates(workspaceId, productId) {
  return all(
    `${TEMPLATE_SELECT} WHERE workspace_id = ? AND product_id = ? ORDER BY version DESC`,
    [workspaceId, productId],
  ).map(mapProductTemplate);
}

export function findProductTemplate(workspaceId, productId, templateId) {
  return mapProductTemplate(
    get(`${TEMPLATE_SELECT} WHERE id = ? AND workspace_id = ? AND product_id = ?`, [templateId, workspaceId, productId]),
  );
}

export function findLatestProductTemplate(workspaceId, productId) {
  return mapProductTemplate(
    get(`${TEMPLATE_SELECT} WHERE workspace_id = ? AND product_id = ? ORDER BY version DESC LIMIT 1`, [workspaceId, productId]),
  );
}

export function findApprovedProductTemplate(workspaceId, productId) {
  return mapProductTemplate(
    get(`${TEMPLATE_SELECT} WHERE workspace_id = ? AND product_id = ? AND status = 'approved' LIMIT 1`, [workspaceId, productId]),
  );
}

export function nextTemplateVersion(workspaceId, productId) {
  const row = get(
    'SELECT MAX(version) AS max_version FROM product_email_templates WHERE workspace_id = ? AND product_id = ?',
    [workspaceId, productId],
  );
  return (row?.max_version || 0) + 1;
}

const INSERT_COLUMNS = [
  'id', 'workspace_id', 'product_id', 'version', 'subject', 'body_text', 'language', 'status', 'variables_json',
  'attachments_json', 'generated_by', 'approved_by', 'approved_at', 'created_by', 'created_at', 'updated_at',
];

export function insertProductTemplate(data) {
  run(
    `INSERT INTO product_email_templates (${INSERT_COLUMNS.join(', ')})
     VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    INSERT_COLUMNS.map((column) => (data[column] === undefined ? null : data[column])),
  );
  return findProductTemplate(data.workspace_id, data.product_id, data.id);
}

const UPDATE_COLUMNS = new Set([
  'subject', 'body_text', 'language', 'status', 'variables_json', 'attachments_json', 'generated_by', 'approved_by',
  'approved_at', 'updated_at',
]);

export function updateProductTemplate(workspaceId, productId, templateId, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findProductTemplate(workspaceId, productId, templateId);
  run(
    `UPDATE product_email_templates SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND workspace_id = ? AND product_id = ?`,
    [...entries.map(([, value]) => value), templateId, workspaceId, productId],
  );
  return findProductTemplate(workspaceId, productId, templateId);
}

/** Disable every approved template except `keepTemplateId` (approval uniqueness). */
export function disableOtherApprovedTemplates(workspaceId, productId, keepTemplateId) {
  const now = new Date().toISOString();
  return run(
    `UPDATE product_email_templates SET status = 'disabled', updated_at = ?
      WHERE workspace_id = ? AND product_id = ? AND status = 'approved' AND id <> ?`,
    [now, workspaceId, productId, keepTemplateId],
  ).changes;
}

export function countApprovedTemplates(workspaceId, productId) {
  return get(
    "SELECT COUNT(*) AS c FROM product_email_templates WHERE workspace_id = ? AND product_id = ? AND status = 'approved'",
    [workspaceId, productId],
  )?.c ?? 0;
}
