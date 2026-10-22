/**
 * OWNER: t-crm.
 *
 * Campaign business rules: CRUD, steps, enrollment (dedupe + suppression +
 * automation-state guards), pause/resume/archive, statistics and the
 * post-send advancement called by the worker after `email.send` succeeds.
 */
import { conflict, notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { asString, asInt, asBool, asArray, asObject, validateInput } from '../core/validate.mjs';
import { id } from '../core/ids.mjs';
import { nowIso, addDays } from '../core/time.mjs';
import {
  listCampaigns as repoListCampaigns,
  getCampaign,
  createCampaign as repoCreateCampaign,
  updateCampaign as repoUpdateCampaign,
  softDeleteCampaign,
  listSteps,
  getStep,
  getStepByNo,
  maxStepNo,
  createStep as repoCreateStep,
  updateStep as repoUpdateStep,
  deleteStep as repoDeleteStep,
  listTargets,
  getTarget,
  insertTarget,
  updateTarget,
  countTargetsByStatus,
  countCampaignDraftsByStatus,
  markTargetsReplied,
  countCampaigns,
  countActiveCampaigns,
} from '../repositories/campaigns.mjs';
import { getCompany, getContact, listEnrollableContacts, getContactByEmail } from '../repositories/crm-shared.mjs';
import { getCompanyAutomationState } from './automation.mjs';
import { checkSuppression } from './suppression.mjs';
import { getSetting } from './settings.mjs';

export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'archived'];
const STEP_LANGUAGES_MAX = 20;

function normalizeActor(actor = {}) {
  return {
    actorType: actor.actorType || (actor.actorId ? 'user' : 'system'),
    actorId: actor.actorId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
  };
}

function requireCampaign(workspaceId, campaignId) {
  const campaign = getCampaign(workspaceId, campaignId);
  if (!campaign) throw notFound('活动不存在');
  return campaign;
}

// ----------------------------------------------------------------------- CRUD
export function list(workspaceId, filters = {}) {
  return repoListCampaigns(workspaceId, filters);
}

export function detail(workspaceId, campaignId) {
  const campaign = requireCampaign(workspaceId, campaignId);
  const steps = listSteps(workspaceId, campaignId);
  const stats = statsFor(workspaceId, campaignId);
  return { campaign, steps, stats };
}

export function create(workspaceId, input = {}, actor = {}) {
  const data = validateInput(input, {
    name: { type: 'string', required: true, max: 200, label: '活动名称' },
    productId: { type: 'string', max: 80, label: '产品' },
    icpId: { type: 'string', max: 80, label: 'ICP' },
    goal: { type: 'string', max: 2000, label: '目标' },
    dailyLimit: { type: 'int', min: 1, max: 1000, label: '每日限额', default: 30 },
    sendWindow: { type: 'object', label: '发送窗口' },
    requireApproval: { type: 'bool', label: '需要审批', default: true },
  });
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const campaign = repoCreateCampaign(workspaceId, {
    id: id('cmp'),
    name: data.name,
    productId: data.productId || null,
    icpId: data.icpId || null,
    goal: data.goal || null,
    status: 'draft',
    dailyLimit: data.dailyLimit ?? 30,
    sendWindow: data.sendWindow || getSetting(workspaceId, 'outreach').sendWindow || {},
    requireApproval: data.requireApproval !== false,
    createdBy: actorInfo.actorId,
    createdAt: now,
    updatedAt: now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'campaign.create',
    entityType: 'campaign',
    entityId: campaign.id,
    after: { name: campaign.name, productId: campaign.productId, icpId: campaign.icpId },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return campaign;
}

export function update(workspaceId, campaignId, input = {}, actor = {}) {
  const campaign = requireCampaign(workspaceId, campaignId);
  const patch = {};
  if (input.name !== undefined) patch.name = asString(input.name, { required: true, max: 200, label: '活动名称' });
  if (input.productId !== undefined) patch.productId = input.productId ? asString(input.productId, { max: 80 }) : null;
  if (input.icpId !== undefined) patch.icpId = input.icpId ? asString(input.icpId, { max: 80 }) : null;
  if (input.goal !== undefined) patch.goal = asString(input.goal, { max: 2000, label: '目标' });
  if (input.dailyLimit !== undefined) patch.dailyLimit = asInt(input.dailyLimit, { min: 1, max: 1000, label: '每日限额' });
  if (input.sendWindow !== undefined) patch.sendWindow = asObject(input.sendWindow, { label: '发送窗口' });
  if (input.requireApproval !== undefined) patch.requireApproval = asBool(input.requireApproval);
  if (!Object.keys(patch).length) return campaign;
  patch.updatedAt = nowIso();
  const updated = repoUpdateCampaign(workspaceId, campaignId, patch);
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.update',
    entityType: 'campaign',
    entityId: campaignId,
    before: campaign,
    after: updated,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

export function archive(workspaceId, campaignId, actor = {}) {
  const campaign = requireCampaign(workspaceId, campaignId);
  const now = nowIso();
  softDeleteCampaign(workspaceId, campaignId, { updatedAt: now });
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.archive',
    entityType: 'campaign',
    entityId: campaignId,
    before: { status: campaign.status },
    after: { status: 'archived', deleted: true },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { archived: true };
}

// ---------------------------------------------------------------------- steps
export function steps(workspaceId, campaignId) {
  requireCampaign(workspaceId, campaignId);
  return listSteps(workspaceId, campaignId);
}

export function addStep(workspaceId, campaignId, input = {}, actor = {}) {
  requireCampaign(workspaceId, campaignId);
  const name = asString(input.name, { required: true, max: 200, label: '步骤名称' });
  const subjectTemplate = asString(input.subjectTemplate, { max: 500, label: '主题模板' });
  const bodyTemplate = asString(input.bodyTemplate, { max: 20000, label: '正文模板' });
  const language = asString(input.language || 'en', { max: 20, label: '语言' }).toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) throw validationError('语言代码不正确');
  const delayDays = asInt(input.delayDays, { min: 0, max: 365, fallback: 0, label: '延迟天数' });
  const conditions = input.conditions !== undefined ? asObject(input.conditions, { label: '条件' }) : {};
  const isActive = input.isActive === undefined ? true : asBool(input.isActive);
  const stepNo = input.stepNo !== undefined ? asInt(input.stepNo, { required: true, min: 1, max: STEP_LANGUAGES_MAX * 50, label: '步骤序号' }) : maxStepNo(workspaceId, campaignId) + 1;
  const now = nowIso();
  let step;
  try {
    step = repoCreateStep(workspaceId, {
      id: id('stp'),
      campaignId,
      stepNo,
      name,
      channel: 'email',
      subjectTemplate,
      bodyTemplate,
      language,
      delayDays,
      conditions,
      isActive,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) throw conflict('该步骤序号已存在');
    throw error;
  }
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.step_create',
    entityType: 'campaign_step',
    entityId: step.id,
    after: { campaignId, stepNo, name, language },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return step;
}

export function updateStep(workspaceId, campaignId, stepId, input = {}, actor = {}) {
  requireCampaign(workspaceId, campaignId);
  const existing = getStep(workspaceId, campaignId, stepId);
  if (!existing) throw notFound('活动步骤不存在');
  const patch = {};
  if (input.name !== undefined) patch.name = asString(input.name, { required: true, max: 200, label: '步骤名称' });
  if (input.subjectTemplate !== undefined) patch.subjectTemplate = asString(input.subjectTemplate, { max: 500, label: '主题模板' });
  if (input.bodyTemplate !== undefined) patch.bodyTemplate = asString(input.bodyTemplate, { max: 20000, label: '正文模板' });
  if (input.language !== undefined) patch.language = asString(input.language, { max: 20, label: '语言' }).toLowerCase();
  if (input.delayDays !== undefined) patch.delayDays = asInt(input.delayDays, { min: 0, max: 365, label: '延迟天数' });
  if (input.conditions !== undefined) patch.conditions = asObject(input.conditions, { label: '条件' });
  if (input.isActive !== undefined) patch.isActive = asBool(input.isActive);
  if (input.stepNo !== undefined) patch.stepNo = asInt(input.stepNo, { required: true, min: 1, max: 1000, label: '步骤序号' });
  if (!Object.keys(patch).length) return existing;
  patch.updatedAt = nowIso();
  const updated = repoUpdateStep(workspaceId, campaignId, stepId, patch);
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.step_update',
    entityType: 'campaign_step',
    entityId: stepId,
    before: existing,
    after: updated,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

export function removeStep(workspaceId, campaignId, stepId, actor = {}) {
  requireCampaign(workspaceId, campaignId);
  const existing = getStep(workspaceId, campaignId, stepId);
  if (!existing) throw notFound('活动步骤不存在');
  repoDeleteStep(workspaceId, campaignId, stepId);
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.step_delete',
    entityType: 'campaign_step',
    entityId: stepId,
    before: existing,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { deleted: true };
}

// -------------------------------------------------------------------- enroll
/**
 * Enroll companies/contacts into a campaign. Skips duplicates, contacts without
 * a real email, suppressed recipients and companies whose automation state
 * forbids outbound work (DNC / takeover / paused / closed).
 */
export function enroll(workspaceId, campaignId, input = {}, actor = {}) {
  const campaign = requireCampaign(workspaceId, campaignId);
  if (campaign.status === 'archived') throw conflict('已归档的活动不能添加目标');
  const companyIds = asArray(input.companyIds, { max: 1000, label: '企业列表' }).map((value) => asString(value, { max: 80 }));
  const contactIds = asArray(input.contactIds, { max: 2000, label: '联系人列表' }).map((value) => asString(value, { max: 80 }));
  if (!companyIds.length && !contactIds.length) throw validationError('请至少选择一个企业或联系人');
  const contacts = listEnrollableContacts(workspaceId, { companyIds, contactIds });
  const now = nowIso();
  const result = { enrolled: 0, skipped: 0, duplicate: 0, noEmail: 0, suppressed: 0, automationBlocked: 0, invalid: 0, targetIds: [] };
  const automationCache = new Map();
  const companyCache = new Map();
  for (const contact of contacts) {
    if (!contact.emailNormalized) {
      result.skipped += 1;
      result.noEmail += 1;
      continue;
    }
    if (!companyCache.has(contact.companyId)) {
      const company = getCompany(workspaceId, contact.companyId);
      companyCache.set(contact.companyId, company);
      if (!company) {
        result.skipped += 1;
        result.invalid += 1;
        continue;
      }
      automationCache.set(contact.companyId, getCompanyAutomationState(workspaceId, contact.companyId));
    }
    const company = companyCache.get(contact.companyId);
    const automation = automationCache.get(contact.companyId);
    if (!['AUTOMATION_ACTIVE', 'NEEDS_HUMAN_REVIEW'].includes(automation.state)) {
      result.skipped += 1;
      result.automationBlocked += 1;
      continue;
    }
    if (checkSuppression(workspaceId, { email: contact.emailNormalized, domain: company.domain }).suppressed) {
      result.skipped += 1;
      result.suppressed += 1;
      continue;
    }
    const created = insertTarget(workspaceId, {
      id: id('tgt'),
      campaignId,
      companyId: contact.companyId,
      contactId: contact.id,
      status: campaign.status === 'active' ? 'active' : 'enrolled',
      currentStep: 0,
      enrolledAt: now,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (created) {
      result.enrolled += 1;
      result.targetIds.push(contact.id);
    } else {
      result.skipped += 1;
      result.duplicate += 1;
    }
  }
  if (companyIds.length) {
    for (const companyId of companyIds) {
      if (companyCache.has(companyId)) continue;
      const company = getCompany(workspaceId, companyId);
      if (!company) result.invalid += 1;
    }
  }
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.enroll',
    entityType: 'campaign',
    entityId: campaignId,
    after: {
      enrolled: result.enrolled,
      skipped: result.skipped,
      duplicate: result.duplicate,
      suppressed: result.suppressed,
      automationBlocked: result.automationBlocked,
      noEmail: result.noEmail,
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return result;
}

// ------------------------------------------------------------------ lifecycle
export function pause(workspaceId, campaignId, actor = {}) {
  const campaign = requireCampaign(workspaceId, campaignId);
  if (campaign.status === 'paused') return campaign;
  if (campaign.status !== 'active' && campaign.status !== 'draft') throw conflict('当前活动状态不能暂停');
  const updated = repoUpdateCampaign(workspaceId, campaignId, { status: 'paused', updatedAt: nowIso() });
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.pause',
    entityType: 'campaign',
    entityId: campaignId,
    before: { status: campaign.status },
    after: { status: 'paused' },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

export function resume(workspaceId, campaignId, actor = {}) {
  const campaign = requireCampaign(workspaceId, campaignId);
  if (campaign.status === 'active') return campaign;
  if (campaign.status !== 'paused' && campaign.status !== 'draft') throw conflict('当前活动状态不能恢复');
  // A campaign may be resumed for manual review at any time, but sending still
  // requires approval + limits; the global auto-send switch must be on for the
  // automatic tick to run.
  const updated = repoUpdateCampaign(workspaceId, campaignId, { status: 'active', updatedAt: nowIso() });
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'campaign.resume',
    entityType: 'campaign',
    entityId: campaignId,
    before: { status: campaign.status },
    after: { status: 'active', autoSendEnabled: Boolean(getSetting(workspaceId, 'outreach').autoSendEnabled) },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

export function targets(workspaceId, campaignId, filters = {}) {
  requireCampaign(workspaceId, campaignId);
  return listTargets(workspaceId, campaignId, filters);
}

// ---------------------------------------------------------------------- stats
export function statsFor(workspaceId, campaignId) {
  const byStatus = countTargetsByStatus(workspaceId, campaignId);
  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
  const sent = countCampaignDraftsByStatus(workspaceId, campaignId, 'sent');
  const pendingApproval = countCampaignDraftsByStatus(workspaceId, campaignId, 'pending_approval');
  const replied = byStatus.replied || 0;
  const unsubscribed = byStatus.unsubscribed || 0;
  const completed = byStatus.completed || 0;
  const active = byStatus.active || 0;
  const enrolled = byStatus.enrolled || 0;
  const bounced = byStatus.bounced || 0;
  return {
    campaignId,
    targets: total,
    total,
    sent,
    replied,
    unsubscribed,
    pendingApproval,
    completed,
    active,
    enrolled,
    bounced,
    pending: active + enrolled,
    byStatus,
    replyRate: sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0,
    unsubscribeRate: sent > 0 ? Math.round((unsubscribed / sent) * 1000) / 10 : 0,
  };
}

export function stats(workspaceId, campaignId) {
  requireCampaign(workspaceId, campaignId);
  return statsFor(workspaceId, campaignId);
}

export function overview(workspaceId) {
  return { total: countCampaigns(workspaceId), active: countActiveCampaigns(workspaceId) };
}

// ---------------------------------------------------------- worker integration
/**
 * Called by the worker after a successful send. `current_step` stores the last
 * completed step (0 = nothing sent yet), so after sending the step
 * `currentStep + 1` we schedule the following active step (honouring its
 * delay) or mark the target completed.
 */
export function advanceAfterSend({ workspaceId, campaignId, contactId, draftId = null }) {
  const campaign = campaignId ? getCampaign(workspaceId, campaignId) : null;
  if (!campaign) return { advanced: false, reason: 'campaign_not_found' };
  const target = getTarget(workspaceId, campaignId, contactId);
  if (!target) return { advanced: false, reason: 'target_not_found' };
  if (['replied', 'unsubscribed', 'bounced', 'failed', 'completed'].includes(target.status)) {
    return { advanced: false, reason: `target_${target.status}` };
  }
  const now = nowIso();
  const sentStepNo = target.currentStep + 1;
  const upcomingStep = getStepByNo(workspaceId, campaignId, sentStepNo + 1);
  let patch;
  let outcome;
  if (upcomingStep && upcomingStep.isActive) {
    patch = {
      status: 'active',
      currentStep: sentStepNo,
      nextRunAt: addDays(Math.max(0, upcomingStep.delayDays || 0), Date.now()),
      lastContactedAt: now,
      updatedAt: now,
    };
    outcome = { advanced: true, completed: false, sentStepNo, nextStepNo: upcomingStep.stepNo, nextRunAt: patch.nextRunAt };
  } else {
    patch = { status: 'completed', currentStep: sentStepNo, nextRunAt: null, lastContactedAt: now, updatedAt: now };
    outcome = { advanced: true, completed: true, sentStepNo };
  }
  updateTarget(workspaceId, target.id, patch);
  recordAudit({
    workspaceId,
    actorType: 'system',
    action: 'campaign.target_advance',
    entityType: 'campaign_target',
    entityId: target.id,
    before: { status: target.status, currentStep: target.currentStep },
    after: { status: patch.status, currentStep: patch.currentStep, nextRunAt: patch.nextRunAt, draftId },
  });
  return outcome;
}

/**
 * Worker helper: resolve the campaign/step/target for a draft. Accepts a draft
 * row in either camelCase (service) or snake_case (raw DB) shape.
 */
export function getCampaignSendContext(workspaceId, draft) {
  if (!draft) return null;
  const campaignId = draft.campaignId ?? draft.campaign_id;
  if (!campaignId) return null;
  const campaign = getCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  const stepId = draft.campaignStepId ?? draft.campaign_step_id;
  const contactId = draft.contactId ?? draft.contact_id;
  const target = contactId ? getTarget(workspaceId, campaignId, contactId) : null;
  const step = stepId ? getStep(workspaceId, campaignId, stepId) : target ? getStepByNo(workspaceId, campaignId, target.currentStep + 1) : null;
  return { campaign, step, target };
}

/** Called by the worker when a reply is received (targets stop being nurtured). */
export function markReplied(workspaceId, { companyId, contactId = null }) {
  return markTargetsReplied(workspaceId, { companyId, contactId, updatedAt: nowIso() });
}

/** Resolve a contact id from an inbound email address (worker convenience). */
export function findContactByEmail(workspaceId, email) {
  return getContactByEmail(workspaceId, email);
}

/** Resolve a contact within a company (worker convenience). */
export function findContact(workspaceId, contactId) {
  return getContact(workspaceId, contactId);
}

export default {
  CAMPAIGN_STATUSES,
  list,
  detail,
  create,
  update,
  archive,
  steps,
  addStep,
  updateStep,
  removeStep,
  enroll,
  pause,
  resume,
  targets,
  stats,
  overview,
  advanceAfterSend,
  getCampaignSendContext,
  markReplied,
};
