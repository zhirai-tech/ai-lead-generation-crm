/**
 * OWNER: t-crm.
 *
 * Read-only lookups into the data domain (companies / contacts / products /
 * ICPs / lead scores) that the outreach & CRM services need. The data domain
 * owns the write paths; this module only issues SELECTs and maps rows to the
 * camelCase shape used by the HTTP API.
 *
 * Every query is scoped by workspace_id.
 */
import { all, get } from '../core/db.mjs';
import { jsonArray, jsonObject } from './helpers.mjs';

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

// ------------------------------------------------------------------ companies
export function mapCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    normalizedName: row.normalized_name,
    domain: row.domain,
    website: row.website,
    country: row.country,
    region: row.region,
    city: row.city,
    address: row.address,
    companyType: row.company_type,
    industry: row.industry,
    employeeRange: row.employee_range,
    revenueRange: row.revenue_range,
    description: row.description,
    linkedinUrl: row.linkedin_url,
    phone: row.phone,
    status: row.status,
    tags: jsonArray(row.tags_json),
    icpId: row.icp_id,
    ownerUserId: row.owner_user_id,
    dataQualityScore: row.data_quality_score,
    confidence: row.confidence,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCompany(workspaceId, companyId) {
  if (!companyId) return null;
  const row = get('SELECT * FROM companies WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [workspaceId, companyId]);
  return mapCompany(row);
}

export function getCompanyByDomain(workspaceId, domain) {
  if (!domain) return null;
  const row = get('SELECT * FROM companies WHERE workspace_id = ? AND domain = ? AND deleted_at IS NULL', [workspaceId, domain]);
  return mapCompany(row);
}

export function listCompaniesByIds(workspaceId, companyIds) {
  const ids = [...new Set((companyIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return all(
    `SELECT * FROM companies WHERE workspace_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
    [workspaceId, ...ids],
  ).map(mapCompany);
}

/** Select primary contact emails for a set of companies (used for enrollment). */
export function listEnrollableContacts(workspaceId, { companyIds = [], contactIds = [] } = {}) {
  const collected = new Map();
  const ids = [...new Set((contactIds || []).filter(Boolean))];
  for (const row of ids.length
    ? all(
        `SELECT * FROM contacts
          WHERE workspace_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids.length)})
          ORDER BY is_primary DESC, created_at ASC`,
        [workspaceId, ...ids],
      )
    : []) {
    collected.set(row.id, row);
  }
  const companies = [...new Set((companyIds || []).filter(Boolean))];
  if (companies.length) {
    const rows = all(
      `SELECT * FROM contacts
        WHERE workspace_id = ? AND deleted_at IS NULL AND company_id IN (${placeholders(companies.length)})
        ORDER BY company_id ASC, is_primary DESC, created_at ASC`,
      [workspaceId, ...companies],
    );
    for (const row of rows) {
      if (!collected.has(row.id)) collected.set(row.id, row);
    }
  }
  return [...collected.values()].map(mapContact);
}

// ------------------------------------------------------------------- contacts
export function mapContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    title: row.title,
    roleCategory: row.role_category,
    email: row.email,
    emailNormalized: row.email_normalized,
    emailType: row.email_type,
    emailStatus: row.email_status,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    country: row.country,
    language: row.language,
    department: row.department,
    isPrimary: Boolean(row.is_primary),
    confidence: row.confidence,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getContact(workspaceId, contactId) {
  if (!contactId) return null;
  const row = get('SELECT * FROM contacts WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [workspaceId, contactId]);
  return mapContact(row);
}

export function listContactsByIds(workspaceId, contactIds) {
  const ids = [...new Set((contactIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return all(
    `SELECT * FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
    [workspaceId, ...ids],
  ).map(mapContact);
}

export function listContactsForCompany(workspaceId, companyId) {
  return all(
    'SELECT * FROM contacts WHERE workspace_id = ? AND company_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, created_at ASC',
    [workspaceId, companyId],
  ).map(mapContact);
}

export function getContactByEmail(workspaceId, email) {
  if (!email) return null;
  const row = get('SELECT * FROM contacts WHERE workspace_id = ? AND email_normalized = ? AND deleted_at IS NULL', [workspaceId, email.toLowerCase()]);
  return mapContact(row);
}

export function listCompanyEmails(workspaceId, companyId) {
  return all(
    `SELECT email_normalized FROM contacts
      WHERE workspace_id = ? AND company_id = ? AND deleted_at IS NULL AND email_normalized IS NOT NULL AND email_normalized <> ''`,
    [workspaceId, companyId],
  )
    .map((row) => row.email_normalized)
    .filter(Boolean);
}

// ------------------------------------------------------------------- products
export function mapProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    category: row.category,
    sku: row.sku,
    description: row.description,
    specs: jsonObject(row.specs_json),
    applications: jsonArray(row.applications_json),
    materials: row.materials,
    certifications: jsonArray(row.certifications_json),
    capacity: row.capacity,
    moq: row.moq,
    pricingTerms: row.pricing_terms,
    samples: row.samples,
    leadTime: row.lead_time,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getProduct(workspaceId, productId) {
  if (!productId) return null;
  const row = get('SELECT * FROM products WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [workspaceId, productId]);
  return mapProduct(row);
}

/** Pick the best matching product for a company when a campaign does not pin one. */
export function getMatchedProduct(workspaceId, companyId) {
  const row = get(
    `SELECT p.* FROM company_product_matches m
       JOIN products p ON p.id = m.product_id AND p.workspace_id = m.workspace_id AND p.deleted_at IS NULL
      WHERE m.workspace_id = ? AND m.company_id = ? AND m.status IN ('confirmed', 'suggested')
      ORDER BY CASE m.status WHEN 'confirmed' THEN 0 ELSE 1 END, m.match_score DESC
      LIMIT 1`,
    [workspaceId, companyId],
  );
  return mapProduct(row);
}

// ------------------------------------------------------------------------ ICP
export function mapIcp(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id,
    name: row.name,
    description: row.description,
    targetCountries: jsonArray(row.target_countries_json),
    targetRegions: jsonArray(row.target_regions_json),
    targetCompanyTypes: jsonArray(row.target_company_types_json),
    targetSizes: jsonArray(row.target_sizes_json),
    targetRoles: jsonArray(row.target_roles_json),
    includeKeywords: jsonArray(row.include_keywords_json),
    excludeKeywords: jsonArray(row.exclude_keywords_json),
    minScore: row.min_score,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getIcp(workspaceId, icpId) {
  if (!icpId) return null;
  return mapIcp(get('SELECT * FROM icps WHERE workspace_id = ? AND id = ?', [workspaceId, icpId]));
}

// ----------------------------------------------------------------- lead score
export function getLatestLeadScore(workspaceId, companyId, productId = null) {
  const row = productId
    ? get(
        'SELECT * FROM lead_scores WHERE workspace_id = ? AND company_id = ? AND product_id = ? ORDER BY scored_at DESC LIMIT 1',
        [workspaceId, companyId, productId],
      )
    : get('SELECT * FROM lead_scores WHERE workspace_id = ? AND company_id = ? ORDER BY scored_at DESC LIMIT 1', [workspaceId, companyId]);
  if (!row) return null;
  return {
    score: row.score,
    grade: row.grade,
    factors: jsonArray(row.factors_json),
    exclusions: jsonArray(row.exclusions_json),
    explanation: row.explanation,
    modelVersion: row.model_version,
    scoredAt: row.scored_at,
  };
}

// -------------------------------------------------------------------- members
/** True when the user is an active member of the workspace (assignee checks). */
export function isWorkspaceMember(workspaceId, userId) {
  if (!workspaceId || !userId) return false;
  return Boolean(
    get(
      `SELECT 1 AS ok FROM memberships m
        JOIN users u ON u.id = m.user_id AND u.is_active = 1
       WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'active'`,
      [workspaceId, userId],
    ),
  );
}

export function listWorkspaceMembers(workspaceId) {
  return all(
    `SELECT u.id, u.name, u.email, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id AND u.is_active = 1
      WHERE m.workspace_id = ? AND m.status = 'active'
      ORDER BY u.name ASC`,
    [workspaceId],
  ).map((row) => ({ id: row.id, name: row.name, email: row.email, role: row.role }));
}

// -------------------------------------------------------- agent executions
/**
 * The convenience agent functions (CONTRACTS 7.3) return only the model output,
 * not the execution id. For traceability (drafts.generated_by /
 * classifications.agent_execution_id) we fall back to the latest matching
 * execution row when the agent did not return an id.
 */
export function latestAgentExecutionId(workspaceId, agentRole, sinceIso) {
  if (!workspaceId || !agentRole) return null;
  const row = sinceIso
    ? get(
        `SELECT id FROM agent_executions
          WHERE workspace_id = ? AND agent_role = ? AND created_at >= ?
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, agentRole, sinceIso],
      )
    : get(
        `SELECT id FROM agent_executions
          WHERE workspace_id = ? AND agent_role = ?
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, agentRole],
      );
  return row?.id ?? null;
}
