/** OWNER: t-data. ICP routes. */
import { asArray, asBool, asCountry, asInt, asString, parsePagination, parseSort } from '../core/validate.mjs';
import * as icpsService from '../services/icps.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = { auth: 'required', capability: 'data.write' };
const DELETE = { auth: 'required', capability: 'data.delete' };

function context(ctx) {
  return { actorId: ctx.user?.id || null, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

function stringArray(value, label) {
  return asArray(value, { max: 100, label }).filter((item) => typeof item === 'string');
}

function icpInput(body) {
  return {
    name: asString(body.name, { required: true, max: 200, label: 'ICP 名称' }),
    description: asString(body.description, { max: 4000 }) || null,
    productId: body.productId ? asString(body.productId, { max: 100 }) : null,
    targetCountries: stringArray(body.targetCountries || [], '目标国家').map((code) => asCountry(code)),
    targetRegions: stringArray(body.targetRegions || [], '目标区域'),
    targetCompanyTypes: stringArray(body.targetCompanyTypes || [], '目标企业类型'),
    targetSizes: stringArray(body.targetSizes || [], '目标规模'),
    targetRoles: stringArray(body.targetRoles || [], '目标角色'),
    includeKeywords: stringArray(body.includeKeywords || [], '包含关键词'),
    excludeKeywords: stringArray(body.excludeKeywords || [], '排除关键词'),
    minScore: body.minScore === undefined ? 60 : asInt(body.minScore, { min: 0, max: 100, label: '最低评分' }),
    isActive: body.isActive === undefined ? true : asBool(body.isActive),
  };
}

export function mount(router) {
  router.get(
    '/api/v1/icps',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      const sort = parseSort(ctx.query, { name: 'name', createdAt: 'createdAt' }, { key: 'createdAt', direction: 'DESC' });
      const isActiveRaw = ctx.query.get('isActive');
      return icpsService.listIcps(
        ctx.workspace.id,
        {
          q: asString(ctx.query.get('q'), { max: 120 }),
          productId: asString(ctx.query.get('productId'), { max: 100 }) || null,
          isActive: isActiveRaw === null || isActiveRaw === '' ? null : asBool(isActiveRaw),
          ...pagination,
        },
        sort,
      );
    },
    READ,
  );

  router.post('/api/v1/icps', async (ctx) => icpsService.createIcp(ctx.workspace.id, icpInput(ctx.body || {}), context(ctx)), WRITE);

  router.get('/api/v1/icps/:id', async (ctx) => icpsService.getIcpOrThrow(ctx.workspace.id, ctx.params.id), READ);

  router.patch(
    '/api/v1/icps/:id',
    async (ctx) => {
      const body = ctx.body || {};
      const patch = {};
      if (body.name !== undefined) patch.name = asString(body.name, { required: true, max: 200, label: 'ICP 名称' });
      if (body.description !== undefined) patch.description = body.description === null ? null : asString(body.description, { max: 4000 });
      if (body.productId !== undefined) patch.productId = body.productId ? asString(body.productId, { max: 100 }) : null;
      if (body.minScore !== undefined) patch.minScore = asInt(body.minScore, { min: 0, max: 100, label: '最低评分' });
      if (body.isActive !== undefined) patch.isActive = asBool(body.isActive);
      const arrayFields = ['targetCountries', 'targetRegions', 'targetCompanyTypes', 'targetSizes', 'targetRoles', 'includeKeywords', 'excludeKeywords'];
      for (const field of arrayFields) {
        if (body[field] === undefined) continue;
        let values = stringArray(body[field], field);
        if (field === 'targetCountries') values = values.map((code) => asCountry(code));
        patch[field] = values;
      }
      return icpsService.updateIcp(ctx.workspace.id, ctx.params.id, patch, context(ctx));
    },
    WRITE,
  );

  router.delete(
    '/api/v1/icps/:id',
    async (ctx) => icpsService.deleteIcp(ctx.workspace.id, ctx.params.id, context(ctx)),
    DELETE,
  );
}
