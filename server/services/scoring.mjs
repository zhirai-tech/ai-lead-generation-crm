/**
 * Rule-based, explainable lead scoring. No AI and no network calls: the score is
 * a deterministic weighted sum over product fit, company profile, buying
 * signals, data quality and contact quality, plus hard exclusion rules.
 *
 * Every factor carries its weight, its 0..1 score and a human-readable reason so
 * the UI can explain the number. Exclusions force the score to 0 / grade D.
 */
import { all, get, run } from '../core/db.mjs';
import { validationError, notFound } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import * as contactsRepo from '../repositories/contacts.mjs';
import * as productsRepo from '../repositories/products.mjs';
import * as icpsRepo from '../repositories/icps.mjs';
import * as scoringRepo from '../repositories/scoring.mjs';
import { matchProductRules } from './products.mjs';

export const SCORE_MODEL_VERSION = 'rules-v1';

export const FACTOR_DEFINITIONS = [
  { key: 'product_match', label: '产品匹配度', weight: 0.25 },
  { key: 'company_type', label: '企业类型匹配', weight: 0.1 },
  { key: 'region', label: '目标地区匹配', weight: 0.15 },
  { key: 'buying_scenario', label: '采购场景', weight: 0.15 },
  { key: 'data_confidence', label: '信息可信度', weight: 0.1 },
  { key: 'contact_confidence', label: '联系方式可信度', weight: 0.15 },
  { key: 'recent_signal', label: '近期采购信号', weight: 0.1 },
];

const REGION_COUNTRIES = {
  western_europe: ['DE', 'FR', 'NL', 'BE', 'LU', 'AT', 'CH', 'IE', 'GB'],
  southern_europe: ['IT', 'ES', 'PT', 'GR', 'MT', 'CY'],
  northern_europe: ['SE', 'NO', 'DK', 'FI', 'IS', 'EE', 'LV', 'LT'],
  eastern_europe: ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'SI', 'HR', 'RS', 'UA'],
  central_europe: ['DE', 'AT', 'CH', 'PL', 'CZ', 'SK', 'HU', 'SI'],
};

const BUYING_KEYWORDS = [
  'import', 'importer', 'distributor', 'wholesale', 'wholesaler', 'trading', 'sourcing', 'procurement', 'purchase',
  'purchasing', 'supplier', 'reseller', 'dealer', 'großhandel', 'grosshandel', 'handel', 'négoce', 'commercio',
  'distribuidor', 'dystrybutor', 'aftermarket', 'oem', 'rfq', 'quote', 'quotation', 'catalog', 'katalog',
];

const DIRECT_BUYER_TYPES = new Set([
  'distributor', 'wholesaler', 'wholesale', 'importer', 'import', 'trader', 'trading', 'trading_company',
  'reseller', 'dealer', 'retailer',
]);

const PLATFORM_TYPES = new Set([
  'platform', 'marketplace', 'marketplace_operator', 'directory', 'aggregator', 'b2b_marketplace',
]);

const PLATFORM_DESCRIPTION_PATTERNS = [
  /\bb2b\s+(?:online\s+)?(?:groß|gross)?handels(?:marktplatz|plattform)\b/i,
  /\b(?:online\s+)?(?:groß|gross)?handelsmarktplatz\b/i,
  /\bb2b\s+(?:online\s+)?(?:handels)?marktplatz\b/i,
  /\bb2b\s+(?:online\s+)?handelsplattform\b/i,
  /\bb2b\s+(?:online\s+)?marketplace\b/i,
  /\b(?:supplier|company|business)\s+directory\b/i,
  /\b(?:firmen|lieferanten|unternehmens)verzeichnis\b/i,
  /\b(?:gelbe\s+seiten|yellow\s+pages)\b/i,
  /\b(?:marketplace|platform)\s+operator\b/i,
];

const DIRECT_BUYER_DESCRIPTION_PATTERNS = [
  /\bimporter\b/i,
  /\bimport(?:s|ing|ed)?\b/i,
  /\bdistributor\b/i,
  /\bwholesaler\b/i,
  /\bwholesale\b/i,
  /\bgroßhandel\b/i,
  /\bgrosshandel\b/i,
  /\bgroßhändler\b/i,
  /\bgrosshaendler\b/i,
  /\btrading(?:\s+company)?\b/i,
  /\btrader\b/i,
  /\breseller\b/i,
  /\bdealer\b/i,
  /\bretailer\b/i,
];

/**
 * Infer the company's operating role from fields already stored on the record.
 * This is intentionally conservative and evidence-labelled:
 * - platform/marketplace phrases take precedence when a platform also mentions
 *   wholesale/catalog keywords;
 * - direct-buyer role requires an actual buyer/wholesale phrase, not just an
 *   industry word;
 * - no inference is made from a search title alone.
 */
export function inferCompanyIdentity(company = {}) {
  const explicitType = String(company.companyType || '').trim().toLowerCase().replace(/\s+/g, '_');
  const text = [company.name, company.description, company.industry, company.companyType]
    .filter(Boolean)
    .join(' ');
  const evidence = [];
  if (explicitType) evidence.push(`company_type:${explicitType}`);
  const platformHit = PLATFORM_DESCRIPTION_PATTERNS.find((pattern) => pattern.test(text));
  if (PLATFORM_TYPES.has(explicitType) || platformHit) {
    return {
      role: 'platform',
      companyType: explicitType || 'platform',
      confidence: 'explicit',
      evidence: platformHit ? [...evidence, `description:${platformHit.source}`] : evidence,
    };
  }
  if (DIRECT_BUYER_TYPES.has(explicitType)) {
    return { role: 'direct_buyer', companyType: explicitType, confidence: 'explicit', evidence };
  }
  const directHit = DIRECT_BUYER_DESCRIPTION_PATTERNS.find((pattern) => pattern.test(text));
  if (directHit) {
    let inferredType = 'direct_buyer';
    if (/\bimporter\b|\bimport(?:s|ing|ed)?\b/i.test(text)) inferredType = 'importer';
    else if (/\bdistributor\b/i.test(text)) inferredType = 'distributor';
    else if (/\bwholesaler\b|\bwholesale\b|\bgroßhandel\b|\bgrosshandel\b|\bgroßhändler\b|\bgrosshaendler\b/i.test(text)) inferredType = 'wholesaler';
    else if (/\btrader\b|\btrading(?:\s+company)?\b/i.test(text)) inferredType = 'trader';
    return {
      role: 'direct_buyer',
      companyType: inferredType,
      confidence: 'inferred',
      evidence: [...evidence, `description:${directHit.source}`],
    };
  }
  if (explicitType) {
    return { role: 'other', companyType: explicitType, confidence: 'explicit', evidence };
  }
  return { role: 'unknown', companyType: null, confidence: 'unknown', evidence };
}

export const QUALIFICATION_VALUES = ['qualified', 'rejected', 'insufficient_evidence'];

const REPORT_DESCRIPTION_PATTERNS = [
  /\bmarket\s+report\b/i,
  /\bafter[-\s]?sales\s+intelligence\b/i,
  /\bwebshops?\b/i,
];

const RETAIL_ONLY_PATTERNS = [
  /\bb2c\b/i,
  /\bendkunde(?:n)?\b/i,
  /\beinzelhandel\b/i,
  /\bonline[-\s]?shop\b/i,
  /\bwebshop\b/i,
];

const MANUFACTURER_BRAND_PATTERNS = [
  /\bhersteller\b/i,
  /\bmanufacturer\b/i,
  /\bmarkenhersteller\b/i,
  /\bown\s+brand\b/i,
  /\beigene\s+marke\b/i,
];

function qualificationCountries(icp) {
  const raw = icp?.targetCountries ?? icp?.target_countries_json ?? [];
  if (Array.isArray(raw)) return raw.map((country) => String(country).toUpperCase());
  try {
    return JSON.parse(raw).map((country) => String(country).toUpperCase());
  } catch {
    return [];
  }
}

function qualificationSourceText(sources = []) {
  const chunks = [];
  for (const source of sources) {
    chunks.push(source.source_type, source.source_name, source.source_url);
    try {
      const payload = typeof source.payload_json === 'string' ? JSON.parse(source.payload_json) : source.payload_json || {};
      chunks.push(payload.title, payload.description, payload.text, payload.snippet);
    } catch {
      // Malformed source payloads are not evidence.
    }
  }
  return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function isBusinessPageUrl(source) {
  const url = String(source?.source_url || '').trim();
  if (!url) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path !== '';
  } catch {
    return false;
  }
}

function officialSourceTexts(sources = []) {
  const chunks = [];
  for (const source of sources) {
    const type = String(source.source_type || '').toLowerCase();
    if (!['crawl', 'browser', 'web'].includes(type) || !isBusinessPageUrl(source)) continue;
    try {
      const payload = typeof source.payload_json === 'string' ? JSON.parse(source.payload_json) : source.payload_json || {};
      chunks.push(payload.title, payload.description, payload.text, payload.snippet);
    } catch {
      // Malformed source payloads are not evidence.
    }
  }
  return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function hasOfficialEvidence(sources) {
  return (sources || []).some(
    (source) => ['crawl', 'browser', 'web'].includes(String(source.source_type || '').toLowerCase()) && isBusinessPageUrl(source),
  );
}

/**
 * Evidence-based ICP classification. It deliberately does not use lead score:
 * a score is a ranking signal, not proof that the company is a target buyer.
 * If official/company evidence is too thin, the result must be
 * insufficient_evidence, never a guessed qualified/rejected.
 */
export function classifyCompanyQualification({ company = {}, sources = [], icp = null } = {}) {
  const evidence = [];
  const text = [company.name, company.description, company.industry, company.companyType]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  const sourceText = qualificationSourceText(sources);
  const officialText = officialSourceTexts(sources);
  const combined = `${text} ${sourceText}`.trim();
  const identity = inferCompanyIdentity(company);
  const countries = qualificationCountries(icp);
  const country = String(company.country || '').toUpperCase();
  const official = hasOfficialEvidence(sources);

  if (identity.role === 'platform') {
    evidence.push(...identity.evidence.slice(0, 2));
    return { qualification: 'rejected', reason: 'platform_or_directory', evidence, role: 'platform' };
  }
  if (REPORT_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(combined))) {
    return { qualification: 'rejected', reason: 'research_report_or_directory', evidence: ['description:report_or_webshop_directory'], role: 'other' };
  }
  if (countries.length && country && !countries.includes(country)) {
    return { qualification: 'rejected', reason: 'country_mismatch', evidence: [`country:${country}`, `icp:${countries.join(',')}`], role: identity.role };
  }

  const isDirect = identity.role === 'direct_buyer';
  const isRetailOnly = RETAIL_ONLY_PATTERNS.some((pattern) => pattern.test(combined));
  const hasWholesaleEvidence = /\b(?:b2b|wholesale|wholesaler|großhandel|grosshandel|großhändler|grosshaendler|distributor|importer|import)\b/i.test(text);
  const isManufacturerOrBrand = MANUFACTURER_BRAND_PATTERNS.some((pattern) => pattern.test(combined));

  if (isRetailOnly && !hasWholesaleEvidence) {
    return { qualification: 'rejected', reason: 'retail_only', evidence: ['description:retail_only'], role: 'retailer' };
  }
  if (isDirect) {
    evidence.push(...identity.evidence.slice(0, 2));
    const officialDirectEvidence = /\b(?:b2b|wholesale|wholesaler|großhandel|grosshandel|großhändler|grosshaendler|distributor|importer|import)\b/i.test(officialText);
    if (!official) {
      return { qualification: 'insufficient_evidence', reason: 'official_business_page_missing', evidence, role: identity.companyType || 'direct_buyer' };
    }
    if (!officialDirectEvidence) {
      return { qualification: 'insufficient_evidence', reason: 'official_business_role_unverified', evidence, role: identity.companyType || 'direct_buyer' };
    }
    return { qualification: 'qualified', reason: 'verified_direct_buyer', evidence, role: identity.companyType || 'direct_buyer' };
  }
  if (isManufacturerOrBrand && !isRetailOnly) {
    return { qualification: 'rejected', reason: 'manufacturer_or_brand', evidence: ['description:manufacturer_or_brand'], role: 'manufacturer_or_brand' };
  }
  if (isRetailOnly) {
    return { qualification: 'rejected', reason: 'retail_only', evidence: ['description:retail_only'], role: 'retailer' };
  }
  if (!official) {
    return { qualification: 'insufficient_evidence', reason: 'official_business_page_missing', evidence, role: identity.role };
  }
  return { qualification: 'insufficient_evidence', reason: 'business_role_not_verified', evidence, role: identity.role };
}

export function readQualificationFromTags(tags = []) {
  const tag = (Array.isArray(tags) ? tags : []).find((item) => String(item).startsWith('qualification:'));
  if (!tag) return null;
  const value = String(tag).slice('qualification:'.length);
  return QUALIFICATION_VALUES.includes(value) ? value : null;
}

export function readQualificationReasonFromTags(tags = []) {
  const tag = (Array.isArray(tags) ? tags : []).find((item) => String(item).startsWith('qualification_reason:'));
  return tag ? String(tag).slice('qualification_reason:'.length) : null;
}

export function withQualificationTags(tags = [], result = {}) {
  const cleaned = (Array.isArray(tags) ? tags : []).filter(
    (tag) => !String(tag).startsWith('qualification:') && !String(tag).startsWith('qualification_reason:'),
  );
  if (!QUALIFICATION_VALUES.includes(result.qualification)) return cleaned;
  const reason = String(result.reason || 'not_verified').replace(/[^a-z0-9_]/gi, '').slice(0, 30) || 'not_verified';
  return [...cleaned, `qualification:${result.qualification}`, `qualification_reason:${reason}`].slice(0, 30);
}

/**
 * Count a caller-supplied, already-deduplicated set of independent companies.
 * Only `qualified` is eligible for the target-customer quota; rejected and
 * insufficient_evidence never fill a qualified slot.
 */
export function summarizeQualification(companies = []) {
  const summary = { total: 0, qualified: 0, rejected: 0, insufficientEvidence: 0, unclassified: 0, verified: 0, qualifiedRate: 0 };
  for (const company of Array.isArray(companies) ? companies : []) {
    summary.total += 1;
    const value = company?.qualification;
    if (value === 'qualified') summary.qualified += 1;
    else if (value === 'rejected') summary.rejected += 1;
    else if (value === 'insufficient_evidence') summary.insufficientEvidence += 1;
    else summary.unclassified += 1;
  }
  summary.verified = summary.qualified + summary.rejected + summary.insufficientEvidence;
  summary.qualifiedRate = summary.verified ? Math.round((summary.qualified / summary.verified) * 1000) / 10 : 0;
  return summary;
}

export function gradeForScore(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function completenessRatio(company) {
  const fields = [
    company.domain || company.website,
    company.country,
    company.city,
    company.address,
    company.description,
    company.phone,
    company.linkedinUrl,
    company.industry || company.companyType,
  ];
  return fields.filter(Boolean).length / fields.length;
}

function evaluateCompanyType(company, icp, identity) {
  if (identity.role === 'platform') {
    return {
      score: 0.05,
      reason: '企业身份为 B2B 市场平台/供应商目录运营方，不是直接采购客户',
      evidence: identity.evidence,
    };
  }
  const effectiveType = identity.companyType || company.companyType;
  if (!icp || !Array.isArray(icp.targetCompanyTypes) || !icp.targetCompanyTypes.length) {
    return { score: 0.5, reason: '未设置 ICP 目标企业类型，按中性处理', evidence: identity.evidence };
  }
  const companyType = String(effectiveType || '').toLowerCase();
  const matched = icp.targetCompanyTypes.some((target) => companyType && companyType.includes(String(target).toLowerCase()));
  if (matched) {
    return {
      score: 1,
      reason: `企业类型（${effectiveType}${identity.confidence === 'inferred' ? '，由公开描述推断' : ''}）与 ICP 目标一致`,
      evidence: identity.evidence,
    };
  }
  if (!companyType) return { score: 0.35, reason: '企业类型未知，无法判断是否匹配 ICP', evidence: identity.evidence };
  return { score: 0.15, reason: `企业类型（${effectiveType}）不在 ICP 目标类型中`, evidence: identity.evidence };
}

function evaluateRegion(company, icp) {
  if (!icp) return { score: 0.5, reason: '未关联 ICP，地区按中性处理' };
  const country = String(company.country || '').toUpperCase();
  const countries = (icp.targetCountries || []).map((value) => String(value).toUpperCase());
  if (countries.length && country && countries.includes(country)) {
    return { score: 1, reason: `企业所在国家（${country}）属于 ICP 目标国家` };
  }
  const regions = icp.targetRegions || [];
  if (regions.length && country) {
    const regionHit = regions.some((region) => (REGION_COUNTRIES[String(region).toLowerCase()] || []).includes(country));
    if (regionHit) return { score: 0.85, reason: `企业所在国家（${country}）属于 ICP 目标区域` };
  }
  if (!country) return { score: 0.3, reason: '企业国家信息缺失' };
  if (!countries.length && !regions.length) return { score: 0.5, reason: 'ICP 未限定国家/区域，按中性处理' };
  return { score: 0.1, reason: `企业所在国家（${country}）不在 ICP 目标范围内` };
}

function evaluateBuyingScenario(company, product, identity = null) {
  if (identity?.role === 'platform') {
    return {
      score: 0.05,
      reason: '企业是平台/供应商目录运营方；目录中的批发、商品和 Katalog 关键词不代表其自身采购活动',
    };
  }
  const text = [company.name, company.industry, company.description, company.companyType, company.region]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const hits = BUYING_KEYWORDS.filter((keyword) => text.includes(keyword));
  const applications = (product.applications || []).filter((application) => text.includes(String(application).toLowerCase()));
  if (hits.length || applications.length) {
    const pieces = [];
    if (hits.length) pieces.push(`采购/分销关键词：${[...new Set(hits)].slice(0, 4).join('、')}`);
    if (applications.length) pieces.push(`产品应用场景：${applications.slice(0, 3).join('、')}`);
    return { score: clamp01(0.55 + hits.length * 0.1 + applications.length * 0.1), reason: pieces.join('；') };
  }
  if (identity?.role === 'direct_buyer') {
    return { score: 0.55, reason: `公开证据表明企业为 ${identity.companyType}，具备采购动机` };
  }
  if (company.companyType) {
    return { score: 0.4, reason: `企业类型为 ${company.companyType}，但未发现明确采购描述` };
  }
  return { score: 0.25, reason: '未发现明确的采购场景信号' };
}

function evaluateDataConfidence(company) {
  const base = { unverified: 0.2, low: 0.45, medium: 0.75, high: 1 }[company.confidence] ?? 0.2;
  const completeness = completenessRatio(company);
  const score = clamp01(base * 0.7 + completeness * 0.3);
  return {
    score,
    reason: `信息可信度为 ${company.confidence}，资料完整度 ${Math.round(completeness * 100)}%`,
  };
}

function evaluateContactConfidence(contacts) {
  if (!contacts.length) return { score: 0.05, reason: '尚未录入任何联系人' };
  const withEmail = contacts.filter((contact) => Boolean(contact.emailNormalized));
  const validDecisionMaker = contacts.find(
    (contact) => contact.roleCategory === 'decision_maker' && contact.emailStatus === 'valid',
  );
  if (validDecisionMaker) {
    return { score: 1, reason: `已有决策人且邮箱校验通过：${validDecisionMaker.fullName || validDecisionMaker.email}` };
  }
  if (contacts.some((contact) => contact.emailStatus === 'valid')) {
    return { score: 0.85, reason: '已有邮箱校验通过的联系人' };
  }
  if (contacts.some((contact) => contact.roleCategory === 'decision_maker')) {
    return { score: 0.6, reason: '已有决策人联系人，但邮箱尚未校验' };
  }
  if (contacts.some((contact) => contact.emailStatus === 'inferred')) {
    return { score: 0.35, reason: '仅有推测邮箱，可信度有限' };
  }
  if (withEmail.length) return { score: 0.5, reason: '已有联系人邮箱，但尚未校验' };
  return { score: 0.2, reason: '联系人均无邮箱' };
}

function evaluateRecentSignal(signals) {
  if (signals.repliedThreadAt) return { score: 1, reason: '存在已回复的邮件线程' };
  if (signals.lastDealAt) return { score: 0.9, reason: '存在近期商机记录' };
  if (signals.lastActivityAt) return { score: 0.7, reason: '近期有销售跟进记录' };
  if (signals.lastThreadAt) return { score: 0.5, reason: '存在邮件往来记录' };
  return { score: 0.3, reason: '暂无近期采购/沟通信号' };
}

function collectExclusions({ company, product, icp, contacts, signals }) {
  const exclusions = [];
  if (['disqualified', 'archived'].includes(company.status)) {
    exclusions.push({ code: 'company_status', label: '企业状态排除', reason: `企业状态为 ${company.status}，不参与优先排序` });
  }
  if (signals.suppressed) {
    exclusions.push({ code: 'suppressed', label: '退订/抑制名单', reason: '企业域名或联系人邮箱命中抑制名单' });
  }
  if (signals.automationState === 'DO_NOT_CONTACT') {
    exclusions.push({ code: 'do_not_contact', label: '禁止联系', reason: '自动化状态为 DO_NOT_CONTACT' });
  }
  if (product.status !== 'active') {
    exclusions.push({ code: 'product_inactive', label: '产品未上架', reason: `产品状态为 ${product.status}` });
  }
  if (icp && Array.isArray(icp.excludeKeywords) && icp.excludeKeywords.length) {
    const haystack = [company.name, company.description, company.industry].filter(Boolean).join(' ').toLowerCase();
    const hit = icp.excludeKeywords.find((keyword) => haystack.includes(String(keyword).toLowerCase()));
    if (hit) {
      exclusions.push({ code: 'icp_exclude_keyword', label: 'ICP 排除关键词', reason: `企业资料命中排除关键词：${hit}` });
    }
  }
  if (contacts.length && contacts.every((contact) => contact.emailStatus === 'invalid')) {
    exclusions.push({ code: 'all_emails_invalid', label: '邮箱全部无效', reason: '所有联系人邮箱校验均未通过' });
  }
  return exclusions;
}

/**
 * Pure scoring function (exported for unit tests and bulk operations).
 * @returns {{score:number, grade:string, factors:Array, exclusions:Array, explanation:string}}
 */
export function computeScore({ company, product, icp = null, contacts = [], signals = {} }) {
  const factors = [];
  const identity = inferCompanyIdentity(company);
  const productMatch = matchProductRules(product, company, { identity });
  factors.push({
    key: 'product_match',
    label: '产品匹配度',
    weight: 0.25,
    score: clamp01(productMatch.score),
    reason: productMatch.reasons.join('；'),
    evidence: productMatch.evidence,
  });
  const companyType = evaluateCompanyType(company, icp, identity);
  factors.push({
    key: 'company_type',
    label: '企业类型匹配',
    weight: 0.1,
    score: clamp01(companyType.score),
    reason: companyType.reason,
    evidence: companyType.evidence,
  });
  const region = evaluateRegion(company, icp);
  factors.push({ key: 'region', label: '目标地区匹配', weight: 0.15, score: clamp01(region.score), reason: region.reason });
  const buying = evaluateBuyingScenario(company, product, identity);
  factors.push({ key: 'buying_scenario', label: '采购场景', weight: 0.15, score: clamp01(buying.score), reason: buying.reason, evidence: identity.evidence });
  const dataConfidence = evaluateDataConfidence(company);
  factors.push({ key: 'data_confidence', label: '信息可信度', weight: 0.1, score: clamp01(dataConfidence.score), reason: dataConfidence.reason });
  const contactConfidence = evaluateContactConfidence(contacts);
  factors.push({
    key: 'contact_confidence',
    label: '联系方式可信度',
    weight: 0.15,
    score: clamp01(contactConfidence.score),
    reason: contactConfidence.reason,
  });
  const recent = evaluateRecentSignal(signals);
  factors.push({ key: 'recent_signal', label: '近期采购信号', weight: 0.1, score: clamp01(recent.score), reason: recent.reason });

  const exclusions = collectExclusions({ company, product, icp, contacts, signals });
  const weighted = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);
  const score = exclusions.length ? 0 : Math.max(0, Math.min(100, Math.round(weighted * 100)));
  const grade = exclusions.length ? 'D' : gradeForScore(score);

  const strengths = [...factors].sort((a, b) => b.weight * b.score - a.weight * a.score).slice(0, 3);
  const positive = strengths.filter((factor) => factor.score >= 0.5).map((factor) => factor.label);
  const parts = [`综合评分 ${score} 分（${grade} 级）`];
  if (positive.length) parts.push(`主要加分项：${positive.join('、')}`);
  if (exclusions.length) parts.push(`命中 ${exclusions.length} 条排除规则：${exclusions.map((item) => item.label).join('、')}`);
  else {
    const weakest = [...factors].sort((a, b) => a.score - b.score)[0];
    if (weakest) parts.push(`最弱项：${weakest.label}（${weakest.reason}）`);
  }
  return { score, grade, factors, exclusions, explanation: parts.join('；') + '。' };
}

function loadSignals(workspaceId, company, contacts) {
  const signals = { suppressed: false, automationState: null, repliedThreadAt: null, lastThreadAt: null, lastDealAt: null, lastActivityAt: null };
  const automation = get('SELECT state FROM automation_states WHERE workspace_id = ? AND company_id = ?', [workspaceId, company.id]);
  signals.automationState = automation?.state || null;
  const emails = contacts.map((contact) => contact.emailNormalized).filter(Boolean);
  const scopeChecks = [];
  if (company.domain) scopeChecks.push(['domain', company.domain]);
  for (const email of emails.slice(0, 20)) scopeChecks.push(['email', email]);
  if (scopeChecks.length) {
    const where = scopeChecks.map(() => '(scope = ? AND value_normalized = ?)').join(' OR ');
    const row = get(
      `SELECT 1 AS hit FROM suppression_records WHERE workspace_id = ? AND (${where}) LIMIT 1`,
      [workspaceId, ...scopeChecks.flat()],
    );
    signals.suppressed = Boolean(row);
  }
  const thread = get(
    `SELECT MAX(CASE WHEN status = 'replied' THEN last_message_at END) AS replied_at, MAX(last_message_at) AS last_at
       FROM email_threads WHERE workspace_id = ? AND company_id = ?`,
    [workspaceId, company.id],
  );
  signals.repliedThreadAt = thread?.replied_at || null;
  signals.lastThreadAt = thread?.last_at || null;
  const deal = get('SELECT MAX(created_at) AS last_at FROM deals WHERE workspace_id = ? AND company_id = ?', [workspaceId, company.id]);
  signals.lastDealAt = deal?.last_at || null;
  const activity = get('SELECT MAX(occurred_at) AS last_at FROM sales_activities WHERE workspace_id = ? AND company_id = ?', [
    workspaceId,
    company.id,
  ]);
  signals.lastActivityAt = activity?.last_at || null;
  return signals;
}

function resolveIcp(workspaceId, company, productId) {
  if (company.icpId) return icpsRepo.findIcp(workspaceId, company.icpId);
  const linked = all(
    'SELECT * FROM icps WHERE workspace_id = ? AND product_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1',
    [workspaceId, productId],
  )[0];
  if (!linked) return null;
  return icpsRepo.findIcp(workspaceId, linked.id);
}

/**
 * Fixed contract signature used by the worker (`lead.score` job) and routes.
 */
export async function scoreCompany({ workspaceId, companyId, productId, actorId = null, ip = null, userAgent = null, requestId = null }) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  const contacts = contactsRepo.listContactsForCompany(workspaceId, companyId);
  const icp = resolveIcp(workspaceId, company, productId);
  const signals = loadSignals(workspaceId, company, contacts);
  const result = computeScore({ company, product, icp, contacts, signals });
  const sources = all(
    'SELECT source_type, source_name, source_url, payload_json FROM company_sources WHERE workspace_id = ? AND company_id = ? ORDER BY retrieved_at DESC LIMIT 40',
    [workspaceId, companyId],
  );
  const qualificationResult = classifyCompanyQualification({ company, sources, icp });
  const qualificationTags = withQualificationTags(company.tags, qualificationResult);
  const scoredAt = nowIso();
  companiesRepo.updateCompany(workspaceId, companyId, {
    tags_json: JSON.stringify(qualificationTags),
    updated_at: scoredAt,
  });
  scoringRepo.upsertLeadScore({
    id: id('scr'),
    workspace_id: workspaceId,
    company_id: companyId,
    product_id: productId,
    score: result.score,
    grade: result.grade,
    factors: result.factors,
    exclusions: result.exclusions,
    explanation: result.explanation,
    model_version: SCORE_MODEL_VERSION,
    scored_at: scoredAt,
  });
  const productMatch = result.factors.find((factor) => factor.key === 'product_match');
  scoringRepo.upsertSuggestedMatch({
    id: id('mat'),
    workspace_id: workspaceId,
    company_id: companyId,
    product_id: productId,
    match_score: Math.round((productMatch?.score || 0) * 100),
    reasons: productMatch?.evidence && productMatch.evidence.length ? [productMatch.reason] : [productMatch?.reason || ''],
    evidence: productMatch?.evidence || [],
    updated_at: scoredAt,
  });
  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'lead.score',
    entityType: 'company',
    entityId: companyId,
    after: { productId, score: result.score, grade: result.grade, qualification: qualificationResult.qualification, exclusions: result.exclusions.map((item) => item.code) },
    ip,
    userAgent,
    requestId,
  });
  return {
    companyId,
    productId,
    score: result.score,
    grade: result.grade,
    factors: result.factors,
    exclusions: result.exclusions,
    explanation: result.explanation,
    qualification: qualificationResult.qualification,
    qualificationReason: qualificationResult.reason,
    modelVersion: SCORE_MODEL_VERSION,
    scoredAt,
  };
}

export function recordScoreFeedback(workspaceId, companyId, input, context = {}) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  const field = String(input.field || '').trim();
  if (!field || field.length > 60) throw validationError('反馈字段不合法');
  const reason = input.reason ? String(input.reason).slice(0, 1000) : null;
  let aiValue = input.aiValue === undefined ? null : input.aiValue;
  let userValue = input.userValue === undefined ? null : input.userValue;
  if (JSON.stringify(aiValue ?? null).length > 20000 || JSON.stringify(userValue ?? null).length > 20000) {
    throw validationError('反馈内容过大');
  }
  let productId = input.productId || null;
  if (productId && !productsRepo.findProduct(workspaceId, productId)) throw validationError('关联产品不存在');
  const feedbackId = scoringRepo.insertScoreFeedback({
    id: id('sfb'),
    workspace_id: workspaceId,
    company_id: companyId,
    product_id: productId,
    field,
    ai_value: aiValue,
    user_value: userValue,
    reason,
    user_id: context.actorId || null,
    created_at: nowIso(),
  });
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'lead.score_feedback',
    entityType: 'company',
    entityId: companyId,
    after: { feedbackId, field, productId },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { id: feedbackId, field, productId, aiValue, userValue, reason };
}
