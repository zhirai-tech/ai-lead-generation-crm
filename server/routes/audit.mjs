/** Audit trail read API. */
import { listAuditEvents } from '../core/audit.mjs';
import { asInt, asString } from '../core/validate.mjs';

export function mount(router) {
  router.get(
    '/api/v1/audit',
    async (ctx) => {
      const limit = asInt(ctx.query.get('limit'), { fallback: 50, min: 1, max: 200 });
      const page = asInt(ctx.query.get('page'), { fallback: 1, min: 1, max: 10000 });
      const action = asString(ctx.query.get('action'), { max: 80 });
      const entityType = asString(ctx.query.get('entityType'), { max: 60 });
      const entityId = asString(ctx.query.get('entityId'), { max: 80 });
      const { rows, total } = listAuditEvents(ctx.workspace.id, {
        limit,
        offset: (page - 1) * limit,
        action,
        entityType,
        entityId,
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          actorType: row.actor_type,
          actorId: row.actor_id,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          before: row.before_json ? JSON.parse(row.before_json) : null,
          after: row.after_json ? JSON.parse(row.after_json) : null,
          ip: row.ip,
          requestId: row.request_id,
          createdAt: row.created_at,
        })),
        total,
        page,
        pageSize: limit,
      };
    },
    { auth: 'required', capability: 'audit.read' },
  );
}
