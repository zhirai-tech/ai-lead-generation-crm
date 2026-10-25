/**
 * Company service: creation, dedupe, filters, bulk actions and the aggregated
 * company detail used by the UI. Cross-module tables (threads, drafts, deals,
 * automation, activities) are read read-only with SQL joins so the company page
 * is a single request.
 */
import { all, get } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { conflict, notFound, validationError } from '../core/errors.mjs';
import { normalizeDomain, normalizeName } from '../core/validate.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import * as contactsRepo from '../repositories/contacts.mjs';
import * as icpsRepo from '../repositories/icps.mjs';
import * as scoringRepo from '../repositories/scoring.mjs';

export const COMPANY_STATUSES = ['new', 'qualified', 'contacted', 'replied', 'customer', 'disqualified', 'archived'];
export const CONFIDENCE_LEVELS = ['unverified', 'low', 'medium', 'high'];

const LEGAL_SUFFIX_RE =
  /\b(gmbh|mbh|ag|kg|ohg|ug|se|sarl|sas|sa|srl|spa|bv|nv|ltd|limited|llc|inc|corp|corporation|co|oy|ab|aps|as|sro|kft|doo|plc|pte|gbr|eurl|sl|srl|ltda)\b/g;

/**
 * Normalise a company name for dedupe: lowercase, strip legal suffixes and
 * punctuation, collapse whitespace. Two rows resolving to the same value are
 * treated as the same company when no domain is available.
 */
export function normalizeCompanyName(name) {
  return normalizeName(name)
    .toLowerCase()
    .replace(/[.,'’`()&+/\\-]/g, ' ')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeCompanyDataQuality(company, { contactsCount = 0, hasEmail = false } = {}) {
  let score = 0;
  if (company.name) score += 10;
  if (company.domain || company.website) score += 15;
  if (company.country) score += 10;
  if (company.city) score += 5;
  if (company.address) score += 10;
  if (company.description && company.description.length >= 40) score += 15;
  if (company.phone) score += 10;
  if (company.linkedinUrl) score += 5;
  if (company.companyType || company.industry) score += 10;
  if (contactsCount > 0) score += 5;
  if (hasEmail) score += 5;
  return Math.min(100, score);
}

/** Translate an API/import source descriptor into a company_sources row. */
export function normalizeCompanySource(source, defaultType = 'manual') {
  if (!source || typeof source !== 'object') return null;
  const confidence = Number(source.confidence);
  return {
    type: String(source.type || source.sourceType || defaultType).slice(0, 40),
    name: source.name || source.sourceName || null,
    url: source.url || source.sourceUrl || null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 50,
    payload: source.payload && typeof source.payload === 'object' ? source.payload : {},
    retrievedAt: source.retrievedAt || nowIso(),
  };
}

export function addCompanySource(workspaceId, companyId, source) {
  const normalized = normalizeCompanySource(source);
  if (!normalized) return null;
  return companiesRepo.addCompanySource(workspaceId, companyId, {
    id: id('src'),
    sourceType: normalized.type,
    sourceName: normalized.name,
    sourceUrl: normalized.url,
    retrievedAt: normalized.retrievedAt,
    payload: normalized.payload,
    confidence: normalized.confidence,
  });
}

function resolveIcp(workspaceId, icpId) {
  if (!icpId) return null;
  const icp = icpsRepo.findIcp(workspaceId, icpId);
  if (!icp) throw validationError('所选 ICP 不存在');
  return icp;
}

function resolveOwner(workspaceId, ownerUserId) {
  if (!ownerUserId) return null;
  const member = get(
    "SELECT user_id FROM memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
    [workspaceId, ownerUserId],
  );
  if (!member) throw validationError('负责人必须是当前工作空间成员');
  return ownerUserId;
}

/**
 * Low-level insert shared by manual creation, CSV import, discovery and the
 * enrichment flow. It performs dedupe-free insertion plus optional source and
 * audit records. Business callers decide how to dedupe first.
 */
export function createCompanyRecord(workspaceId, input, { actorId = null, audit = true, ip, userAgent, requestId } = {}) {
  const name = normalizeName(input.name);
  if (!name) throw validationError('企业名称不能为空');
  const domain = input.domain ? normalizeDomain(input.domain) : '';
  if (input.domain && !domain) throw validationError('企业域名格式不正确');
  const normalizedName = normalizeCompanyName(name);
  const now = nowIso();
  const icp = resolveIcp(workspaceId, input.icpId || null);
  const ownerUserId = resolveOwner(workspaceId, input.ownerUserId || null);
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim().slice(0, 40)).slice(0, 30) : [];
  const status = COMPANY_STATUSES.includes(input.status) ? input.status : 'new';
  const confidence = CONFIDENCE_LEVELS.includes(input.confidence) ? input.confidence : 'unverified';
  const companyId = id('cmp');
  const data = {
    id: companyId,
    workspace_id: workspaceId,
    name: name.slice(0, 200),
    normalized_name: normalizedName.slice(0, 200),
    domain: domain || null,
    website: input.website || (domain ? `https://${domain}` : null),
    country: input.country || null,
    region: input.region || null,
    city: input.city || null,
    address: input.address || null,
    company_type: input.companyType || null,
    industry: input.industry || null,
    employee_range: input.employeeRange || null,
    revenue_range: input.revenueRange || null,
    description: input.description ? String(input.description).slice(0, 4000) : null,
    linkedin_url: input.linkedinUrl || null,
    phone: input.phone || null,
    status,
    tags_json: JSON.stringify(tags),
    icp_id: icp ? icp.id : null,
    owner_user_id: ownerUserId,
    data_quality_score: 0,
    confidence,
    last_verified_at: input.lastVerifiedAt || null,
    created_by: actorId || null,
    created_at: now,
    updated_at: now,
  };
  let company = companiesRepo.insertCompany(data);
  const contactsCount = 0;
  const quality = computeCompanyDataQuality({ ...company, tags }, { contactsCount, hasEmail: false });
  company = companiesRepo.updateCompany(workspaceId, companyId, { data_quality_score: quality, updated_at: now }) || company;
  if (input.source) addCompanySource(workspaceId, companyId, input.source);
  if (audit) {
    recordAudit({
      workspaceId,
      actorType: actorId ? 'user' : 'system',
      actorId,
      action: 'company.create',
      entityType: 'company',
      entityId: companyId,
      after: company,
      ip,
      userAgent,
      requestId,
    });
  }
  return company;
}

export function createCompany(workspaceId, input, context = {}) {
  const domain = input.domain ? normalizeDomain(input.domain) : '';
  if (domain) {
    const existing = companiesRepo.findCompanyByDomain(workspaceId, domain);
    if (existing) throw conflict(`该域名已存在：${existing.name}`);
  }
  return createCompanyRecord(workspaceId, { ...input, domain }, context);
}

export function computeContactCompleteness(company, { contactsCount = 0, emailCount = 0 } = {}) {
  const hasDomain = Boolean(company.domain || company.website);
  const hasEmail = Number(emailCount) > 0;
  const hasPhone = Boolean(company.phone);
  const hasAddress = Boolean(company.address);
  const hasLinkedin = Boolean(company.linkedinUrl);
  let score = 0;
  if (hasDomain) score += 20;
  if (hasEmail) score += 25;
  if (hasPhone) score += 20;
  if (hasAddress) score += 15;
  if (hasLinkedin) score += 5;
  if (Number(contactsCount) > 0) score += 10;
  let level = 'D';
  if (hasDomain && hasEmail && hasPhone && hasAddress) level = 'A';
  else if (hasDomain && hasEmail && hasPhone) level = 'B';
  else if (hasDomain && (hasEmail || hasPhone)) level = 'C';
  else if (hasDomain) level = 'D';
  else level = 'none';
  return {
    score: Math.min(100, score),
    level,
    hasDomain,
    hasEmail,
    hasPhone,
    hasAddress,
    hasLinkedin,
  };
}

function withCompleteness(company) {
  const completeness = computeContactCompleteness(company, {
    contactsCount: company.contactsCount ?? company.contactCount ?? 0,
    emailCount: company.emailCount ?? 0,
  });
  const status = String(company.status || 'new');
  let leadStage = 'potential';
  if (status === 'contacted') leadStage = 'contacted';
  else if (status === 'replied') leadStage = 'intent';
  else if (status === 'customer') leadStage = 'customer';
  else if (status === 'qualified') leadStage = 'qualified';
  else if (status === 'disqualified' || status === 'archived') leadStage = 'excluded';
  else if (!completeness.hasDomain) leadStage = 'discovered';
  else if (!completeness.hasEmail) leadStage = 'new_lead';
  else leadStage = 'potential';
  return { ...company, contactCompleteness: completeness, leadStage };
}

export function listCompanies(workspaceId, filters, sort) {
  const limit = filters.limit ?? filters.pageSize ?? 25;
  const result = companiesRepo.listCompanies(workspaceId, {
    ...filters,
    limit,
    offset: filters.offset ?? 0,
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? limit,
    sortKey: sort?.key,
    sortDirection: sort?.direction,
  });
  return {
    ...result,
    items: (result.items || []).map(withCompleteness),
  };
}

export function getCompanyOrThrow(workspaceId, companyId) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  return company;
}

const UPDATABLE_TEXT_FIELDS = [
  ['name', 'name', 200],
  ['website', 'website', 2000],
  ['country', 'country', 8],
  ['region', 'region', 120],
  ['city', 'city', 120],
  ['address', 'address', 500],
  ['companyType', 'company_type', 80],
  ['industry', 'industry', 120],
  ['employeeRange', 'employee_range', 40],
  ['revenueRange', 'revenue_range', 40],
  ['description', 'description', 4000],
  ['linkedinUrl', 'linkedin_url', 2000],
  ['phone', 'phone', 60],
  ['lastVerifiedAt', 'last_verified_at', 40],
];

export function updateCompany(workspaceId, companyId, patch, context = {}) {
  const before = getCompanyOrThrow(workspaceId, companyId);
  const changes = {};
  for (const [apiField, column, max] of UPDATABLE_TEXT_FIELDS) {
    if (patch[apiField] !== undefined) {
      const value = patch[apiField] === null ? null : String(patch[apiField]).trim().slice(0, max);
      changes[column] = value || null;
    }
  }
  if (patch.name !== undefined) {
    if (!changes.name) throw validationError('企业名称不能为空');
    changes.normalized_name = normalizeCompanyName(changes.name);
  }
  if (patch.domain !== undefined) {
    const domain = patch.domain ? normalizeDomain(patch.domain) : '';
    if (patch.domain && !domain) throw validationError('企业域名格式不正确');
    if (domain) {
      const existing = companiesRepo.findCompanyByDomain(workspaceId, domain);
      if (existing && existing.id !== companyId) throw conflict(`该域名已存在：${existing.name}`);
    }
    changes.domain = domain || null;
    if (!patch.website && domain) changes.website = `https://${domain}`;
  }
  if (patch.status !== undefined) {
    if (!COMPANY_STATUSES.includes(patch.status)) throw validationError('企业状态不在允许范围内');
    changes.status = patch.status;
  }
  if (patch.confidence !== undefined) {
    if (!CONFIDENCE_LEVELS.includes(patch.confidence)) throw validationError('可信度不在允许范围内');
    changes.confidence = patch.confidence;
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) throw validationError('标签必须是数组');
    changes.tags_json = JSON.stringify(
      patch.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim().slice(0, 40)).slice(0, 30),
    );
  }
  if (patch.icpId !== undefined) {
    const icp = resolveIcp(workspaceId, patch.icpId || null);
    changes.icp_id = icp ? icp.id : null;
  }
  if (patch.ownerUserId !== undefined) {
    changes.owner_user_id = resolveOwner(workspaceId, patch.ownerUserId || null);
  }
  changes.updated_at = nowIso();
  const merged = { ...before, ...patch };
  const contacts = contactsRepo.listContactsForCompany(workspaceId, companyId);
  changes.data_quality_score = computeCompanyDataQuality(merged, {
    contactsCount: contacts.length,
    hasEmail: contacts.some((contact) => contact.emailStatus !== 'invalid' && Boolean(contact.emailNormalized)),
  });
  const company = companiesRepo.updateCompany(workspaceId, companyId, changes);
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'company.update',
    entityType: 'company',
    entityId: companyId,
    before,
    after: company,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return company;
}

export function deleteCompany(workspaceId, companyId, context = {}) {
  const before = getCompanyOrThrow(workspaceId, companyId);
  if (!companiesRepo.softDeleteCompany(workspaceId, companyId)) throw notFound('企业不存在');
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'company.delete',
    entityType: 'company',
    entityId: companyId,
    before,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { deleted: true, id: companyId };
}

/** Bulk score / archive / assign. Returns per-id outcome for the UI. */
export async function bulkCompanyAction(workspaceId, { action, ids, productId = null, ownerUserId = null }, context = {}) {
  const uniqueIds = [...new Set((ids || []).filter((value) => typeof value === 'string' && value))];
  if (!uniqueIds.length) throw validationError('请至少选择一家企业');
  if (uniqueIds.length > 200) throw validationError('单次最多操作 200 家企业');
  const companies = uniqueIds.map((companyId) => companiesRepo.findCompany(workspaceId, companyId));
  const missing = uniqueIds.filter((companyId, index) => !companies[index]);
  if (missing.length) throw notFound(`部分企业不存在或无权限：${missing.slice(0, 5).join(', ')}`);

  const now = nowIso();
  let affected = 0;
  if (action === 'archive') {
    for (const company of companies) {
      companiesRepo.updateCompany(workspaceId, company.id, { status: 'archived', updated_at: now });
      affected += 1;
    }
  } else if (action === 'delete') {
    for (const company of companies) {
      if (companiesRepo.softDeleteCompany(workspaceId, company.id)) affected += 1;
    }
  } else if (action === 'assign') {
    const owner = resolveOwner(workspaceId, ownerUserId);
    for (const company of companies) {
      companiesRepo.updateCompany(workspaceId, company.id, { owner_user_id: owner, updated_at: now });
      affected += 1;
    }
  } else if (action === 'score') {
    const { scoreCompany } = await import('./scoring.mjs');
    if (!productId) throw validationError('批量评分需要提供产品');
    for (const company of companies) {
      await scoreCompany({ workspaceId, companyId: company.id, productId, actorId: context.actorId || null });
      affected += 1;
    }
  } else if (action === 'enrich') {
    const { enqueueJob } = await import('../jobs/queue.mjs');
    for (const company of companies) {
      try {
        enqueueJob({
          workspaceId,
          type: 'company.enrich',
          payload: { companyId: company.id, companyName: company.name },
          dedupeKey: `company.enrich:${workspaceId}:${company.id}`,
          createdBy: context.actorId || null,
          maxAttempts: 3,
          priority: 80,
        });
        affected += 1;
      } catch {
        // keep going: one blocked queue write must not stop the batch
      }
    }
  } else if (action === 'draft') {
    const drafts = await import('./drafts.mjs');
    const contactsRepo = await import('../repositories/contacts.mjs');
    const language = context.language || 'en';
    for (const company of companies) {
      const contact = contactsRepo.listContactsForCompany(workspaceId, company.id, { limit: 10 })
        .find((item) => item.email && item.emailNormalized);
      if (!contact) continue;
      try {
        const draft = drafts.create(workspaceId, {
          companyId: company.id,
          contactId: contact.id,
          language,
          subject: '',
          bodyText: '',
        }, { actorId: context.actorId || null });
        affected += 1;
        try {
          await drafts.generateDraft({
            workspaceId,
            draftId: draft.id,
            actorType: 'user',
            actorId: context.actorId || null,
          });
        } catch {
          // keep the empty draft; it can be generated later from the drafts page
        }
      } catch {
        // one model/provider failure must not stop the whole batch
      }
    }
  } else if (action === 'status') {
    if (!COMPANY_STATUSES.includes(context.status)) throw validationError('企业状态不在允许范围内');
    for (const company of companies) {
      companiesRepo.updateCompany(workspaceId, company.id, { status: context.status, updated_at: now });
      affected += 1;
    }
  } else {
    throw validationError('不支持的批量操作');
  }
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: `company.bulk_${action}`,
    entityType: 'company',
    entityId: null,
    after: { action, ids: uniqueIds.slice(0, 200), productId, count: affected },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { action, requested: uniqueIds.length, updated: affected, productId, ownerUserId: ownerUserId || null };
}

// ---------------------------------------------------------------- aggregation
function selectAll(sql, params) {
  try {
    return all(sql, params);
  } catch {
    return [];
  }
}

function selectOne(sql, params) {
  try {
    return get(sql, params);
  } catch {
    return null;
  }
}

function computeTimeline(workspaceId, companyId, company, contacts) {
  const events = [];
  const push = (type, at, title, extra = {}) => {
    if (!at) return;
    events.push({ type, at, title, ...extra });
  };

  push('company_created', company.createdAt, '企业创建', { entityType: 'company', entityId: company.id, summary: company.name });
  if (company.updatedAt && company.updatedAt !== company.createdAt) {
    push('company_updated', company.updatedAt, '企业资料更新', { entityType: 'company', entityId: company.id });
  }

  for (const source of companiesRepo.listCompanySources(workspaceId, companyId, { limit: 50 })) {
    push('source', source.retrievedAt, `数据来源：${source.sourceName || source.sourceType}`, {
      entityType: 'company_source',
      entityId: source.id,
      summary: source.sourceUrl || '',
      meta: { sourceType: source.sourceType, confidence: source.confidence },
    });
  }
  for (const row of selectAll(
    'SELECT * FROM data_verifications WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? ORDER BY verified_at DESC LIMIT 30',
    [workspaceId, 'company', companyId],
  )) {
    push('verification', row.verified_at, `企业校验：${row.check_type} ${row.result}`, {
      entityType: 'data_verification',
      entityId: row.id,
      meta: { result: row.result, confidence: row.confidence },
    });
  }
  for (const score of scoringRepo.listLeadScoresForCompany(workspaceId, companyId)) {
    push('score', score.scoredAt, `规则评分 ${score.score} 分（${score.grade} 级）`, {
      entityType: 'lead_score',
      entityId: score.id,
      summary: score.productName || '',
      meta: { grade: score.grade, productId: score.productId },
    });
  }
  for (const feedback of scoringRepo.listScoreFeedbackForCompany(workspaceId, companyId, { limit: 20 })) {
    push('score_feedback', feedback.createdAt, `评分反馈：${feedback.field}`, {
      entityType: 'score_feedback',
      entityId: feedback.id,
      summary: feedback.reason || '',
    });
  }
  for (const contact of contacts) {
    push('contact_created', contact.createdAt, `新增联系人：${contact.fullName || contact.email || '未命名'}`, {
      entityType: 'contact',
      entityId: contact.id,
      summary: contact.title || '',
    });
    if (contact.lastVerifiedAt) {
      push('contact_verified', contact.lastVerifiedAt, `联系人邮箱校验：${contact.emailStatus}`, {
        entityType: 'contact',
        entityId: contact.id,
        summary: contact.email || '',
      });
    }
  }
  for (const thread of selectAll(
    `SELECT * FROM email_threads WHERE workspace_id = ? AND company_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 30`,
    [workspaceId, companyId],
  )) {
    push('email_thread', thread.last_message_at || thread.created_at, `邮件线程：${thread.subject || '(无主题)'}`, {
      entityType: 'email_thread',
      entityId: thread.id,
      meta: { status: thread.status, messageCount: thread.message_count },
    });
  }
  for (const draft of selectAll(
    'SELECT * FROM message_drafts WHERE workspace_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 30',
    [workspaceId, companyId],
  )) {
    push('draft', draft.created_at, `开发信草稿：${draft.subject || '(无主题)'}`, {
      entityType: 'message_draft',
      entityId: draft.id,
      meta: { status: draft.status },
    });
  }
  for (const deal of selectAll(
    'SELECT * FROM deals WHERE workspace_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 30',
    [workspaceId, companyId],
  )) {
    push('deal', deal.created_at, `商机：${deal.title}`, {
      entityType: 'deal',
      entityId: deal.id,
      summary: `${deal.stage} · ${deal.status}`,
    });
  }
  for (const activity of selectAll(
    'SELECT * FROM sales_activities WHERE workspace_id = ? AND company_id = ? ORDER BY occurred_at DESC LIMIT 30',
    [workspaceId, companyId],
  )) {
    push('activity', activity.occurred_at, `销售动态（${activity.type}）：${activity.subject || ''}`, {
      entityType: 'sales_activity',
      entityId: activity.id,
      summary: activity.body || '',
    });
  }
  const automation = selectOne('SELECT * FROM automation_states WHERE workspace_id = ? AND company_id = ?', [
    workspaceId,
    companyId,
  ]);
  if (automation) {
    push('automation', automation.changed_at, `自动化状态：${automation.state}`, {
      entityType: 'automation_state',
      entityId: automation.id,
      summary: automation.reason || '',
    });
  }
  for (const task of selectAll(
    'SELECT * FROM follow_up_tasks WHERE workspace_id = ? AND company_id = ? ORDER BY due_at DESC LIMIT 20',
    [workspaceId, companyId],
  )) {
    push('follow_up', task.due_at, `跟进任务：${task.title}`, {
      entityType: 'follow_up_task',
      entityId: task.id,
      meta: { status: task.status },
    });
  }

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return events;
}

export function getCompanyTimeline(workspaceId, companyId, { types = [], page = 1, pageSize = 25 } = {}) {
  const company = getCompanyOrThrow(workspaceId, companyId);
  const contacts = contactsRepo.listContactsForCompany(workspaceId, companyId);
  let events = computeTimeline(workspaceId, companyId, company, contacts);
  if (types.length) events = events.filter((event) => types.includes(event.type));
  const total = events.length;
  const offset = (page - 1) * pageSize;
  return { items: events.slice(offset, offset + pageSize), total, page, pageSize, hasMore: offset + pageSize < total };
}

export function getCompanySources(workspaceId, companyId, { page = 1, pageSize = 25 } = {}) {
  getCompanyOrThrow(workspaceId, companyId);
  const total = companiesRepo.countCompanySources(workspaceId, companyId);
  const items = companiesRepo.listCompanySources(workspaceId, companyId, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

export function getCompanyVerifications(workspaceId, companyId) {
  getCompanyOrThrow(workspaceId, companyId);
  return { items: companiesRepo.listVerifications(workspaceId, 'company', companyId) };
}

/** Full company detail used by GET /api/v1/companies/:id. */
export function getCompanyDetail(workspaceId, companyId) {
  const company = getCompanyOrThrow(workspaceId, companyId);
  const contacts = contactsRepo.listContactsForCompany(workspaceId, companyId).map((contact) => ({
    ...contact,
    sources: contactsRepo.listContactSources(workspaceId, contact.id, { limit: 20 }),
  }));
  const companySources = companiesRepo.listCompanySources(workspaceId, companyId, { limit: 100 });
  const matches = scoringRepo.listMatchesForCompany(workspaceId, companyId);
  const scores = scoringRepo.listLeadScoresForCompany(workspaceId, companyId);
  const scoreFeedback = scoringRepo.listScoreFeedbackForCompany(workspaceId, companyId);
  const icp = company.icpId ? icpsRepo.findIcp(workspaceId, company.icpId) : null;
  const automation = selectOne('SELECT * FROM automation_states WHERE workspace_id = ? AND company_id = ?', [
    workspaceId,
    companyId,
  ]);
  const emailThreads = selectAll(
    `SELECT t.*, c.full_name AS contact_name
       FROM email_threads t LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.workspace_id = ? AND t.company_id = ?
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 20`,
    [workspaceId, companyId],
  ).map((row) => ({
    id: row.id,
    contactId: row.contact_id || null,
    contactName: row.contact_name || null,
    subject: row.subject || null,
    status: row.status,
    classification: row.classification || null,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at || null,
    createdAt: row.created_at,
  }));
  const recentMessages = selectAll(
    `SELECT id, thread_id, contact_id, direction, from_address, subject, sent_at, received_at, status, is_read
       FROM email_messages WHERE workspace_id = ? AND company_id = ?
      ORDER BY COALESCE(sent_at, received_at, created_at) DESC LIMIT 20`,
    [workspaceId, companyId],
  ).map((row) => ({
    id: row.id,
    threadId: row.thread_id || null,
    contactId: row.contact_id || null,
    direction: row.direction,
    fromAddress: row.from_address || null,
    subject: row.subject || null,
    at: row.sent_at || row.received_at || null,
    status: row.status,
    isRead: Boolean(row.is_read),
  }));
  const drafts = selectAll(
    'SELECT * FROM message_drafts WHERE workspace_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 20',
    [workspaceId, companyId],
  ).map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    campaignId: row.campaign_id || null,
    subject: row.subject,
    bodyText: row.body_text,
    language: row.language,
    status: row.status,
    approvedAt: row.approved_at || null,
    scheduledAt: row.scheduled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const deals = selectAll(
    'SELECT * FROM deals WHERE workspace_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 20',
    [workspaceId, companyId],
  ).map((row) => ({
    id: row.id,
    title: row.title,
    stage: row.stage,
    status: row.status,
    valueAmount: row.value_amount,
    currency: row.currency,
    expectedCloseDate: row.expected_close_date || null,
    ownerUserId: row.owner_user_id || null,
    createdAt: row.created_at,
    closedAt: row.closed_at || null,
  }));
  const activities = selectAll(
    'SELECT * FROM sales_activities WHERE workspace_id = ? AND company_id = ? ORDER BY occurred_at DESC LIMIT 30',
    [workspaceId, companyId],
  ).map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subject || null,
    body: row.body || null,
    occurredAt: row.occurred_at,
    userId: row.user_id || null,
  }));
  const followUpTasks = selectAll(
    'SELECT * FROM follow_up_tasks WHERE workspace_id = ? AND company_id = ? ORDER BY due_at DESC LIMIT 20',
    [workspaceId, companyId],
  ).map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    notes: row.notes || null,
    status: row.status,
    dueAt: row.due_at,
    assignedTo: row.assigned_to || null,
  }));
  const timeline = computeTimeline(workspaceId, companyId, company, contacts);
  const verifications = companiesRepo.listVerifications(workspaceId, 'company', companyId, { limit: 50 });

  return {
    company,
    icp,
    contacts,
    sources: companySources,
    matches,
    scores,
    scoreFeedback,
    automation: automation
      ? {
          state: automation.state,
          reason: automation.reason || null,
          changedBy: automation.changed_by || null,
          changedAt: automation.changed_at,
        }
      : null,
    automationState: automation ? automation.state : null,
    emailThreads,
    threads: emailThreads,
    recentMessages,
    drafts,
    deals,
    activities,
    followUpTasks,
    verifications,
    timeline: timeline.slice(0, 50),
    stats: {
      contacts: contacts.length,
      contactsWithEmail: contacts.filter((contact) => Boolean(contact.emailNormalized)).length,
      verifiedContacts: contacts.filter((contact) => contact.emailStatus === 'valid').length,
      inferredContacts: contacts.filter((contact) => contact.emailStatus === 'inferred').length,
      sources: companySources.length,
      scores: scores.length,
      matches: matches.length,
      threads: emailThreads.length,
      drafts: drafts.length,
      deals: deals.length,
      maxScore: scores.length ? Math.max(...scores.map((score) => score.score)) : null,
      timelineEvents: timeline.length,
    },
  };
}
