/**
 * Company repository: SQL only, always scoped by workspace_id.
 * Row mapping to camelCase API objects lives here; business rules live in
 * services/companies.mjs.
 */
import { all, get, run } from '../core/db.mjs';
import { jsonArray, paged } from './helpers.mjs';

/** Whitelisted ORDER BY builder that accepts qualified columns and whitelisted sub-selects. */
function orderSql(column, direction) {
  const isSafe =
    typeof column === 'string' &&
    (/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column) ||
      (column.startsWith('(SELECT ') && column.endsWith(')') && !/[;'"]/.test(column)));
  const safeColumn = isSafe ? column : 'created_at';
  const safeDirection = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${safeColumn} ${safeDirection}`;
}

const COMPANY_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM contacts ct
       WHERE ct.company_id = c.id AND ct.workspace_id = c.workspace_id AND ct.deleted_at IS NULL) AS contacts_count,
    (SELECT COUNT(*) FROM contacts ct
       WHERE ct.company_id = c.id AND ct.workspace_id = c.workspace_id AND ct.deleted_at IS NULL
         AND ct.email_normalized IS NOT NULL AND ct.email_normalized <> '' AND ct.email_status <> 'invalid') AS email_count,
    (SELECT MAX(s.score) FROM lead_scores s
       WHERE s.company_id = c.id AND s.workspace_id = c.workspace_id) AS latest_score,
    (SELECT a.state FROM automation_states a
       WHERE a.company_id = c.id AND a.workspace_id = c.workspace_id LIMIT 1) AS automation_state,
    (SELECT MAX(src.retrieved_at) FROM company_sources src
       WHERE src.company_id = c.id AND src.workspace_id = c.workspace_id) AS last_sourced_at,
    (SELECT MAX(activity_at) FROM (
       SELECT MAX(t.last_message_at) AS activity_at FROM email_threads t
        WHERE t.company_id = c.id AND t.workspace_id = c.workspace_id
       UNION ALL
       SELECT MAX(a.occurred_at) FROM sales_activities a
        WHERE a.company_id = c.id AND a.workspace_id = c.workspace_id
       UNION ALL
       SELECT MAX(d.created_at) FROM message_drafts d
        WHERE d.company_id = c.id AND d.workspace_id = c.workspace_id
       UNION ALL
       SELECT MAX(dl.created_at) FROM deals dl
        WHERE dl.company_id = c.id AND dl.workspace_id = c.workspace_id
    )) AS last_activity_at
  FROM companies c`;

export function mapCompany(row) {
  if (!row) return null;
  const company = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    normalizedName: row.normalized_name,
    domain: row.domain || null,
    website: row.website || null,
    country: row.country || null,
    region: row.region || null,
    city: row.city || null,
    address: row.address || null,
    companyType: row.company_type || null,
    industry: row.industry || null,
    employeeRange: row.employee_range || null,
    revenueRange: row.revenue_range || null,
    description: row.description || null,
    linkedinUrl: row.linkedin_url || null,
    phone: row.phone || null,
    status: row.status,
    tags: jsonArray(row.tags_json),
    icpId: row.icp_id || null,
    ownerUserId: row.owner_user_id || null,
    dataQualityScore: row.data_quality_score,
    confidence: row.confidence,
    lastVerifiedAt: row.last_verified_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
  if (row.contacts_count !== undefined) {
    company.contactsCount = row.contacts_count;
    company.contactCount = row.contacts_count;
  }
  if (row.email_count !== undefined) company.emailCount = row.email_count;
  if (row.latest_score !== undefined) {
    company.latestScore = row.latest_score === null ? null : row.latest_score;
    company.score = company.latestScore;
  }
  if (row.automation_state !== undefined) company.automationState = row.automation_state || null;
  if (row.last_sourced_at !== undefined) company.lastSourcedAt = row.last_sourced_at || null;
  if (row.last_activity_at !== undefined) company.lastActivityAt = row.last_activity_at || null;
  return company;
}

function like(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** Build the shared WHERE clause for company list / export queries. */
export function buildCompanyWhere(workspaceId, filters = {}) {
  const where = ['c.workspace_id = ?', 'c.deleted_at IS NULL'];
  const params = [workspaceId];
  const f = filters;

  if (f.q) {
    const needle = like(f.q);
    where.push(
      `(c.name LIKE ? ESCAPE '\\' OR c.normalized_name LIKE ? ESCAPE '\\' OR c.domain LIKE ? ESCAPE '\\'
        OR c.description LIKE ? ESCAPE '\\' OR c.city LIKE ? ESCAPE '\\' OR c.industry LIKE ? ESCAPE '\\')`,
    );
    params.push(needle, needle, needle, needle, needle, needle);
  }
  if (f.domain) {
    where.push('c.domain = ?');
    params.push(f.domain);
  }
  if (Array.isArray(f.statuses) && f.statuses.length) {
    where.push(`c.status IN (${f.statuses.map(() => '?').join(',')})`);
    params.push(...f.statuses);
  }
  if (Array.isArray(f.countries) && f.countries.length) {
    where.push(`c.country IN (${f.countries.map(() => '?').join(',')})`);
    params.push(...f.countries);
  }
  if (f.icpId) {
    where.push('c.icp_id = ?');
    params.push(f.icpId);
  }
  if (f.ownerUserId) {
    where.push('c.owner_user_id = ?');
    params.push(f.ownerUserId);
  }
  if (f.companyType) {
    where.push('c.company_type = ?');
    params.push(f.companyType);
  }
  if (f.industry) {
    where.push('c.industry = ?');
    params.push(f.industry);
  }
  if (f.tag) {
    where.push(`c.tags_json LIKE ? ESCAPE '\\'`);
    params.push(`%"${String(f.tag).replace(/[\\%_"]/g, '')}"%`);
  }
  if (f.productId) {
    where.push(
      `(EXISTS (SELECT 1 FROM company_product_matches m
                 WHERE m.company_id = c.id AND m.workspace_id = c.workspace_id AND m.product_id = ?)
       OR EXISTS (SELECT 1 FROM lead_scores ls
                 WHERE ls.company_id = c.id AND ls.workspace_id = c.workspace_id AND ls.product_id = ?))`,
    );
    params.push(f.productId, f.productId);
  }
  if (f.minScore !== null && f.minScore !== undefined) {
    where.push(
      `(SELECT MAX(s.score) FROM lead_scores s WHERE s.company_id = c.id AND s.workspace_id = c.workspace_id) >= ?`,
    );
    params.push(f.minScore);
  }
  if (f.maxScore !== null && f.maxScore !== undefined) {
    where.push(
      `(SELECT MAX(s.score) FROM lead_scores s WHERE s.company_id = c.id AND s.workspace_id = c.workspace_id) <= ?`,
    );
    params.push(f.maxScore);
  }
  if (f.hasEmail === true) {
    where.push(
      `EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND ct.workspace_id = c.workspace_id
                AND ct.deleted_at IS NULL AND ct.email_normalized IS NOT NULL AND ct.email_normalized <> '' AND ct.email_status <> 'invalid')`,
    );
  } else if (f.hasEmail === false) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND ct.workspace_id = c.workspace_id
                AND ct.deleted_at IS NULL AND ct.email_normalized IS NOT NULL AND ct.email_normalized <> '' AND ct.email_status <> 'invalid')`,
    );
  }
  if (f.hasContacts === true) {
    where.push(`EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND ct.workspace_id = c.workspace_id AND ct.deleted_at IS NULL)`);
  }
  if (f.automationState) {
    where.push(`EXISTS (SELECT 1 FROM automation_states a WHERE a.company_id = c.id AND a.workspace_id = c.workspace_id AND a.state = ?)`);
    params.push(f.automationState);
  }
  return { where: where.join(' AND '), params };
}

const COMPANY_SORT = {
  name: 'c.normalized_name',
  createdAt: 'c.created_at',
  updatedAt: 'c.updated_at',
  country: 'c.country',
  status: 'c.status',
  dataQualityScore: 'c.data_quality_score',
  score: '(SELECT MAX(s.score) FROM lead_scores s WHERE s.company_id = c.id AND s.workspace_id = c.workspace_id)',
  contactsCount: '(SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id AND ct.workspace_id = c.workspace_id AND ct.deleted_at IS NULL)',
};

export function listCompanies(workspaceId, filters = {}) {
  const { where, params } = buildCompanyWhere(workspaceId, filters);
  const total = get(`SELECT COUNT(*) AS c FROM companies c WHERE ${where}`, params)?.c ?? 0;
  const orderBy = orderSql(COMPANY_SORT[filters.sortKey] || 'c.created_at', filters.sortDirection);
  const rows = all(
    `${COMPANY_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return paged(rows.map(mapCompany), total, filters.page, filters.pageSize);
}

/** All companies matching filters without pagination (CSV export). */
export function listAllCompaniesForExport(workspaceId, filters = {}, max = 10000) {
  const { where, params } = buildCompanyWhere(workspaceId, filters);
  const rows = all(
    `${COMPANY_SELECT} WHERE ${where} ORDER BY c.created_at DESC LIMIT ?`,
    [...params, max],
  );
  return rows.map(mapCompany);
}

export function findCompany(workspaceId, companyId, { includeDeleted = false } = {}) {
  const extra = includeDeleted ? '' : 'AND c.deleted_at IS NULL';
  const row = get(`${COMPANY_SELECT} WHERE c.id = ? AND c.workspace_id = ? ${extra}`, [companyId, workspaceId]);
  return mapCompany(row);
}

export function findCompanyByDomain(workspaceId, domain) {
  if (!domain) return null;
  return mapCompany(
    get(`${COMPANY_SELECT} WHERE c.workspace_id = ? AND c.domain = ? LIMIT 1`, [workspaceId, domain]),
  );
}

export function findCompanyByNormalizedName(workspaceId, normalizedName) {
  if (!normalizedName) return null;
  return mapCompany(
    get(`${COMPANY_SELECT} WHERE c.workspace_id = ? AND c.normalized_name = ? LIMIT 1`, [workspaceId, normalizedName]),
  );
}

export function listCompanyIdsByDomain(workspaceId, domains) {
  if (!domains.length) return [];
  return all(
    `SELECT id, domain FROM companies WHERE workspace_id = ? AND domain IN (${domains.map(() => '?').join(',')})`,
    [workspaceId, ...domains],
  );
}

const INSERT_COLUMNS = [
  'id', 'workspace_id', 'name', 'normalized_name', 'domain', 'website', 'country', 'region', 'city', 'address',
  'company_type', 'industry', 'employee_range', 'revenue_range', 'description', 'linkedin_url', 'phone', 'status',
  'tags_json', 'icp_id', 'owner_user_id', 'data_quality_score', 'confidence', 'last_verified_at', 'created_by',
  'created_at', 'updated_at',
];

export function insertCompany(data) {
  const values = INSERT_COLUMNS.map((column) => (data[column] === undefined ? null : data[column]));
  run(
    `INSERT INTO companies (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    values,
  );
  return findCompany(data.workspace_id, data.id);
}

const UPDATE_COLUMNS = new Set([
  'name', 'normalized_name', 'domain', 'website', 'country', 'region', 'city', 'address', 'company_type', 'industry',
  'employee_range', 'revenue_range', 'description', 'linkedin_url', 'phone', 'status', 'tags_json', 'icp_id',
  'owner_user_id', 'data_quality_score', 'confidence', 'last_verified_at', 'updated_at',
]);

export function updateCompany(workspaceId, companyId, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findCompany(workspaceId, companyId);
  const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
  run(`UPDATE companies SET ${assignments} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [
    ...entries.map(([, value]) => value),
    companyId,
    workspaceId,
  ]);
  return findCompany(workspaceId, companyId);
}

export function softDeleteCompany(workspaceId, companyId) {
  const now = new Date().toISOString();
  const result = run(
    `UPDATE companies SET deleted_at = ?, updated_at = ?, status = 'archived' WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [now, now, companyId, workspaceId],
  );
  return result.changes > 0;
}

// ------------------------------------------------------------------ sources
export function addCompanySource(workspaceId, companyId, source = {}) {
  const sourceId = source.id;
  run(
    `INSERT INTO company_sources (id, workspace_id, company_id, source_type, source_name, source_url, retrieved_at, payload_json, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceId,
      workspaceId,
      companyId,
      source.sourceType,
      source.sourceName || null,
      source.sourceUrl || null,
      source.retrievedAt,
      JSON.stringify(source.payload && typeof source.payload === 'object' ? source.payload : {}),
      Number.isFinite(source.confidence) ? source.confidence : 0,
      source.retrievedAt,
    ],
  );
  return sourceId;
}

export function listCompanySources(workspaceId, companyId, { limit = 100, offset = 0 } = {}) {
  return all(
    `SELECT * FROM company_sources WHERE workspace_id = ? AND company_id = ? ORDER BY retrieved_at DESC LIMIT ? OFFSET ?`,
    [workspaceId, companyId, limit, offset],
  ).map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    url: row.source_url,
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

export function countCompanySources(workspaceId, companyId) {
  return get('SELECT COUNT(*) AS c FROM company_sources WHERE workspace_id = ? AND company_id = ?', [workspaceId, companyId])?.c ?? 0;
}

export function listCompanySourcesBulk(workspaceId, companyIds, { limit = 200 } = {}) {
  if (!companyIds.length) return [];
  return all(
    `SELECT * FROM company_sources WHERE workspace_id = ? AND company_id IN (${companyIds.map(() => '?').join(',')})
      ORDER BY retrieved_at DESC LIMIT ?`,
    [workspaceId, ...companyIds, limit],
  );
}

/** Latest discovery run id recorded on a company source (read-only traceability). */
export function findCompaniesByDiscoveryRun(workspaceId, discoveryRunId, { limit = 100 } = {}) {
  const rows = all(
    `SELECT DISTINCT c.id FROM company_sources s
       JOIN companies c ON c.id = s.company_id AND c.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.source_type = 'discovery' AND s.payload_json LIKE ? AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC LIMIT ?`,
    [workspaceId, `%"discoveryRunId":"${discoveryRunId}"%`, limit],
  );
  return rows.map((row) => row.id);
}

// ------------------------------------------------------------ verifications
export function addVerification(workspaceId, verification) {
  run(
    `INSERT INTO data_verifications (id, workspace_id, entity_type, entity_id, check_type, result, confidence, details_json, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      verification.id,
      workspaceId,
      verification.entityType,
      verification.entityId,
      verification.checkType,
      verification.result,
      Number.isFinite(verification.confidence) ? verification.confidence : 0,
      JSON.stringify(verification.details && typeof verification.details === 'object' ? verification.details : {}),
      verification.verifiedAt,
      verification.verifiedAt,
    ],
  );
  return verification.id;
}

export function listVerifications(workspaceId, entityType, entityId, { limit = 100 } = {}) {
  return all(
    `SELECT * FROM data_verifications WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?
      ORDER BY verified_at DESC LIMIT ?`,
    [workspaceId, entityType, entityId, limit],
  ).map((row) => ({
    id: row.id,
    checkType: row.check_type,
    result: row.result,
    confidence: row.confidence,
    details: (() => {
      try {
        return JSON.parse(row.details_json || '{}');
      } catch {
        return {};
      }
    })(),
    verifiedAt: row.verified_at,
  }));
}
