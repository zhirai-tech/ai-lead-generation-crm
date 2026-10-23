/**
 * OWNER: t-data. Product media/documents (images + PDF) for the v1.1 outreach
 * attachments feature.
 *
 * - uploads arrive as base64 JSON (single file <= 8 MB) and are written to
 *   `<uploadsDir>/products/<workspaceId>/<productId>/<fileId>.<ext>`;
 * - authenticated streaming is workspace scoped;
 * - email-safe public links are signed tokens (`{t:'pfile',w,p,f}`, 180 days)
 *   and only issued for PDF documents;
 * - every mutation is audited and every read is tenant scoped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig } from '../config.mjs';
import { getSecret } from '../core/secrets.mjs';
import { signToken, verifyToken } from '../core/crypto.mjs';
import { AppError, notFound, validationError } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as productsRepo from '../repositories/products.mjs';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PUBLIC_TOKEN_DAYS = 180;
export const MAX_FILES_PER_PRODUCT = 100;

export const IMAGE_MIME_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
});
export const DOCUMENT_MIME_EXTENSIONS = Object.freeze({
  'application/pdf': '.pdf',
});
export const ALLOWED_MIME_TYPES = Object.freeze({
  ...IMAGE_MIME_EXTENSIONS,
  ...DOCUMENT_MIME_EXTENSIONS,
});

function contextOf(context = {}) {
  return {
    actorId: context.actorId || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    requestId: context.requestId || null,
  };
}

function auditRecord(workspaceId, action, entityId, after, context) {
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action,
    entityType: 'product_file',
    entityId,
    after,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
}

function uploadsRoot(config) {
  return path.resolve((config && config.uploadsDir) || defaultConfig.uploadsDir);
}

/** Absolute on-disk path for a stored relative path; refuses path traversal. */
export function resolveStoragePath(storagePath, config = null) {
  const root = uploadsRoot(config);
  const relative = String(storagePath || '').replace(/\\/g, '/');
  if (!relative || relative.includes('..')) throw notFound('文件路径无效');
  const resolved = path.resolve(root, ...relative.split('/').filter(Boolean));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw notFound('文件路径无效');
  return resolved;
}

/** Strip directories/CRLF and cap the display filename at 160 characters. */
export function sanitizeFilename(filename) {
  const base = String(filename || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || 'file').slice(0, 160);
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').trim().toLowerCase().split(';')[0];
}

function kindForMimeType(mimeType) {
  if (IMAGE_MIME_EXTENSIONS[mimeType]) return 'image';
  if (DOCUMENT_MIME_EXTENSIONS[mimeType]) return 'document';
  return null;
}

/** Decode a plain or data-URI base64 payload with strict validation. */
export function decodeBase64File(dataBase64) {
  if (typeof dataBase64 !== 'string' || !dataBase64.trim()) throw validationError('文件内容不能为空');
  const cleaned = dataBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
    throw validationError('文件内容不是合法的 base64 编码');
  }
  let buffer;
  try {
    buffer = Buffer.from(cleaned, 'base64');
  } catch {
    throw validationError('文件内容不是合法的 base64 编码');
  }
  if (!buffer.length) throw validationError('文件内容为空');
  if (buffer.length > MAX_FILE_BYTES) throw validationError('单个文件不能超过 8MB');
  return buffer;
}

/**
 * Token expiry is pinned to the start of the UTC day ~180 days out so repeated
 * list calls return the same publicUrl (stable email links / caching) while the
 * link still expires after 180 days.
 */
function tokenExpiryDays() {
  const target = new Date(Date.now() + PUBLIC_TOKEN_DAYS * 86_400_000);
  target.setUTCHours(0, 0, 0, 0);
  return Math.max(1, (target.getTime() - Date.now()) / 86_400_000);
}

export function productFilePublicUrl(workspaceId, productId, fileId) {
  const token = signToken(
    getSecret(),
    { t: 'pfile', w: workspaceId, p: productId, f: fileId },
    { expiresInDays: tokenExpiryDays() },
  );
  return `/api/v1/public/product-files/${token}`;
}

/** Build the API view for one file row. publicUrl is issued for documents only. */
export function buildFileView(product, row) {
  if (!row) return null;
  const kind = row.kind || kindForMimeType(row.mimeType) || 'document';
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    kind,
    isMain: Boolean(product && product.mainImageFileId && product.mainImageFileId === row.id),
    url: `/api/v1/products/${row.productId}/files/${row.id}`,
    publicUrl: kind === 'document' ? productFilePublicUrl(row.workspaceId, row.productId, row.id) : null,
    createdAt: row.createdAt,
  };
}

/** Attach `files` + `mainImageUrl` to a single product object. */
export function decorateProduct(workspaceId, product) {
  if (!product) return null;
  const rows = productsRepo.listFilesForProduct(workspaceId, product.id);
  const files = rows.map((row) => buildFileView(product, row));
  const mainFile = files.find((file) => file.id === product.mainImageFileId) || null;
  return { ...product, files, mainImageUrl: mainFile ? mainFile.url : null };
}

/** Attach `files` + `mainImageUrl` to a product list without N+1 queries. */
export function decorateProducts(workspaceId, products = []) {
  if (!products.length) return [];
  const rows = productsRepo.listFilesForProducts(
    workspaceId,
    products.map((product) => product.id),
  );
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.productId)) byProduct.set(row.productId, []);
    byProduct.get(row.productId).push(row);
  }
  return products.map((product) => {
    const files = (byProduct.get(product.id) || []).map((row) => buildFileView(product, row));
    const mainFile = files.find((file) => file.id === product.mainImageFileId) || null;
    return { ...product, files, mainImageUrl: mainFile ? mainFile.url : null };
  });
}

// ------------------------------------------------------------------ contract
/** Throw 404 when a product does not exist in the workspace (route guard). */
export function assertProductExists(workspaceId, productId) {
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  return product;
}

/** Contract for t-crm: all files (views) for a product, including publicUrl. */
export function listProductFiles(workspaceId, productId) {
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) return [];
  return productsRepo.listFilesForProduct(workspaceId, product.id).map((row) => buildFileView(product, row));
}

/** Contract for t-crm email attachments: PDF documents only, with public links. */
export function listProductFilesForEmail(workspaceId, productId) {
  return listProductFiles(workspaceId, productId)
    .filter((file) => file.kind === 'document' && file.mimeType === 'application/pdf' && file.publicUrl)
    .map((file) => ({
      productFileId: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      publicUrl: file.publicUrl,
    }));
}

// ------------------------------------------------------------------- upload
export function uploadProductFile(workspaceId, productId, input = {}, context = {}) {
  const ctx = contextOf(context);
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  if (productsRepo.countProductFiles(workspaceId, productId) >= MAX_FILES_PER_PRODUCT) {
    throw validationError(`单个产品最多 ${MAX_FILES_PER_PRODUCT} 个文件`);
  }
  const mimeType = normalizeMimeType(input.mimeType);
  const inferredKind = kindForMimeType(mimeType);
  if (!inferredKind) throw validationError('仅支持 PNG/JPEG/WebP 图片或 PDF 文档');
  if (input.kind && !['image', 'document'].includes(input.kind)) throw validationError('文件类型不在允许范围内');
  if (input.kind && input.kind !== inferredKind) throw validationError('文件内容类型与 kind 不匹配');
  const buffer = decodeBase64File(input.dataBase64);
  const extension = ALLOWED_MIME_TYPES[mimeType];
  const filename = sanitizeFilename(input.filename);
  const fileId = id('pfl');
  const relativePath = `products/${workspaceId}/${productId}/${fileId}${extension}`;
  const absolutePath = resolveStoragePath(relativePath, context.config);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer);
  let row;
  try {
    row = productsRepo.insertProductFile({
      id: fileId,
      workspace_id: workspaceId,
      product_id: productId,
      filename,
      mime_type: mimeType,
      size_bytes: buffer.length,
      storage_path: relativePath,
      kind: inferredKind,
      uploaded_by: ctx.actorId,
      created_at: nowIso(),
    });
  } catch (error) {
    try {
      fs.unlinkSync(absolutePath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }

  let refreshed = product;
  let autoMain = false;
  if (inferredKind === 'image' && !product.mainImageFileId) {
    refreshed = productsRepo.setProductMainImage(workspaceId, productId, fileId) || product;
    autoMain = true;
  }
  const file = buildFileView(refreshed, row);
  auditRecord(workspaceId, 'product.file_upload', fileId, {
    productId,
    filename,
    mimeType,
    sizeBytes: buffer.length,
    kind: inferredKind,
    isMain: file.isMain,
    autoMain,
  }, ctx);
  return file;
}

// ------------------------------------------------------------------- delete
export function deleteProductFile(workspaceId, productId, fileId, context = {}) {
  const ctx = contextOf(context);
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  const row = productsRepo.findProductFile(workspaceId, productId, fileId);
  if (!row) throw notFound('文件不存在');
  productsRepo.deleteProductFileRow(workspaceId, productId, fileId);
  if (product.mainImageFileId === fileId) {
    productsRepo.setProductMainImage(workspaceId, productId, null);
  }
  try {
    fs.unlinkSync(resolveStoragePath(row.storagePath, context.config));
  } catch {
    // A missing physical file must not block deleting the record.
  }
  auditRecord(workspaceId, 'product.file_delete', fileId, {
    productId,
    filename: row.filename,
    mimeType: row.mimeType,
    wasMain: product.mainImageFileId === fileId,
  }, ctx);
  return { deleted: true, id: fileId };
}

// ---------------------------------------------------------------- main image
export function setMainImage(workspaceId, productId, fileId, context = {}) {
  const ctx = contextOf(context);
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  const row = productsRepo.findProductFile(workspaceId, productId, fileId);
  if (!row) throw notFound('文件不存在');
  if (row.kind !== 'image') throw validationError('只有图片可以设为主图');
  const refreshed = productsRepo.setProductMainImage(workspaceId, productId, fileId) || product;
  auditRecord(workspaceId, 'product.file_set_main', fileId, { productId, filename: row.filename }, ctx);
  return buildFileView(refreshed, row);
}

// ------------------------------------------------------------------- read
export function getAuthenticatedFile(workspaceId, productId, fileId) {
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  const file = productsRepo.findProductFile(workspaceId, productId, fileId);
  if (!file) throw notFound('文件不存在');
  return file;
}

/** Resolve a signed public token; invalid/expired/foreign tokens are all 404. */
export function resolvePublicFile(token) {
  const payload = verifyToken(getSecret(), token);
  if (!payload || payload.t !== 'pfile') throw notFound('文件链接无效或已过期');
  if (!payload.w || !payload.p || !payload.f) throw notFound('文件链接无效或已过期');
  const file = productsRepo.findProductFile(payload.w, payload.p, payload.f);
  if (!file) throw notFound('文件链接无效或已过期');
  return file;
}

/**
 * Stream a stored file to the raw HTTP response (inline). Returns undefined so
 * the framework does not wrap the response in JSON.
 */
export function streamFile(ctx, file, { inline = true, cacheControl = 'private, max-age=300' } = {}) {
  const absolutePath = resolveStoragePath(file.storagePath, ctx.config);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw notFound('文件已丢失，请重新上传');
  }
  const filename = sanitizeFilename(file.filename).replace(/"/g, '_');
  const encoded = encodeURIComponent(sanitizeFilename(file.filename));
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${filename}"; filename*=UTF-8''${encoded}`;
  ctx.header('Content-Type', file.mimeType || 'application/octet-stream');
  ctx.header('Content-Length', String(stat.size));
  ctx.header('Content-Disposition', disposition);
  ctx.header('X-Content-Type-Options', 'nosniff');
  ctx.header('Cache-Control', cacheControl);
  ctx.res.writeHead(200, ctx._headers);
  ctx._status = 200;
  const stream = fs.createReadStream(absolutePath);
  stream.on('error', () => {
    try {
      ctx.res.destroy();
    } catch {
      // ignore
    }
  });
  stream.pipe(ctx.res);
  return undefined;
}

/** Throw a standard 503 when the keyword agent is unavailable (no fabrication). */
export function agentUnavailable(detail = '') {
  throw new AppError('AGENT_UNAVAILABLE', 'AI 关键词生成服务暂不可用，请稍后重试或手动填写关键词', {
    status: 503,
    details: detail ? { agent: 'generateProductKeywords', reason: String(detail).slice(0, 200) } : { agent: 'generateProductKeywords' },
  });
}
