/**
 * OWNER: t-crm.
 *
 * Follow-up planning (agent-assisted) and follow-up task CRUD. AI planning is
 * suppressed while a company is under human takeover / paused / do-not-contact.
 */
import { notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import { nowIso, addDays } from '../core/time.mjs';
import { asString, asEnum, asIsoDate } from '../core/validate.mjs';
import { callAgent } from './agent-client.mjs';
import { getCompanyAutomationState } from './automation.mjs';
import {
  listTasks,
  getTask,
  createTask as repoCreateTask,
  updateTask as repoUpdateTask,
  deleteTask as repoDeleteTask,
  countDueTasks,
  countPendingTasks,
  countOverdueTasks,
  listTasksDueSoon,
} from '../repositories/deals.mjs';
import { createDraft as repoCreateDraft } from '../repositories/drafts.mjs';
import { getThread, listThreadMessages, latestClassificationForThread } from '../repositories/email.mjs';
import { getCompany, getContact, isWorkspaceMember } from '../repositories/crm-shared.mjs';

export const TASK_TYPES = ['follow_up', 'email', 'call', 'review', 'reminder'];
export const TASK_STATUSES = ['pending', 'done', 'cancelled', 'skipped'];
const PLANNABLE_STATES = ['AUTOMATION_ACTIVE', 'NEEDS_HUMAN_REVIEW'];

function normalizeActor(actor = {}) {
  return {
    actorType: actor.actorType || (actor.actorId ? 'user' : 'system'),
    actorId: actor.actorId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
  };
}

function auditType(actorType) {
  return ['user', 'agent', 'system', 'api_key'].includes(actorType) ? actorType : 'system';
}

// ----------------------------------------------------------------- task CRUD
export function list(workspaceId, filters = {}) {
  return listTasks(workspaceId, filters);
}

export function due(workspaceId, { until = null, limit = 10 } = {}) {
  return listTasksDueSoon(workspaceId, until || nowIso(), Math.min(100, Math.max(1, Number(limit) || 10)));
}

export function create(workspaceId, input = {}, actor = {}) {
  const companyId = asString(input.companyId, { required: true, max: 80, label: '企业' });
  const company = getCompany(workspaceId, companyId);
  if (!company) throw notFound('客户不存在');
  const contactId = input.contactId ? asString(input.contactId, { max: 80 }) : null;
  if (contactId) {
    const contact = getContact(workspaceId, contactId);
    if (!contact || contact.companyId !== companyId) throw validationError('联系人与企业不匹配');
  }
  const type = asEnum(input.type || 'follow_up', TASK_TYPES, { label: '任务类型' });
  const title = asString(input.title, { required: true, max: 200, label: '任务标题' });
  const dueAt = input.dueAt ? asIsoDate(input.dueAt, { required: true, label: '到期时间' }) : addDays(3);
  const assignedTo = input.assignedTo ? asString(input.assignedTo, { max: 80 }) : null;
  if (assignedTo && !isWorkspaceMember(workspaceId, assignedTo)) throw validationError('指派对象不是当前工作空间成员');
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const task = repoCreateTask(workspaceId, {
    id: id('fut'),
    companyId,
    contactId,
    campaignId: input.campaignId ? asString(input.campaignId, { max: 80 }) : null,
    dealId: input.dealId ? asString(input.dealId, { max: 80 }) : null,
    dueAt,
    type,
    title,
    notes: input.notes ? asString(input.notes, { max: 4000, label: '备注' }) : null,
    status: 'pending',
    assignedTo,
    createdAt: now,
    updatedAt: now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'followup_task.create',
    entityType: 'follow_up_task',
    entityId: task.id,
    after: { companyId, contactId, type, title, dueAt, assignedTo },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return task;
}

export function update(workspaceId, taskId, input = {}, actor = {}) {
  const existing = getTask(workspaceId, taskId);
  if (!existing) throw notFound('跟进任务不存在');
  const patch = {};
  if (input.title !== undefined) patch.title = asString(input.title, { required: true, max: 200, label: '任务标题' });
  if (input.dueAt !== undefined) patch.dueAt = asIsoDate(input.dueAt, { required: true, label: '到期时间' });
  if (input.type !== undefined) patch.type = asEnum(input.type, TASK_TYPES, { label: '任务类型', required: true });
  if (input.status !== undefined) patch.status = asEnum(input.status, TASK_STATUSES, { label: '任务状态', required: true });
  if (input.notes !== undefined) patch.notes = input.notes ? asString(input.notes, { max: 4000 }) : null;
  if (input.assignedTo !== undefined) {
    if (input.assignedTo) {
      const assignee = asString(input.assignedTo, { max: 80 });
      if (!isWorkspaceMember(workspaceId, assignee)) throw validationError('指派对象不是当前工作空间成员');
      patch.assignedTo = assignee;
    } else {
      patch.assignedTo = null;
    }
  }
  if (!Object.keys(patch).length) return existing;
  patch.updatedAt = nowIso();
  const updated = repoUpdateTask(workspaceId, taskId, patch);
  const actorInfo = normalizeActor(actor);
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'followup_task.update',
    entityType: 'follow_up_task',
    entityId: taskId,
    before: existing,
    after: updated,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

export function remove(workspaceId, taskId, actor = {}) {
  const existing = getTask(workspaceId, taskId);
  if (!existing) throw notFound('跟进任务不存在');
  repoDeleteTask(workspaceId, taskId);
  const actorInfo = normalizeActor(actor);
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'followup_task.delete',
    entityType: 'follow_up_task',
    entityId: taskId,
    before: existing,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { deleted: true };
}

export function stats(workspaceId) {
  return {
    pending: countPendingTasks(workspaceId),
    due: countDueTasks(workspaceId, nowIso()),
    overdue: countOverdueTasks(workspaceId, nowIso()),
  };
}

// ------------------------------------------------------------ agent planning
function clampDue(dueAt) {
  const date = dueAt ? new Date(dueAt) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const min = Date.now() + 60 * 60 * 1000;
  if (date.getTime() < min) return addDays(1);
  return date.toISOString();
}

/**
 * Contract 7.2: plan the next follow-up for a thread. Persists a follow-up task
 * (and, when the agent proposes copy, a draft suggestion). Never creates new AI
 * work for companies in takeover / paused / do-not-contact / closed states.
 */
export async function planFollowUpForThread({ workspaceId, threadId, messageId = null, actorType = 'system', actorId = null }) {
  const thread = getThread(workspaceId, threadId);
  if (!thread) throw notFound('会话不存在');
  const company = thread.companyId ? getCompany(workspaceId, thread.companyId) : null;
  if (!company) throw validationError('会话没有关联客户，无法规划跟进');
  const contact = thread.contactId ? getContact(workspaceId, thread.contactId) : null;
  const automation = getCompanyAutomationState(workspaceId, company.id);
  if (!PLANNABLE_STATES.includes(automation.state)) {
    recordAudit({
      workspaceId,
      actorType: auditType(actorType),
      actorId,
      action: 'followup.plan_skipped',
      entityType: 'company',
      entityId: company.id,
      after: { state: automation.state, threadId: thread.id, reason: 'automation_blocked' },
    });
    return { taskId: null, draftId: null, skipped: true, reason: `automation_${automation.state.toLowerCase()}` };
  }
  const messages = listThreadMessages(workspaceId, thread.id, { limit: 10 });
  const focusMessage = messageId ? messages.find((message) => message.id === messageId) || null : messages.find((message) => message.direction === 'inbound') || messages[0] || null;
  const classification = latestClassificationForThread(workspaceId, thread.id);
  const context = {
    company: {
      id: company.id,
      name: company.name,
      country: company.country,
      industry: company.industry,
      description: company.description,
    },
    contact: contact ? { id: contact.id, fullName: contact.fullName, title: contact.title, email: contact.email } : null,
    thread: { id: thread.id, subject: thread.subject, status: thread.status, classification: thread.classification },
    classification: classification
      ? {
          label: classification.label,
          confidence: classification.confidence,
          intentScore: classification.intentScore,
          suggestedReply: classification.suggestedReply,
        }
      : null,
    messages: messages.map((message) => ({
      direction: message.direction,
      subject: message.subject,
      body: String(message.bodyText || '').slice(0, 1500),
      at: message.receivedAt || message.sentAt || message.createdAt,
    })),
    focusMessageId: focusMessage?.id || null,
    today: nowIso(),
  };
  const output = await callAgent('planFollowUp', { workspaceId, context });
  const source = output && typeof output === 'object' ? output : {};
  const nextStep = typeof source.nextStep === 'string' ? source.nextStep.trim().slice(0, 500) : '';
  const draftHint = typeof source.draftHint === 'string' ? source.draftHint.trim().slice(0, 2000) : '';
  const title =
    (typeof source.taskTitle === 'string' && source.taskTitle.trim()) ||
    (typeof source.title === 'string' && source.title.trim()) ||
    nextStep ||
    `跟进 ${company.name}`;
  const type = TASK_TYPES.includes(source.type) ? source.type : 'follow_up';
  const dueInDays = Number.isFinite(Number(source.dueInDays)) ? Number(source.dueInDays) : 3;
  const dueAt = clampDue(source.dueAt || source.due_at) || addDays(Math.max(0, Math.min(60, dueInDays)));
  const notesParts = [];
  if (typeof source.notes === 'string' && source.notes.trim()) notesParts.push(source.notes.trim().slice(0, 3000));
  if (nextStep) notesParts.push(`下一步：${nextStep}`);
  if (draftHint) notesParts.push(`草稿建议：${draftHint}`);
  if (typeof source.rationale === 'string' && source.rationale.trim()) notesParts.push(`依据：${source.rationale.trim().slice(0, 1000)}`);
  if (typeof source.priority === 'string' && source.priority.trim()) notesParts.push(`优先级：${source.priority.trim().slice(0, 40)}`);
  if (focusMessage) notesParts.push(`关联邮件：${focusMessage.subject || focusMessage.id}`);
  const actorInfo = normalizeActor({ actorType: auditType(actorType), actorId });
  const now = nowIso();
  const task = repoCreateTask(workspaceId, {
    id: id('fut'),
    companyId: company.id,
    contactId: contact?.id || null,
    campaignId: null,
    dealId: null,
    dueAt,
    type,
    title: title.slice(0, 200),
    notes: notesParts.join('\n\n') || null,
    status: 'pending',
    assignedTo: null,
    createdAt: now,
    updatedAt: now,
  });
  let draft = null;
  // Only explicit draft copy creates a message draft; a `draftHint` is planning
  // input and stays in the task notes (no auto-generated sendable draft).
  const draftSubject = typeof source.draftSubject === 'string' ? source.draftSubject : typeof source.suggestedSubject === 'string' ? source.suggestedSubject : '';
  const draftBody = typeof source.draftBody === 'string' ? source.draftBody : typeof source.suggestedReply === 'string' ? source.suggestedReply : '';
  if (contact && draftBody.trim().length >= 10) {
    draft = repoCreateDraft(workspaceId, {
      id: id('drf'),
      companyId: company.id,
      contactId: contact.id,
      campaignId: null,
      accountId: thread.accountId || null,
      subject: (draftSubject || `Re: ${thread.subject || ''}`).slice(0, 500),
      bodyText: draftBody.slice(0, 20000),
      language: contact.language || 'en',
      status: 'draft',
      quality: { source: 'followup_plan' },
      guard: {},
      createdAt: now,
      updatedAt: now,
    });
  }
  recordAudit({
    workspaceId,
    actorType: auditType(actorType),
    actorId,
    action: 'followup.plan',
    entityType: 'follow_up_task',
    entityId: task.id,
    after: { companyId: company.id, threadId: thread.id, type, dueAt, draftId: draft?.id || null, messageId: focusMessage?.id || null },
  });
  return { taskId: task.id, draftId: draft?.id || null, skipped: false, task };
}

export default { TASK_TYPES, TASK_STATUSES, list, due, create, update, remove, stats, planFollowUpForThread };
