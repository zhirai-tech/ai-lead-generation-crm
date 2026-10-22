/** Notification inbox (Lead-owned; workers create notifications via services). */
import { all, get, run } from '../core/db.mjs';
import { asInt, asString } from '../core/validate.mjs';
import { nowIso } from '../core/time.mjs';
import { notFound } from '../core/errors.mjs';

function mapNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    severity: row.severity,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function mount(router) {
  router.get(
    '/api/v1/notifications',
    async (ctx) => {
      const unreadOnly = ctx.query.get('unread') === '1';
      const limit = asInt(ctx.query.get('limit'), { fallback: 30, min: 1, max: 100 });
      const where = ['workspace_id = ?'];
      const params = [ctx.workspace.id];
      if (unreadOnly) where.push('read_at IS NULL');
      const rows = all(
        `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
        [...params, limit],
      );
      const unread = get('SELECT COUNT(*) AS c FROM notifications WHERE workspace_id = ? AND read_at IS NULL', [ctx.workspace.id])?.c ?? 0;
      return { items: rows.map(mapNotification), unread };
    },
    { auth: 'required' },
  );

  router.post(
    '/api/v1/notifications/:id/read',
    async (ctx) => {
      const id = asString(ctx.params.id, { required: true, max: 80 });
      const row = get('SELECT id FROM notifications WHERE id = ? AND workspace_id = ?', [id, ctx.workspace.id]);
      if (!row) throw notFound('通知不存在');
      run('UPDATE notifications SET read_at = ? WHERE id = ?', [nowIso(), id]);
      return { read: true };
    },
    { auth: 'required' },
  );

  router.post(
    '/api/v1/notifications/read-all',
    async (ctx) => {
      const result = run('UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL', [nowIso(), ctx.workspace.id]);
      return { updated: result.changes };
    },
    { auth: 'required' },
  );
}
