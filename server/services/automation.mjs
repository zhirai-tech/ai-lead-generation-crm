/**
 * OWNER: t-crm.
 *
 * Automation state machine + human takeover. This is the highest-priority
 * business safety module:
 *
 *  - Every state change is transactional: state row + pending follow-up task
 *    cancellation + per-company job cancellation + audit trail.
 *  - The send pipeline (t-worker) calls getCompanyAutomationState() before any
 *    outbound message and must refuse sending unless `canSend` is true.
 *  - HUMAN_TAKEOVER / PAUSED / NEEDS_HUMAN_REVIEW can return to automation.
 *  - DO_NOT_CONTACT can only be released after an owner/admin removed the
 *    suppression records; resuming directly is rejected at the API layer.
 *  - CLOSED is terminal.
 */
import { tx } from '../core/db.mjs';
import { AppError, conflict, forbidden, notFound } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { createNotification } from './notifications.mjs';
import { cancelCompanyJobsSafe } from './queue-client.mjs';
import { getCompany, listContactsForCompany } from '../repositories/crm-shared.mjs';
import { AUTOMATION_STATES, getStateRow, listStates, upsertState, countStates } from '../repositories/automation.mjs';
import { cancelPendingTasksForCompany } from '../repositories/deals.mjs';
import { companyHasSuppression, insertSuppression } from '../repositories/suppression.mjs';

export { AUTOMATION_STATES };

export const AUTOMATION_STATE_LABELS = {
  AUTOMATION_ACTIVE: '自动化运行中',
  NEEDS_HUMAN_REVIEW: '需要人工审核',
  HUMAN_TAKEOVER: '人工接管中',
  PAUSED: '已暂停',
  DO_NOT_CONTACT: '禁止联系',
  CLOSED: '已关闭',
};

/** States that still allow an outbound send. */
const SENDABLE_STATES = new Set(['AUTOMATION_ACTIVE', 'NEEDS_HUMAN_REVIEW']);
/** States an operator may resume from (DO_NOT_CONTACT handled separately). */
const RESUMABLE_STATES = new Set(['HUMAN_TAKEOVER', 'PAUSED', 'NEEDS_HUMAN_REVIEW']);

/** Audit action per target state (stable names used by tests and the UI). */
export const AUDIT_ACTION_BY_STATE = {
  AUTOMATION_ACTIVE: 'automation.resume',
  NEEDS_HUMAN_REVIEW: 'automation.review_required',
  HUMAN_TAKEOVER: 'automation.takeover',
  PAUSED: 'automation.pause',
  DO_NOT_CONTACT: 'automation.do_not_contact',
  CLOSED: 'automation.close',
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

function requireCompany(workspaceId, companyId) {
  const company = getCompany(workspaceId, companyId);
  if (!company) throw notFound('客户不存在');
  return company;
}

/**
 * Deterministic pre-send state check. Safe to call from the worker for every
 * candidate message; never throws for an existing company.
 *
 * @returns {{
 *   companyId: string, exists: boolean, state: string, reason: string|null,
 *   changedBy: string|null, changedAt: string|null, canSend: boolean,
 *   canAutoSend: boolean, suppressed: boolean, label: string
 * }}
 */
export function getCompanyAutomationState(workspaceId, companyId) {
  const company = getCompany(workspaceId, companyId);
  if (!company) {
    return {
      companyId,
      exists: false,
      state: null,
      reason: 'company_not_found',
      changedBy: null,
      changedAt: null,
      canSend: false,
      canAutoSend: false,
      suppressed: false,
      label: '客户不存在',
    };
  }
  const row = getStateRow(workspaceId, companyId);
  const state = row?.state || 'AUTOMATION_ACTIVE';
  const suppressed = companyHasSuppression(workspaceId, companyId);
  const canSend = SENDABLE_STATES.has(state) && !suppressed;
  return {
    companyId,
    exists: true,
    state,
    reason: row?.reason ?? (suppressed ? 'suppression_hit' : null),
    changedBy: row?.changedBy ?? null,
    changedAt: row?.changedAt ?? null,
    canSend,
    canAutoSend: state === 'AUTOMATION_ACTIVE' && !suppressed,
    suppressed,
    label: AUTOMATION_STATE_LABELS[state] || state,
  };
}

/** Throw a typed error when an outbound send to this company must not happen. */
export function assertCompanySendable(workspaceId, companyId) {
  const snapshot = getCompanyAutomationState(workspaceId, companyId);
  if (!snapshot.exists) throw notFound('客户不存在');
  if (snapshot.suppressed) {
    throw conflict('该客户已在禁止联系名单中，不能发送', { code: 'RECIPIENT_SUPPRESSED' });
  }
  if (!SENDABLE_STATES.has(snapshot.state)) {
    throw conflict('该客户当前不允许自动发送', {
      code: 'AUTOMATION_BLOCKED',
      state: snapshot.state,
    });
  }
  return snapshot;
}

/** Whether the state currently forbids *any* automatic following-up (AI). */
export function isAutomationBlocked(workspaceId, companyId) {
  const snapshot = getCompanyAutomationState(workspaceId, companyId);
  return !snapshot.exists || !snapshot.canAutoSend;
}

/**
 * Core transition primitive: state + cancellation + audit in one transaction.
 * `state` must be one of AUTOMATION_STATES. Callers enforce the transition
 * rules; this function is also used by the reply classifier.
 */
export function applyStateTransition(workspaceId, companyId, nextState, { reason = null, actor = {}, notify = null } = {}) {
  if (!AUTOMATION_STATES.includes(nextState)) throw new AppError('BAD_STATE', '未知的自动化状态', { status: 400 });
  const company = requireCompany(workspaceId, companyId);
  const actorInfo = normalizeActor(actor);
  const before = getStateRow(workspaceId, companyId);
  const now = nowIso();
  let cancelledTasks = 0;
  let cancelledJobs = 0;
  tx(() => {
    if (before?.state !== nextState) {
      upsertState(workspaceId, companyId, {
        id: id('aut'),
        state: nextState,
        reason: reason ?? null,
        changedBy: actorInfo.actorId,
        changedAt: now,
      });
    }
    if (nextState !== 'AUTOMATION_ACTIVE' && nextState !== 'NEEDS_HUMAN_REVIEW') {
      cancelledTasks = cancelPendingTasksForCompany(workspaceId, companyId, { updatedAt: now });
      cancelledJobs = cancelCompanyJobsSafe(workspaceId, companyId, `automation:${nextState}`);
    }
    recordAudit({
      workspaceId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      action: AUDIT_ACTION_BY_STATE[nextState] || `automation.${nextState.toLowerCase()}`,
      entityType: 'company',
      entityId: companyId,
      before: before ? { state: before.state, reason: before.reason } : null,
      after: { state: nextState, reason, cancelledTasks, cancelledJobs },
      ip: actorInfo.ip,
      userAgent: actorInfo.userAgent,
      requestId: actorInfo.requestId,
    });
  });
  if (notify) {
    createNotification({
      workspaceId,
      type: notify.type,
      title: notify.title,
      body: notify.body,
      entityType: 'company',
      entityId: companyId,
      severity: notify.severity || 'info',
    });
  }
  return {
    company: { id: company.id, name: company.name },
    state: nextState,
    previousState: before?.state || 'AUTOMATION_ACTIVE',
    cancelledTasks,
    cancelledJobs,
  };
}

/** Human operator takes over a company: automation stops immediately. */
export function takeoverCompany(workspaceId, companyId, { reason = '人工接管', actor = {} } = {}) {
  const current = getCompanyAutomationState(workspaceId, companyId);
  if (!current.exists) throw notFound('客户不存在');
  if (current.state === 'DO_NOT_CONTACT') {
    throw conflict('该客户为禁止联系状态，不能被接管', { code: 'DO_NOT_CONTACT_LOCKED' });
  }
  if (current.state === 'CLOSED') throw conflict('该客户已关闭，不能接管', { code: 'CLOSED_LOCKED' });
  return applyStateTransition(workspaceId, companyId, 'HUMAN_TAKEOVER', { reason, actor });
}

/**
 * Resume automation. Only HUMAN_TAKEOVER / PAUSED / NEEDS_HUMAN_REVIEW are
 * allowed. DO_NOT_CONTACT requires an owner/admin to remove suppression first.
 */
export function resumeAutomation(workspaceId, companyId, { reason = '恢复自动化', actor = {} } = {}) {
  const current = getCompanyAutomationState(workspaceId, companyId);
  if (!current.exists) throw notFound('客户不存在');
  const actorInfo = normalizeActor(actor);
  if (current.state === 'DO_NOT_CONTACT') {
    if (companyHasSuppression(workspaceId, companyId)) {
      throw conflict('禁止联系状态需要先由管理员/拥有者删除抑制记录后才能恢复', {
        code: 'DO_NOT_CONTACT_LOCKED',
        hint: 'delete_suppression_first',
      });
    }
    if (!['owner', 'admin'].includes(actorInfo.actorRole)) {
      throw forbidden('只有管理员或拥有者可以恢复禁止联系状态');
    }
  } else if (!RESUMABLE_STATES.has(current.state)) {
    if (current.state === 'CLOSED') throw conflict('已关闭的客户不能恢复自动化', { code: 'CLOSED_LOCKED' });
    throw conflict('当前状态不允许恢复自动化', { code: 'RESUME_NOT_ALLOWED', state: current.state });
  }
  return applyStateTransition(workspaceId, companyId, 'AUTOMATION_ACTIVE', { reason, actor });
}

/** Pause automation without a full human takeover. */
export function pauseAutomation(workspaceId, companyId, { reason = '手动暂停', actor = {} } = {}) {
  const current = getCompanyAutomationState(workspaceId, companyId);
  if (!current.exists) throw notFound('客户不存在');
  if (current.state === 'DO_NOT_CONTACT') {
    throw conflict('禁止联系状态不能降级为暂停，请先删除抑制记录', { code: 'DO_NOT_CONTACT_LOCKED' });
  }
  if (current.state === 'CLOSED') throw conflict('已关闭的客户不能暂停', { code: 'CLOSED_LOCKED' });
  return applyStateTransition(workspaceId, companyId, 'PAUSED', { reason, actor });
}

/**
 * Mark a company as do-not-contact: sets the state, writes suppression records
 * (domain and/or contact emails) and cancels pending work.
 */
export function markDoNotContact(workspaceId, companyId, { reason = 'manual', note = null, actor = {} } = {}) {
  const company = requireCompany(workspaceId, companyId);
  const current = getCompanyAutomationState(workspaceId, companyId);
  if (current.state === 'DO_NOT_CONTACT') return applyStateTransition(workspaceId, companyId, 'DO_NOT_CONTACT', { reason, actor });
  if (current.state === 'CLOSED') throw conflict('已关闭的客户不能标记为禁止联系', { code: 'CLOSED_LOCKED' });
  const now = nowIso();
  const created = [];
  tx(() => {
    if (company.domain) {
      const { record, created: isNew } = insertSuppression(workspaceId, {
        id: id('sup'),
        scope: 'domain',
        valueNormalized: company.domain,
        reason: 'do_not_contact',
        source: 'automation',
        note,
        createdBy: normalizeActor(actor).actorId,
        createdAt: now,
      });
      if (isNew) created.push(record);
    }
    for (const contact of listContactsForCompany(workspaceId, companyId)) {
      if (!contact.emailNormalized) continue;
      const { record, created: isNew } = insertSuppression(workspaceId, {
        id: id('sup'),
        scope: 'email',
        valueNormalized: contact.emailNormalized,
        reason: 'do_not_contact',
        source: 'automation',
        note,
        createdBy: normalizeActor(actor).actorId,
        createdAt: now,
      });
      if (isNew) created.push(record);
    }
  });
  const result = applyStateTransition(workspaceId, companyId, 'DO_NOT_CONTACT', { reason, actor });
  return { ...result, suppressionCreated: created.length };
}

/** Close a company thread of work entirely (terminal state). */
export function closeCompany(workspaceId, companyId, { reason = '关闭客户', actor = {} } = {}) {
  const current = getCompanyAutomationState(workspaceId, companyId);
  if (!current.exists) throw notFound('客户不存在');
  if (current.state === 'CLOSED') return applyStateTransition(workspaceId, companyId, 'CLOSED', { reason, actor });
  // Closing from DO_NOT_CONTACT is allowed: suppression records stay in place,
  // so the customer remains unreachable even though the workflow is closed.
  return applyStateTransition(workspaceId, companyId, 'CLOSED', { reason, actor });
}

export function listAutomationStates(workspaceId, filters = {}) {
  return listStates(workspaceId, filters);
}

export function getAutomationDetail(workspaceId, companyId) {
  const company = requireCompany(workspaceId, companyId);
  const snapshot = getCompanyAutomationState(workspaceId, companyId);
  const row = getStateRow(workspaceId, companyId);
  return {
    company,
    state: snapshot.state,
    reason: snapshot.reason,
    changedBy: snapshot.changedBy,
    changedAt: snapshot.changedAt,
    canSend: snapshot.canSend,
    canAutoSend: snapshot.canAutoSend,
    suppressed: snapshot.suppressed,
    label: snapshot.label,
    recordId: row?.id ?? null,
  };
}

export function getAutomationSummary(workspaceId) {
  const counts = countStates(workspaceId);
  return { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}

/**
 * Reply-classifier hook: a reply needs human attention, but never downgrades a
 * stronger state (takeover / DNC / closed / paused).
 */
export function flagNeedsHumanReview(workspaceId, companyId, { reason = '收到需要人工处理的回复', actor = { actorType: 'agent' } } = {}) {
  const current = getCompanyAutomationState(workspaceId, companyId);
  if (!current.exists) return current;
  if (current.state === 'AUTOMATION_ACTIVE') {
    return applyStateTransition(workspaceId, companyId, 'NEEDS_HUMAN_REVIEW', { reason, actor });
  }
  return current;
}

export default {
  AUTOMATION_STATES,
  AUTOMATION_STATE_LABELS,
  getCompanyAutomationState,
  assertCompanySendable,
  isAutomationBlocked,
  applyStateTransition,
  takeoverCompany,
  resumeAutomation,
  pauseAutomation,
  markDoNotContact,
  closeCompany,
  listAutomationStates,
  getAutomationDetail,
  getAutomationSummary,
  flagNeedsHumanReview,
};
