import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { get } from '../../server/core/db.mjs';
import { setMxResolverForTests, resetMxResolverForTests } from '../../server/services/verification.mjs';

let ctx;
let companyId;

before(async () => {
  ctx = await createTestContext();
  const company = await ctx.request('POST', '/api/v1/companies', {
    body: { name: 'Contact Test GmbH', domain: 'contact-test.example', country: 'DE' },
  });
  assert.equal(company.status, 200, company.text);
  companyId = company.body.data.id;
});

after(async () => {
  resetMxResolverForTests();
  await ctx.close();
});

async function createContact(body) {
  const response = await ctx.request('POST', '/api/v1/contacts', { body: { companyId, ...body } });
  return response;
}

test('contact CRUD with unique email and primary handling', async () => {
  const created = await createContact({
    firstName: 'Anna',
    lastName: 'Schmidt',
    title: 'Purchasing Manager',
    roleCategory: 'decision_maker',
    email: 'Anna.Schmidt@Contact-Test.example',
    isPrimary: true,
    confidence: 'medium',
  });
  assert.equal(created.status, 200, created.text);
  const contact = created.body.data;
  assert.equal(contact.fullName, 'Anna Schmidt');
  assert.equal(contact.emailNormalized, 'anna.schmidt@contact-test.example');
  assert.equal(contact.emailType, 'business');
  assert.equal(contact.emailStatus, 'unverified');
  assert.equal(contact.isPrimary, true);
  assert.equal(contact.companyId, companyId);

  const duplicate = await createContact({ fullName: 'Other Person', email: 'anna.schmidt@contact-test.example' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'CONFLICT');

  const second = await createContact({ firstName: 'Ben', lastName: 'Weber', email: 'ben.weber@contact-test.example', isPrimary: true });
  assert.equal(second.status, 200, second.text);
  const firstRow = get('SELECT is_primary FROM contacts WHERE id = ?', [contact.id]);
  assert.equal(firstRow.is_primary, 0, 'only one primary contact per company');

  const list = await ctx.request('GET', `/api/v1/contacts?companyId=${companyId}`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data.total, 2);
  assert.ok(list.body.data.items[0].companyName === 'Contact Test GmbH');

  const detail = await ctx.request('GET', `/api/v1/contacts/${contact.id}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.data.contact.id, contact.id);
  assert.equal(detail.body.data.company.id, companyId);
  assert.ok(Array.isArray(detail.body.data.sources));
  assert.ok(Array.isArray(detail.body.data.verifications));

  const patched = await ctx.request('PATCH', `/api/v1/contacts/${contact.id}`, {
    body: { title: 'Head of Procurement', department: 'Purchasing' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.data.title, 'Head of Procurement');
  assert.equal(patched.body.data.department, 'Purchasing');

  const sources = await ctx.request('GET', `/api/v1/contacts/${contact.id}/sources`);
  assert.equal(sources.status, 200, sources.text);
  assert.equal(sources.body.data.items.length, 1);
  assert.equal(sources.body.data.items[0].method, 'manual');

  const removed = await ctx.request('DELETE', `/api/v1/contacts/${contact.id}`);
  assert.equal(removed.status, 200, removed.text);
  const gone = await ctx.request('GET', `/api/v1/contacts/${contact.id}`);
  assert.equal(gone.status, 404);
});

test('email format and role validation errors are surfaced as 422', async () => {
  const badEmail = await createContact({ fullName: 'Bad Email', email: 'not-an-email' });
  assert.equal(badEmail.status, 422);
  const badRole = await createContact({ fullName: 'Bad Role', roleCategory: 'ceo' });
  assert.equal(badRole.status, 422);
});

test('inferred emails are always stored with email_status inferred and cannot become valid', async () => {
  const inferred = await createContact({
    fullName: 'Clara Hoffmann',
    email: 'clara.hoffmann@contact-test.example',
    emailType: 'inferred',
    emailStatus: 'valid',
  });
  assert.equal(inferred.status, 200, inferred.text);
  assert.equal(inferred.body.data.emailType, 'inferred');
  assert.equal(inferred.body.data.emailStatus, 'inferred');

  const promoteToValid = await ctx.request('PATCH', `/api/v1/contacts/${inferred.body.data.id}`, {
    body: { emailStatus: 'valid' },
  });
  assert.equal(promoteToValid.status, 422, 'inferred email must not be promoted to valid');

  const explicitGuard = await ctx.request('PATCH', `/api/v1/contacts/${inferred.body.data.id}`, {
    body: { emailType: 'inferred', emailStatus: 'valid' },
  });
  assert.equal(explicitGuard.status, 422);

  const dbRow = get('SELECT email_status, email_type FROM contacts WHERE id = ?', [inferred.body.data.id]);
  assert.equal(dbRow.email_status, 'inferred');
  assert.equal(dbRow.email_type, 'inferred');
});

test('POST /contacts/:id/verify updates status and writes verification rows', async () => {
  const created = await createContact({
    fullName: 'Dora Valid',
    email: 'dora.valid@contact-test.example',
    roleCategory: 'decision_maker',
  });
  setMxResolverForTests(async () => [{ exchange: 'mx.contact-test.example', priority: 10 }]);
  const verified = await ctx.request('POST', `/api/v1/contacts/${created.body.data.id}/verify`, { body: {} });
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.body.data.emailStatus, 'valid');
  assert.equal(verified.body.data.mx, 'passed');
  const detail = await ctx.request('GET', `/api/v1/contacts/${created.body.data.id}`);
  assert.equal(detail.body.data.contact.emailStatus, 'valid');
  assert.ok(detail.body.data.contact.lastVerifiedAt);
  assert.ok(detail.body.data.verifications.length >= 4);
  for (const verification of detail.body.data.verifications) {
    assert.ok(['passed', 'failed', 'unknown'].includes(verification.result));
  }
  resetMxResolverForTests();
});

test('infer-email endpoint returns inferred candidates', async () => {
  const response = await ctx.request('POST', '/api/v1/contacts/infer-email', {
    body: { companyId, firstName: 'Anna', lastName: 'Schmidt' },
  });
  assert.equal(response.status, 200, response.text);
  const { candidates } = response.body.data;
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length >= 3);
  for (const candidate of candidates) {
    assert.equal(candidate.status, 'inferred');
    assert.ok(candidate.confidence > 0);
    assert.match(candidate.email, /@contact-test\.example$/);
  }
  assert.ok(Array.isArray(response.body.data.items));
});

test('infer-email requires a company and name', async () => {
  const missingCompany = await ctx.request('POST', '/api/v1/contacts/infer-email', { body: { firstName: 'Anna' } });
  assert.equal(missingCompany.status, 422);
  const missingName = await ctx.request('POST', '/api/v1/contacts/infer-email', { body: { companyId } });
  assert.equal(missingName.status, 422);
});

test('contact list filters: q, emailStatus, hasEmail, pagination', async () => {
  const filtered = await ctx.request('GET', `/api/v1/contacts?q=Clara&companyId=${companyId}`);
  assert.equal(filtered.status, 200, filtered.text);
  assert.ok(filtered.body.data.items.every((item) => item.fullName.includes('Clara') || item.email.includes('clara')));

  const inferredOnly = await ctx.request('GET', '/api/v1/contacts?emailStatus=inferred');
  assert.ok(inferredOnly.body.data.items.length >= 1);
  assert.ok(inferredOnly.body.data.items.every((item) => item.emailStatus === 'inferred'));

  const withoutEmail = await ctx.request('GET', '/api/v1/contacts?hasEmail=false');
  assert.ok(withoutEmail.body.data.items.every((item) => !item.emailNormalized));

  const paged = await ctx.request('GET', '/api/v1/contacts?pageSize=1&page=2');
  assert.equal(paged.body.data.page, 2);
  assert.equal(paged.body.data.items.length, 1);
  assert.ok(paged.body.data.total >= 2);
});

test('workspace isolation for contacts', async () => {
  const created = await createContact({ fullName: 'Isolated Contact', email: 'isolated@contact-test.example' });
  assert.equal(created.status, 200, created.text);
  const isolated = ctx.createWorkspace();
  const originalAuth = ctx.auth;
  ctx.as(isolated);
  const detail = await ctx.request('GET', `/api/v1/contacts/${created.body.data.id}`);
  assert.equal(detail.status, 404);
  const list = await ctx.request('GET', '/api/v1/contacts');
  assert.equal(list.body.data.total, 0);
  const sameEmail = await ctx.request('POST', '/api/v1/contacts', {
    body: { companyId: 'cmp_not_exists', fullName: 'X', email: 'isolated@contact-test.example' },
  });
  assert.equal(sameEmail.status, 404, 'unknown company is rejected before any email check');
  ctx.auth = originalAuth;
});
