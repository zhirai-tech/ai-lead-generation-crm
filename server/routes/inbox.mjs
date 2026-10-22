/** OWNER: t-crm (unified inbox / threads / replies routes). */
import * as inbox from '../services/inbox.mjs';
import { actorOf, paginationOf, queryString } from './crm-shared.mjs';

export function mount(router) {
  router.get(
    '/api/v1/inbox/threads',
    async (ctx) => {
      const page = paginationOf(ctx);
      const unread = String(ctx.query.get('unread') || '').toLowerCase();
      const highIntent = String(ctx.query.get('highIntent') || ctx.query.get('high_intent') || '').toLowerCase();
      return inbox.threads(ctx.workspace.id, {
        unread: ['1', 'true', 'yes'].includes(unread),
        highIntent: ['1', 'true', 'yes'].includes(highIntent),
        companyId: queryString(ctx, 'companyId') || null,
        classification: queryString(ctx, 'classification') || null,
        status: queryString(ctx, 'status') || null,
        search: queryString(ctx, 'search'),
        page: page.page,
        pageSize: page.pageSize,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.get(
    '/api/v1/inbox/high-intent',
    async (ctx) => {
      const page = paginationOf(ctx);
      return inbox.highIntent(ctx.workspace.id, {
        page: page.page,
        pageSize: page.pageSize,
        search: queryString(ctx, 'search'),
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.get('/api/v1/inbox/threads/:id', async (ctx) => inbox.detail(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.post('/api/v1/inbox/threads/:id/reply', async (ctx) => inbox.reply(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'data.write',
    rateLimit: { windowMs: 60_000, max: 60 },
  });

  router.post('/api/v1/inbox/threads/:id/read', async (ctx) => inbox.markRead(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'data.read',
  });

  router.post('/api/v1/inbox/threads/:id/classification', async (ctx) => inbox.correctClassification(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'data.write',
  });

  router.post('/api/v1/inbox/threads/:id/takeover', async (ctx) => inbox.takeoverThread(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'automation.manage',
  });
}
