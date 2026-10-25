import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { executeDiscoveryRun } from '../../server/services/discovery.mjs';

let ctx;
let workspaceId;

before(async () => {
  ctx = await createTestContext();
  workspaceId = ctx.owner.workspaceId;
});

after(async () => {
  await ctx.close();
});

async function createRun(body) {
  return ctx.request('POST', '/api/v1/discovery/runs', { body });
}

test('a simulation discovery run is queued, executed and materialises companies', async () => {
  const created = await createRun({
    provider: 'simulation',
    keywords: ['brake', 'filter'],
    countries: ['DE', 'FR'],
    companyTypes: ['distributor', 'wholesaler'],
    limit: 6,
  });
  assert.equal(created.status, 200, created.text);
  const run = created.body.data;
  assert.equal(run.provider, 'simulation');
  assert.equal(run.status, 'queued');
  assert.equal(run.query.limit, 6);
  assert.deepEqual(run.query.countries, ['DE', 'FR']);
  assert.equal(run.resultCount, 0);
  assert.equal(run.companiesCreated, 0);
  assert.ok(run.job, 'creation must report the enqueue attempt');

  const executed = await executeDiscoveryRun(workspaceId, run.id, { actorId: ctx.owner.userId });
  assert.equal(executed.companiesCreated, 6);
  assert.equal(executed.resultCount, 6);
  assert.equal(executed.status, 'completed');

  const detailResponse = await ctx.request('GET', `/api/v1/discovery/runs/${run.id}`);
  assert.equal(detailResponse.status, 200, detailResponse.text);
  const detail = detailResponse.body.data;
  assert.equal(detail.status, 'completed');
  assert.equal(detail.companiesCreated, 6);
  assert.equal(detail.resultCount, 6);
  assert.equal(detail.companies.length, 6);
  assert.deepEqual(detail.results, detail.companies);
  assert.ok(detail.startedAt);
  assert.ok(detail.finishedAt);

  for (const company of detail.companies) {
    assert.ok(company.tags.includes('simulation') || company.tags.includes('demo'));
    assert.match(company.domain, /\.example$/);
    assert.equal(company.confidence, 'low');
    assert.ok(['DE', 'FR'].includes(company.country));
  }

  const sources = await ctx.request('GET', `/api/v1/companies/${detail.companies[0].id}/sources`);
  assert.equal(sources.status, 200, sources.text);
  const discoverySource = sources.body.data.items.find((item) => item.sourceType === 'discovery');
  assert.ok(discoverySource, 'discovery result must record a company_sources row');
  assert.equal(discoverySource.payload.discoveryRunId, run.id);
  assert.equal(discoverySource.payload.provider, 'simulation');

  const companies = await ctx.request('GET', '/api/v1/companies?tag=simulation');
  assert.ok(companies.body.data.total >= 6);
});

test('re-running the same discovery dedupes by domain instead of creating duplicates', async () => {
  const first = await createRun({ provider: 'simulation', countries: ['SE'], limit: 4 });
  const firstExecution = await executeDiscoveryRun(workspaceId, first.body.data.id, {});
  assert.equal(firstExecution.companiesCreated, 4);

  const second = await createRun({ provider: 'simulation', countries: ['SE'], limit: 4 });
  const secondExecution = await executeDiscoveryRun(workspaceId, second.body.data.id, {});
  assert.equal(secondExecution.companiesCreated, 0);
  assert.equal(secondExecution.skippedExisting, 4);
  assert.equal(secondExecution.resultCount, 4);
});

test('csv discovery provider imports rows from CSV text', async () => {
  const csvText = [
    'name,domain,country,city,description',
    '"CSV Discovery One, GmbH",csv-discovery-one.example,DE,Hamburg,"Distributor, brake parts"',
    'CSV Discovery Two Sarl,csv-discovery-two.example,FR,Lyon,Brake importer',
  ].join('\n');
  const created = await createRun({ provider: 'csv', csvText });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.body.data.provider, 'csv');
  const executed = await executeDiscoveryRun(workspaceId, created.body.data.id, {});
  assert.equal(executed.companiesCreated, 2);

  const list = await ctx.request('GET', '/api/v1/companies?q=CSV Discovery');
  assert.equal(list.body.data.total, 2);
  const names = list.body.data.items.map((item) => item.name).sort();
  assert.deepEqual(names, ['CSV Discovery One, GmbH', 'CSV Discovery Two Sarl']);
  const withComma = list.body.data.items.find((item) => item.name.includes('One'));
  assert.match(withComma.description, /Distributor, brake parts/);
});

test('cancelled discovery runs do not create companies', async () => {
  const created = await createRun({ provider: 'simulation', limit: 3 });
  const runId = created.body.data.id;
  const cancelled = await ctx.request('POST', `/api/v1/discovery/runs/${runId}/cancel`, { body: {} });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.data.status, 'cancelled');

  const executed = await executeDiscoveryRun(workspaceId, runId, {});
  assert.equal(executed.cancelled, true);
  assert.equal(executed.companiesCreated, 0);
  const companies = await ctx.request('GET', `/api/v1/companies?q=Autoteile&pageSize=100`);
  assert.equal(companies.status, 200);
  // No company may reference the cancelled run as a source.
  const detail = await ctx.request('GET', `/api/v1/discovery/runs/${runId}`);
  assert.deepEqual(detail.body.data.companies, []);
});

test('discovery run listing, detail 404 and provider catalogue', async () => {
  const list = await ctx.request('GET', '/api/v1/discovery/runs?pageSize=2');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data.pageSize, 2);
  assert.equal(list.body.data.items.length, 2);
  assert.ok(list.body.data.total >= 4);
  for (const item of list.body.data.items) {
    assert.ok('createdAt' in item);
    assert.ok('provider' in item);
    assert.ok('status' in item);
    assert.ok('resultCount' in item);
    assert.ok('companiesCreated' in item);
  }

  const missing = await ctx.request('GET', '/api/v1/discovery/runs/dr_missing');
  assert.equal(missing.status, 404);

  const providers = await ctx.request('GET', '/api/v1/discovery/providers');
  assert.equal(providers.status, 200, providers.text);
  const keys = providers.body.data.items.map((item) => item.key);
  assert.ok(keys.includes('osm'));
  assert.ok(keys.includes('csv_import'));
  assert.ok(keys.includes('brave'));
  assert.ok(keys.includes('serper'));
  assert.ok(!keys.includes('simulation'), 'simulation provider is hidden from the live catalogue');
  const osm = providers.body.data.items.find((item) => item.key === 'osm');
  assert.equal(osm.implemented, true);
  assert.equal(osm.offline, false);
});

test('discovery honours maxResults and links created companies to the selected ICP', async () => {
  const icp = await ctx.request('POST', '/api/v1/icps', {
    body: { name: 'Discovery ICP', targetCountries: ['AT'], targetCompanyTypes: ['distributor'] },
  });
  assert.equal(icp.status, 200, icp.text);
  const created = await createRun({
    provider: 'simulation',
    countries: ['AT'],
    keywords: ['brake'],
    maxResults: 3,
    icpId: icp.body.data.id,
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.body.data.query.limit, 3);
  assert.equal(created.body.data.query.icpId, icp.body.data.id);
  const executed = await executeDiscoveryRun(workspaceId, created.body.data.id, {});
  assert.equal(executed.companiesCreated, 3);
  const detail = await ctx.request('GET', `/api/v1/discovery/runs/${created.body.data.id}`);
  for (const company of detail.body.data.companies) {
    assert.equal(company.icpId, icp.body.data.id);
  }
});

test('discovery request validation', async () => {
  const badProvider = await createRun({ provider: 'google_scraper' });
  assert.equal(badProvider.status, 400);
  const missingCsv = await createRun({ provider: 'csv' });
  assert.equal(missingCsv.status, 400);
  const disabledSearchApi = await createRun({ provider: 'search_api', keywords: ['brake'] });
  assert.equal(disabledSearchApi.status, 400);
  const invalidLimit = await createRun({ provider: 'simulation', limit: 'abc' });
  assert.equal(invalidLimit.status, 200, 'invalid limits fall back to a safe default');
  await executeDiscoveryRun(workspaceId, invalidLimit.body.data.id, {});
});
