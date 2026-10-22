/**
 * OWNER: t-crm.
 *
 * Deals / sales activities / follow-up task persistence. SQL + row mapping
 * only; stage transition rules live in services/deals.mjs.
 */
import { all, get, run } from '../core/db.mjs';
import { paged } from './helpers.mjs';

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

// --------------------------------------------------------------------- deals
const DEAL_SELECT = `
  SELECT d.*, c.name AS company_name, c.domain AS company_domain,
         ct.full_name AS contact_name, ct.email AS contact_email,
         p.name AS product_name
    FROM deals d
    LEFT JOIN companies c ON c.id = d.company_id AND c.workspace_id = d.workspace_id
    LEFT JOIN contacts ct ON ct.id = d.contact_id AND ct.workspace_id = d.workspace_id
    LEFT JOIN products p ON p.id = d.product_id AND p.workspace_id = d.workspace_id`;

export function mapDeal(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    productId: row.product_id,
    title: row.title,
    stage: row.stage,
    valueAmount: row.value_amount,
    currency: row.currency,
    probability: row.probability,
    expectedCloseDate: row.expected_close_date,
    status: row.status,
    lostReason: row.lost_reason,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    companyName: row.company_name ?? null,
    companyDomain: row.company_domain ?? null,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    productName: row.product_name ?? null,
  };
}

function dealFilters(workspaceId, { stage = null, status = null, companyId = null, ownerUserId = null, search = '' } = {}) {
  const where = ['d.workspace_id = ?'];
  const params = [workspaceId];
  if (stage) {
    where.push('d.stage = ?');
    params.push(stage);
  }
  if (status) {
    where.push('d.status = ?');
    params.push(status);
  }
  if (companyId) {
    where.push('d.company_id = ?');
    params.push(companyId);
  }
  if (ownerUserId) {
    where.push('d.owner_user_id = ?');
    params.push(ownerUserId);
  }
  if (search) {
    where.push("(d.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  return { clause: where.join(' AND '), params };
}

export function listDeals(workspaceId, filters = {}, { page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const { clause, params } = dealFilters(workspaceId, filters);
  const rows = all(`${DEAL_SELECT} WHERE ${clause} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(mapDeal);
  const total = get(
    `SELECT COUNT(*) AS c FROM deals d
       LEFT JOIN companies c ON c.id = d.company_id AND c.workspace_id = d.workspace_id
      WHERE ${clause}`,
    params,
  )?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getDeal(workspaceId, dealId) {
  if (!dealId) return null;
  return mapDeal(get(`${DEAL_SELECT} WHERE d.workspace_id = ? AND d.id = ?`, [workspaceId, dealId]));
}

export function createDeal(workspaceId, data) {
  run(
    `INSERT INTO deals
      (id, workspace_id, company_id, contact_id, product_id, title, stage, value_amount, currency, probability,
       expected_close_date, status, lost_reason, owner_user_id, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.companyId,
      data.contactId ?? null,
      data.productId ?? null,
      data.title,
      data.stage || 'lead',
      data.valueAmount ?? null,
      data.currency || 'EUR',
      data.probability ?? null,
      data.expectedCloseDate ?? null,
      data.status || 'open',
      data.lostReason ?? null,
      data.ownerUserId ?? null,
      data.createdAt,
      data.updatedAt,
      data.closedAt ?? null,
    ],
  );
  return getDeal(workspaceId, data.id);
}

const DEAL_UPDATE_COLUMNS = {
  title: 'title',
  contactId: 'contact_id',
  productId: 'product_id',
  stage: 'stage',
  valueAmount: 'value_amount',
  currency: 'currency',
  probability: 'probability',
  expectedCloseDate: 'expected_close_date',
  status: 'status',
  lostReason: 'lost_reason',
  ownerUserId: 'owner_user_id',
  closedAt: 'closed_at',
};

export function updateDeal(workspaceId, dealId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(DEAL_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return getDeal(workspaceId, dealId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE deals SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, dealId]);
  return getDeal(workspaceId, dealId);
}

export function deleteDeal(workspaceId, dealId) {
  return run('DELETE FROM deals WHERE workspace_id = ? AND id = ?', [workspaceId, dealId]).changes;
}

export function pipelineByStage(workspaceId) {
  return all(
    `SELECT stage, COUNT(*) AS count, COALESCE(SUM(value_amount), 0) AS total_value
       FROM deals
      WHERE workspace_id = ?
      GROUP BY stage`,
    [workspaceId],
  ).map((row) => ({ stage: row.stage, count: Number(row.count), totalValue: Number(row.total_value || 0) }));
}

/** All deals (every stage) with company/contact names, used by the pipeline board. */
export function listPipelineDeals(workspaceId) {
  return all(`${DEAL_SELECT} WHERE d.workspace_id = ? ORDER BY d.updated_at DESC`, [workspaceId]).map(mapDeal);
}

export function countDeals(workspaceId) {
  return get('SELECT COUNT(*) AS c FROM deals WHERE workspace_id = ?', [workspaceId])?.c ?? 0;
}

// ---------------------------------------------------------------- activities
export function mapActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    dealId: row.deal_id,
    type: row.type,
    subject: row.subject,
    body: row.body,
    occurredAt: row.occurred_at,
    userId: row.user_id,
    createdAt: row.created_at,
    companyName: row.company_name ?? null,
    userName: row.user_name ?? null,
  };
}

export function listActivities(workspaceId, { companyId = null, contactId = null, dealId = null, type = null, from = null, to = null, page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const where = ['a.workspace_id = ?'];
  const params = [workspaceId];
  if (companyId) {
    where.push('a.company_id = ?');
    params.push(companyId);
  }
  if (contactId) {
    where.push('a.contact_id = ?');
    params.push(contactId);
  }
  if (dealId) {
    where.push('a.deal_id = ?');
    params.push(dealId);
  }
  if (type) {
    where.push('a.type = ?');
    params.push(type);
  }
  if (from) {
    where.push('a.occurred_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('a.occurred_at <= ?');
    params.push(to);
  }
  const clause = where.join(' AND ');
  const rows = all(
    `SELECT a.*, c.name AS company_name, u.name AS user_name
       FROM sales_activities a
       LEFT JOIN companies c ON c.id = a.company_id AND c.workspace_id = a.workspace_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE ${clause}
      ORDER BY a.occurred_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(mapActivity);
  const total = get(`SELECT COUNT(*) AS c FROM sales_activities a WHERE ${clause}`, params)?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function createActivity(workspaceId, data) {
  run(
    `INSERT INTO sales_activities
      (id, workspace_id, company_id, contact_id, deal_id, type, subject, body, occurred_at, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.companyId,
      data.contactId ?? null,
      data.dealId ?? null,
      data.type,
      data.subject ?? null,
      data.body ?? null,
      data.occurredAt,
      data.userId ?? null,
      data.createdAt,
    ],
  );
  return mapActivity(get('SELECT * FROM sales_activities WHERE workspace_id = ? AND id = ?', [workspaceId, data.id]));
}

export function listRecentActivities(workspaceId, limit = 10) {
  return all(
    `SELECT a.*, c.name AS company_name, u.name AS user_name
       FROM sales_activities a
       LEFT JOIN companies c ON c.id = a.company_id AND c.workspace_id = a.workspace_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = ?
      ORDER BY a.occurred_at DESC LIMIT ?`,
    [workspaceId, limit],
  ).map(mapActivity);
}

// ------------------------------------------------------------ follow-up tasks
export function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    campaignId: row.campaign_id,
    dealId: row.deal_id,
    dueAt: row.due_at,
    type: row.type,
    title: row.title,
    notes: row.notes,
    status: row.status,
    assignedTo: row.assigned_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    companyName: row.company_name ?? null,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    assigneeName: row.assignee_name ?? null,
  };
}

export function listTasks(workspaceId, { status = null, companyId = null, contactId = null, campaignId = null, assignedTo = null, dueBefore = null, type = null, includeCancelled = false, page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const where = ['t.workspace_id = ?'];
  const params = [workspaceId];
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  } else if (!includeCancelled) {
    where.push("t.status <> 'cancelled'");
  }
  if (companyId) {
    where.push('t.company_id = ?');
    params.push(companyId);
  }
  if (contactId) {
    where.push('t.contact_id = ?');
    params.push(contactId);
  }
  if (campaignId) {
    where.push('t.campaign_id = ?');
    params.push(campaignId);
  }
  if (assignedTo) {
    where.push('t.assigned_to = ?');
    params.push(assignedTo);
  }
  if (dueBefore) {
    where.push('t.due_at <= ?');
    params.push(dueBefore);
  }
  if (type) {
    where.push('t.type = ?');
    params.push(type);
  }
  const clause = where.join(' AND ');
  const rows = all(
    `SELECT t.*, c.name AS company_name, ct.full_name AS contact_name, ct.email AS contact_email, u.name AS assignee_name
       FROM follow_up_tasks t
       LEFT JOIN companies c ON c.id = t.company_id AND c.workspace_id = t.workspace_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id AND ct.workspace_id = t.workspace_id
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE ${clause}
      ORDER BY t.due_at ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(mapTask);
  const total = get(`SELECT COUNT(*) AS c FROM follow_up_tasks t WHERE ${clause}`, params)?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getTask(workspaceId, taskId) {
  if (!taskId) return null;
  const row = get(
    `SELECT t.*, c.name AS company_name, ct.full_name AS contact_name, ct.email AS contact_email, u.name AS assignee_name
       FROM follow_up_tasks t
       LEFT JOIN companies c ON c.id = t.company_id AND c.workspace_id = t.workspace_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id AND ct.workspace_id = t.workspace_id
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.workspace_id = ? AND t.id = ?`,
    [workspaceId, taskId],
  );
  return mapTask(row);
}

export function createTask(workspaceId, data) {
  run(
    `INSERT INTO follow_up_tasks
      (id, workspace_id, company_id, contact_id, campaign_id, deal_id, due_at, type, title, notes, status, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.companyId ?? null,
      data.contactId ?? null,
      data.campaignId ?? null,
      data.dealId ?? null,
      data.dueAt,
      data.type || 'follow_up',
      data.title,
      data.notes ?? null,
      data.status || 'pending',
      data.assignedTo ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return getTask(workspaceId, data.id);
}

const TASK_UPDATE_COLUMNS = {
  dueAt: 'due_at',
  type: 'type',
  title: 'title',
  notes: 'notes',
  status: 'status',
  assignedTo: 'assigned_to',
};

export function updateTask(workspaceId, taskId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(TASK_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return getTask(workspaceId, taskId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE follow_up_tasks SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, taskId]);
  return getTask(workspaceId, taskId);
}

export function deleteTask(workspaceId, taskId) {
  return run('DELETE FROM follow_up_tasks WHERE workspace_id = ? AND id = ?', [workspaceId, taskId]).changes;
}

/** Atomically cancel every pending task of a company (human takeover). */
export function cancelPendingTasksForCompany(workspaceId, companyId, { updatedAt }) {
  return run(
    `UPDATE follow_up_tasks SET status = 'cancelled', updated_at = ?
      WHERE workspace_id = ? AND company_id = ? AND status = 'pending'`,
    [updatedAt, workspaceId, companyId],
  ).changes;
}

export function cancelPendingTasksForThread(workspaceId, companyId, { updatedAt }) {
  return cancelPendingTasksForCompany(workspaceId, companyId, { updatedAt });
}

export function countDueTasks(workspaceId, dueBefore) {
  return (
    get("SELECT COUNT(*) AS c FROM follow_up_tasks WHERE workspace_id = ? AND status = 'pending' AND due_at <= ?", [
      workspaceId,
      dueBefore,
    ])?.c ?? 0
  );
}

export function countPendingTasks(workspaceId) {
  return get("SELECT COUNT(*) AS c FROM follow_up_tasks WHERE workspace_id = ? AND status = 'pending'", [workspaceId])?.c ?? 0;
}

export function countOverdueTasks(workspaceId, nowIso) {
  return countDueTasks(workspaceId, nowIso);
}

export function listTasksDueSoon(workspaceId, untilIso, limit = 10) {
  return all(
    `SELECT t.*, c.name AS company_name, ct.full_name AS contact_name, ct.email AS contact_email, u.name AS assignee_name
       FROM follow_up_tasks t
       LEFT JOIN companies c ON c.id = t.company_id AND c.workspace_id = t.workspace_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id AND ct.workspace_id = t.workspace_id
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.workspace_id = ? AND t.status = 'pending' AND t.due_at <= ?
      ORDER BY t.due_at ASC LIMIT ?`,
    [workspaceId, untilIso, limit],
  ).map(mapTask);
}
