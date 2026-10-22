/**
 * OWNER: t-crm.
 *
 * Dashboard aggregation. Read-only: composes counts from the repositories and
 * never mutates business data.
 */
import { addDays, dayKey, nowIso } from '../core/time.mjs';
import { getSettings } from './settings.mjs';
import { getAutomationSummary } from './automation.mjs';
import * as dashboardRepo from '../repositories/dashboard.mjs';

function isoDaysAgo(days) {
  return addDays(-days);
}

function startOfTodayIso() {
  return `${dayKey()}T00:00:00.000Z`;
}

function limitsFor(workspaceId) {
  const settings = getSettings(workspaceId);
  const outreach = settings.outreach || {};
  const limits = settings.limits || {};
  return {
    dailyLimit: Math.max(1, Math.min(Number(outreach.dailySendLimit || 50), Number(limits.dailyEmailLimit || 50))),
    autoSendEnabled: Boolean(outreach.autoSendEnabled),
  };
}

export function summary(workspaceId) {
  const now = Date.now();
  const weekIso = isoDaysAgo(7);
  const monthIso = isoDaysAgo(30);
  const todayIso = startOfTodayIso();
  const companies = dashboardRepo.companyCounts(workspaceId, weekIso);
  const contacts = dashboardRepo.contactCounts(workspaceId);
  const drafts = dashboardRepo.draftCounts(workspaceId);
  const campaigns = dashboardRepo.campaignCounts(workspaceId);
  const inbox = dashboardRepo.inboxCounts(workspaceId, weekIso);
  const deals = dashboardRepo.dealCounts(workspaceId, monthIso);
  const sendCounts = dashboardRepo.sendCounts(workspaceId, weekIso, monthIso, todayIso);
  const agents = dashboardRepo.agentCounts(workspaceId, weekIso);
  const jobs = dashboardRepo.jobCounts(workspaceId);
  const tasks = dashboardRepo.taskCounts(workspaceId, nowIso());
  const limits = limitsFor(workspaceId);
  const usage = dashboardRepo.usageOverview(workspaceId, monthIso);
  const automation = getAutomationSummary(workspaceId);
  return {
    workspaceId,
    generatedAt: nowIso(),
    companies,
    contacts,
    drafts,
    campaigns,
    inbox,
    deals,
    sends: {
      sent7d: sendCounts.sent7d,
      sent30d: sendCounts.sent30d,
      totalSent: sendCounts.totalSent,
      dailyUsed: sendCounts.dailyUsed,
      dailyLimit: limits.dailyLimit,
      autoSendEnabled: limits.autoSendEnabled,
      replyRate: sendCounts.replyRate,
    },
    agents,
    jobs,
    tasks,
    automation: automation.counts,
    usage,
    trend: dashboardRepo.trend(workspaceId, 14, isoDaysAgo(14)),
    funnel: [
      { stage: 'new', label: '新增', count: Math.max(0, companies.total - companies.qualified - companies.contacted - companies.replied - companies.customer) },
      { stage: 'qualified', label: '合格', count: companies.qualified },
      { stage: 'contacted', label: '已触达', count: companies.contacted },
      { stage: 'replied', label: '已回复', count: companies.replied },
      { stage: 'customer', label: '已成交', count: companies.customer },
    ],
    alerts: alerts(workspaceId).items,
    recent: activity(workspaceId, { limit: 8 }).items,
    generatedMs: Date.now() - now,
  };
}

export function activity(workspaceId, { limit = 8 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8));
  const messages = dashboardRepo.recentMessages(workspaceId, safeLimit);
  const activities = dashboardRepo.recentActivities(workspaceId, safeLimit);
  const audit = dashboardRepo.recentAuditEvents(workspaceId, safeLimit);
  const items = [
    ...messages.map((row) => ({
      type: row.direction === 'inbound' ? 'reply' : 'email',
      title: row.subject || (row.direction === 'inbound' ? '收到客户回复' : '外发邮件'),
      detail: row.company_name || null,
      at: row.received_at || row.sent_at || row.created_at,
      entityType: 'email_message',
      entityId: row.id,
    })),
    ...activities.map((row) => ({
      type: 'activity',
      title: row.subject || `销售活动（${row.type}）`,
      detail: row.company_name || null,
      at: row.occurred_at,
      entityType: 'company',
      entityId: row.company_id,
    })),
    ...audit.map((row) => ({
      type: 'system',
      title: row.action,
      detail: row.entity_type ? `${row.entity_type}${row.entity_id ? ` · ${row.entity_id}` : ''}` : null,
      at: row.created_at,
      entityType: row.entity_type || null,
      entityId: row.entity_id || null,
    })),
  ]
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, safeLimit);
  return { items };
}

export function alerts(workspaceId) {
  const items = [];
  const now = nowIso();
  for (const thread of dashboardRepo.highIntentThreads(workspaceId, 5)) {
    items.push({
      type: 'high_intent',
      severity: 'critical',
      title: '高意向客户待跟进',
      detail: `${thread.company_name || '客户'}：${thread.subject || '来信'}`,
      entityType: 'email_thread',
      entityId: thread.id,
      createdAt: thread.last_message_at || now,
    });
  }
  const pending = dashboardRepo.draftCounts(workspaceId).pendingApproval;
  if (pending > 0) {
    items.push({
      type: 'pending_approval',
      severity: 'warning',
      title: `${pending} 封草稿待审批`,
      detail: 'AI 生成草稿需要人工审批后才会发送。',
      entityType: null,
      entityId: null,
      createdAt: now,
    });
  }
  for (const job of dashboardRepo.failedJobs(workspaceId, 5)) {
    items.push({
      type: 'job_failed',
      severity: 'warning',
      title: `后台任务失败：${job.type}`,
      detail: job.error || job.status,
      entityType: 'background_job',
      entityId: job.id,
      createdAt: job.updatedAt || now,
    });
  }
  for (const account of dashboardRepo.erroredAccounts(workspaceId)) {
    items.push({
      type: 'email_account_error',
      severity: 'critical',
      title: `邮箱账户异常：${account.name}`,
      detail: account.last_error || account.address,
      entityType: 'email_account',
      entityId: account.id,
      createdAt: now,
    });
  }
  for (const state of dashboardRepo.neededReviewStates(workspaceId, 5)) {
    items.push({
      type: 'automation_review',
      severity: 'warning',
      title: '客户需要人工处理',
      detail: `${state.company_name || state.company_id}：${state.reason || state.state}`,
      entityType: 'company',
      entityId: state.company_id,
      createdAt: state.changed_at || now,
    });
  }
  const tasks = dashboardRepo.taskCounts(workspaceId, now);
  if (tasks.overdue > 0) {
    items.push({
      type: 'task_overdue',
      severity: 'warning',
      title: `${tasks.overdue} 个跟进任务已逾期`,
      detail: '请尽快处理逾期跟进任务，避免遗漏客户。',
      entityType: null,
      entityId: null,
      createdAt: now,
    });
  }
  return { items };
}

export default { summary, activity, alerts };
