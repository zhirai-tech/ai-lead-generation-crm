/** OWNER: t-crm (automation state / human takeover routes). */
import * as automation from '../services/automation.mjs';
import { actorOf, paginationOf, queryString } from './crm-shared.mjs';

export function mount(router) {
  router.get(
    '/api/v1/automation/states',
    async (ctx) => {
      const page = paginationOf(ctx);
      return automation.listAutomationStates(ctx.workspace.id, {
        state: queryString(ctx, 'state') || null,
        companyId: queryString(ctx, 'companyId') || null,
        page: page.page,
        pageSize: page.pageSize,
        offset: page.offset,
        limit: page.limit,
      });
    },
    { auth: 'required', capability: 'data.read' },
  );

  router.get('/api/v1/automation/:companyId', async (ctx) => automation.getAutomationDetail(ctx.workspace.id, ctx.params.companyId), {
    auth: 'required',
    capability: 'data.read',
  });

  router.post(
    '/api/v1/automation/:companyId/takeover',
    async (ctx) =>
      automation.takeoverCompany(ctx.workspace.id, ctx.params.companyId, {
        reason: (ctx.body || {}).reason || '人工接管',
        actor: actorOf(ctx),
      }),
    { auth: 'required', capability: 'automation.manage' },
  );

  router.post(
    '/api/v1/automation/:companyId/resume',
    async (ctx) =>
      automation.resumeAutomation(ctx.workspace.id, ctx.params.companyId, {
        reason: (ctx.body || {}).reason || '恢复自动化',
        actor: actorOf(ctx),
      }),
    { auth: 'required', capability: 'automation.manage' },
  );

  router.post(
    '/api/v1/automation/:companyId/pause',
    async (ctx) =>
      automation.pauseAutomation(ctx.workspace.id, ctx.params.companyId, {
        reason: (ctx.body || {}).reason || '手动暂停',
        actor: actorOf(ctx),
      }),
    { auth: 'required', capability: 'automation.manage' },
  );

  router.post(
    '/api/v1/automation/:companyId/do-not-contact',
    async (ctx) =>
      automation.markDoNotContact(ctx.workspace.id, ctx.params.companyId, {
        reason: (ctx.body || {}).reason || 'manual',
        note: (ctx.body || {}).note || null,
        actor: actorOf(ctx),
      }),
    { auth: 'required', capability: 'suppression.write' },
  );

  router.post(
    '/api/v1/automation/:companyId/close',
    async (ctx) =>
      automation.closeCompany(ctx.workspace.id, ctx.params.companyId, {
        reason: (ctx.body || {}).reason || '关闭客户',
        actor: actorOf(ctx),
      }),
    { auth: 'required', capability: 'automation.manage' },
  );
}
