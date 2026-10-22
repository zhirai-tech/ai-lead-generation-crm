/**
 * Audit trail. Append-only records for security-relevant actions. Written by
 * both user-facing routes and background workers.
 */
import { all, get, json, run } from './db.mjs';
import { id } from './ids.mjs';
import { nowIso } from './time.mjs';

const SENSITIVE_KEYS = /(password|secret|token|api[_-]?key|credential|cookie|authorization)/i;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : sanitize(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 2000);
  return value;
}

export function recordAudit({
  workspaceId = null,
  actorType = 'system',
  actorId = null,
  action,
  entityType = null,
  entityId = null,
  before = null,
  after = null,
  ip = null,
  userAgent = null,
  requestId = null,
} = {}) {
  if (!action) throw new Error('audit action is required');
  const auditId = id('aud');
  run(
    `INSERT INTO audit_events
      (id, workspace_id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip, user_agent, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      auditId,
      workspaceId,
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      json(sanitize(before)),
      json(sanitize(after)),
      ip,
      userAgent ? String(userAgent).slice(0, 300) : null,
      requestId,
      nowIso(),
    ],
  );
  return auditId;
}

export function listAuditEvents(workspaceId, { limit = 50, offset = 0, action = '', entityType = '', entityId = '' } = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  const rows = all(
    `SELECT * FROM audit_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS c FROM audit_events WHERE ${where.join(' AND ')}`, params)?.c ?? 0;
  return { rows, total };
}

export default { recordAudit, listAuditEvents };
