/** OWNER: t-data. Discovery routes: runs, cancel, provider catalogue. */
import { asString, parsePagination } from '../core/validate.mjs';
import * as discoveryService from '../services/discovery.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const RUN = { auth: 'required', capability: 'discovery.run', rateLimit: { windowMs: 60_000, max: 30 } };

function context(ctx) {
  return { actorId: ctx.user?.id || null, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

export function mount(router) {
  router.get(
    '/api/v1/discovery/runs',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      return discoveryService.listDiscoveryRuns(ctx.workspace.id, {
        status: asString(ctx.query.get('status'), { max: 20 }) || null,
        provider: asString(ctx.query.get('provider'), { max: 40 }) || null,
        ...pagination,
      });
    },
    READ,
  );

  router.post(
    '/api/v1/discovery/runs',
    async (ctx) => {
      const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      // Pass the whole payload through: the service normalises both flat fields
      // (keywords/countries/maxResults/icpId) and a nested `query` object.
      const input = {
        ...body,
        provider: body.provider ? asString(body.provider, { max: 40 }) : 'simulation',
        industry: body.industry ? asString(body.industry, { max: 120 }) : undefined,
        region: body.region ? asString(body.region, { max: 120 }) : undefined,
      };
      return discoveryService.createDiscoveryRun(ctx.workspace.id, input, context(ctx));
    },
    RUN,
  );

  router.get('/api/v1/discovery/providers', async (ctx) => ({ items: discoveryService.listDiscoveryProviders(ctx.workspace.id) }), READ);

  router.get('/api/v1/discovery/runs/:id', async (ctx) => discoveryService.getDiscoveryRunDetail(ctx.workspace.id, ctx.params.id), READ);

  router.post(
    '/api/v1/discovery/runs/:id/cancel',
    async (ctx) => discoveryService.cancelDiscoveryRun(ctx.workspace.id, ctx.params.id, context(ctx)),
    RUN,
  );
}
