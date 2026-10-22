/**
 * OWNER: t-crm.
 *
 * Suppression (do-not-contact) rules. A hit on either the recipient email or
 * the company domain blocks every outbound message. Deleting entries is
 * restricted to owner/admin and always audited.
 */
import { validationError, forbidden, notFound } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import { nowIso, dayKey } from '../core/time.mjs';
import { asString, asEnum, normalizeEmail, normalizeDomain, isEmail } from '../core/validate.mjs';
import {
  listSuppression,
  getSuppression,
  insertSuppression,
  deleteSuppression,
  matchSuppression,
  companyHasSuppression,
  countSuppression,
} from '../repositories/suppression.mjs';
import { getCompany, listCompanyEmails } from '../repositories/crm-shared.mjs';

export const SUPPRESSION_REASONS = ['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'do_not_contact', 'gdpr_request'];
export const SUPPRESSION_SCOPES = ['email', 'domain'];
export const SUPPRESSION_REASON_LABELS = {
  unsubscribe: '客户退订',
  hard_bounce: '硬退信',
  complaint: '投诉',
  manual: '人工添加',
  do_not_contact: '拒绝联系',
  gdpr_request: 'GDPR 请求',
};

function normalizeActor(actor = {}) {
  return {
    actorType: actor.actorType || (actor.actorId ? 'user' : 'system'),
    actorId: actor.actorId ?? null,
    actorRole: actor.actorRole ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
  };
}

export function list(workspaceId, filters = {}) {
  const result = listSuppression(workspaceId, filters);
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, reasonLabel: SUPPRESSION_REASON_LABELS[item.reason] || item.reason })),
  };
}

export function create(workspaceId, input = {}, actor = {}) {
  const scope = asEnum(input.scope, SUPPRESSION_SCOPES, { required: true, label: '范围' });
  const reason = asEnum(input.reason || 'manual', SUPPRESSION_REASONS, { required: true, label: '原因' });
  const rawValue = asString(input.value, { required: true, max: 320, label: '值' });
  let valueNormalized;
  if (scope === 'email') {
    valueNormalized = normalizeEmail(rawValue);
    if (!isEmail(valueNormalized)) throw validationError('邮箱格式不正确');
  } else {
    valueNormalized = normalizeDomain(rawValue);
    if (!valueNormalized) throw validationError('域名格式不正确');
  }
  const actorInfo = normalizeActor(actor);
  const { record, created } = insertSuppression(workspaceId, {
    id: id('sup'),
    scope,
    valueNormalized,
    reason,
    source: input.source ? asString(input.source, { max: 120 }) : 'manual',
    note: input.note ? asString(input.note, { max: 1000 }) : null,
    createdBy: actorInfo.actorId,
    createdAt: nowIso(),
  });
  if (created) {
    recordAudit({
      workspaceId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      action: 'suppression.create',
      entityType: 'suppression_record',
      entityId: record.id,
      after: { scope, valueNormalized, reason, source: record.source },
      ip: actorInfo.ip,
      userAgent: actorInfo.userAgent,
      requestId: actorInfo.requestId,
    });
  }
  return { record: { ...record, reasonLabel: SUPPRESSION_REASON_LABELS[record.reason] || record.reason }, created };
}

/** Deleting suppression entries is owner/admin only (override of automatic sends). */
export function remove(workspaceId, suppressionId, actor = {}) {
  const actorInfo = normalizeActor(actor);
  if (!['owner', 'admin'].includes(actorInfo.actorRole)) {
    throw forbidden('只有管理员或拥有者可以删除抑制记录');
  }
  const removed = deleteSuppression(workspaceId, suppressionId);
  if (!removed) throw notFound('抑制记录不存在');
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'suppression.delete',
    entityType: 'suppression_record',
    entityId: removed.id,
    before: { scope: removed.scope, valueNormalized: removed.valueNormalized, reason: removed.reason },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return { removed: true, record: removed };
}

/**
 * Send-pipeline check: returns `{ suppressed, matches }` for the recipient.
 * Accepts `{ email, domain }`; a missing domain is derived from the email.
 */
export function checkSuppression(workspaceId, { email = null, domain = null } = {}) {
  const matches = matchSuppression(workspaceId, { email, domain });
  return { suppressed: matches.length > 0, matches };
}

/** Throwing variant used before queueing any outbound message. */
export function assertNotSuppressed(workspaceId, { email = null, domain = null } = {}) {
  const result = checkSuppression(workspaceId, { email, domain });
  if (result.suppressed) {
    throw conflict('该收件人已在禁止联系名单中，不能发送', {
      code: 'RECIPIENT_SUPPRESSED',
      matches: result.matches.map((item) => ({ scope: item.scope, value: item.valueNormalized, reason: item.reason })),
    });
  }
  return result;
}

/** True while the company still has suppression entries (DNC resume guard). */
export function isCompanySuppressed(workspaceId, companyId) {
  return companyHasSuppression(workspaceId, companyId);
}

export function summary(workspaceId) {
  return { total: countSuppression(workspaceId), day: dayKey() };
}

/** Contact + company suppression snapshot used by draft approval UI hints. */
export function recipientStatus(workspaceId, companyId, contactId = null) {
  const company = getCompany(workspaceId, companyId);
  if (!company) throw notFound('客户不存在');
  const emails = contactId ? listCompanyEmails(workspaceId, companyId) : listCompanyEmails(workspaceId, companyId);
  const targets = [];
  if (company.domain) targets.push({ email: null, domain: company.domain });
  for (const email of emails) targets.push({ email, domain: company.domain });
  const hits = [];
  for (const target of targets) hits.push(...matchSuppression(workspaceId, target));
  const deduped = [...new Map(hits.map((item) => [item.id, item])).values()];
  return { companyId, domain: company.domain, emails, suppressed: deduped.length > 0, matches: deduped };
}

export default {
  SUPPRESSION_REASONS,
  SUPPRESSION_SCOPES,
  list,
  create,
  remove,
  checkSuppression,
  assertNotSuppressed,
  isCompanySuppressed,
  recipientStatus,
  summary,
};
