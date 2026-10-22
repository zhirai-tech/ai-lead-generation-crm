/** OWNER: t-crm (dashboard route). */
import * as dashboard from '../services/dashboard.mjs';
import { queryInt } from './crm-shared.mjs';

export function mount(router) {
  router.get('/api/v1/dashboard/summary', async (ctx) => dashboard.summary(ctx.workspace.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.get(
    '/api/v1/dashboard/activity',
    async (ctx) => dashboard.activity(ctx.workspace.id, { limit: queryInt(ctx, 'limit', 8) }),
    { auth: 'required', capability: 'data.read' },
  );

  router.get('/api/v1/dashboard/alerts', async (ctx) => dashboard.alerts(ctx.workspace.id), {
    auth: 'required',
    capability: 'data.read',
  });
}
