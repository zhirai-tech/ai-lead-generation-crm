/**
 * Rule-based, explainable lead scoring. No AI and no network calls: the score is
 * a deterministic weighted sum over product fit, company profile, buying
 * signals, data quality and contact quality, plus hard exclusion rules.
 *
 * Every factor carries its weight, its 0..1 score and a human-readable reason so
 * the UI can explain the number. Exclusions force the score to 0 / grade D.
 */
import { all, get } from '../core/db.mjs';
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

function evaluateCompanyType(company, icp) {
  if (!icp || !Array.isArray(icp.targetCompanyTypes) || !icp.targetCompanyTypes.length) {
    return { score: 0.5, reason: '未设置 ICP 目标企业类型，按中性处理' };
  }
  const companyType = String(company.companyType || '').toLowerCase();
  const matched = icp.targetCompanyTypes.some((target) => companyType && companyType.includes(String(target).toLowerCase()));
  if (matched) return { score: 1, reason: `企业类型（${company.companyType}）与 ICP 目标一致` };
  if (!companyType) return { score: 0.35, reason: '企业类型未知，无法判断是否匹配 ICP' };
  return { score: 0.15, reason: `企业类型（${company.companyType}）不在 ICP 目标类型中` };
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

function evaluateBuyingScenario(company, product) {
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
  const productMatch = matchProductRules(product, company);
  factors.push({
    key: 'product_match',
    label: '产品匹配度',
    weight: 0.25,
    score: clamp01(productMatch.score),
    reason: productMatch.reasons.join('；'),
    evidence: productMatch.evidence,
  });
  const companyType = evaluateCompanyType(company, icp);
  factors.push({ key: 'company_type', label: '企业类型匹配', weight: 0.1, score: clamp01(companyType.score), reason: companyType.reason });
  const region = evaluateRegion(company, icp);
  factors.push({ key: 'region', label: '目标地区匹配', weight: 0.15, score: clamp01(region.score), reason: region.reason });
  const buying = evaluateBuyingScenario(company, product);
  factors.push({ key: 'buying_scenario', label: '采购场景', weight: 0.15, score: clamp01(buying.score), reason: buying.reason });
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
  const scoredAt = nowIso();
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
    after: { productId, score: result.score, grade: result.grade, exclusions: result.exclusions.map((item) => item.code) },
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
