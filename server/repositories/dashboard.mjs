/**
 * OWNER: t-crm.
 *
 * Read-only aggregation queries for the dashboard. No writes, no audit.
 */
import { all, get } from '../core/db.mjs';
import { HIGH_INTENT_LABELS } from './email.mjs';

function count(sql, params = []) {
  return Number(get(sql, params)?.c || 0);
}

function labelsPlaceholders() {
  return HIGH_INTENT_LABELS.map(() => '?').join(', ');
}

export function companyCounts(workspaceId, sinceIso) {
  const row = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new7d,
            SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contacted,
            SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied,
            SUM(CASE WHEN status = 'customer' THEN 1 ELSE 0 END) AS customer
       FROM companies WHERE workspace_id = ? AND deleted_at IS NULL`,
    [sinceIso, workspaceId],
  );
  return {
    total: Number(row?.total || 0),
    new7d: Number(row?.new7d || 0),
    qualified: Number(row?.qualified || 0),
    contacted: Number(row?.contacted || 0),
    replied: Number(row?.replied || 0),
    customer: Number(row?.customer || 0),
  };
}

export function contactCounts(workspaceId) {
  const row = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN email_normalized IS NOT NULL AND email_normalized <> '' THEN 1 ELSE 0 END) AS with_email
       FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL`,
    [workspaceId],
  );
  return { total: Number(row?.total || 0), withEmail: Number(row?.with_email || 0) };
}

export function draftCounts(workspaceId) {
  return {
    pendingApproval: count("SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = 'pending_approval'", [workspaceId]),
    approved: count("SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = 'approved'", [workspaceId]),
    total: count('SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ?', [workspaceId]),
    sent: count("SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = 'sent'", [workspaceId]),
  };
}

export function campaignCounts(workspaceId) {
  return {
    active: count("SELECT COUNT(*) AS c FROM campaigns WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL", [workspaceId]),
    total: count('SELECT COUNT(*) AS c FROM campaigns WHERE workspace_id = ? AND deleted_at IS NULL', [workspaceId]),
  };
}

export function inboxCounts(workspaceId, sinceIso) {
  return {
    unreadThreads: count(
      `SELECT COUNT(*) AS c FROM email_threads th
        WHERE th.workspace_id = ?
          AND EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = th.id AND m.direction = 'inbound' AND m.is_read = 0)`,
      [workspaceId],
    ),
    highIntent: count(
      `SELECT COUNT(*) AS c FROM email_threads th
        WHERE th.workspace_id = ?
          AND (SELECT cc.label FROM conversation_classifications cc WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) IN (${labelsPlaceholders()})`,
      [workspaceId, ...HIGH_INTENT_LABELS],
    ),
    replies7d: count(
      `SELECT COUNT(*) AS c FROM email_messages
        WHERE workspace_id = ? AND direction = 'inbound' AND COALESCE(received_at, created_at) >= ?`,
      [workspaceId, sinceIso],
    ),
  };
}

export function dealCounts(workspaceId, sinceIso) {
  const open = get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(value_amount), 0) AS v
       FROM deals WHERE workspace_id = ? AND status = 'open'`,
    [workspaceId],
  );
  const won = get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(value_amount), 0) AS v
       FROM deals WHERE workspace_id = ? AND status = 'won' AND COALESCE(closed_at, updated_at) >= ?`,
    [workspaceId, sinceIso],
  );
  return {
    open: Number(open?.c || 0),
    pipelineValue: Math.round(Number(open?.v || 0) * 100) / 100,
    won30d: Math.round(Number(won?.v || 0) * 100) / 100,
  };
}

export function sendCounts(workspaceId, weekIso, monthIso, dayIso) {
  const sent7d = count(
    `SELECT COUNT(*) AS c FROM email_messages
      WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sent', 'sending')
        AND COALESCE(sent_at, created_at) >= ?`,
    [workspaceId, weekIso],
  );
  const sent30d = count(
    `SELECT COUNT(*) AS c FROM email_messages
      WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sent', 'sending')
        AND COALESCE(sent_at, created_at) >= ?`,
    [workspaceId, monthIso],
  );
  const inbound30d = count(
    `SELECT COUNT(*) AS c FROM email_messages
      WHERE workspace_id = ? AND direction = 'inbound' AND COALESCE(received_at, created_at) >= ?`,
    [workspaceId, monthIso],
  );
  const sentToday = count(
    `SELECT COUNT(*) AS c FROM email_messages
      WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sent', 'sending')
        AND COALESCE(sent_at, created_at) >= ?`,
    [workspaceId, dayIso],
  );
  const queuedToday = count(
    `SELECT COUNT(*) AS c FROM message_drafts
      WHERE workspace_id = ? AND status = 'scheduled' AND scheduled_at >= ?`,
    [workspaceId, dayIso],
  );
  const totals = get(
    `SELECT COUNT(*) AS sent FROM email_messages
      WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sent', 'sending')`,
    [workspaceId],
  );
  return {
    sent7d,
    sent30d,
    sentToday: sentToday + queuedToday,
    dailyUsed: sentToday + queuedToday,
    inbound30d,
    totalSent: Number(totals?.sent || 0),
    replyRate: sent30d > 0 ? Math.min(100, Math.round((inbound30d / sent30d) * 1000) / 10) : 0,
  };
}

export function agentCounts(workspaceId, sinceIso) {
  const row = get(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_estimate), 0) AS cost
       FROM agent_executions WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, sinceIso],
  );
  return {
    runs7d: Number(row?.runs || 0),
    tokens7d: Number(row?.tokens || 0),
    cost7d: Math.round(Number(row?.cost || 0) * 10000) / 10000,
  };
}

export function jobCounts(workspaceId) {
  const rows = all('SELECT status, COUNT(*) AS c FROM background_jobs WHERE workspace_id = ? GROUP BY status', [workspaceId]);
  const counts = { queued: 0, running: 0, failed: 0, succeeded: 0, cancelled: 0, dead: 0 };
  for (const row of rows) counts[row.status] = Number(row.c);
  return counts;
}

export function taskCounts(workspaceId, nowIso) {
  const row = get(
    `SELECT COUNT(*) AS pending,
            SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN due_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM follow_up_tasks WHERE workspace_id = ? AND status = 'pending'`,
    [nowIso, nowIso, workspaceId],
  );
  return { pending: Number(row?.pending || 0), due: Number(row?.due || 0), overdue: Number(row?.overdue || 0) };
}

export function automationCounts(workspaceId) {
  const rows = all('SELECT state, COUNT(*) AS c FROM automation_states WHERE workspace_id = ? GROUP BY state', [workspaceId]);
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.c)]));
}

export function trend(workspaceId, days, sinceIso) {
  const outbound = all(
    `SELECT substr(COALESCE(sent_at, created_at), 1, 10) AS day, COUNT(*) AS c
       FROM email_messages
      WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sent', 'sending')
        AND COALESCE(sent_at, created_at) >= ?
      GROUP BY day`,
    [workspaceId, sinceIso],
  );
  const inbound = all(
    `SELECT substr(COALESCE(received_at, created_at), 1, 10) AS day, COUNT(*) AS c
       FROM email_messages
      WHERE workspace_id = ? AND direction = 'inbound' AND COALESCE(received_at, created_at) >= ?
      GROUP BY day`,
    [workspaceId, sinceIso],
  );
  const emailMap = new Map(outbound.map((row) => [row.day, Number(row.c)]));
  const replyMap = new Map(inbound.map((row) => [row.day, Number(row.c)]));
  const result = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
    result.push({ day: date, emails: emailMap.get(date) || 0, replies: replyMap.get(date) || 0 });
  }
  return result;
}

export function failedJobs(workspaceId, limit = 10) {
  return all(
    `SELECT id, type, status, last_error, updated_at FROM background_jobs
      WHERE workspace_id = ? AND status IN ('failed', 'dead')
      ORDER BY updated_at DESC LIMIT ?`,
    [workspaceId, limit],
  ).map((row) => ({ id: row.id, type: row.type, status: row.status, error: row.last_error, updatedAt: row.updated_at }));
}

export function recentAuditEvents(workspaceId, limit = 10) {
  return all(
    'SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
    [workspaceId, limit],
  );
}

export function recentNotifications(workspaceId, limit = 10) {
  return all(
    'SELECT * FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
    [workspaceId, limit],
  );
}

export function highIntentThreads(workspaceId, limit = 5) {
  return all(
    `SELECT th.id, th.subject, th.company_id, th.contact_id, th.last_message_at,
            c.name AS company_name,
            (SELECT cc.label FROM conversation_classifications cc WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) AS label
       FROM email_threads th
       LEFT JOIN companies c ON c.id = th.company_id AND c.workspace_id = th.workspace_id
      WHERE th.workspace_id = ?
        AND (SELECT cc.label FROM conversation_classifications cc WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) IN (${labelsPlaceholders()})
      ORDER BY th.last_message_at DESC LIMIT ?`,
    [workspaceId, ...HIGH_INTENT_LABELS, limit],
  );
}

export function urgentTasks(workspaceId, nowIsoValue, limit = 5) {
  return all(
    `SELECT id, title, due_at, company_id FROM follow_up_tasks
      WHERE workspace_id = ? AND status = 'pending' AND due_at <= ?
      ORDER BY due_at ASC LIMIT ?`,
    [workspaceId, nowIsoValue, limit],
  );
}

export function erroredAccounts(workspaceId) {
  return all("SELECT id, name, address, last_error FROM email_accounts WHERE workspace_id = ? AND status = 'error'", [workspaceId]);
}

export function neededReviewStates(workspaceId, limit = 5) {
  return all(
    `SELECT s.company_id, s.state, s.reason, s.changed_at, c.name AS company_name
       FROM automation_states s
       LEFT JOIN companies c ON c.id = s.company_id AND c.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.state IN ('NEEDS_HUMAN_REVIEW', 'HUMAN_TAKEOVER')
      ORDER BY s.changed_at DESC LIMIT ?`,
    [workspaceId, limit],
  );
}

export function usageOverview(workspaceId, sinceIso) {
  return all(
    `SELECT category, COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(cost_estimate), 0) AS cost
       FROM usage_records WHERE workspace_id = ? AND occurred_at >= ?
      GROUP BY category`,
    [workspaceId, sinceIso],
  ).map((row) => ({
    category: row.category,
    quantity: Number(row.quantity || 0),
    cost: Math.round(Number(row.cost || 0) * 10000) / 10000,
  }));
}

export function recentActivities(workspaceId, limit = 10) {
  return all(
    `SELECT a.id, a.type, a.subject, a.body, a.occurred_at, a.company_id, a.deal_id,
            c.name AS company_name, u.name AS user_name
       FROM sales_activities a
       LEFT JOIN companies c ON c.id = a.company_id AND c.workspace_id = a.workspace_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = ?
      ORDER BY a.occurred_at DESC LIMIT ?`,
    [workspaceId, limit],
  );
}

export function recentMessages(workspaceId, limit = 10) {
  return all(
    `SELECT m.id, m.direction, m.subject, m.received_at, m.sent_at, m.created_at, m.company_id, m.is_read,
            c.name AS company_name
       FROM email_messages m
       LEFT JOIN companies c ON c.id = m.company_id AND c.workspace_id = m.workspace_id
      WHERE m.workspace_id = ?
      ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC LIMIT ?`,
    [workspaceId, limit],
  );
}
