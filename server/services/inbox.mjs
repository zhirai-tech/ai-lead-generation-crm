/**
 * OWNER: t-crm.
 *
 * Unified inbox: thread listing/detail, manual replies (human takeover safe),
 * read state and manual classification corrections.
 */
import { conflict, notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { asString } from '../core/validate.mjs';
import { nowIso, addDays } from '../core/time.mjs';
import { getSettings } from './settings.mjs';
import { getCompanyAutomationState, takeoverCompany } from './automation.mjs';
import { checkSuppression } from './suppression.mjs';
import { createApprovedReplyDraft, enqueueDraftSend } from './drafts.mjs';
import { correctThreadClassification, CLASSIFICATION_LABELS, CLASSIFICATION_LABELS_ZH } from './replies.mjs';
import {
  listThreads,
  getThread,
  listMessages,
  markThreadRead,
  latestClassificationForThread,
  updateThread,
  listClassifications,
} from '../repositories/email.mjs';
import { getCompany, getContact, getContactByEmail } from '../repositories/crm-shared.mjs';
import { createActivity } from '../repositories/deals.mjs';
import { id } from '../core/ids.mjs';

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

function presentThread(thread) {
  if (!thread) return null;
  return {
    ...thread,
    unread: thread.unreadCount > 0,
    snippet: thread.lastMessagePreview,
    classification: thread.latestLabel || thread.classification || null,
    classificationLabel: thread.latestLabel ? CLASSIFICATION_LABELS_ZH[thread.latestLabel] || thread.latestLabel : null,
  };
}

export function threads(workspaceId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 25));
  const result = listThreads(
    workspaceId,
    {
      unread: Boolean(filters.unread),
      highIntent: Boolean(filters.highIntent),
      companyId: filters.companyId || null,
      classification: filters.classification || null,
      status: filters.status || null,
      search: filters.search || '',
    },
    { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize },
  );
  return { ...result, items: result.items.map(presentThread) };
}

export function highIntent(workspaceId, filters = {}) {
  return threads(workspaceId, { ...filters, highIntent: true });
}

export function detail(workspaceId, threadId) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  const messages = listMessages(workspaceId, thread.id).map((message) => ({
    ...message,
    isRead: message.isRead,
  }));
  const classification = latestClassificationForThread(workspaceId, thread.id);
  const company = thread.companyId ? getCompany(workspaceId, thread.companyId) : null;
  const contact = thread.contactId ? getContact(workspaceId, thread.contactId) : null;
  const automationState = company ? getCompanyAutomationState(workspaceId, company.id) : null;
  return {
    thread: presentThread(thread),
    messages,
    classification,
    suggestedReply: classification?.suggestedReply || null,
    company,
    contact,
    automationState,
    classifications: listClassifications(workspaceId, { threadId: thread.id, limit: 10 }),
  };
}

/** Mark every inbound message of a thread as read. */
export function markRead(workspaceId, threadId, actor = {}) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  const marked = markThreadRead(workspaceId, thread.id);
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'thread.read',
    entityType: 'email_thread',
    entityId: thread.id,
    after: { markedRead: marked },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { markedRead: marked };
}

/**
 * Send a manual reply from the inbox. Creates an already-approved outbound
 * draft and queues `email.send`; suppressed / do-not-contact recipients are
 * rejected. Under HUMAN_TAKEOVER manual replies remain allowed (only AI
 * automation is suspended).
 */
export async function reply(workspaceId, threadId, input = {}, actor = {}) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  const bodyText = asString(input.bodyText || input.body || '', { required: true, max: 20000, label: '回复正文' });
  const actorInfo = normalizeActor(actor);
  let company = thread.companyId ? getCompany(workspaceId, thread.companyId) : null;
  let contact = thread.contactId ? getContact(workspaceId, thread.contactId) : null;
  if (!contact) {
    const messages = listMessages(workspaceId, thread.id);
    const inbound = [...messages].reverse().find((message) => message.direction === 'inbound');
    if (inbound?.fromAddress) contact = getContactByEmail(workspaceId, inbound.fromAddress);
  }
  if (!contact) throw validationError('该会话没有可回复的联系人');
  if (!company) company = getCompany(workspaceId, contact.companyId);
  if (!company) throw validationError('该会话没有关联客户');
  if (!contact.emailNormalized) throw validationError('联系人缺少有效邮箱');
  const suppression = checkSuppression(workspaceId, { email: contact.emailNormalized, domain: company.domain });
  if (suppression.suppressed) {
    throw conflict('该收件人已在禁止联系名单中，不能回复', { code: 'RECIPIENT_SUPPRESSED' });
  }
  const automation = getCompanyAutomationState(workspaceId, company.id);
  if (['DO_NOT_CONTACT', 'CLOSED'].includes(automation.state)) {
    throw conflict('该客户处于禁止联系或已关闭状态，不能回复', { code: 'AUTOMATION_BLOCKED', state: automation.state });
  }
  const settings = getSettings(workspaceId);
  const subject = asString(input.subject || (thread.subject ? `Re: ${thread.subject}` : 'Re:'), { max: 500, label: '主题' });
  const draft = await createApprovedReplyDraft(
    workspaceId,
    {
      companyId: company.id,
      contactId: contact.id,
      campaignId: null,
      accountId: thread.accountId || null,
      subject,
      bodyText,
      language: contact.language || settings.outreach?.defaultLanguage || 'en',
    },
    actor,
  );
  const queued = await enqueueDraftSend(workspaceId, draft.id, actor, { manual: true });
  const now = nowIso();
  updateThread(workspaceId, thread.id, { status: 'waiting', updatedAt: now });
  markThreadRead(workspaceId, thread.id);
  createActivity(workspaceId, {
    id: id('act'),
    companyId: company.id,
    contactId: contact.id,
    dealId: null,
    type: 'email',
    subject: subject || '人工回复',
    body: bodyText.slice(0, 4000),
    occurredAt: now,
    userId: actorInfo.actorId,
    createdAt: now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'thread.reply',
    entityType: 'email_thread',
    entityId: thread.id,
    after: {
      draftId: draft.id,
      companyId: company.id,
      contactId: contact.id,
      queued: queued.queued,
      jobId: queued.jobId,
      manualReplyAllowedUnder: automation.state,
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { draft: queued.draft, draftId: queued.draft.id, queued: queued.queued, jobId: queued.jobId, automationState: automation.state };
}

/** Correct the AI classification of a thread (status=user_corrected + audit). */
export function correctClassification(workspaceId, threadId, input = {}, actor = {}) {
  const label = asString(input.label, { required: true, max: 40, label: '分类' });
  if (!CLASSIFICATION_LABELS.includes(label)) throw validationError('分类标签不正确');
  return correctThreadClassification(workspaceId, threadId, { label, note: input.note || '' }, actor);
}

/** Inbox shortcut for human takeover (CONTRACTS 8: /threads/:id/takeover). */
export function takeoverThread(workspaceId, threadId, input = {}, actor = {}) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  if (!thread.companyId) throw validationError('该会话没有关联客户，无法接管');
  return takeoverCompany(workspaceId, thread.companyId, {
    reason: input.reason || '通过收件箱人工接管',
    actor,
  });
}

/** Lightweight inbox counters used by the dashboard. */
export function summary(workspaceId) {
  const totals = listThreads(workspaceId, {}, { page: 1, pageSize: 1, offset: 0, limit: 1 });
  const unread = listThreads(workspaceId, { unread: true }, { page: 1, pageSize: 1, offset: 0, limit: 1 });
  const high = listThreads(workspaceId, { highIntent: true }, { page: 1, pageSize: 1, offset: 0, limit: 1 });
  return { total: totals.total, unread: unread.total, highIntent: high.total };
}

/** Follow-up reminder helper for the inbox UI (manual schedule). */
export function nextFollowUpHint(workspaceId, threadId) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  return { dueAt: addDays(2), threadId: thread.id };
}

export { getCompanyAutomationState };
