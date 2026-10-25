/**
 * OWNER: t-data. Product-level email template routes (v1.2).
 *
 * GET    /api/v1/products/:id/email-template                -> {template, approved}
 * GET    /api/v1/products/:id/email-templates               -> {items: versions desc}
 * POST   /api/v1/products/:id/email-template/generate       -> new pending_approval version
 * PATCH  /api/v1/products/:id/email-template/:templateId    -> edit (approved -> new version)
 * POST   /api/v1/products/:id/email-template/:templateId/approve -> approve (only one per product)
 */
import { asString } from '../core/validate.mjs';
import * as productTemplates from '../services/product-templates.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = { auth: 'required', capability: 'data.write' };

function context(ctx) {
  return {
    actorId: ctx.user?.id || null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    config: ctx.config,
  };
}

export function mount(router) {
  router.get(
    '/api/v1/products/:id/email-template',
    async (ctx) => productTemplates.getProductTemplateOverview(ctx.workspace.id, ctx.params.id),
    READ,
  );

  router.get(
    '/api/v1/products/:id/email-templates',
    async (ctx) => productTemplates.listProductTemplateVersions(ctx.workspace.id, ctx.params.id),
    READ,
  );

  router.post(
    '/api/v1/products/:id/email-template/generate',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        language: body.language === undefined || body.language === null || body.language === ''
          ? undefined
          : asString(body.language, { max: 10, label: '语言' }),
        instructions: body.instructions === undefined || body.instructions === null || body.instructions === ''
          ? ''
          : asString(body.instructions, { max: 1000, label: '生成要求' }),
      };
      return productTemplates.generateProductTemplate(ctx.workspace.id, ctx.params.id, input, context(ctx));
    },
    { ...WRITE, rateLimit: { windowMs: 60_000, max: 20 } },
  );

  router.patch(
    '/api/v1/products/:id/email-template/:templateId',
    async (ctx) => {
      const body = ctx.body || {};
      const patch = {};
      if (body.subject !== undefined) patch.subject = asString(body.subject, { required: true, max: 300, label: '邮件主题' });
      if (body.bodyText !== undefined) {
        patch.bodyText = asString(body.bodyText, { required: true, max: 20000, trim: false, label: '邮件正文' });
      }
      if (body.language !== undefined) patch.language = asString(body.language, { required: true, max: 10, label: '语言' });
      return productTemplates.updateProductTemplate(ctx.workspace.id, ctx.params.id, ctx.params.templateId, patch, context(ctx));
    },
    WRITE,
  );

  router.post(
    '/api/v1/products/:id/email-template/:templateId/approve',
    async (ctx) => productTemplates.approveProductTemplate(ctx.workspace.id, ctx.params.id, ctx.params.templateId, context(ctx)),
    WRITE,
  );
}
