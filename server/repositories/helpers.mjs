/**
 * Shared repository helpers. Repositories only build SQL and map rows; business
 * rules belong in services. Every query must be scoped by workspace_id.
 */
import { json, parseJson } from '../core/db.mjs';

export function paged(items, total, page, pageSize) {
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

export function jsonArray(value, fallback = []) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

export function jsonObject(value, fallback = {}) {
  const parsed = parseJson(value, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

export function toJson(value, fallback = '[]') {
  return json(value, fallback);
}

export function bool(value) {
  return Boolean(value);
}

export function toBoolInt(value) {
  return value ? 1 : 0;
}

export function sortSql(column, direction) {
  const safeColumn = /^[a-z_][a-z0-9_]*$/i.test(column) ? column : 'created_at';
  const safeDirection = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `${safeColumn} ${safeDirection}`;
}

export function assertWorkspaceId(workspaceId) {
  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('workspaceId is required');
  return workspaceId;
}

export function isoNow() {
  return new Date().toISOString();
}
