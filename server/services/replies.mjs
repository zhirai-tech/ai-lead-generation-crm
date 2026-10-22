/**
 * OWNER: t-crm.
 *
 * Inbound reply classification persistence. The worker calls
 * classifyInboundMessage() after syncing an inbound message; the result is
 * stored (label / confidence / evidence / rationale / suggested reply), the
 * thread and company are updated, high-intent customers are notified and
 * unsubscribe replies are escalated to DO_NOT_CONTACT + suppression.
 */
import { notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import { nowIso, addDays } from '../core/time.mjs';
import { createNotification, notifyHighIntent } from './notifications.mjs';
import { callAgent } from './agent-client.mjs';
import { applyStateTransition, flagNeedsHumanReview, getCompanyAutomationState } from './automation.mjs';
import {
  getMessage,
  getThread,
  listThreadMessages,
  createClassification,
  latestClassificationForThread,
  updateThread,
  updateCompanyStatus,
  agentExecutionExists,
} from '../repositories/email.mjs';
import { insertSuppression } from '../repositories/suppression.mjs';
import { markTargetsReplied, markTargetsUnsubscribed } from '../repositories/campaigns.mjs';
import { getCompany, getContact, latestAgentExecutionId } from '../repositories/crm-shared.mjs';
import { createActivity } from '../repositories/deals.mjs';

export const CLASSIFICATION_LABELS = [
  'positive_interest',
  'price_inquiry',
  'quote_request',
  'sample_request',
  'technical_question',
  'follow_up_needed',
  'no_need_now',
  'rejection',
  'unsubscribe',
  'auto_reply',
  'unknown',
];

export const HIGH_INTENT_LABELS = ['positive_interest', 'price_inquiry', 'quote_request', 'sample_request'];
const REVIEW_REQUIRED_LABELS = [...HIGH_INTENT_LABELS, 'technical_question', 'follow_up_needed', 'rejection', 'no_need_now'];

export const CLASSIFICATION_LABELS_ZH = {
  positive_interest: '正面合作意向',
  price_inquiry: '询价',
  quote_request: '索要报价',
  sample_request: '索取样品',
  technical_question: '技术问题',
  follow_up_needed: '需要进一步联系',
  no_need_now: '暂时无需求',
  rejection: '明确拒绝',
  unsubscribe: '退订',
  auto_reply: '自动回复',
  unknown: '无法判断',
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 100) / 100;
}

function normalizeIntentScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  const scaled = number > 0 && number <= 1 ? Math.round(number * 100) : Math.round(number);
  return Math.max(0, Math.min(100, scaled));
}

function normalizeOutput(output) {
  const source = output && typeof output === 'object' ? output : {};
  const label = CLASSIFICATION_LABELS.includes(source.label) ? source.label : 'unknown';
  const evidence = Array.isArray(source.evidence)
    ? source.evidence
        .slice(0, 20)
        .map((item) => {
          if (typeof item === 'string') return item.slice(0, 500);
          if (item && typeof item === 'object') {
            return [item.quote, item.explanation].filter(Boolean).join(' — ').slice(0, 500) || JSON.stringify(item).slice(0, 500);
          }
          return String(item).slice(0, 500);
        })
        .filter(Boolean)
    : [];
  const nextAction = typeof source.nextAction === 'string' ? source.nextAction.trim().slice(0, 300) : '';
  const baseRationale = typeof source.rationale === 'string' ? source.rationale.trim() : '';
  const rationale = [baseRationale, nextAction ? `建议下一步：${nextAction}` : ''].filter(Boolean).join('\n').slice(0, 2000) || null;
  const suggestedReply = typeof source.suggestedReply === 'string' ? source.suggestedReply.slice(0, 10000) : null;
  return {
    label,
    confidence: clamp01(Number(source.confidence ?? 0)),
    intentScore: normalizeIntentScore(source.intentScore ?? source.intent_score ?? 0),
    evidence,
    rationale,
    suggestedReply,
    executionId: source.executionId || source.execution_id || source.agentExecutionId || null,
  };
}

/** Mark the company / thread as replied and stop nurturing its targets. */
function markReplied(workspaceId, { thread, companyId, contactId, message }) {
  const now = nowIso();
  if (thread) {
    updateThread(workspaceId, thread.id, { status: 'replied', updatedAt: now });
  }
  if (companyId) {
    updateCompanyStatus(workspaceId, companyId, 'replied', now);
    markTargetsReplied(workspaceId, { companyId, contactId, updatedAt: now });
    createActivity(workspaceId, {
      id: id('act'),
      companyId,
      contactId,
      dealId: null,
      type: 'email',
      subject: message?.subject || '收到客户回复',
      body: String(message?.bodyText || '').slice(0, 4000),
      occurredAt: message?.receivedAt || message?.createdAt || now,
      userId: null,
      createdAt: now,
    });
  }
}

/**
 * Unsubscribe escalation (also used by manual classification corrections):
 * suppression record + DO_NOT_CONTACT (which cancels pending tasks/jobs) +
 * targets unsubscribed + thread closed + critical notification.
 */
export function escalateUnsubscribe(workspaceId, { company, contact, thread, messageId = null, actorType = 'agent', actorId = null, correctionNote = null }) {
  if (!company) throw notFound('客户不存在');
  const now = nowIso();
  let suppressionCreated = false;
  if (contact?.emailNormalized) {
    const result = insertSuppression(workspaceId, {
      id: id('sup'),
      scope: 'email',
      valueNormalized: contact.emailNormalized,
      reason: 'unsubscribe',
      source: correctionNote ? 'manual_correction' : 'reply',
      note: correctionNote ? correctionNote.slice(0, 1000) : `客户在来信中要求退订${messageId ? `（message: ${messageId}）` : ''}`,
      createdBy: actorId,
      createdAt: now,
    });
    suppressionCreated = result.created;
  }
  if (thread) updateThread(workspaceId, thread.id, { status: 'closed', classification: 'unsubscribe', updatedAt: now });
  markTargetsUnsubscribed(workspaceId, { companyId: company.id, contactId: contact?.id || null, updatedAt: now });
  const transition = applyStateTransition(workspaceId, company.id, 'DO_NOT_CONTACT', {
    reason: '客户退订',
    actor: { actorType: actorType === 'user' ? 'user' : 'agent', actorId },
  });
  createNotification({
    workspaceId,
    type: 'unsubscribe',
    title: '客户要求退订',
    body: `${company.name}${contact?.email ? `（${contact.email}）` : ''} 已退订，已加入禁止联系名单并停止所有自动跟进。`,
    entityType: 'company',
    entityId: company.id,
    severity: 'critical',
  });
  recordAudit({
    workspaceId,
    actorType: actorType === 'user' ? 'user' : 'agent',
    actorId,
    action: 'reply.unsubscribe',
    entityType: 'company',
    entityId: company.id,
    before: { state: transition.previousState },
    after: { state: 'DO_NOT_CONTACT', suppressionCreated, contactId: contact?.id || null, messageId },
  });
  return getCompanyAutomationState(workspaceId, company.id);
}

/**
 * Contract 7.2: classify one inbound message and persist the outcome.
 * @returns {{classification: object, automationState: object}}
 */
export async function classifyInboundMessage({ workspaceId, messageId, actorType = 'system', actorId = null }) {
  const message = getMessage(workspaceId, messageId);
  if (!message) throw notFound('邮件不存在');
  if (message.direction !== 'inbound') throw validationError('只能对收到的客户邮件进行分类');
  const thread = message.threadId ? getThread(workspaceId, message.threadId) : null;
  const companyId = message.companyId || thread?.companyId || null;
  const contactId = message.contactId || thread?.contactId || null;
  const company = companyId ? getCompany(workspaceId, companyId) : null;
  const contact = contactId ? getContact(workspaceId, contactId) : null;
  const history = thread ? listThreadMessages(workspaceId, thread.id, { limit: 8 }) : [];
  const context = {
    message: {
      id: message.id,
      subject: message.subject || '',
      bodyText: String(message.bodyText || '').slice(0, 8000),
      fromAddress: message.fromAddress,
      fromName: message.fromName,
      receivedAt: message.receivedAt || message.createdAt,
    },
    thread: thread ? { id: thread.id, subject: thread.subject, classification: thread.classification, status: thread.status } : null,
    company: company
      ? {
          id: company.id,
          name: company.name,
          domain: company.domain,
          country: company.country,
          industry: company.industry,
          companyType: company.companyType,
          description: company.description,
        }
      : null,
    contact: contact ? { id: contact.id, fullName: contact.fullName, title: contact.title, email: contact.email } : null,
    history: history
      .filter((item) => item.id !== message.id)
      .map((item) => ({ direction: item.direction, subject: item.subject, body: String(item.bodyText || '').slice(0, 800), at: item.receivedAt || item.sentAt })),
  };
  const startedAt = nowIso();
  const output = await callAgent('classifyReply', { workspaceId, context });
  const normalized = normalizeOutput(output);
  const now = nowIso();
  const candidateExecutionId = normalized.executionId || latestAgentExecutionId(workspaceId, 'reply_classification', startedAt);
  const executionId = agentExecutionExists(candidateExecutionId) ? candidateExecutionId : null;
  const classification = createClassification(workspaceId, {
    id: id('cls'),
    threadId: thread?.id || null,
    messageId: message.id,
    companyId,
    contactId,
    label: normalized.label,
    confidence: normalized.confidence,
    intentScore: normalized.intentScore,
    evidence: normalized.evidence,
    rationale: normalized.rationale,
    suggestedReply: normalized.suggestedReply,
    status: 'ai_suggested',
    agentExecutionId: executionId,
    createdAt: now,
    updatedAt: now,
  });
  const highIntent = HIGH_INTENT_LABELS.includes(normalized.label) || normalized.intentScore >= 60;
  let automationState = null;
  if (normalized.label === 'unsubscribe') {
    automationState = escalateUnsubscribe(workspaceId, {
      company,
      contact,
      thread,
      messageId: message.id,
      actorType,
      actorId,
    });
  } else {
    if (thread) {
      const nextStatus = ['rejection', 'no_need_now'].includes(normalized.label) ? 'closed' : normalized.label === 'auto_reply' ? thread.status : 'replied';
      updateThread(workspaceId, thread.id, { classification: normalized.label, status: nextStatus, lastMessageAt: thread.lastMessageAt || now, updatedAt: now });
    }
    if (company) {
      markReplied(workspaceId, { thread: null, companyId: company.id, contactId: contact?.id || null, message });
      if (highIntent && contact) {
        notifyHighIntent({
          workspaceId,
          companyId: company.id,
          contactId: contact.id,
          threadId: thread?.id || null,
          label: CLASSIFICATION_LABELS_ZH[normalized.label] || normalized.label,
          confidence: normalized.confidence,
        });
      }
      if (REVIEW_REQUIRED_LABELS.includes(normalized.label)) {
        flagNeedsHumanReview(workspaceId, company.id, {
          reason: `客户回复被识别为「${CLASSIFICATION_LABELS_ZH[normalized.label] || normalized.label}」`,
          actor: { actorType: 'agent', actorId },
        });
      }
      automationState = getCompanyAutomationState(workspaceId, company.id);
    }
  }
  recordAudit({
    workspaceId,
    actorType: ['user', 'agent', 'system', 'api_key'].includes(actorType) ? actorType : 'system',
    actorId,
    action: 'reply.classified',
    entityType: 'email_message',
    entityId: message.id,
    before: thread ? { threadClassification: thread.classification } : null,
    after: {
      label: normalized.label,
      confidence: normalized.confidence,
      intentScore: normalized.intentScore,
      highIntent,
      threadId: thread?.id || null,
      companyId,
      agentExecutionId: executionId,
    },
  });
  return { classification, automationState };
}

/**
 * Manual correction of a thread's classification. Keeps the AI suggestion for
 * traceability by appending a user_corrected row, then updates the thread.
 */
export function correctThreadClassification(workspaceId, threadId, { label, note = '' } = {}, actor = {}) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  const normalizedLabel = CLASSIFICATION_LABELS.includes(label) ? label : null;
  if (!normalizedLabel) throw validationError('分类标签不正确');
  const company = thread.companyId ? getCompany(workspaceId, thread.companyId) : null;
  const contact = thread.contactId ? getContact(workspaceId, thread.contactId) : null;
  const latestMessage = listThreadMessages(workspaceId, thread.id, { direction: 'inbound', limit: 1 })[0] || null;
  const previous = latestClassificationForThread(workspaceId, thread.id);
  const actorInfo = {
    actorType: actor.actorType || 'user',
    actorId: actor.actorId ?? null,
  };
  const now = nowIso();
  const classification = createClassification(workspaceId, {
    id: id('cls'),
    threadId: thread.id,
    messageId: latestMessage?.id || previous?.messageId || null,
    companyId: thread.companyId,
    contactId: thread.contactId,
    label: normalizedLabel,
    confidence: 1,
    intentScore: HIGH_INTENT_LABELS.includes(normalizedLabel) ? 80 : normalizedLabel === 'unsubscribe' ? 100 : 0,
    evidence: latestMessage ? [String(latestMessage.bodyText || '').slice(0, 500)] : [],
    rationale: String(note || '人工修正分类').slice(0, 2000),
    suggestedReply: null,
    status: 'user_corrected',
    agentExecutionId: null,
    createdAt: now,
    updatedAt: now,
  });
  updateThread(workspaceId, thread.id, {
    classification: normalizedLabel,
    status: normalizedLabel === 'unsubscribe' ? 'closed' : thread.status,
    updatedAt: now,
  });
  if (normalizedLabel === 'unsubscribe' && company) {
    escalateUnsubscribe(workspaceId, {
      company,
      contact,
      thread,
      messageId: latestMessage?.id || null,
      actorType: 'user',
      actorId: actorInfo.actorId,
      correctionNote: note || '人工修正为退订',
    });
  } else if (company && REVIEW_REQUIRED_LABELS.includes(normalizedLabel)) {
    flagNeedsHumanReview(workspaceId, company.id, {
      reason: `人工修正分类：${CLASSIFICATION_LABELS_ZH[normalizedLabel] || normalizedLabel}`,
      actor: { actorType: 'user', actorId: actorInfo.actorId },
    });
  }
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'classification.correct',
    entityType: 'email_thread',
    entityId: thread.id,
    before: previous ? { label: previous.label, status: previous.status } : null,
    after: { label: normalizedLabel, classificationId: classification.id, note },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { classification, automationState: company ? getCompanyAutomationState(workspaceId, company.id) : null };
}

/**
 * Simple follow-up hint: create a task for a thread when the classification
 * suggests the conversation needs action. Not part of the fixed worker contract
 * but shared with the inbox UI.
 */
export function suggestedNextAction(workspaceId, threadId) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  const classification = latestClassificationForThread(workspaceId, thread.id);
  if (!classification) return { action: 'review', dueAt: addDays(2) };
  if (classification.label === 'unsubscribe') return { action: 'none', dueAt: null };
  if (HIGH_INTENT_LABELS.includes(classification.label)) return { action: 'reply_now', dueAt: addDays(1) };
  return { action: 'follow_up', dueAt: addDays(3) };
}

/** Re-exported for the inbox service. */
export { getCompanyAutomationState };
