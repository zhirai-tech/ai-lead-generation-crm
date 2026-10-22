/** OWNER: t-crm (deals / pipeline / activities / follow-up routes). */
import * as deals from '../services/deals.mjs';
import * as followups from '../services/followups.mjs';
import { actorOf, paginationOf, queryString } from './crm-shared.mjs';

export function mount(router) {
  // ------------------------------------------------------------------- deals
  router.get(
    '/api/v1/deals',
    async (ctx) => {
      const page = paginationOf(ctx);
      return deals.list(ctx.workspace.id, {
        stage: queryString(ctx, 'stage') || null,
        status: queryString(ctx, 'status') || null,
        companyId: queryString(ctx, 'companyId') || null,
        ownerUserId: queryString(ctx, 'ownerUserId') || null,
        search: queryString(ctx, 'search'),
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.post('/api/v1/deals', async (ctx) => deals.create(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'deals.write',
  });

  router.get('/api/v1/deals/pipeline', async (ctx) => deals.pipeline(ctx.workspace.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.get('/api/v1/deals/:id', async (ctx) => deals.detail(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.patch('/api/v1/deals/:id', async (ctx) => deals.update(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'deals.write',
  });

  router.delete('/api/v1/deals/:id', async (ctx) => deals.remove(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'data.delete',
  });

  // -------------------------------------------------------------- activities
  router.get(
    '/api/v1/activities',
    async (ctx) => {
      const page = paginationOf(ctx);
      return deals.activities(ctx.workspace.id, {
        companyId: queryString(ctx, 'companyId') || null,
        contactId: queryString(ctx, 'contactId') || null,
        dealId: queryString(ctx, 'dealId') || null,
        type: queryString(ctx, 'type') || null,
        from: queryString(ctx, 'from') || null,
        to: queryString(ctx, 'to') || null,
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.post('/api/v1/activities', async (ctx) => deals.createActivity(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'deals.write',
  });

  // ----------------------------------------------------------- follow-up tasks
  router.get(
    '/api/v1/follow-up-tasks',
    async (ctx) => {
      const page = paginationOf(ctx);
      return followups.list(ctx.workspace.id, {
        status: queryString(ctx, 'status') || null,
        companyId: queryString(ctx, 'companyId') || null,
        contactId: queryString(ctx, 'contactId') || null,
        campaignId: queryString(ctx, 'campaignId') || null,
        assignedTo: queryString(ctx, 'assignedTo') || null,
        dueBefore: queryString(ctx, 'dueBefore') || null,
        type: queryString(ctx, 'type') || null,
        includeCancelled: ['1', 'true', 'yes'].includes(String(ctx.query.get('includeCancelled') || '').toLowerCase()),
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.post('/api/v1/follow-up-tasks', async (ctx) => followups.create(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'deals.write',
  });

  router.patch('/api/v1/follow-up-tasks/:id', async (ctx) => followups.update(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'deals.write',
  });

  router.delete('/api/v1/follow-up-tasks/:id', async (ctx) => followups.remove(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'deals.write',
  });
}
