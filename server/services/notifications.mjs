/** Notification helpers shared by routes and background workers. */
import { run } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';

export function createNotification({
  workspaceId,
  userId = null,
  type,
  title,
  body = null,
  entityType = null,
  entityId = null,
  severity = 'info',
} = {}) {
  if (!workspaceId || !type || !title) return null;
  const notificationId = id('ntf');
  run(
    `INSERT INTO notifications (id, workspace_id, user_id, type, title, body, entity_type, entity_id, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [notificationId, workspaceId, userId, type, title, body, entityType, entityId, severity, nowIso()],
  );
  return notificationId;
}

export function notifyHighIntent({ workspaceId, companyId, contactId, threadId, label, confidence }) {
  return createNotification({
    workspaceId,
    type: 'high_intent',
    title: '发现高意向客户回复',
    body: `意向：${label}（置信度 ${Math.round((confidence || 0) * 100)}%），建议尽快查看并人工跟进。`,
    entityType: 'company',
    entityId: companyId,
    severity: 'critical',
    userId: null,
  });
}

export default { createNotification, notifyHighIntent };
