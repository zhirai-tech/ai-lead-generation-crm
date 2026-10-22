/** Public health endpoint (no authentication, no tenant data). */
import { hasUsers } from '../core/auth.mjs';
import { get } from '../core/db.mjs';

const startedAt = Date.now();

export function mount(router) {
  router.get(
    '/api/v1/health',
    async (ctx) => {
      let dbOk = true;
      try {
        get('SELECT 1 AS ok');
      } catch {
        dbOk = false;
      }
      return {
        status: dbOk ? 'ok' : 'degraded',
        version: ctx.config.version,
        initialized: dbOk ? hasUsers() : false,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        time: new Date().toISOString(),
      };
    },
    { auth: 'public', csrf: false, rateLimit: { windowMs: 60_000, max: 120 } },
  );
}
