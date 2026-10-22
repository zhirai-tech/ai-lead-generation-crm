/** OWNER: t-crm (campaign routes). */
import * as campaigns from '../services/campaigns.mjs';
import { actorOf, paginationOf, queryString } from './crm-shared.mjs';

export function mount(router) {
  router.get(
    '/api/v1/campaigns',
    async (ctx) => {
      const page = paginationOf(ctx);
      return campaigns.list(ctx.workspace.id, {
        status: queryString(ctx, 'status') || null,
        search: queryString(ctx, 'search'),
        productId: queryString(ctx, 'productId') || null,
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.post('/api/v1/campaigns', async (ctx) => campaigns.create(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.get('/api/v1/campaigns/:id', async (ctx) => campaigns.detail(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.patch('/api/v1/campaigns/:id', async (ctx) => campaigns.update(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.delete('/api/v1/campaigns/:id', async (ctx) => campaigns.archive(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.get('/api/v1/campaigns/:id/steps', async (ctx) => ({ items: campaigns.steps(ctx.workspace.id, ctx.params.id) }), {
    auth: 'required',
    capability: 'data.read',
  });

  router.post('/api/v1/campaigns/:id/steps', async (ctx) => campaigns.addStep(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.patch(
    '/api/v1/campaigns/:id/steps/:stepId',
    async (ctx) => campaigns.updateStep(ctx.workspace.id, ctx.params.id, ctx.params.stepId, ctx.body || {}, actorOf(ctx)),
    { auth: 'required', capability: 'campaigns.write' },
  );

  router.delete('/api/v1/campaigns/:id/steps/:stepId', async (ctx) => campaigns.removeStep(ctx.workspace.id, ctx.params.id, ctx.params.stepId, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.post('/api/v1/campaigns/:id/enroll', async (ctx) => campaigns.enroll(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.post('/api/v1/campaigns/:id/pause', async (ctx) => campaigns.pause(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.post('/api/v1/campaigns/:id/resume', async (ctx) => campaigns.resume(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'campaigns.write',
  });

  router.get('/api/v1/campaigns/:id/stats', async (ctx) => campaigns.stats(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.get(
    '/api/v1/campaigns/:id/targets',
    async (ctx) => {
      const page = paginationOf(ctx);
      return campaigns.targets(ctx.workspace.id, ctx.params.id, {
        status: queryString(ctx, 'status') || null,
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );
}
