/**
 * Drafts + approvals integration: generation with a stubbed agent layer,
 * approval state machine, send queueing guards and tenancy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestContext } from '../helpers.mjs';
import { seedCompany, seedContact, seedProduct } from '../unit/crm-fixtures.mjs';
import { setAgentImplementation, resetAgentImplementations } from '../../server/services/agent-client.mjs';
import { setProductFilesLoaderForTests, resetProductFilesLoaderForTests, MAX_DRAFT_ATTACHMENTS } from '../../server/services/drafts.mjs';
import { get, run } from '../../server/core/db.mjs';

const DRAFT_BODY = 'Dear Anna, we supply aluminium battery pack brackets for EV platforms.';

async function createDraft(ctx, company, contact, extra = {}) {
  const response = await ctx.request('POST', '/api/v1/drafts', {
    body: { companyId: company.id, contactId: contact.id, subject: 'Partnership', bodyText: DRAFT_BODY, language: 'en', ...extra },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

/** Create a campaign pinned to a product so the draft resolves a product. */
async function createProductCampaign(ctx, productId, name = '附件活动') {
  const campaign = await ctx.request('POST', '/api/v1/campaigns', { body: { name, productId } });
  assert.equal(campaign.status, 200, campaign.text);
  return campaign.body.data;
}

function pdfFile(index, overrides = {}) {
  return {
    productFileId: `prf_pdf_${index}`,
    filename: `catalogue-${index}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1000 + index,
    publicUrl: `/api/v1/public/product-files/token-${index}`,
    ...overrides,
  };
}

test('drafts: generation persists validated agent output and requires approval', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);

  setAgentImplementation('generateOutreachDraft', async () => ({
    subject: 'Battery pack brackets for Test Autoteile',
    bodyText: `${DRAFT_BODY} Could we send you our catalogue?`,
    language: 'de',
    quality: { score: 88, issues: [] },
    guard: { unsubscribeLink: true, claimsVerified: true },
  }));

  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  assert.equal(generated.body.data.draft.status, 'pending_approval');
  assert.equal(generated.body.data.draft.language, 'de');
  assert.equal(generated.body.data.draft.subject, 'Battery pack brackets for Test Autoteile');
  assert.equal(generated.body.data.draft.quality.score, 88);
  assert.equal(generated.body.data.draft.guard.unsubscribeLink, true);

  const detail = await ctx.request('GET', `/api/v1/drafts/${draft.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.data.draft);
  assert.deepEqual(detail.body.data.quality, { score: 88, issues: [] });
  assert.deepEqual(detail.body.data.guard, { unsubscribeLink: true, claimsVerified: true });
  assert.equal(detail.body.data.company.id, company.id);
  assert.equal(detail.body.data.contact.id, contact.id);

  // Unapproved drafts cannot be sent/queued.
  const unapproved = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(unapproved.status, 409);
  assert.equal(unapproved.body.error.details.code, 'DRAFT_NOT_APPROVED');

  const approved = await ctx.request('POST', `/api/v1/drafts/${draft.id}/approve`, { body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.data.status, 'approved');
  assert.equal(approved.body.data.approvedBy, ctx.owner.userId);

  const sent = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.data.draft.status, 'scheduled');
  assert.equal(typeof sent.body.data.queued, 'boolean');
  assert.ok(sent.body.data.draft.scheduledAt);

  const secondSend = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(secondSend.status, 409);
  assert.equal(secondSend.body.error.details.code, 'DRAFT_ALREADY_QUEUED');
});

test('drafts: reject, batch approve and pending approvals list', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const first = await createDraft(ctx, company, contact);
  const second = await createDraft(ctx, company, contact, { subject: 'Second' });
  const third = await createDraft(ctx, company, contact, { subject: 'Third' });

  const rejected = await ctx.request('POST', `/api/v1/drafts/${first.id}/reject`, { body: { reason: '语气太生硬' } });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.body.data.status, 'rejected');
  assert.equal(rejected.body.data.rejectionReason, '语气太生硬');

  const batch = await ctx.request('POST', '/api/v1/drafts/batch-approve', { body: { ids: [second.id, third.id, 'drf_missing'] } });
  assert.equal(batch.status, 200, batch.text);
  assert.equal(batch.body.data.approved.length, 2);
  assert.equal(batch.body.data.failed.length, 1);
  assert.equal(batch.body.data.failed[0].draftId, 'drf_missing');

  const pending = await ctx.request('GET', '/api/v1/approvals/pending');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.count, 0);
  assert.equal(pending.body.data.items.length, 0);
});

test('drafts: human takeover blocks campaign drafts but approval is still audited', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  await ctx.request('POST', `/api/v1/drafts/${draft.id}/approve`, { body: {} });
  await ctx.request('POST', `/api/v1/automation/${company.id}/takeover`, { body: { reason: '人工接管' } });

  const blocked = await ctx.request('POST', `/api/v1/drafts/${draft.id}/send`, { body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.code, 'AUTOMATION_BLOCKED');
  assert.equal(blocked.body.error.details.state, 'HUMAN_TAKEOVER');
});

test('drafts: real agent layer (simulation) generates a valid draft end-to-end', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  let agentsAvailable = true;
  try {
    await import('../../server/agents/index.mjs');
  } catch {
    agentsAvailable = false;
  }
  if (!agentsAvailable) {
    t.skip('agents layer not implemented yet');
    return;
  }
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  resetAgentImplementations();
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  const result = generated.body.data.draft;
  assert.ok(result.subject.length > 0);
  assert.ok(result.bodyText.length >= 20, 'generated body must be validated as non-empty');
  assert.equal(result.status, 'pending_approval');
  assert.ok(result.quality && typeof result.quality === 'object');
  assert.ok(result.guard && typeof result.guard === 'object');
  assert.ok(result.generatedBy, 'generated_by should reference the agent execution for traceability');
});

test('drafts: AI layer unavailable yields a clear 503 instead of crashing', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  let agentsAvailable = true;
  try {
    await import('../../server/agents/index.mjs');
  } catch {
    agentsAvailable = false;
  }
  if (agentsAvailable) {
    t.skip('agents layer already implemented; AGENT_UNAVAILABLE fallback not exercised');
    return;
  }
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  resetAgentImplementations();
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 503);
  assert.equal(generated.body.error.code, 'AGENT_UNAVAILABLE');
});

test('drafts: generation attaches up to 3 product PDFs and exposes them', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    resetProductFilesLoaderForTests();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const product = seedProduct({ workspaceId });
  const campaign = await createProductCampaign(ctx, product.id);
  const draft = await createDraft(ctx, company, contact, { campaignId: campaign.id });

  const loaderCalls = [];
  setProductFilesLoaderForTests((wsId, productId) => {
    loaderCalls.push({ wsId, productId });
    return [
      pdfFile(1),
      pdfFile(2),
      { productFileId: 'prf_img', filename: 'product.png', mimeType: 'image/png', sizeBytes: 999, publicUrl: '/api/v1/public/product-files/img' },
      pdfFile(3),
      pdfFile(4),
      { productFileId: 'prf_broken', filename: 'no-url.pdf', mimeType: 'application/pdf', sizeBytes: 10, publicUrl: '' },
    ];
  });
  const agentCalls = [];
  setAgentImplementation('generateOutreachDraft', async (args) => {
    agentCalls.push(args);
    return {
      subject: 'Battery brackets with catalogue',
      bodyText: 'Dear Anna, please find our catalogue links in this email. Best regards.',
      language: 'en',
      claims: [{ text: 'catalogue', source: 'product_files' }],
      riskNotes: [],
    };
  });

  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  const attachments = generated.body.data.draft.attachments;
  assert.equal(attachments.length, MAX_DRAFT_ATTACHMENTS);
  assert.deepEqual(
    attachments.map((item) => item.filename),
    ['catalogue-1.pdf', 'catalogue-2.pdf', 'catalogue-3.pdf'],
  );
  for (const attachment of attachments) {
    assert.deepEqual(Object.keys(attachment).sort(), ['filename', 'mimeType', 'productFileId', 'publicUrl', 'sizeBytes']);
    assert.equal(attachment.mimeType, 'application/pdf');
    assert.ok(Number(attachment.sizeBytes) > 0);
    assert.ok(attachment.publicUrl.startsWith('/api/v1/public/product-files/'));
  }

  // The writer context must receive absolute public links (relative URLs are
  // not clickable inside emails), while stored attachments keep the relative form.
  assert.equal(agentCalls.length, 1);
  assert.deepEqual(agentCalls[0].context.productFiles, [
    { filename: 'catalogue-1.pdf', publicUrl: 'http://127.0.0.1:4173/api/v1/public/product-files/token-1' },
    { filename: 'catalogue-2.pdf', publicUrl: 'http://127.0.0.1:4173/api/v1/public/product-files/token-2' },
    { filename: 'catalogue-3.pdf', publicUrl: 'http://127.0.0.1:4173/api/v1/public/product-files/token-3' },
  ]);
  assert.deepEqual(loaderCalls[0], { wsId: workspaceId, productId: product.id });

  // Detail and list must expose the parsed attachments array.
  const detail = await ctx.request('GET', `/api/v1/drafts/${draft.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.attachments.length, 3);
  assert.equal(detail.body.data.draft.attachments.length, 3);
  const list = await ctx.request('GET', '/api/v1/drafts');
  const row = list.body.data.items.find((item) => item.id === draft.id);
  assert.equal(row.attachments.length, 3);

  const stored = get('SELECT attachments_json FROM message_drafts WHERE workspace_id = ? AND id = ?', [workspaceId, draft.id]);
  const parsed = JSON.parse(stored.attachments_json);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].productFileId, 'prf_pdf_1');
});

test('drafts: generation without product PDFs writes an empty attachments array', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    resetProductFilesLoaderForTests();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const product = seedProduct({ workspaceId });
  const campaign = await createProductCampaign(ctx, product.id);
  const draft = await createDraft(ctx, company, contact, { campaignId: campaign.id });

  setProductFilesLoaderForTests(() => [
    { productFileId: 'prf_img', filename: 'product.png', mimeType: 'image/png', sizeBytes: 500, publicUrl: '/api/v1/public/product-files/img' },
  ]);
  const agentCalls = [];
  setAgentImplementation('generateOutreachDraft', async (args) => {
    agentCalls.push(args);
    return { subject: 'No attachments', bodyText: 'Plain outreach body without product documents.', language: 'en' };
  });

  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  assert.deepEqual(generated.body.data.draft.attachments, []);
  assert.deepEqual(agentCalls[0].context.productFiles, []);
  const stored = get('SELECT attachments_json FROM message_drafts WHERE workspace_id = ? AND id = ?', [workspaceId, draft.id]);
  assert.deepEqual(JSON.parse(stored.attachments_json), []);
  const detail = await ctx.request('GET', `/api/v1/drafts/${draft.id}`);
  assert.deepEqual(detail.body.data.attachments, []);
});

test('drafts: product-files module not ready degrades to no attachments', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    resetProductFilesLoaderForTests();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const product = seedProduct({ workspaceId });
  const campaign = await createProductCampaign(ctx, product.id);
  const draft = await createDraft(ctx, company, contact, { campaignId: campaign.id });

  // No loader override: the real dynamic import of services/product-files.mjs
  // may fail while t-data is still working; generation must still succeed.
  resetProductFilesLoaderForTests();
  setAgentImplementation('generateOutreachDraft', async () => ({ subject: 'Degraded', bodyText: 'Body still generated without media.', language: 'en' }));
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  assert.deepEqual(generated.body.data.draft.attachments, []);
});

test('drafts: failed generation does not write dirty attachments', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    resetProductFilesLoaderForTests();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const product = seedProduct({ workspaceId });
  const campaign = await createProductCampaign(ctx, product.id);
  const draft = await createDraft(ctx, company, contact, { campaignId: campaign.id });

  setProductFilesLoaderForTests(() => [pdfFile(1)]);
  setAgentImplementation('generateOutreachDraft', async () => {
    throw new Error('model exploded');
  });
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 502);
  assert.equal(generated.body.error.code, 'AGENT_FAILED');
  const stored = get('SELECT attachments_json, status, subject FROM message_drafts WHERE workspace_id = ? AND id = ?', [workspaceId, draft.id]);
  assert.deepEqual(JSON.parse(stored.attachments_json), []);
  assert.equal(stored.status, 'draft');
  assert.equal(stored.subject, 'Partnership');
});

test('drafts: real product-files module picks up stored PDFs (if t-data delivered)', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    resetProductFilesLoaderForTests();
    await ctx.close();
  });
  let productFilesModule = null;
  try {
    productFilesModule = await import('../../server/services/product-files.mjs');
  } catch {
    productFilesModule = null;
  }
  if (typeof productFilesModule?.listProductFilesForEmail !== 'function') {
    t.skip('product-files service not delivered yet; injection path covered by the other tests');
    return;
  }
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const product = seedProduct({ workspaceId });
  const campaign = await createProductCampaign(ctx, product.id);
  const draft = await createDraft(ctx, company, contact, { campaignId: campaign.id });

  const fileId = `prf_${Date.now()}`;
  const relativePath = `products/${workspaceId}/${product.id}/${fileId}.pdf`;
  const absolutePath = path.join(ctx.config.uploadsDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, Buffer.from('%PDF-1.4 test catalogue'));
  run(
    `INSERT INTO product_files (id, workspace_id, product_id, filename, mime_type, size_bytes, storage_path, kind, created_at)
     VALUES (?, ?, ?, 'catalogue.pdf', 'application/pdf', 20, ?, 'document', ?)`,
    [fileId, workspaceId, product.id, relativePath, new Date().toISOString()],
  );

  resetProductFilesLoaderForTests();
  setAgentImplementation('generateOutreachDraft', async () => ({ subject: 'With real catalogue', bodyText: 'Body generated with the real product file module.', language: 'en' }));
  const generated = await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} });
  assert.equal(generated.status, 200, generated.text);
  const attachments = generated.body.data.draft.attachments;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].productFileId, fileId);
  assert.equal(attachments[0].filename, 'catalogue.pdf');
  assert.equal(attachments[0].mimeType, 'application/pdf');
  assert.ok(attachments[0].publicUrl.includes('/api/v1/public/product-files/'));
});

test('drafts: tenant isolation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const draft = await createDraft(ctx, company, contact);
  const other = ctx.createWorkspace({ name: '隔离空间' });

  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/drafts/${draft.id}`)).status, 404);
  assert.equal((await ctx.request('POST', `/api/v1/drafts/${draft.id}/approve`, { body: {} })).status, 404);
  assert.equal((await ctx.request('POST', `/api/v1/drafts/${draft.id}/generate`, { body: {} })).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/drafts')).body.data.items.length, 0);
});
