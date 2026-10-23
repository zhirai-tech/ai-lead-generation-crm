/** OWNER: t-data. Product catalogue routes. */
import { asArray, asEnum, asObject, asString, parsePagination, parseSort } from '../core/validate.mjs';
import * as productsService from '../services/products.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = { auth: 'required', capability: 'data.write' };
const DELETE = { auth: 'required', capability: 'data.delete' };

function context(ctx) {
  return { actorId: ctx.user?.id || null, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

function productInput(body) {
  return {
    name: asString(body.name, { required: true, max: 200, label: '产品名称' }),
    category: asString(body.category, { max: 120 }) || null,
    sku: asString(body.sku, { max: 80 }) || null,
    description: asString(body.description, { max: 4000 }) || null,
    specs: asObject(body.specs, { label: '产品规格' }),
    applications: asArray(body.applications, { max: 100, label: '应用领域' }).filter((item) => typeof item === 'string'),
    materials: asString(body.materials, { max: 500 }) || null,
    certifications: asArray(body.certifications, { max: 100, label: '认证' }).filter((item) => typeof item === 'string'),
    capacity: asString(body.capacity, { max: 500 }) || null,
    moq: asString(body.moq, { max: 200 }) || null,
    pricingTerms: asString(body.pricingTerms, { max: 500 }) || null,
    samples: asString(body.samples, { max: 500 }) || null,
    leadTime: asString(body.leadTime, { max: 200 }) || null,
    status: body.status ? asEnum(body.status, productsService.PRODUCT_STATUSES, { label: '产品状态' }) : undefined,
    keywords: body.keywords === undefined ? undefined : asArray(body.keywords, { max: 200, label: '关键词' }).filter((item) => typeof item === 'string'),
  };
}

export function mount(router) {
  router.get(
    '/api/v1/products',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      const sort = parseSort(ctx.query, { name: 'name', createdAt: 'createdAt' }, { key: 'createdAt', direction: 'DESC' });
      return productsService.listProducts(
        ctx.workspace.id,
        {
          q: asString(ctx.query.get('q'), { max: 120 }),
          status: ctx.query.get('status')
            ? asEnum(ctx.query.get('status'), productsService.PRODUCT_STATUSES, { label: '产品状态' })
            : null,
          category: asString(ctx.query.get('category'), { max: 120 }) || null,
          ...pagination,
        },
        sort,
      );
    },
    READ,
  );

  router.post('/api/v1/products', async (ctx) => productsService.createProduct(ctx.workspace.id, productInput(ctx.body || {}), context(ctx)), WRITE);

  router.get('/api/v1/products/:id', async (ctx) => productsService.getProductDetail(ctx.workspace.id, ctx.params.id), READ);

  router.patch(
    '/api/v1/products/:id',
    async (ctx) => {
      const body = ctx.body || {};
      const patch = {};
      const stringFields = ['name', 'category', 'sku', 'description', 'materials', 'capacity', 'moq', 'pricingTerms', 'samples', 'leadTime'];
      for (const field of stringFields) {
        if (body[field] !== undefined) patch[field] = body[field] === null ? null : asString(body[field], { max: field === 'description' ? 4000 : 500 });
      }
      if (body.specs !== undefined) patch.specs = asObject(body.specs, { label: '产品规格' });
      if (body.applications !== undefined) {
        patch.applications = asArray(body.applications, { max: 100, label: '应用领域' }).filter((item) => typeof item === 'string');
      }
      if (body.certifications !== undefined) {
        patch.certifications = asArray(body.certifications, { max: 100, label: '认证' }).filter((item) => typeof item === 'string');
      }
      if (body.status !== undefined) patch.status = asEnum(body.status, productsService.PRODUCT_STATUSES, { label: '产品状态' });
      if (body.keywords !== undefined) {
        patch.keywords = asArray(body.keywords, { max: 200, label: '关键词' }).filter((item) => typeof item === 'string');
      }
      return productsService.updateProduct(ctx.workspace.id, ctx.params.id, patch, context(ctx));
    },
    WRITE,
  );

  router.post(
    '/api/v1/products/:id/generate-keywords',
    async (ctx) =>
      productsService.generateProductKeywordsForProduct(ctx.workspace.id, ctx.params.id, context(ctx)),
    { ...WRITE, rateLimit: { windowMs: 60_000, max: 20 } },
  );

  router.delete(
    '/api/v1/products/:id',
    async (ctx) => productsService.deleteProduct(ctx.workspace.id, ctx.params.id, context(ctx)),
    DELETE,
  );
}
