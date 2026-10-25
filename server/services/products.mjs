/**
 * Product catalogue service plus the pure rule-based product/company matcher
 * shared with the scoring service.
 *
 * Truthfulness invariant: certifications, capacity, MOQ, pricing and lead time
 * are stored exactly as entered by the user. This module never invents them.
 */
import { notFound, validationError } from '../core/errors.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import * as productsRepo from '../repositories/products.mjs';
import { getSetting } from './settings.mjs';
import { agentUnavailable, decorateProduct, decorateProducts } from './product-files.mjs';

export const PRODUCT_STATUSES = ['active', 'draft', 'archived'];
export const MAX_KEYWORDS = 30;
export const MAX_KEYWORD_LENGTH = 80;

const TEXT_FIELDS = [
  ['name', 'name', 200],
  ['category', 'category', 120],
  ['sku', 'sku', 80],
  ['description', 'description', 4000],
  ['materials', 'materials', 500],
  ['capacity', 'capacity', 500],
  ['moq', 'moq', 200],
  ['pricingTerms', 'pricing_terms', 500],
  ['samples', 'samples', 500],
  ['leadTime', 'lead_time', 200],
];

function stringArray(value, { max = 100, itemMax = 200, label = '列表' } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${label}必须是数组`);
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, itemMax))
    .slice(0, max);
}

function objectValue(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw validationError(`${label}必须是对象`);
  return value;
}

/**
 * Normalise keyword arrays: trim, collapse whitespace, truncate, dedupe
 * case-insensitively and cap the count.
 */
export function normalizeKeywords(value, { max = MAX_KEYWORDS, itemMax = MAX_KEYWORD_LENGTH } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError('关键词必须是数组');
  const seen = new Set();
  const keywords = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const keyword = item.trim().replace(/\s+/g, ' ').slice(0, itemMax);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= max) break;
  }
  return keywords;
}

export function listProducts(workspaceId, filters, sort) {
  const result = productsRepo.listProducts(workspaceId, { ...filters, sortKey: sort?.key, sortDirection: sort?.direction });
  return { ...result, items: decorateProducts(workspaceId, result.items) };
}

export function getProductOrThrow(workspaceId, productId) {
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  return product;
}

/** Product detail with `files` / `mainImageUrl` (used by the HTTP layer). */
export function getProductDetail(workspaceId, productId) {
  return decorateProduct(workspaceId, getProductOrThrow(workspaceId, productId));
}

export function createProduct(workspaceId, input, context = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw validationError('产品名称不能为空');
  const now = nowIso();
  const product = productsRepo.insertProduct({
    id: id('prd'),
    workspace_id: workspaceId,
    name: name.slice(0, 200),
    category: input.category ? String(input.category).slice(0, 120) : null,
    sku: input.sku ? String(input.sku).slice(0, 80) : null,
    description: input.description ? String(input.description).slice(0, 4000) : null,
    specs_json: JSON.stringify(objectValue(input.specs, '产品规格')),
    applications_json: JSON.stringify(stringArray(input.applications, { label: '应用领域' })),
    materials: input.materials ? String(input.materials).slice(0, 500) : null,
    certifications_json: JSON.stringify(stringArray(input.certifications, { label: '认证' })),
    capacity: input.capacity ? String(input.capacity).slice(0, 500) : null,
    moq: input.moq ? String(input.moq).slice(0, 200) : null,
    pricing_terms: input.pricingTerms ? String(input.pricingTerms).slice(0, 500) : null,
    samples: input.samples ? String(input.samples).slice(0, 500) : null,
    lead_time: input.leadTime ? String(input.leadTime).slice(0, 200) : null,
    status: PRODUCT_STATUSES.includes(input.status) ? input.status : 'active',
    keywords_json: JSON.stringify(normalizeKeywords(input.keywords)),
    main_image_file_id: null,
    created_by: context.actorId || null,
    created_at: now,
    updated_at: now,
  });
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'product.create',
    entityType: 'product',
    entityId: product.id,
    after: product,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return decorateProduct(workspaceId, product);
}

export function updateProduct(workspaceId, productId, patch, context = {}) {
  const before = getProductOrThrow(workspaceId, productId);
  const changes = {};
  for (const [apiField, column, max] of TEXT_FIELDS) {
    if (patch[apiField] !== undefined) {
      const value = patch[apiField] === null ? null : String(patch[apiField]).trim().slice(0, max);
      changes[column] = value || null;
    }
  }
  if (patch.name !== undefined && !changes.name) throw validationError('产品名称不能为空');
  if (patch.specs !== undefined) changes.specs_json = JSON.stringify(objectValue(patch.specs, '产品规格'));
  if (patch.applications !== undefined) changes.applications_json = JSON.stringify(stringArray(patch.applications, { label: '应用领域' }));
  if (patch.certifications !== undefined) {
    changes.certifications_json = JSON.stringify(stringArray(patch.certifications, { label: '认证' }));
  }
  if (patch.status !== undefined) {
    if (!PRODUCT_STATUSES.includes(patch.status)) throw validationError('产品状态不在允许范围内');
    changes.status = patch.status;
  }
  if (patch.keywords !== undefined) changes.keywords_json = JSON.stringify(normalizeKeywords(patch.keywords));
  changes.updated_at = nowIso();
  const product = productsRepo.updateProduct(workspaceId, productId, changes);
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'product.update',
    entityType: 'product',
    entityId: productId,
    before,
    after: product,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return decorateProduct(workspaceId, product);
}

export function deleteProduct(workspaceId, productId, context = {}) {
  const before = getProductOrThrow(workspaceId, productId);
  if (!productsRepo.softDeleteProduct(workspaceId, productId)) throw notFound('产品不存在');
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'product.delete',
    entityType: 'product',
    entityId: productId,
    before,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { deleted: true, id: productId };
}

// ------------------------------------------------------------- product match
const AUTOMOTIVE_KEYWORDS = [
  'automotive', 'auto', 'car', 'vehicle', 'kfz', 'ersatzteil', 'autoteil', 'pièce', 'pieces', 'ricambi', 'recambio',
  'autoparts', 'aftermarket', 'oem', 'truck', 'brake', 'filter', 'suspension', 'bearing', 'clutch', 'engine',
];
const BUYER_TYPE_KEYWORDS = [
  'distributor', 'wholesaler', 'wholesale', 'importer', 'import', 'trading', 'trader', 'retailer', 'retail', 'dealer',
  'supplier', 'reseller', 'großhandel', 'grosshandel', 'handel', 'négoce', 'commercio', 'distribuidor', 'dystrybutor',
];
const BUYER_COMPANY_TYPES = new Set([
  'distributor', 'wholesaler', 'importer', 'retailer', 'dealer', 'trader', 'trading_company', 'reseller',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9äöüßéèêàçñ]+/i)
    .filter((token) => token.length > 2);
}

/**
 * Pure rule matcher. Returns {score (0..1), reasons[], evidence[]}.
 * No AI, no network, deterministic and unit-testable.
 */
export function matchProductRules(product, company, { identity = null } = {}) {
  const reasons = [];
  const evidence = [];
  if (!product || !company) return { score: 0, reasons: ['缺少产品或企业信息'], evidence: [] };
  const isPlatform = identity?.role === 'platform';
  const companyText = [company.name, company.industry, company.description, company.companyType, company.region]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const companyTokens = new Set(tokenize(companyText));
  let score = 0;

  // 1) Industry / product category overlap.
  const categoryTokens = [...tokenize(product.category), ...tokenize(product.name)];
  const categoryHits = categoryTokens.filter((token) => companyTokens.has(token));
  if (categoryHits.length) {
    score += Math.min(0.25, 0.1 + categoryHits.length * 0.05);
    reasons.push(`企业资料与产品类目关键词重合：${[...new Set(categoryHits)].slice(0, 4).join('、')}`);
    evidence.push({ type: 'category', matched: [...new Set(categoryHits)].slice(0, 8) });
  }

  // 2) Application keywords explained in the product sheet.
  const applicationHits = [];
  for (const application of product.applications || []) {
    const tokens = tokenize(application);
    if (tokens.some((token) => companyTokens.has(token))) applicationHits.push(application);
  }
  if (applicationHits.length) {
    score += Math.min(0.3, applicationHits.length * 0.1);
    reasons.push(`产品应用领域与企业业务相符：${applicationHits.slice(0, 3).join('、')}`);
    evidence.push({ type: 'applications', matched: applicationHits.slice(0, 5) });
  }

  // 3) Materials referenced by the company.
  const materialHits = tokenize(product.materials).filter((token) => companyTokens.has(token));
  if (materialHits.length) {
    score += 0.1;
    reasons.push(`企业资料提及相关材料：${[...new Set(materialHits)].slice(0, 3).join('、')}`);
    evidence.push({ type: 'materials', matched: [...new Set(materialHits)].slice(0, 5) });
  }

  // 4) Buyer profile: distributors / importers / wholesalers are the ICP.
  // Platform catalogue pages must not inherit their suppliers' buyer signals.
  const buyerHit = !isPlatform && (BUYER_COMPANY_TYPES.has(String(company.companyType || '').toLowerCase())
    || identity?.role === 'direct_buyer'
    || BUYER_TYPE_KEYWORDS.some((word) => companyText.includes(word)));
  if (buyerHit) {
    score += 0.2;
    reasons.push('企业属于进口商/分销商/批发商类型，具备采购动机');
    evidence.push({ type: 'buyer_profile', matched: company.companyType || identity?.companyType || 'keyword' });
  } else if (isPlatform) {
    reasons.push('平台/供应商目录中的商品和批发关键词不计入自身采购匹配');
    evidence.push({ type: 'platform_identity', matched: 'catalog_not_own_buying' });
  }

  // 5) Automotive aftermarket industry fit.
  const industryHit = AUTOMOTIVE_KEYWORDS.filter((word) => companyText.includes(word));
  if (industryHit.length) {
    score += Math.min(0.2, 0.08 + industryHit.length * 0.03);
    reasons.push('企业处于汽车零部件/售后市场相关行业');
    evidence.push({ type: 'industry', matched: [...new Set(industryHit)].slice(0, 6) });
  }

  // 6) Certification mentions both sides (only user-provided certifications).
  const certificationHits = (product.certifications || []).filter((cert) => {
    const token = String(cert).toLowerCase().replace(/[^a-z0-9]/g, '');
    return token && companyText.replace(/[^a-z0-9]/g, '').includes(token.slice(0, Math.max(3, Math.min(6, token.length))));
  });
  if (certificationHits.length) {
    score += 0.1;
    reasons.push(`企业资料提及相关认证：${certificationHits.slice(0, 3).join('、')}`);
    evidence.push({ type: 'certifications', matched: certificationHits.slice(0, 5) });
  }

  if (!reasons.length) reasons.push('未发现明确的产品匹配信号，建议人工确认');
  return { score: Math.max(0, Math.min(1, Number(score.toFixed(3)))), reasons, evidence };
}

export function listActiveProducts(workspaceId) {
  return productsRepo.listActiveProducts(workspaceId);
}

// ------------------------------------------------------- AI keyword research
/**
 * Generate English B2B discovery keywords for a product via the t-agents
 * `keyword_research` role, then persist them on the product.
 *
 * Never fabricates keywords: when the agent module/role is unavailable or the
 * output is unusable, a 503 AGENT_UNAVAILABLE is thrown and nothing is saved.
 */
export async function generateProductKeywordsForProduct(workspaceId, productId, context = {}) {
  const product = getProductOrThrow(workspaceId, productId);
  let agentModule = null;
  try {
    agentModule = await import('../agents/index.mjs');
  } catch (error) {
    throw agentUnavailable(error && error.message);
  }
  const generate = agentModule.generateProductKeywords;
  if (typeof generate !== 'function') throw agentUnavailable('generateProductKeywords is not exported');
  let output = null;
  try {
    output = await generate({
      workspaceId,
      product,
      actorType: context.actorId ? 'user' : 'system',
      actorId: context.actorId || null,
      createdBy: context.actorId || null,
    });
  } catch (error) {
    throw agentUnavailable(error && error.message);
  }
  if (!output || typeof output !== 'object' || !Array.isArray(output.keywords)) {
    throw agentUnavailable('keyword agent returned an unexpected payload');
  }
  const keywords = normalizeKeywords(output.keywords);
  if (!keywords.length) throw agentUnavailable('keyword agent returned no keywords');
  const negativeKeywords = normalizeKeywords(output.negativeKeywords, { max: 15 });
  const searchQueries = Array.isArray(output.searchQueries)
    ? output.searchQueries
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 200))
        .slice(0, 10)
    : [];
  const notes = typeof output.notes === 'string' ? output.notes.slice(0, 1000) : '';
  const aiSettings = getSetting(workspaceId, 'ai');
  const provider = (typeof output.provider === 'string' && output.provider) || aiSettings.provider || null;

  productsRepo.updateProduct(workspaceId, productId, {
    keywords_json: JSON.stringify(keywords),
    updated_at: nowIso(),
  });
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'product.keywords_generate',
    entityType: 'product',
    entityId: productId,
    before: { keywords: product.keywords || [] },
    after: { keywords, negativeKeywords, provider },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { keywords, negativeKeywords, notes, searchQueries, provider };
}
