/** OWNER: t-crm (message drafts + approvals routes). */
import * as drafts from '../services/drafts.mjs';
import { actorOf, paginationOf, queryString } from './crm-shared.mjs';

export function mount(router) {
  router.get(
    '/api/v1/drafts',
    async (ctx) => {
      const page = paginationOf(ctx);
      return drafts.list(ctx.workspace.id, {
        status: queryString(ctx, 'status') || null,
        campaignId: queryString(ctx, 'campaignId') || null,
        companyId: queryString(ctx, 'companyId') || null,
        contactId: queryString(ctx, 'contactId') || null,
        accountId: queryString(ctx, 'accountId') || null,
        language: queryString(ctx, 'language') || null,
        search: queryString(ctx, 'search'),
        page: page.page,
        pageSize: page.pageSize,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.post('/api/v1/drafts', async (ctx) => drafts.create(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'data.write',
  });

  router.get('/api/v1/drafts/:id', async (ctx) => drafts.detail(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.patch('/api/v1/drafts/:id', async (ctx) => drafts.update(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'data.write',
  });

  router.post('/api/v1/drafts/batch-approve', async (ctx) => drafts.batchApprove(ctx.workspace.id, (ctx.body || {}).ids || [], actorOf(ctx)), {
    auth: 'required',
    capability: 'drafts.approve',
  });

  router.post(
    '/api/v1/drafts/:id/generate',
    async (ctx) =>
      drafts.generateDraft({
        workspaceId: ctx.workspace.id,
        draftId: ctx.params.id,
        actorType: ctx.authType === 'api_key' ? 'api_key' : 'user',
        actorId: ctx.user?.id ?? null,
      }),
    { auth: 'required', capability: 'data.write', rateLimit: { windowMs: 60_000, max: 30 } },
  );

  router.post('/api/v1/drafts/:id/approve', async (ctx) => drafts.approveDraft(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'drafts.approve',
  });

  router.post('/api/v1/drafts/:id/reject', async (ctx) => drafts.rejectDraft(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'drafts.approve',
  });

  router.post('/api/v1/drafts/:id/send', async (ctx) => drafts.sendDraft(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'drafts.approve',
    rateLimit: { windowMs: 60_000, max: 60 },
  });

  router.get(
    '/api/v1/approvals/pending',
    async (ctx) => {
      const page = paginationOf(ctx);
      const result = drafts.pendingApprovals(ctx.workspace.id, {
        page: page.page,
        pageSize: page.pageSize,
        search: queryString(ctx, 'search'),
        campaignId: queryString(ctx, 'campaignId') || null,
      });
      return { count: result.total, ...result };
    },
    { auth: 'required', capability: 'data.read' },
  );
}
