/** OWNER: t-crm (suppression / do-not-contact routes). */
import * as suppression from '../services/suppression.mjs';
import { actorOf, paginationOf, queryString } from './crm-shared.mjs';

export function mount(router) {
  router.get(
    '/api/v1/suppression',
    async (ctx) => {
      const page = paginationOf(ctx);
      return suppression.list(ctx.workspace.id, {
        scope: queryString(ctx, 'scope') || null,
        reason: queryString(ctx, 'reason') || null,
        search: queryString(ctx, 'search'),
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.post('/api/v1/suppression', async (ctx) => suppression.create(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'suppression.write',
  });

  router.delete('/api/v1/suppression/:id', async (ctx) => suppression.remove(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'suppression.write',
  });
}
