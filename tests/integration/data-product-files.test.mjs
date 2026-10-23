import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestContext } from '../helpers.mjs';
import { get } from '../../server/core/db.mjs';
import { signToken } from '../../server/core/crypto.mjs';
import { getSecret } from '../../server/core/secrets.mjs';
import {
  MAX_FILE_BYTES,
  listProductFiles,
  listProductFilesForEmail,
} from '../../server/services/product-files.mjs';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF_TEXT = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n';
const PDF_BASE64 = Buffer.from(PDF_TEXT, 'utf8').toString('base64');

let ctx;
let workspaceId;
let productId;

before(async () => {
  ctx = await createTestContext();
  workspaceId = ctx.owner.workspaceId;
  const product = await ctx.request('POST', '/api/v1/products', {
    body: { name: 'Ceramic Brake Pad', category: 'Brake System', applications: ['brake'] },
  });
  assert.equal(product.status, 200, product.text);
  productId = product.body.data.id;
});

after(async () => {
  await ctx.close();
});

function upload(product, body) {
  return ctx.request('POST', `/api/v1/products/${product}/files`, { body });
}

async function uploadImage(overrides = {}) {
  const response = await upload(productId, {
    filename: 'brake-pad.png',
    mimeType: 'image/png',
    dataBase64: PNG_BASE64,
    ...overrides,
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data.file;
}

async function uploadPdf(overrides = {}) {
  const response = await upload(productId, {
    filename: 'catalogue.pdf',
    mimeType: 'application/pdf',
    dataBase64: PDF_BASE64,
    ...overrides,
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data.file;
}

test('uploading the first image auto-sets the main image and returns the file view', async () => {
  const file = await uploadImage();
  assert.match(file.id, /^pfl_/);
  assert.equal(file.filename, 'brake-pad.png');
  assert.equal(file.mimeType, 'image/png');
  assert.equal(file.kind, 'image');
  assert.equal(file.isMain, true, 'first image becomes main image');
  assert.ok(file.sizeBytes > 0);
  assert.equal(file.publicUrl, null, 'public links are only issued for documents');
  assert.equal(file.url, `/api/v1/products/${productId}/files/${file.id}`);
  assert.ok(file.createdAt);

  const stored = get('SELECT storage_path, size_bytes, kind, uploaded_by FROM product_files WHERE id = ? AND workspace_id = ?', [file.id, workspaceId]);
  assert.match(stored.storage_path, new RegExp(`^products/${workspaceId}/${productId}/`));
  assert.equal(stored.kind, 'image');
  assert.equal(stored.uploaded_by, ctx.owner.userId);
  const absolute = path.resolve(ctx.config.uploadsDir, ...stored.storage_path.split('/'));
  assert.equal(fs.existsSync(absolute), true, 'file is written to the uploads dir');

  const list = await ctx.request('GET', `/api/v1/products/${productId}/files`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].id, file.id);

  const detail = await ctx.request('GET', `/api/v1/products/${productId}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.data.files.length, 1);
  assert.equal(detail.body.data.mainImageUrl, file.url);
  assert.deepEqual(detail.body.data.keywords, []);

  const productList = await ctx.request('GET', '/api/v1/products?pageSize=50');
  assert.equal(productList.status, 200, productList.text);
  const listed = productList.body.data.items.find((item) => item.id === productId);
  assert.ok(listed, 'product appears in the list');
  assert.equal(listed.files.length, 1);
  assert.equal(listed.mainImageUrl, file.url);
  assert.deepEqual(listed.keywords, []);

  const audits = ctx.db
    .prepare("SELECT action FROM audit_events WHERE workspace_id = ? AND entity_type = 'product_file' AND entity_id = ?")
    .all(workspaceId, file.id)
    .map((row) => row.action);
  assert.ok(audits.includes('product.file_upload'));

  const stream = await ctx.request('GET', file.url, { raw: true });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'image/png');
  assert.match(stream.headers.get('content-disposition'), /^inline;/);
  assert.equal(stream.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(stream.headers.get('content-length'));
});

test('PDF documents get signed public links that email recipients can open anonymously', async () => {
  const file = await uploadPdf();
  assert.equal(file.kind, 'document');
  assert.equal(file.mimeType, 'application/pdf');
  assert.match(file.publicUrl, /^\/api\/v1\/public\/product-files\//);

  const anonymous = await ctx.request('GET', file.publicUrl, { anonymous: true, raw: true });
  assert.equal(anonymous.status, 200, anonymous.text);
  assert.equal(anonymous.headers.get('content-type'), 'application/pdf');
  assert.match(anonymous.headers.get('content-disposition'), /^inline;/);
  assert.equal(anonymous.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(anonymous.text.includes('%PDF-1.4'));

  const wrongProduct = await ctx.request('GET', `/api/v1/products/${productId}/files/${file.id}`, { anonymous: true });
  assert.ok([401, 404].includes(wrongProduct.status), 'authenticated file URL requires a session');

  const emailFiles = listProductFilesForEmail(workspaceId, productId);
  assert.equal(emailFiles.length, 1);
  assert.equal(emailFiles[0].productFileId, file.id);
  assert.equal(emailFiles[0].mimeType, 'application/pdf');
  assert.equal(emailFiles[0].filename, 'catalogue.pdf');
  assert.match(emailFiles[0].publicUrl, /^\/api\/v1\/public\/product-files\//);
  const reopened = await ctx.request('GET', emailFiles[0].publicUrl, { anonymous: true, raw: true });
  assert.equal(reopened.status, 200, 'contract publicUrl stays usable for email recipients');
  assert.deepEqual(
    listProductFiles(workspaceId, productId).map((item) => item.kind).sort(),
    ['document', 'image'],
  );
});

test('public tokens are rejected when tampered, expired or issued for another workspace', async () => {
  const file = await uploadPdf({ filename: 'spec-sheet.pdf' });

  const tampered = await ctx.request('GET', `${file.publicUrl}broken`, { anonymous: true });
  assert.equal(tampered.status, 404);
  const garbage = await ctx.request('GET', '/api/v1/public/product-files/not-a-token', { anonymous: true });
  assert.equal(garbage.status, 404);

  const expiredToken = signToken(
    getSecret(),
    { t: 'pfile', w: workspaceId, p: productId, f: file.id },
    { expiresInDays: -1 },
  );
  const expired = await ctx.request('GET', `/api/v1/public/product-files/${expiredToken}`, { anonymous: true });
  assert.equal(expired.status, 404);

  const wrongType = signToken(getSecret(), { t: 'unsubscribe', w: workspaceId, p: productId, f: file.id });
  const wrongTypeResponse = await ctx.request('GET', `/api/v1/public/product-files/${wrongType}`, { anonymous: true });
  assert.equal(wrongTypeResponse.status, 404);

  const otherWorkspace = ctx.createWorkspace();
  const foreignToken = signToken(
    getSecret(),
    { t: 'pfile', w: otherWorkspace.workspaceId, p: productId, f: file.id },
    { expiresInDays: 180 },
  );
  const foreign = await ctx.request('GET', `/api/v1/public/product-files/${foreignToken}`, { anonymous: true });
  assert.equal(foreign.status, 404, 'tokens are bound to the owning workspace');
});

test('upload validation: mime type, kind, base64 and 8MB limit', async () => {
  const svg = await upload(productId, {
    filename: 'logo.svg',
    mimeType: 'image/svg+xml',
    dataBase64: Buffer.from('<svg/>').toString('base64'),
  });
  assert.equal(svg.status, 422);

  const html = await upload(productId, {
    filename: 'page.html',
    mimeType: 'text/html',
    dataBase64: Buffer.from('<html></html>').toString('base64'),
  });
  assert.equal(html.status, 422);

  const kindMismatch = await upload(productId, {
    filename: 'cat.pdf',
    mimeType: 'application/pdf',
    kind: 'image',
    dataBase64: PDF_BASE64,
  });
  assert.equal(kindMismatch.status, 422);

  const badBase64 = await upload(productId, {
    filename: 'bad.png',
    mimeType: 'image/png',
    dataBase64: '!!!not-base64!!!',
  });
  assert.equal(badBase64.status, 422);

  const tooLarge = await upload(productId, {
    filename: 'huge.pdf',
    mimeType: 'application/pdf',
    dataBase64: Buffer.alloc(MAX_FILE_BYTES + 1, 0x41).toString('base64'),
  });
  assert.equal(tooLarge.status, 422);

  const missingProduct = await upload('prd_missing', {
    filename: 'cat.pdf',
    mimeType: 'application/pdf',
    dataBase64: PDF_BASE64,
  });
  assert.equal(missingProduct.status, 404);
});

test('data URI base64 and path traversal filenames are normalised', async () => {
  const response = await upload(productId, {
    filename: '../../etc/evil.png',
    mimeType: 'image/png',
    dataBase64: `data:image/png;base64,${PNG_BASE64}`,
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.data.file.filename, 'evil.png');
  const stored = get('SELECT storage_path FROM product_files WHERE id = ?', [response.body.data.file.id]);
  assert.ok(!stored.storage_path.includes('..'));
});

test('main image can be changed and is cleared when the main file is deleted', async () => {
  const image = await uploadImage({ filename: 'main-choice.png' });
  const before = await ctx.request('GET', `/api/v1/products/${productId}`);
  const firstMainId = before.body.data.files.find((file) => file.isMain).id;

  const second = await uploadImage({ filename: 'second-choice.png' });
  assert.equal(second.isMain, false, 'only one main image');
  const setMain = await ctx.request('POST', `/api/v1/products/${productId}/files/${second.id}/main`, { body: {} });
  assert.equal(setMain.status, 200, setMain.text);
  assert.equal(setMain.body.data.file.isMain, true);

  const afterSet = await ctx.request('GET', `/api/v1/products/${productId}`);
  assert.equal(afterSet.body.data.mainImageUrl, second.url);
  assert.equal(afterSet.body.data.files.filter((file) => file.isMain).length, 1);

  const pdfAsMain = await ctx.request('POST', `/api/v1/products/${productId}/files/${pdfFileId()}/main`, { body: {} });
  assert.equal(pdfAsMain.status, 422, 'documents cannot be the main image');

  const removed = await ctx.request('DELETE', `/api/v1/products/${productId}/files/${second.id}`);
  assert.equal(removed.status, 200, removed.text);
  const afterDelete = await ctx.request('GET', `/api/v1/products/${productId}`);
  assert.equal(afterDelete.body.data.mainImageUrl, null, 'deleting the main image clears main_image_file_id');
  const row = get('SELECT main_image_file_id FROM products WHERE id = ?', [productId]);
  assert.equal(row.main_image_file_id, null);
  const missingStream = await ctx.request('GET', second.url);
  assert.equal(missingStream.status, 404);
  assert.notEqual(firstMainId, second.id);
});

function pdfFileId() {
  return get("SELECT id FROM product_files WHERE workspace_id = ? AND product_id = ? AND kind = 'document' ORDER BY created_at LIMIT 1", [
    workspaceId,
    productId,
  ]).id;
}

test('PATCH keywords normalises, dedupes and caps the list', async () => {
  const tooMany = Array.from({ length: 35 }, (_, index) => `keyword ${index + 1}`);
  const patched = await ctx.request('PATCH', `/api/v1/products/${productId}`, {
    body: { keywords: ['brake pad', ' Brake Pad ', 'ceramic brake pad', '', 42, 'x'.repeat(120), ...tooMany] },
  });
  assert.equal(patched.status, 200, patched.text);
  const keywords = patched.body.data.keywords;
  assert.equal(keywords.length, 30);
  assert.equal(keywords[0], 'brake pad');
  assert.equal(keywords.filter((keyword) => keyword.toLowerCase() === 'brake pad').length, 1);
  assert.ok(keywords.every((keyword) => keyword.length <= 80));
  assert.ok(!keywords.includes(''));

  const detail = await ctx.request('GET', `/api/v1/products/${productId}`);
  assert.deepEqual(detail.body.data.keywords, keywords);
  const stored = get('SELECT keywords_json FROM products WHERE id = ?', [productId]);
  assert.deepEqual(JSON.parse(stored.keywords_json), keywords);

  const invalid = await ctx.request('PATCH', `/api/v1/products/${productId}`, { body: { keywords: 'brake' } });
  assert.equal(invalid.status, 422);

  const created = await ctx.request('POST', '/api/v1/products', {
    body: { name: 'Keyword Seed Product', keywords: ['brake rotor', 'brake disc', 'brake rotor'] },
  });
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(created.body.data.keywords, ['brake rotor', 'brake disc']);
  assert.deepEqual(created.body.data.files, []);
  assert.equal(created.body.data.mainImageUrl, null);
});

test('POST generate-keywords persists AI keywords or reports AGENT_UNAVAILABLE', async () => {
  const before = get('SELECT keywords_json FROM products WHERE id = ?', [productId]);
  const response = await ctx.request('POST', `/api/v1/products/${productId}/generate-keywords`, { body: {} });
  if (response.status === 200) {
    const data = response.body.data;
    assert.ok(Array.isArray(data.keywords));
    assert.ok(data.keywords.length > 0);
    assert.ok(Array.isArray(data.negativeKeywords));
    assert.equal(typeof data.notes, 'string');
    const stored = JSON.parse(get('SELECT keywords_json FROM products WHERE id = ?', [productId]).keywords_json);
    assert.deepEqual(stored, data.keywords);
    const detail = await ctx.request('GET', `/api/v1/products/${productId}`);
    assert.deepEqual(detail.body.data.keywords, data.keywords);
    const auditRow = get(
      "SELECT id FROM audit_events WHERE workspace_id = ? AND action = 'product.keywords_generate' AND entity_id = ? ORDER BY created_at DESC LIMIT 1",
      [workspaceId, productId],
    );
    assert.ok(auditRow, 'keyword generation is audited');
  } else {
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AGENT_UNAVAILABLE');
    assert.equal(get('SELECT keywords_json FROM products WHERE id = ?', [productId]).keywords_json, before.keywords_json);
  }
});

test('workspace isolation for product files and products', async () => {
  const file = await uploadPdf({ filename: 'private.pdf' });
  const isolated = ctx.createWorkspace();
  const originalAuth = ctx.auth;
  try {
    ctx.as(isolated);

    assert.equal((await ctx.request('GET', `/api/v1/products/${productId}/files`)).status, 404);
    assert.equal((await ctx.request('GET', file.url)).status, 404);
    const uploadAttempt = await upload(productId, {
      filename: 'hack.pdf',
      mimeType: 'application/pdf',
      dataBase64: PDF_BASE64,
    });
    assert.equal(uploadAttempt.status, 404);
    assert.equal((await ctx.request('DELETE', `/api/v1/products/${productId}/files/${file.id}`)).status, 404);
    assert.deepEqual(listProductFiles(isolated.workspaceId, productId), []);
  } finally {
    ctx.auth = originalAuth;
  }
});

test('viewer can read files but cannot upload, delete or set the main image', async () => {
  const file = await uploadPdf({ filename: 'viewer-check.pdf' });
  const viewer = ctx.createMember({ email: 'viewer-files@test.local', role: 'viewer' });
  const originalAuth = ctx.auth;
  try {
    ctx.as(viewer);

    assert.equal((await ctx.request('GET', `/api/v1/products/${productId}/files`)).status, 200);
    assert.equal((await ctx.request('GET', file.url, { raw: true })).status, 200);
    assert.equal(
      (await upload(productId, { filename: 'denied.png', mimeType: 'image/png', dataBase64: PNG_BASE64 })).status,
      403,
    );
    assert.equal((await ctx.request('DELETE', `/api/v1/products/${productId}/files/${file.id}`)).status, 403);
    assert.equal((await ctx.request('POST', `/api/v1/products/${productId}/files/${file.id}/main`, { body: {} })).status, 403);
    assert.equal((await ctx.request('POST', `/api/v1/products/${productId}/generate-keywords`, { body: {} })).status, 403);
  } finally {
    ctx.auth = originalAuth;
  }
});
