/**
 * OWNER: t-crm. Shared helpers for the outreach & CRM route modules.
 */
import { parsePagination } from '../core/validate.mjs';

/** Collect actor information from the request context for service-layer audit. */
export function actorOf(ctx) {
  return {
    actorType: ctx.authType === 'api_key' ? 'api_key' : 'user',
    actorId: ctx.user?.id ?? null,
    actorRole: ctx.membership?.role ?? null,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    requestId: ctx.requestId ?? null,
  };
}

export function paginationOf(ctx) {
  return parsePagination(ctx.query);
}

export function queryString(ctx, name, fallback = '') {
  const value = ctx.query.get(name);
  return value === null ? fallback : value;
}

export function queryBoolean(ctx, name) {
  const value = String(ctx.query.get(name) || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function queryInt(ctx, name, fallback = null) {
  const raw = ctx.query.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}
