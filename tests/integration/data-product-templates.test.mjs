import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { get } from '../../server/core/db.mjs';
import {
  getApprovedProductTemplate,
  requireApprovedProductTemplate,
  PLACEHOLDERS,
} from '../../server/services/product-templates.mjs';

const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

async function createProduct(suffix = 'A') {
  const response = await ctx.request('POST', '/api/v1/products', {
    body: {
      name: `Ceramic Brake Pad ${suffix}`,
      category: 'Brake System',
      description: 'Low-dust ceramic brake pad for passenger cars and the aftermarket.',
      applications: ['passenger car', 'aftermarket'],
      materials: 'ceramic compound',
      certifications: ['ECE R90'],
      moq: '500 sets',
      leadTime: '25 days',
      keywords: ['brake pad', 'ceramic'],
    },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

async function uploadPdf(productId, filename = 'catalogue.pdf', text = '%PDF-1.4 catalogue\n') {
  const response = await ctx.request('POST', `/api/v1/products/${productId}/files`, {
    body: {
      filename,
      mimeType: 'application/pdf',
      dataBase64: Buffer.from(text, 'utf8').toString('base64'),
    },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data.file;
}

async function uploadImage(productId) {
  const response = await ctx.request('POST', `/api/v1/products/${productId}/files`, {
    body: { filename: 'main.png', mimeType: 'image/png', dataBase64: PNG_BASE64 },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data.file;
}

async function generate(productId, body = {}) {
  return ctx.request('POST', `/api/v1/products/${productId}/email-template/generate`, { body });
}

function versionMap(items) {
  return items.map((item) => `${item.version}:${item.status}`);
}

test('overview is empty before generation and returns 404 for unknown products', async () => {
  const product = await createProduct('Empty');
  const response = await ctx.request('GET', `/api/v1/products/${product.id}/email-template`);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.data, { template: null, approved: null });

  const versions = await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`);
  assert.equal(versions.status, 200, versions.text);
  assert.deepEqual(versions.body.data.items, []);

  const missing = await ctx.request('GET', '/api/v1/products/prd_missing/email-template');
  assert.equal(missing.status, 404);
  const missingVersions = await ctx.request('GET', '/api/v1/products/prd_missing/email-templates');
  assert.equal(missingVersions.status, 404);
});

test('generation creates a pending version with placeholders, variables and PDF attachments', async () => {
  const product = await createProduct('Generate');
  const pdf = await uploadPdf(product.id, 'brake-catalogue.pdf');
  await uploadImage(product.id);

  const response = await generate(product.id, { language: 'en', instructions: 'Keep it concise and mention the catalogue.' });
  assert.equal(response.status, 200, response.text);
  const template = response.body.data;
  assert.match(template.id, /^ptm_/);
  assert.equal(template.productId, product.id);
  assert.equal(template.version, 1);
  assert.equal(template.status, 'pending_approval');
  assert.equal(template.language, 'en');
  assert.ok(template.subject.length > 0);
  assert.ok(template.bodyText.length > 0);
  assert.ok(template.bodyText.includes(PLACEHOLDERS.companyName), 'body uses {{companyName}}');
  assert.ok(template.bodyText.includes(PLACEHOLDERS.contactFirstName), 'body uses {{contactFirstName}}');
  assert.ok(template.bodyText.includes(PLACEHOLDERS.country), 'body uses {{country}}');

  const keys = template.variables.map((variable) => variable.key).sort();
  assert.deepEqual(keys, ['companyName', 'contactFirstName', 'country', 'productCatalogueUrl']);
  assert.ok(template.bodyText.includes(PLACEHOLDERS.productCatalogueUrl), 'body uses {{productCatalogueUrl}}');
  for (const variable of template.variables) {
    assert.equal(typeof variable.placeholder, 'string');
    assert.equal(typeof variable.label, 'string');
    assert.ok(variable.description.length > 0, 'every variable has an explanation');
  }

  assert.equal(template.attachments.length, 1, 'images are not attached, only PDFs');
  const attachment = template.attachments[0];
  assert.deepEqual(Object.keys(attachment).sort(), ['filename', 'mimeType', 'productFileId', 'publicUrl', 'sizeBytes']);
  assert.equal(attachment.productFileId, pdf.id);
  assert.equal(attachment.filename, 'brake-catalogue.pdf');
  assert.equal(attachment.mimeType, 'application/pdf');
  assert.ok(attachment.sizeBytes > 0);
  assert.match(attachment.publicUrl, /^\/api\/v1\/public\/product-files\//);

  const stored = get('SELECT attachments_json, variables_json, generated_by, created_by FROM product_email_templates WHERE id = ?', [template.id]);
  assert.deepEqual(JSON.parse(stored.attachments_json), template.attachments);
  assert.deepEqual(JSON.parse(stored.variables_json), template.variables);
  assert.equal(stored.generated_by, ctx.owner.userId);
  assert.equal(stored.created_by, ctx.owner.userId);

  const auditRow = get(
    "SELECT id FROM audit_events WHERE workspace_id = ? AND action = 'product.template_generate' AND entity_id = ?",
    [ctx.owner.workspaceId, template.id],
  );
  assert.ok(auditRow, 'generation is audited');

  const overview = await ctx.request('GET', `/api/v1/products/${product.id}/email-template`);
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.body.data.template.id, template.id);
  assert.equal(overview.body.data.approved, null);
});

test('generation without PDF files still works and stores an empty attachment snapshot', async () => {
  const product = await createProduct('NoFiles');
  const response = await generate(product.id, {});
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.data.attachments, []);
  assert.deepEqual(response.body.data.variables.map((variable) => variable.key).sort(), [
    'companyName',
    'contactFirstName',
    'country',
  ]);
});

test('only the first three product PDFs are snapshotted', async () => {
  const product = await createProduct('ManyFiles');
  for (const name of ['one.pdf', 'two.pdf', 'three.pdf', 'four.pdf']) {
    await uploadPdf(product.id, name, `%PDF-1.4 ${name}\n`);
  }
  const response = await generate(product.id, {});
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.data.attachments.length, 3);
  assert.ok(response.body.data.attachments.every((attachment) => attachment.mimeType === 'application/pdf'));
});

test('each generation appends a new version and versions are listed newest first', async () => {
  const product = await createProduct('Versions');
  const first = await generate(product.id, { language: 'en' });
  const second = await generate(product.id, { language: 'de' });
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);
  assert.equal(first.body.data.version, 1);
  assert.equal(second.body.data.version, 2);
  assert.equal(second.body.data.status, 'pending_approval');
  assert.equal(second.body.data.language, 'de');

  const versions = await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`);
  assert.equal(versions.status, 200, versions.text);
  assert.deepEqual(versionMap(versions.body.data.items), ['2:pending_approval', '1:pending_approval']);
});

test('editing a pending template updates it in place', async () => {
  const product = await createProduct('EditPending');
  const created = await generate(product.id, {});
  const templateId = created.body.data.id;

  const patched = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${templateId}`, {
    body: {
      subject: 'Custom subject for {{companyName}}',
      bodyText: 'Hello {{contactFirstName}},\n\nWe supply parts to {{companyName}} in {{country}}.\n\nBest regards,',
      language: 'fr',
    },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.data.id, templateId);
  assert.equal(patched.body.data.version, 1);
  assert.equal(patched.body.data.status, 'pending_approval');
  assert.equal(patched.body.data.subject, 'Custom subject for {{companyName}}');
  assert.equal(patched.body.data.language, 'fr');
  assert.ok(patched.body.data.bodyText.includes('{{country}}'));
  assert.deepEqual(patched.body.data.variables.map((variable) => variable.key).sort(), [
    'companyName',
    'contactFirstName',
    'country',
  ]);

  const versions = await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`);
  assert.equal(versions.body.data.items.length, 1, 'pending edits do not create versions');
});

test('editing an approved template copies it into a new pending version and keeps history', async () => {
  const product = await createProduct('EditApproved');
  const created = await generate(product.id, {});
  const templateId = created.body.data.id;
  const approved = await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${templateId}/approve`, { body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.data.status, 'approved');
  assert.equal(approved.body.data.approvedBy, ctx.owner.userId);
  assert.ok(approved.body.data.approvedAt);

  const patched = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${templateId}`, {
    body: { subject: 'A better approved subject {{companyName}}', language: 'en' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.notEqual(patched.body.data.id, templateId);
  assert.equal(patched.body.data.version, 2);
  assert.equal(patched.body.data.status, 'pending_approval');
  assert.equal(patched.body.data.subject, 'A better approved subject {{companyName}}');
  assert.equal(patched.body.data.bodyText, approved.body.data.bodyText, 'body is copied unless edited');
  assert.deepEqual(patched.body.data.attachments, approved.body.data.attachments);

  const versions = await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`);
  assert.deepEqual(versionMap(versions.body.data.items), ['2:pending_approval', '1:approved']);
  const overview = await ctx.request('GET', `/api/v1/products/${product.id}/email-template`);
  assert.equal(overview.body.data.template.version, 2);
  assert.equal(overview.body.data.approved.version, 1, 'the old approved template stays usable');
});

test('approval is unique per product: the previous approved version becomes disabled', async () => {
  const product = await createProduct('Approve');
  const v1 = await generate(product.id, {});
  const v2 = await generate(product.id, {});
  const approvedV1 = await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${v1.body.data.id}/approve`, { body: {} });
  assert.equal(approvedV1.status, 200, approvedV1.text);
  assert.equal(approvedV1.body.data.status, 'approved');

  const approvedV2 = await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${v2.body.data.id}/approve`, { body: {} });
  assert.equal(approvedV2.status, 200, approvedV2.text);
  assert.equal(approvedV2.body.data.status, 'approved');
  assert.equal(approvedV2.body.data.version, 2);

  const versions = await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`);
  assert.deepEqual(versionMap(versions.body.data.items), ['2:approved', '1:disabled']);
  const approvedCount = get(
    "SELECT COUNT(*) AS c FROM product_email_templates WHERE workspace_id = ? AND product_id = ? AND status = 'approved'",
    [ctx.owner.workspaceId, product.id],
  );
  assert.equal(approvedCount.c, 1);

  const overview = await ctx.request('GET', `/api/v1/products/${product.id}/email-template`);
  assert.equal(overview.body.data.approved.id, v2.body.data.id);
  assert.equal(overview.body.data.template.version, 2);

  // Re-approving an already approved template is idempotent.
  const again = await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${v2.body.data.id}/approve`, { body: {} });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.data.status, 'approved');
  const approvedCountAgain = get(
    "SELECT COUNT(*) AS c FROM product_email_templates WHERE workspace_id = ? AND product_id = ? AND status = 'approved'",
    [ctx.owner.workspaceId, product.id],
  );
  assert.equal(approvedCountAgain.c, 1);

  const auditRow = get(
    "SELECT id FROM audit_events WHERE workspace_id = ? AND action = 'product.template_approve' AND entity_id = ?",
    [ctx.owner.workspaceId, v2.body.data.id],
  );
  assert.ok(auditRow, 'approval is audited');
});

test('contract helpers expose only approved templates for batch outreach', async () => {
  const product = await createProduct('Contract');
  assert.equal(getApprovedProductTemplate(ctx.owner.workspaceId, product.id), null);
  await assert.rejects(
    () => Promise.resolve().then(() => requireApprovedProductTemplate(ctx.owner.workspaceId, product.id)),
    (error) => error.code === 'CONFLICT',
  );

  const created = await generate(product.id, {});
  await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${created.body.data.id}/approve`, { body: {} });

  const approved = getApprovedProductTemplate(ctx.owner.workspaceId, product.id);
  assert.ok(approved);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.version, 1);
  const required = requireApprovedProductTemplate(ctx.owner.workspaceId, product.id);
  assert.equal(required.id, created.body.data.id);
});

test('request validation: language, empty fields and unknown template ids', async () => {
  const product = await createProduct('Validation');
  const created = await generate(product.id, {});
  const templateId = created.body.data.id;

  const badLanguage = await generate(product.id, { language: 'english' });
  assert.equal(badLanguage.status, 422);

  const badPatchLanguage = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${templateId}`, {
    body: { language: 'english' },
  });
  assert.equal(badPatchLanguage.status, 422);

  const emptyPatch = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${templateId}`, { body: {} });
  assert.equal(emptyPatch.status, 422);

  const emptySubject = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${templateId}`, {
    body: { subject: '   ' },
  });
  assert.equal(emptySubject.status, 422);

  const emptyBody = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${templateId}`, {
    body: { bodyText: '   ' },
  });
  assert.equal(emptyBody.status, 422);

  const longInstructions = await generate(product.id, { instructions: 'x'.repeat(1001) });
  assert.equal(longInstructions.status, 422);

  const missingTemplate = await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/ptm_missing`, {
    body: { subject: 'x' },
  });
  assert.equal(missingTemplate.status, 404);
  const approveMissing = await ctx.request('POST', `/api/v1/products/${product.id}/email-template/ptm_missing/approve`, { body: {} });
  assert.equal(approveMissing.status, 404);
});

test('templates are workspace isolated', async () => {
  const product = await createProduct('Tenant');
  const created = await generate(product.id, {});
  const isolated = ctx.createWorkspace();
  const originalAuth = ctx.auth;
  try {
    ctx.as(isolated);
    assert.equal((await ctx.request('GET', `/api/v1/products/${product.id}/email-template`)).status, 404);
    assert.equal((await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`)).status, 404);
    assert.equal((await generate(product.id, {})).status, 404);
    assert.equal(
      (await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${created.body.data.id}`, { body: { subject: 'hack' } })).status,
      404,
    );
    assert.equal(
      (await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${created.body.data.id}/approve`, { body: {} })).status,
      404,
    );
    assert.equal(getApprovedProductTemplate(isolated.workspaceId, product.id), null);
  } finally {
    ctx.auth = originalAuth;
  }
});

test('viewers can read templates but cannot generate, edit or approve', async () => {
  const product = await createProduct('Viewer');
  const created = await generate(product.id, {});
  const approved = await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${created.body.data.id}/approve`, { body: {} });
  assert.equal(approved.status, 200, approved.text);

  const viewer = ctx.createMember({ email: 'viewer-templates@test.local', role: 'viewer' });
  const originalAuth = ctx.auth;
  try {
    ctx.as(viewer);
    assert.equal((await ctx.request('GET', `/api/v1/products/${product.id}/email-template`)).status, 200);
    assert.equal((await ctx.request('GET', `/api/v1/products/${product.id}/email-templates`)).status, 200);
    assert.equal((await generate(product.id, {})).status, 403);
    assert.equal(
      (await ctx.request('PATCH', `/api/v1/products/${product.id}/email-template/${created.body.data.id}`, { body: { subject: 'x' } })).status,
      403,
    );
    assert.equal(
      (await ctx.request('POST', `/api/v1/products/${product.id}/email-template/${created.body.data.id}/approve`, { body: {} })).status,
      403,
    );
  } finally {
    ctx.auth = originalAuth;
  }
});
