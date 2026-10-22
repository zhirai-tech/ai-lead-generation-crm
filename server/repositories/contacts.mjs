/**
 * Contact repository: SQL only, always scoped by workspace_id.
 */
import { all, get, run } from '../core/db.mjs';
import { paged } from './helpers.mjs';

/** Whitelisted ORDER BY builder that also accepts qualified columns (e.g. ct.created_at). */
function orderSql(column, direction) {
  const safeColumn = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column) ? column : 'created_at';
  const safeDirection = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${safeColumn} ${safeDirection}`;
}

const CONTACT_SELECT = `
  SELECT ct.*, co.name AS company_name, co.domain AS company_domain
    FROM contacts ct
    LEFT JOIN companies co ON co.id = ct.company_id AND co.workspace_id = ct.workspace_id`;

export function mapContact(row) {
  if (!row) return null;
  const contact = {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName: row.full_name || null,
    title: row.title || null,
    roleCategory: row.role_category,
    email: row.email || null,
    emailNormalized: row.email_normalized || null,
    emailType: row.email_type,
    emailStatus: row.email_status,
    phone: row.phone || null,
    linkedinUrl: row.linkedin_url || null,
    country: row.country || null,
    language: row.language || null,
    department: row.department || null,
    isPrimary: Boolean(row.is_primary),
    confidence: row.confidence,
    lastVerifiedAt: row.last_verified_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
  if (row.company_name !== undefined) contact.companyName = row.company_name || null;
  if (row.company_domain !== undefined) contact.companyDomain = row.company_domain || null;
  return contact;
}

function like(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export function buildContactWhere(workspaceId, filters = {}) {
  const where = ['ct.workspace_id = ?', 'ct.deleted_at IS NULL'];
  const params = [workspaceId];
  if (filters.companyId) {
    where.push('ct.company_id = ?');
    params.push(filters.companyId);
  }
  if (filters.q) {
    const needle = like(filters.q);
    where.push(
      `(ct.full_name LIKE ? ESCAPE '\\' OR ct.first_name LIKE ? ESCAPE '\\' OR ct.last_name LIKE ? ESCAPE '\\'
        OR ct.email LIKE ? ESCAPE '\\' OR ct.title LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')`,
    );
    params.push(needle, needle, needle, needle, needle, needle);
  }
  if (filters.emailStatus) {
    const statuses = Array.isArray(filters.emailStatus) ? filters.emailStatus : [filters.emailStatus];
    where.push(`ct.email_status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.roleCategory) {
    where.push('ct.role_category = ?');
    params.push(filters.roleCategory);
  }
  if (filters.country) {
    where.push('ct.country = ?');
    params.push(filters.country);
  }
  if (filters.hasEmail === true) {
    where.push(`ct.email_normalized IS NOT NULL AND ct.email_normalized <> ''`);
  } else if (filters.hasEmail === false) {
    where.push(`(ct.email_normalized IS NULL OR ct.email_normalized = '')`);
  }
  if (filters.emailType) {
    where.push('ct.email_type = ?');
    params.push(filters.emailType);
  }
  return { where: where.join(' AND '), params };
}

const CONTACT_SORT = {
  fullName: 'ct.full_name',
  firstName: 'ct.first_name',
  createdAt: 'ct.created_at',
  updatedAt: 'ct.updated_at',
  lastVerifiedAt: 'ct.last_verified_at',
  emailStatus: 'ct.email_status',
};

export function listContacts(workspaceId, filters = {}) {
  const { where, params } = buildContactWhere(workspaceId, filters);
  const total = get(
    `SELECT COUNT(*) AS c FROM contacts ct LEFT JOIN companies co ON co.id = ct.company_id AND co.workspace_id = ct.workspace_id WHERE ${where}`,
    params,
  )?.c ?? 0;
  const orderBy = orderSql(CONTACT_SORT[filters.sortKey] || 'ct.created_at', filters.sortDirection);
  const rows = all(
    `${CONTACT_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return paged(rows.map(mapContact), total, filters.page, filters.pageSize);
}

export function findContact(workspaceId, contactId) {
  return mapContact(
    get(`${CONTACT_SELECT} WHERE ct.id = ? AND ct.workspace_id = ? AND ct.deleted_at IS NULL`, [contactId, workspaceId]),
  );
}

export function findContactByEmail(workspaceId, emailNormalized) {
  if (!emailNormalized) return null;
  return mapContact(
    get(`${CONTACT_SELECT} WHERE ct.workspace_id = ? AND ct.email_normalized = ? LIMIT 1`, [workspaceId, emailNormalized]),
  );
}

/** Contacts for a company, e.g. primary first then newest. */
export function listContactsForCompany(workspaceId, companyId, { limit = 200 } = {}) {
  return all(
    `${CONTACT_SELECT} WHERE ct.workspace_id = ? AND ct.company_id = ? AND ct.deleted_at IS NULL
      ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT ?`,
    [workspaceId, companyId, limit],
  ).map(mapContact);
}

/** Contacts elsewhere in the workspace that already own one of these emails. */
export function findContactsByEmails(workspaceId, emails) {
  if (!emails.length) return [];
  return all(
    `SELECT id, email_normalized FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL
      AND email_normalized IN (${emails.map(() => '?').join(',')})`,
    [workspaceId, ...emails],
  );
}

export function listContactsWithoutEmail(workspaceId, companyId, { limit = 10 } = {}) {
  return all(
    `${CONTACT_SELECT} WHERE ct.workspace_id = ? AND ct.company_id = ? AND ct.deleted_at IS NULL
      AND (ct.email_normalized IS NULL OR ct.email_normalized = '')
      AND (ct.first_name IS NOT NULL OR ct.last_name IS NOT NULL)
      ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT ?`,
    [workspaceId, companyId, limit],
  ).map(mapContact);
}

const INSERT_COLUMNS = [
  'id', 'workspace_id', 'company_id', 'first_name', 'last_name', 'full_name', 'title', 'role_category', 'email',
  'email_normalized', 'email_type', 'email_status', 'phone', 'linkedin_url', 'country', 'language', 'department',
  'is_primary', 'confidence', 'last_verified_at', 'created_by', 'created_at', 'updated_at',
];

export function insertContact(data) {
  run(
    `INSERT INTO contacts (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    INSERT_COLUMNS.map((column) => (data[column] === undefined ? null : data[column])),
  );
  return findContact(data.workspace_id, data.id);
}

const UPDATE_COLUMNS = new Set([
  'first_name', 'last_name', 'full_name', 'title', 'role_category', 'email', 'email_normalized', 'email_type',
  'email_status', 'phone', 'linkedin_url', 'country', 'language', 'department', 'is_primary', 'confidence',
  'last_verified_at', 'updated_at',
]);

export function updateContact(workspaceId, contactId, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findContact(workspaceId, contactId);
  run(
    `UPDATE contacts SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [...entries.map(([, value]) => value), contactId, workspaceId],
  );
  return findContact(workspaceId, contactId);
}

export function clearPrimaryContacts(workspaceId, companyId, exceptContactId = null) {
  if (exceptContactId) {
    run(
      `UPDATE contacts SET is_primary = 0, updated_at = ? WHERE workspace_id = ? AND company_id = ? AND id <> ? AND is_primary = 1`,
      [new Date().toISOString(), workspaceId, companyId, exceptContactId],
    );
    return;
  }
  run(
    `UPDATE contacts SET is_primary = 0, updated_at = ? WHERE workspace_id = ? AND company_id = ? AND is_primary = 1`,
    [new Date().toISOString(), workspaceId, companyId],
  );
}

export function softDeleteContact(workspaceId, contactId) {
  const now = new Date().toISOString();
  return (
    run(`UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [
      now,
      now,
      contactId,
      workspaceId,
    ]).changes > 0
  );
}

// ------------------------------------------------------------------ sources
export function addContactSource(workspaceId, contactId, source = {}) {
  run(
    `INSERT INTO contact_sources (id, workspace_id, contact_id, source_type, source_url, method, retrieved_at, confidence, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      source.id,
      workspaceId,
      contactId,
      source.sourceType,
      source.sourceUrl || null,
      source.method || 'manual',
      source.retrievedAt,
      Number.isFinite(source.confidence) ? source.confidence : 0,
      JSON.stringify(source.payload && typeof source.payload === 'object' ? source.payload : {}),
      source.retrievedAt,
    ],
  );
  return source.id;
}

export function countContactSources(workspaceId, contactId) {
  return get('SELECT COUNT(*) AS c FROM contact_sources WHERE workspace_id = ? AND contact_id = ?', [workspaceId, contactId])?.c ?? 0;
}

export function listContactSources(workspaceId, contactId, { limit = 100, offset = 0 } = {}) {
  return all(
    `SELECT * FROM contact_sources WHERE workspace_id = ? AND contact_id = ? ORDER BY retrieved_at DESC LIMIT ? OFFSET ?`,
    [workspaceId, contactId, limit, offset],
  ).map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    url: row.source_url,
    method: row.method,
    retrievedAt: row.retrieved_at,
    confidence: row.confidence,
    payload: (() => {
      try {
        return JSON.parse(row.payload_json || '{}');
      } catch {
        return {};
      }
    })(),
  }));
}
