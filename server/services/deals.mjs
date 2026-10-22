/**
 * OWNER: t-crm.
 *
 * Deals / pipeline / sales activities. Stage transitions are validated and
 * every mutation is audited.
 */
import { conflict, notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { asString, asEnum, asNumber, asInt, asIsoDate } from '../core/validate.mjs';
import {
  listDeals,
  getDeal,
  createDeal as repoCreateDeal,
  updateDeal as repoUpdateDeal,
  deleteDeal,
  listPipelineDeals,
  createActivity as repoCreateActivity,
  listActivities,
} from '../repositories/deals.mjs';
import { getCompany, getContact } from '../repositories/crm-shared.mjs';

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
export const DEAL_STAGE_LABELS = {
  lead: '线索',
  qualified: '合格',
  proposal: '方案/报价',
  negotiation: '谈判',
  won: '赢单',
  lost: '丢单',
};
export const ACTIVITY_TYPES = ['email', 'call', 'meeting', 'note', 'task', 'system'];
const STAGE_PROBABILITY = { lead: 10, qualified: 30, proposal: 50, negotiation: 70, won: 100, lost: 0 };

function normalizeActor(actor = {}) {
  return {
    actorType: actor.actorType || (actor.actorId ? 'user' : 'system'),
    actorId: actor.actorId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
  };
}

function requireDeal(workspaceId, dealId) {
  const deal = getDeal(workspaceId, dealId);
  if (!deal) throw notFound('商机不存在');
  return deal;
}

export function list(workspaceId, filters = {}) {
  return listDeals(workspaceId, filters);
}

export function detail(workspaceId, dealId) {
  const deal = requireDeal(workspaceId, dealId);
  const activities = listActivities(workspaceId, { dealId, page: 1, pageSize: 100, limit: 100, offset: 0 }).items;
  const company = getCompany(workspaceId, deal.companyId);
  const contact = deal.contactId ? getContact(workspaceId, deal.contactId) : null;
  return { deal, activities, company, contact };
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
  const title = asString(input.title || `${company.name} 商机`, { required: true, max: 200, label: '商机名称' });
  const stage = asEnum(input.stage || 'lead', DEAL_STAGES, { label: '阶段', required: true });
  const currency = asString(input.currency || 'EUR', { max: 8, label: '币种' }).toUpperCase();
  const valueAmount = input.valueAmount !== undefined && input.valueAmount !== null && input.valueAmount !== '' ? asNumber(input.valueAmount, { min: 0, max: 1e10, label: '金额' }) : null;
  const probability = input.probability !== undefined ? asInt(input.probability, { min: 0, max: 100, label: '概率' }) : STAGE_PROBABILITY[stage] ?? null;
  const expectedCloseDate = input.expectedCloseDate ? asIsoDate(input.expectedCloseDate, { label: '预计成交日' }) : null;
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const status = stage === 'won' ? 'won' : stage === 'lost' ? 'lost' : 'open';
  const deal = repoCreateDeal(workspaceId, {
    id: id('deal'),
    companyId,
    contactId,
    productId: input.productId ? asString(input.productId, { max: 80 }) : null,
    title,
    stage,
    valueAmount,
    currency,
    probability,
    expectedCloseDate,
    status,
    lostReason: input.lostReason ? asString(input.lostReason, { max: 2000 }) : null,
    ownerUserId: input.ownerUserId ? asString(input.ownerUserId, { max: 80 }) : actorInfo.actorId,
    createdAt: now,
    updatedAt: now,
    closedAt: status === 'open' ? null : now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'deal.create',
    entityType: 'deal',
    entityId: deal.id,
    after: { companyId, title, stage, valueAmount, currency },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return deal;
}

export function update(workspaceId, dealId, input = {}, actor = {}) {
  const deal = requireDeal(workspaceId, dealId);
  const patch = {};
  if (input.title !== undefined) patch.title = asString(input.title, { required: true, max: 200, label: '商机名称' });
  if (input.contactId !== undefined) {
    if (input.contactId) {
      const contact = getContact(workspaceId, input.contactId);
      if (!contact || contact.companyId !== deal.companyId) throw validationError('联系人与企业不匹配');
      patch.contactId = contact.id;
    } else {
      patch.contactId = null;
    }
  }
  if (input.productId !== undefined) patch.productId = input.productId ? asString(input.productId, { max: 80 }) : null;
  if (input.valueAmount !== undefined) patch.valueAmount = input.valueAmount === null || input.valueAmount === '' ? null : asNumber(input.valueAmount, { min: 0, max: 1e10, label: '金额' });
  if (input.currency !== undefined) patch.currency = asString(input.currency, { max: 8, label: '币种' }).toUpperCase();
  if (input.probability !== undefined) patch.probability = input.probability === null ? null : asInt(input.probability, { min: 0, max: 100, label: '概率' });
  if (input.expectedCloseDate !== undefined) patch.expectedCloseDate = input.expectedCloseDate ? asIsoDate(input.expectedCloseDate, { label: '预计成交日' }) : null;
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId ? asString(input.ownerUserId, { max: 80 }) : null;
  if (input.lostReason !== undefined) patch.lostReason = input.lostReason ? asString(input.lostReason, { max: 2000 }) : null;
  if (input.stage !== undefined) {
    const nextStage = asEnum(input.stage, DEAL_STAGES, { label: '阶段', required: true });
    if (nextStage !== deal.stage) {
      if (['won', 'lost'].includes(deal.stage) && nextStage !== deal.stage) {
        throw conflict('已结单的商机不能改回进行中阶段', { code: 'DEAL_CLOSED', stage: deal.stage });
      }
      patch.stage = nextStage;
      patch.status = nextStage === 'won' ? 'won' : nextStage === 'lost' ? 'lost' : 'open';
      patch.closedAt = patch.status === 'open' ? null : nowIso();
      if (input.probability === undefined) patch.probability = STAGE_PROBABILITY[nextStage] ?? deal.probability;
      if (nextStage === 'lost' && !input.lostReason && !deal.lostReason) {
        patch.lostReason = '未填写丢单原因';
      }
    }
  }
  if (!Object.keys(patch).length) return deal;
  patch.updatedAt = nowIso();
  const updated = repoUpdateDeal(workspaceId, dealId, patch);
  const actorInfo = normalizeActor(actor);
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'deal.update',
    entityType: 'deal',
    entityId: dealId,
    before: { stage: deal.stage, status: deal.status, valueAmount: deal.valueAmount, title: deal.title },
    after: { stage: updated.stage, status: updated.status, valueAmount: updated.valueAmount, title: updated.title },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

export function remove(workspaceId, dealId, actor = {}) {
  const deal = requireDeal(workspaceId, dealId);
  deleteDeal(workspaceId, dealId);
  const actorInfo = normalizeActor(actor);
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'deal.delete',
    entityType: 'deal',
    entityId: dealId,
    before: { companyId: deal.companyId, title: deal.title, stage: deal.stage },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { deleted: true };
}

/** Compact card shape used by the pipeline board (see FRONTEND-CONTRACTS 3.2). */
function pipelineCard(deal) {
  return {
    id: deal.id,
    title: deal.title,
    companyId: deal.companyId,
    companyName: deal.companyName ?? null,
    contactId: deal.contactId,
    contactName: deal.contactName ?? null,
    valueAmount: deal.valueAmount,
    currency: deal.currency,
    probability: deal.probability,
    expectedCloseDate: deal.expectedCloseDate,
    ownerUserId: deal.ownerUserId,
    updatedAt: deal.updatedAt,
  };
}

export function pipeline(workspaceId) {
  const deals = listPipelineDeals(workspaceId);
  const grouped = new Map(DEAL_STAGES.map((stage) => [stage, []]));
  for (const deal of deals) {
    if (!grouped.has(deal.stage)) grouped.set(deal.stage, []);
    grouped.get(deal.stage).push(deal);
  }
  const stages = DEAL_STAGES.map((stage) => {
    const stageDeals = grouped.get(stage) || [];
    const totalValue = stageDeals.reduce((sum, deal) => sum + (Number(deal.valueAmount) || 0), 0);
    const probability = STAGE_PROBABILITY[stage] / 100;
    return {
      stage,
      label: DEAL_STAGE_LABELS[stage],
      count: stageDeals.length,
      totalValue: Math.round(totalValue * 100) / 100,
      weightedValue: Math.round(totalValue * probability * 100) / 100,
      items: stageDeals.map(pipelineCard),
    };
  });
  const open = stages.filter((item) => item.stage !== 'won' && item.stage !== 'lost');
  const totals = {
    openCount: open.reduce((sum, item) => sum + item.count, 0),
    totalValue: Math.round(open.reduce((sum, item) => sum + item.totalValue, 0) * 100) / 100,
    weightedValue: Math.round(open.reduce((sum, item) => sum + item.weightedValue, 0) * 100) / 100,
    wonValue: Math.round((stages.find((item) => item.stage === 'won')?.totalValue || 0) * 100) / 100,
  };
  return { stages, totals, currency: 'EUR' };
}

// ---------------------------------------------------------------- activities
export function activities(workspaceId, filters = {}) {
  return listActivities(workspaceId, filters);
}

export function createActivity(workspaceId, input = {}, actor = {}) {
  const companyId = asString(input.companyId, { required: true, max: 80, label: '企业' });
  const company = getCompany(workspaceId, companyId);
  if (!company) throw notFound('客户不存在');
  const type = asEnum(input.type || 'note', ACTIVITY_TYPES, { label: '活动类型', required: true });
  const contactId = input.contactId ? asString(input.contactId, { max: 80 }) : null;
  if (contactId) {
    const contact = getContact(workspaceId, contactId);
    if (!contact || contact.companyId !== companyId) throw validationError('联系人与企业不匹配');
  }
  let dealId = input.dealId ? asString(input.dealId, { max: 80 }) : null;
  if (dealId) {
    const deal = getDeal(workspaceId, dealId);
    if (!deal) throw validationError('商机不存在');
    if (deal.companyId !== companyId) throw validationError('商机不属于该企业');
  }
  const actorInfo = normalizeActor(actor);
  const activity = repoCreateActivity(workspaceId, {
    id: id('act'),
    companyId,
    contactId,
    dealId,
    type,
    subject: input.subject ? asString(input.subject, { max: 300, label: '主题' }) : null,
    body: input.body ? asString(input.body, { max: 8000, label: '内容' }) : null,
    occurredAt: input.occurredAt ? asIsoDate(input.occurredAt, { label: '发生时间' }) : nowIso(),
    userId: actorInfo.actorId,
    createdAt: nowIso(),
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'activity.create',
    entityType: 'sales_activity',
    entityId: activity.id,
    after: { companyId, dealId, type, subject: activity.subject },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return activity;
}

/** Aggregated pipeline view for the dashboard. */
export function summary(workspaceId) {
  const view = pipeline(workspaceId);
  return {
    open: view.totals.openCount,
    pipelineValue: view.totals.totalValue,
    weightedValue: view.totals.weightedValue,
    wonValue: view.totals.wonValue,
  };
}

export default {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  ACTIVITY_TYPES,
  list,
  detail,
  create,
  update,
  remove,
  pipeline,
  activities,
  createActivity,
  summary,
};
