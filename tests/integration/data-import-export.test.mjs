import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { all, get } from '../../server/core/db.mjs';
import { parseCsvRecords } from '../../server/services/imports.mjs';

let ctx;
let workspaceId;

const COMPANIES_CSV = [
  'name,domain,country,city,description',
  '"Import Alpha, GmbH",import-alpha.example,DE,Hamburg,"Distributor of brake parts, filters"',
  'Import Beta SARL,import-beta.example,FR,Lyon,Brake importer',
  'Bad Domain GmbH,not a domain!!,DE,Berlin,bad row',
  ',missing-name.example,DE,Berlin,no name',
].join('\n');

before(async () => {
  ctx = await createTestContext();
  workspaceId = ctx.owner.workspaceId;
});

after(async () => {
  await ctx.close();
});

test('company CSV import creates rows, records sources and reports row errors', async () => {
  const response = await ctx.request('POST', '/api/v1/imports', {
    body: { kind: 'companies', filename: 'companies.csv', text: COMPANIES_CSV },
  });
  assert.equal(response.status, 200, response.text);
  const run = response.body.data;
  assert.equal(run.kind, 'companies');
  assert.equal(run.filename, 'companies.csv');
  assert.equal(run.status, 'completed');
  assert.equal(run.totalRows, 4);
  assert.equal(run.createdCount, 2);
  assert.equal(run.errorCount, 2);
  assert.ok(Array.isArray(run.errors));
  assert.ok(run.errors.some((error) => /域名/.test(error.message)));
  assert.ok(run.errors.some((error) => /名称/.test(error.message)));

  const list = await ctx.request('GET', '/api/v1/companies?q=Import&pageSize=10');
  assert.equal(list.body.data.total, 2);
  const alpha = list.body.data.items.find((item) => item.name === 'Import Alpha, GmbH');
  assert.equal(alpha.country, 'DE');
  assert.match(alpha.description, /Distributor of brake parts, filters/);

  const sources = await ctx.request('GET', `/api/v1/companies/${alpha.id}/sources`);
  const importSource = sources.body.data.items.find((item) => item.sourceType === 'import');
  assert.ok(importSource);
  assert.equal(importSource.payload.filename, 'companies.csv');

  const audits = all(
    "SELECT action FROM audit_events WHERE workspace_id = ? AND action = 'import.run' ORDER BY created_at",
    [workspaceId],
  );
  assert.equal(audits.length, 1);

  // Re-import: dedupe by domain, no duplicates, no updates needed.
  const again = await ctx.request('POST', '/api/v1/imports', {
    body: { kind: 'companies', filename: 'companies.csv', text: COMPANIES_CSV },
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.data.createdCount, 0);
  assert.equal(again.body.data.skippedCount, 2);
  const after = await ctx.request('GET', '/api/v1/companies?q=Import&pageSize=10');
  assert.equal(after.body.data.total, 2);
});

test('company import accepts a UTF-8 BOM', async () => {
  const text = '\uFEFFname,domain,country\nBOM Company GmbH,bom-company.example,AT\n';
  const response = await ctx.request('POST', '/api/v1/imports', {
    body: { kind: 'companies', filename: 'bom.csv', text },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.data.createdCount, 1);
  const company = get('SELECT name, country FROM companies WHERE workspace_id = ? AND domain = ?', [workspaceId, 'bom-company.example']);
  assert.equal(company.name, 'BOM Company GmbH');
  assert.equal(company.country, 'AT');
});

test('contact CSV import links companies, dedupes emails and validates rows', async () => {
  const text = [
    'company_domain,first_name,last_name,email,title,role_category',
    'import-alpha.example,Anna,Schmidt,anna.schmidt@import-alpha.example,Purchasing Manager,decision_maker',
    'import-alpha.example,Ben,Weber,anna.schmidt@import-alpha.example,duplicate email,unknown',
    'import-beta.example,Clara,Hoffmann,not-an-email,Bad email,unknown',
    'unknown-company.example,Dora,Unknown,dora@unknown-company.example,No company,unknown',
    'import-beta.example,Erik,Larsen,erik.larsen@import-beta.example,Sales,technical',
  ].join('\n');
  const response = await ctx.request('POST', '/api/v1/imports', {
    body: { kind: 'contacts', filename: 'contacts.csv', text },
  });
  assert.equal(response.status, 200, response.text);
  const run = response.body.data;
  assert.equal(run.status, 'completed');
  assert.equal(run.createdCount, 2);
  assert.equal(run.errorCount, 3);

  const anna = get('SELECT email_status, role_category, company_id FROM contacts WHERE workspace_id = ? AND email_normalized = ?', [workspaceId, 'anna.schmidt@import-alpha.example']);
  assert.equal(anna.email_status, 'unverified');
  assert.equal(anna.role_category, 'decision_maker');
  const alpha = get('SELECT id FROM companies WHERE workspace_id = ? AND domain = ?', [workspaceId, 'import-alpha.example']);
  assert.equal(anna.company_id, alpha.id);

  const contactSources = all(
    "SELECT method FROM contact_sources WHERE workspace_id = ? AND contact_id = ?",
    [workspaceId, (get('SELECT id FROM contacts WHERE workspace_id = ? AND email_normalized = ?', [workspaceId, 'erik.larsen@import-beta.example'])).id],
  );
  assert.ok(contactSources.some((row) => row.method === 'import'));
});

test('suppression CSV import writes suppression records and dedupes', async () => {
  const text = [
    'email,domain,reason,note',
    'unsub@import-alpha.example,,unsubscribe,asked by email',
    ',blocked-import.example,manual,domain block',
    'unsub@import-alpha.example,,unsubscribe,duplicate',
    'not-an-email,,manual,bad',
  ].join('\n');
  const response = await ctx.request('POST', '/api/v1/imports', {
    body: { kind: 'suppression', filename: 'suppression.csv', text },
  });
  assert.equal(response.status, 200, response.text);
  const run = response.body.data;
  assert.equal(run.createdCount, 2);
  assert.equal(run.skippedCount, 1);
  assert.equal(run.errorCount, 1);

  const emailRecord = get('SELECT reason FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?', [workspaceId, 'email', 'unsub@import-alpha.example']);
  assert.equal(emailRecord.reason, 'unsubscribe');
  const domainRecord = get('SELECT reason FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?', [workspaceId, 'domain', 'blocked-import.example']);
  assert.equal(domainRecord.reason, 'manual');
});

test('import run listing and detail include error details', async () => {
  const list = await ctx.request('GET', '/api/v1/imports?kind=companies');
  assert.equal(list.status, 200, list.text);
  assert.ok(list.body.data.total >= 2);
  for (const item of list.body.data.items) {
    assert.equal(item.kind, 'companies');
    assert.ok('createdCount' in item);
  }
  const firstId = list.body.data.items[0].id;
  const detail = await ctx.request('GET', `/api/v1/imports/${firstId}`);
  assert.equal(detail.status, 200, detail.text);
  assert.ok(Array.isArray(detail.body.data.errors));
  const missing = await ctx.request('GET', '/api/v1/imports/imp_missing');
  assert.equal(missing.status, 404);
});

test('company CSV export returns JSON filename + content with BOM and filters', async () => {
  const response = await ctx.request('GET', '/api/v1/export/companies?format=csv&country=DE');
  assert.equal(response.status, 200, response.text);
  const payload = response.body.data;
  assert.match(payload.filename, /^companies-\d{8}-\d{6}\.csv$/);
  assert.ok(payload.content.startsWith('\uFEFF'));
  const records = parseCsvRecords(payload.content);
  assert.equal(records[0][0], '企业名称');
  assert.ok(records.length >= 2);
  for (const row of records.slice(1)) {
    assert.equal(row[3], 'DE', `export filter applies: ${row[0]}`);
  }
  const names = records.slice(1).map((row) => row[0]);
  assert.ok(names.includes('Import Alpha, GmbH'));
});

test('import validation rejects unknown kinds and empty text', async () => {
  const badKind = await ctx.request('POST', '/api/v1/imports', { body: { kind: 'invoices', text: 'a,b\n1,2\n' } });
  assert.equal(badKind.status, 422);
  const empty = await ctx.request('POST', '/api/v1/imports', { body: { kind: 'companies', text: '' } });
  assert.equal(empty.status, 422);
  const nonString = await ctx.request('POST', '/api/v1/imports', { body: { kind: 'companies', text: 42 } });
  assert.equal(nonString.status, 422);
});
