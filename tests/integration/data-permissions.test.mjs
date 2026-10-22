import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';

let ctx;
let companyId;
let productId;

before(async () => {
  ctx = await createTestContext();
  const company = await ctx.request('POST', '/api/v1/companies', {
    body: { name: 'Permission Target GmbH', domain: 'permission-target.example', country: 'DE' },
  });
  assert.equal(company.status, 200, company.text);
  companyId = company.body.data.id;
  const product = await ctx.request('POST', '/api/v1/products', { body: { name: 'Permission Product' } });
  assert.equal(product.status, 200, product.text);
  productId = product.body.data.id;
});

after(async () => {
  await ctx.close();
});

test('anonymous requests are rejected with 401', async () => {
  const list = await ctx.request('GET', '/api/v1/companies', { anonymous: true });
  assert.equal(list.status, 401);
  const create = await ctx.request('POST', '/api/v1/companies', { body: { name: 'Anon' }, anonymous: true, csrf: false });
  assert.equal(create.status, 401);
});

test('viewer can read but cannot write any data-domain resource', async () => {
  const viewer = ctx.createMember({ email: 'viewer@test.local', role: 'viewer' });
  const originalAuth = ctx.auth;
  ctx.as(viewer);

  const reads = await Promise.all([
    ctx.request('GET', '/api/v1/companies'),
    ctx.request('GET', '/api/v1/contacts'),
    ctx.request('GET', '/api/v1/products'),
    ctx.request('GET', '/api/v1/icps'),
    ctx.request('GET', '/api/v1/discovery/runs'),
    ctx.request('GET', '/api/v1/imports'),
  ]);
  for (const response of reads) assert.equal(response.status, 200, response.text);

  const writes = await Promise.all([
    ctx.request('POST', '/api/v1/companies', { body: { name: 'Viewer Company' } }),
    ctx.request('PATCH', `/api/v1/companies/${companyId}`, { body: { city: 'Paris' } }),
    ctx.request('DELETE', `/api/v1/companies/${companyId}`),
    ctx.request('POST', `/api/v1/companies/${companyId}/score`, { body: { productId } }),
    ctx.request('POST', '/api/v1/contacts', { body: { companyId, fullName: 'Viewer Contact' } }),
    ctx.request('POST', '/api/v1/products', { body: { name: 'Viewer Product' } }),
    ctx.request('POST', '/api/v1/icps', { body: { name: 'Viewer ICP' } }),
    ctx.request('POST', '/api/v1/discovery/runs', { body: { provider: 'simulation' } }),
    ctx.request('POST', '/api/v1/imports', { body: { kind: 'companies', text: 'name\nX\n' } }),
    ctx.request('GET', '/api/v1/export/companies'),
  ]);
  for (const response of writes) assert.equal(response.status, 403, `expected 403, got ${response.status}: ${response.text}`);

  ctx.auth = originalAuth;
});

test('member can write but cannot delete or export-restricted actions', async () => {
  const member = ctx.createMember({ email: 'member-data@test.local', role: 'member' });
  const originalAuth = ctx.auth;
  ctx.as(member);

  const created = await ctx.request('POST', '/api/v1/companies', { body: { name: 'Member Company GmbH', domain: 'member-company.example' } });
  assert.equal(created.status, 200, created.text);

  const patched = await ctx.request('PATCH', `/api/v1/companies/${created.body.data.id}`, { body: { city: 'Hamburg' } });
  assert.equal(patched.status, 200, patched.text);

  const deletion = await ctx.request('DELETE', `/api/v1/companies/${created.body.data.id}`);
  assert.equal(deletion.status, 403);
  assert.equal(deletion.body.error.code, 'FORBIDDEN');

  const imported = await ctx.request('POST', '/api/v1/imports', {
    body: { kind: 'companies', text: 'name,domain\nMember Import GmbH,member-import.example\n' },
  });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.data.createdCount, 1);

  const exported = await ctx.request('GET', '/api/v1/export/companies');
  assert.equal(exported.status, 200, exported.text);

  const discovery = await ctx.request('POST', '/api/v1/discovery/runs', { body: { provider: 'simulation', limit: 2 } });
  assert.equal(discovery.status, 200, discovery.text);

  ctx.auth = originalAuth;
});

test('admin can delete a company', async () => {
  const admin = ctx.createMember({ email: 'admin-data@test.local', role: 'admin' });
  const originalAuth = ctx.auth;
  const company = await ctx.request('POST', '/api/v1/companies', { body: { name: 'Admin Delete GmbH', domain: 'admin-delete.example' } });
  assert.equal(company.status, 200, company.text);
  ctx.as(admin);
  const deleted = await ctx.request('DELETE', `/api/v1/companies/${company.body.data.id}`);
  assert.equal(deleted.status, 200, deleted.text);
  ctx.auth = originalAuth;
});

test('viewer cannot verify emails or enrich companies', async () => {
  const contact = await ctx.request('POST', '/api/v1/contacts', {
    body: { companyId, fullName: 'Verify Guard', email: 'verify.guard@permission-target.example' },
  });
  assert.equal(contact.status, 200, contact.text);
  const viewer = ctx.createMember({ email: 'viewer2@test.local', role: 'viewer' });
  const originalAuth = ctx.auth;
  ctx.as(viewer);
  assert.equal((await ctx.request('POST', `/api/v1/contacts/${contact.body.data.id}/verify`, { body: {} })).status, 403);
  assert.equal((await ctx.request('POST', `/api/v1/contacts/infer-email`, { body: { companyId, firstName: 'A', lastName: 'B' } })).status, 403);
  assert.equal((await ctx.request('POST', `/api/v1/companies/${companyId}/enrich`, { body: {} })).status, 403);
  assert.equal((await ctx.request('POST', `/api/v1/companies/${companyId}/crawl`, { body: {} })).status, 403);
  ctx.auth = originalAuth;
});
