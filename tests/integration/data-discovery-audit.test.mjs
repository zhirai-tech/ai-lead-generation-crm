import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { run } from '../../server/core/db.mjs';
import { insertCandidate, updateCandidate } from '../../server/repositories/discovery-candidates.mjs';
import { runBrowserSearchAdapter } from '../../server/services/discovery.mjs';
import { finalizeDiscoveryQualification } from '../../server/services/discovery.mjs';
import { enqueueJob, claimNextJob } from '../../server/jobs/queue.mjs';
import { processJob } from '../../server/jobs/worker.mjs';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
  await new Promise((resolve) => setTimeout(resolve, 80));
});

async function createRun() {
  const response = await ctx.request('POST', '/api/v1/discovery/runs', {
    body: { provider: 'simulation', keywords: ['brake'], countries: ['DE'], limit: 2 },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

async function createQualifiedCompany(name, domain) {
  const response = await ctx.request('POST', '/api/v1/companies', {
    body: {
      name,
      domain,
      country: 'DE',
      tags: ['qualification:qualified', 'qualification_reason:verified_direct_buyer'],
    },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

test('candidate audit rows are persisted and queryable with reason codes', async () => {
  const discoveryRun = await createRun();
  insertCandidate({
    id: 'dsc_audit_1',
    workspaceId: ctx.owner.workspaceId,
    runId: discoveryRun.id,
    query: 'Autoteile Germany distributor',
    rawUrl: 'https://example-parts.de/',
    normalizedUrl: 'https://example-parts.de/',
    title: 'Example Parts',
    stage: 'assessment',
    outcome: 'insufficient_evidence',
    reasonCode: 'official_business_page_missing',
    identityKeys: ['domain:example-parts.de', 'brand:example-parts'],
    evidenceUrls: ['https://example-parts.de/ueber-uns'],
    qualification: 'insufficient_evidence',
    qualificationReason: 'official_business_page_missing',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const response = await ctx.request('GET', `/api/v1/discovery/runs/${discoveryRun.id}/candidates`);
  assert.equal(response.status, 200, response.text);
  const item = response.body.data.items.find((candidate) => candidate.id === 'dsc_audit_1');
  assert.ok(item);
  assert.equal(item.reasonCode, 'official_business_page_missing');
  assert.equal(item.qualification, 'insufficient_evidence');
  assert.deepEqual(item.evidenceUrls, ['https://example-parts.de/ueber-uns']);
});

test('finalizer is idempotent and writes final qualification counts', async () => {
  const discoveryRun = await createRun();
  const company = await createQualifiedCompany('Finalizer Qualified GmbH', 'finalizer-qualified.example');
  insertCandidate({
    id: 'dsc_final_1',
    workspaceId: ctx.owner.workspaceId,
    runId: discoveryRun.id,
    rawUrl: 'https://finalizer-qualified.example/',
    normalizedUrl: 'https://finalizer-qualified.example/',
    title: 'Finalizer Qualified GmbH',
    stage: 'saved',
    outcome: 'qualified',
    reasonCode: 'verified_direct_buyer',
    qualification: 'qualified',
    qualificationReason: 'verified_direct_buyer',
    savedCompanyId: company.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const first = finalizeDiscoveryQualification(ctx.owner.workspaceId, discoveryRun.id);
  assert.equal(first.qualificationStatus, 'finalized');
  assert.equal(first.qualifiedCount, 1);
  const second = finalizeDiscoveryQualification(ctx.owner.workspaceId, discoveryRun.id);
  assert.equal(second.qualifiedCount, 1);
});

test('finalizer remains pending while linked async jobs are queued', async () => {
  const discoveryRun = await createRun();
  const company = await createQualifiedCompany('Pending Qualified GmbH', 'pending-qualified.example');
  insertCandidate({
    id: 'dsc_pending_1', workspaceId: ctx.owner.workspaceId, runId: discoveryRun.id,
    rawUrl: 'https://pending-qualified.example/', title: 'Pending Qualified GmbH',
    stage: 'saved', outcome: 'qualified', qualification: 'qualified',
    savedCompanyId: company.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const job = enqueueJob({
    workspaceId: ctx.owner.workspaceId,
    type: 'lead.score',
    payload: { companyId: company.id, productId: null, discoveryRunId: discoveryRun.id },
    dedupeKey: `test:${discoveryRun.id}`,
    maxAttempts: 1,
  });
  const pending = finalizeDiscoveryQualification(ctx.owner.workspaceId, discoveryRun.id);
  assert.equal(pending.qualificationStatus, 'pending');

  run("UPDATE background_jobs SET status = 'succeeded', updated_at = ? WHERE id = ?", ['2026-01-01T00:00:01.000Z', job.id]);
  const finalized = finalizeDiscoveryQualification(ctx.owner.workspaceId, discoveryRun.id);
  assert.equal(finalized.qualificationStatus, 'finalized');
  assert.equal(finalized.qualifiedCount, 1);
});

test('finalizer records failed async qualification instead of success', async () => {
  const discoveryRun = await createRun();
  const company = await createQualifiedCompany('Failed Qualified GmbH', 'failed-qualified.example');
  insertCandidate({
    id: 'dsc_failed_1', workspaceId: ctx.owner.workspaceId, runId: discoveryRun.id,
    rawUrl: 'https://failed-qualified.example/', title: 'Failed Qualified GmbH',
    stage: 'saved', outcome: 'qualified', qualification: 'qualified',
    savedCompanyId: company.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const job = enqueueJob({
    workspaceId: ctx.owner.workspaceId,
    type: 'lead.score',
    payload: { companyId: company.id, productId: null, discoveryRunId: discoveryRun.id },
    dedupeKey: `test-failed:${discoveryRun.id}`,
    maxAttempts: 1,
  });
  run("UPDATE background_jobs SET status = 'dead', updated_at = ? WHERE id = ?", ['2026-01-01T00:00:01.000Z', job.id]);
  const failed = finalizeDiscoveryQualification(ctx.owner.workspaceId, discoveryRun.id);
  assert.equal(failed.qualificationStatus, 'failed');
  assert.ok(failed.error);
});

test('browser adapter writes candidate audit through the repository callback', async () => {
  const discoveryRun = await createRun();
  const seen = new Set();
  const record = (data) => {
    if (!data.id) return;
    if (seen.has(data.id)) {
      updateCandidate(ctx.owner.workspaceId, data.id, {
        stage: data.stage,
        outcome: data.outcome,
        reason_code: data.reasonCode || null,
        identity_keys_json: JSON.stringify(data.identityKeys || []),
        evidence_urls_json: JSON.stringify(data.evidenceUrls || []),
        qualification: data.qualification || null,
        qualification_reason: data.qualificationReason || null,
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      return;
    }
    seen.add(data.id);
    insertCandidate({
      id: data.id,
      workspaceId: ctx.owner.workspaceId,
      runId: discoveryRun.id,
      query: data.query,
      rawUrl: data.rawUrl,
      normalizedUrl: data.normalizedUrl,
      title: data.title,
      stage: data.stage,
      outcome: data.outcome,
      reasonCode: data.reasonCode,
      identityKeys: data.identityKeys || [],
      evidenceUrls: data.evidenceUrls || [],
      qualification: data.qualification || null,
      qualificationReason: data.qualificationReason || null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  };
  const result = await runBrowserSearchAdapter({
    run: { query: { keywords: ['Autoteile'], countries: ['DE'] } },
    maxCompanies: 1,
    searchImpl: async () => ({
      results: [
        { url: 'https://www.wlw.de/', title: 'WLW B2B Marktplatz' },
        { url: 'https://audit-qualified.example/', title: 'Audit Qualified Autoteile Großhandel' },
      ],
    }),
    assessCandidate: async () => ({
      qualification: 'qualified', reason: 'verified_direct_buyer',
      evidenceSources: [{ sourceUrl: 'https://audit-qualified.example/ueber-uns', payload: { title: 'Audit Qualified' } }],
      companyDescription: 'Autoteile Großhandel für Händler',
    }),
    recordCandidate: record,
  });
  assert.equal(result.searchStats.qualified, 1);
  const response = await ctx.request('GET', `/api/v1/discovery/runs/${discoveryRun.id}/candidates`);
  assert.equal(response.status, 200, response.text);
  assert.ok(response.body.data.items.length >= 2);
  assert.ok(response.body.data.items.some((item) => item.reasonCode === 'blocked_domain'));
  assert.ok(response.body.data.items.some((item) => item.outcome === 'qualified'));
});

test('worker completion hook invokes the finalizer for a run-linked score job', async () => {
  const discoveryRun = await createRun();
  run('DELETE FROM background_jobs WHERE workspace_id = ?', [ctx.owner.workspaceId]);
  const companyResponse = await ctx.request('POST', '/api/v1/companies', {
    body: { name: 'Worker Finalizer GmbH', domain: 'worker-finalizer.example', country: 'DE', tags: ['qualification:qualified'] },
  });
  assert.equal(companyResponse.status, 200, companyResponse.text);
  const company = companyResponse.body.data;
  const productResponse = await ctx.request('POST', '/api/v1/products', {
    body: { name: 'Worker Brake Pad', status: 'active' },
  });
  assert.equal(productResponse.status, 200, productResponse.text);
  insertCandidate({
    id: 'dsc_worker_1', workspaceId: ctx.owner.workspaceId, runId: discoveryRun.id,
    rawUrl: 'https://worker-finalizer.example/', title: 'Worker Finalizer GmbH',
    stage: 'saved', outcome: 'qualified', qualification: 'qualified',
    savedCompanyId: company.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  enqueueJob({
    workspaceId: ctx.owner.workspaceId,
    type: 'lead.score',
    payload: { companyId: company.id, productId: productResponse.body.data.id, discoveryRunId: discoveryRun.id },
    dedupeKey: `test-worker:${discoveryRun.id}`,
    maxAttempts: 1,
  });
  const job = claimNextJob('test-worker', { workspaceId: ctx.owner.workspaceId });
  assert.ok(job);
  const processed = await processJob(job);
  assert.equal(processed.status, 'succeeded');
  const detail = await ctx.request('GET', `/api/v1/discovery/runs/${discoveryRun.id}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.data.qualificationStatus, 'finalized');
});
