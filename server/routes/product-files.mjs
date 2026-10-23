/**
 * OWNER: t-data. Product media/document routes (v1.1).
 *
 * Authenticated: list / upload / delete / set main image / stream a file.
 * Public: signed, revocable PDF/image link for email recipients.
 */
import { asEnum, asString } from '../core/validate.mjs';
import * as productFiles from '../services/product-files.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = { auth: 'required', capability: 'data.write' };
const PUBLIC = { auth: 'public', csrf: false, rateLimit: { windowMs: 60_000, max: 120 } };

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
    '/api/v1/products/:id/files',
    async (ctx) => {
      productFiles.assertProductExists(ctx.workspace.id, ctx.params.id);
      return { items: productFiles.listProductFiles(ctx.workspace.id, ctx.params.id) };
    },
    READ,
  );

  router.post(
    '/api/v1/products/:id/files',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        filename: asString(body.filename, { required: true, max: 300, label: '文件名' }),
        mimeType: asString(body.mimeType, { required: true, max: 100, label: '文件类型' }),
        dataBase64: asString(body.dataBase64, { required: true, max: 12_000_000, label: '文件内容' }),
        kind: body.kind ? asEnum(body.kind, ['image', 'document'], { label: '文件类别' }) : undefined,
      };
      const file = productFiles.uploadProductFile(ctx.workspace.id, ctx.params.id, input, context(ctx));
      return { file };
    },
    { ...WRITE, maxBodyBytes: 12_000_000 },
  );

  router.delete(
    '/api/v1/products/:id/files/:fileId',
    async (ctx) => productFiles.deleteProductFile(ctx.workspace.id, ctx.params.id, ctx.params.fileId, context(ctx)),
    WRITE,
  );

  router.post(
    '/api/v1/products/:id/files/:fileId/main',
    async (ctx) => ({ file: productFiles.setMainImage(ctx.workspace.id, ctx.params.id, ctx.params.fileId, context(ctx)) }),
    WRITE,
  );

  router.get(
    '/api/v1/products/:id/files/:fileId',
    async (ctx) => {
      const file = productFiles.getAuthenticatedFile(ctx.workspace.id, ctx.params.id, ctx.params.fileId);
      return productFiles.streamFile(ctx, file, { inline: true });
    },
    READ,
  );

  // Public, signed, no session required (opened directly from an email).
  router.get(
    '/api/v1/public/product-files/:token',
    async (ctx) => {
      const file = productFiles.resolvePublicFile(ctx.params.token);
      return productFiles.streamFile(ctx, file, { inline: true });
    },
    PUBLIC,
  );
}
