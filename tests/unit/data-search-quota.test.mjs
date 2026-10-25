import test from 'node:test';
import assert from 'node:assert/strict';
import { runSearchWithQualificationQuota } from '../../server/services/discovery.mjs';

function result(id, kind) {
  return { id, kind };
}

test('quota loop counts only qualified non-duplicate new candidates and stops at target', async () => {
  const queries = ['q1', 'q2', 'q3', 'q4'];
  const seen = new Set();
  const calls = [];
  const response = await runSearchWithQualificationQuota({
    queries,
    target: 2,
    queryBudget: 4,
    search: async (query) => {
      calls.push(query);
      if (query === 'q1') return [result('a', 'qualified'), result('b', 'duplicate')];
      return [result('c', 'rejected'), result('d', 'insufficient'), result('e', 'qualified')];
    },
    isDuplicate: (candidate) => seen.has(candidate.id) || (candidate.id === 'b' && (seen.add('b'), true)),
    assess: async (candidate) => ({ qualification: candidate.kind, reason: candidate.kind }),
  });
  assert.equal(response.stats.qualified, 2);
  assert.equal(response.stats.independentNew, 2);
  assert.equal(response.stats.preFilteredCandidates, 0);
  assert.equal(response.stats.rejected, 1);
  assert.equal(response.stats.insufficientEvidence, 1);
  assert.equal(response.stats.duplicateCandidates, 1);
  assert.equal(response.stats.stopReason, 'target_reached');
  assert.equal(response.stats.queriesUsed.length, 2);
  assert.deepEqual(response.candidates.map((candidate) => candidate.id), ['a', 'e']);
  assert.deepEqual(calls, ['q1', 'q2']);
});

test('quota loop stops at query budget without inventing qualified companies', async () => {
  const response = await runSearchWithQualificationQuota({
    queries: ['q1', 'q2', 'q3'],
    target: 10,
    queryBudget: 2,
    search: async () => [result('x', 'insufficient')],
    assess: async (candidate) => ({ qualification: candidate.kind, reason: 'not_verified' }),
  });
  assert.equal(response.stats.qualified, 0);
  assert.equal(response.stats.insufficientEvidence, 2);
  assert.equal(response.stats.stopReason, 'query_budget_exhausted');
  assert.equal(response.stats.queriesUsed.length, 2);
});

test('search errors are reported as errors, never as success', async () => {
  const response = await runSearchWithQualificationQuota({
    queries: ['q1', 'q2'],
    target: 10,
    queryBudget: 2,
    search: async () => { throw new Error('network down'); },
    assess: async () => ({ qualification: 'qualified' }),
  });
  assert.equal(response.stats.qualified, 0);
  assert.equal(response.stats.errors.length, 2);
  assert.equal(response.stats.stopReason, 'search_error');
});


import { runBrowserSearchAdapter } from '../../server/services/discovery.mjs';

function browserResult(host, title = 'Autoteile Großhandel') {
  return { url: `https://${host}/`, title };
}

test('browser adapter actually stops after target qualified independent candidates', async () => {
  let calls = 0;
  const result = await runBrowserSearchAdapter({
    run: { query: { keywords: ['Autoteile'], countries: ['DE'] } },
    maxCompanies: 2,
    searchImpl: async () => {
      calls += 1;
      return {
        results: [browserResult('alpha-parts.example', 'Alpha Autoteile Großhandel'), browserResult('beta-parts.example', 'Beta Autoteile')],
      };
    },
    assessCandidate: async (candidate) => ({ qualification: 'qualified', reason: 'verified_direct_buyer', evidenceSources: [] }),
  });
  assert.equal(calls, 1);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.searchStats.qualified, 2);
  assert.equal(result.searchStats.stopReason, 'target_reached');
});

test('browser adapter continues after duplicates and insufficient evidence, then stops at target', async () => {
  let calls = 0;
  const result = await runBrowserSearchAdapter({
    run: { query: { keywords: ['Autoteile'], countries: ['DE'] } },
    maxCompanies: 1,
    searchImpl: async () => {
      calls += 1;
      if (calls === 1) return { results: [browserResult('existing.example')] };
      if (calls === 2) return { results: [browserResult('insufficient.example')] };
      return { results: [browserResult('target.example')] };
    },
    inspectDuplicateCandidate: (candidate) => candidate.domain === 'existing.example'
      ? { duplicate: true, kind: 'history_match', matchedCompanyId: 'cmp_existing' }
      : { duplicate: false },
    assessCandidate: async (candidate) => ({
      qualification: candidate.domain === 'target.example' ? 'qualified' : 'insufficient_evidence',
      reason: candidate.domain === 'target.example' ? 'verified_direct_buyer' : 'official_business_page_missing',
      evidenceSources: [],
    }),
  });
  assert.ok(calls >= 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.searchStats.duplicateCandidates, 1);
  assert.equal(result.searchStats.insufficientEvidence, 1);
  assert.equal(result.searchStats.qualified, 1);
  assert.equal(result.searchStats.stopReason, 'target_reached');
});

test('browser adapter reports query-budget exhaustion without inventing qualified candidates', async () => {
  const result = await runBrowserSearchAdapter({
    run: { query: { keywords: ['Autoteile'], countries: ['DE'] } },
    maxCompanies: 10,
    searchImpl: async () => ({ results: [browserResult('rejected.example')] }),
    assessCandidate: async () => ({ qualification: 'rejected', reason: 'retail_only', evidenceSources: [] }),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.searchStats.qualified, 0);
  assert.equal(result.searchStats.preFilteredCandidates, 0);
  assert.equal(result.searchStats.duplicateCandidates, 3);
  assert.equal(result.searchStats.rejected, 1);
  assert.equal(result.searchStats.stopReason, 'query_budget_exhausted');
});

test('browser adapter records distinct prefilter, history and qualified audit reasons', async () => {
  const records = new Map();
  const result = await runBrowserSearchAdapter({
    run: { query: { keywords: ['Autoteile'], countries: ['DE'] } },
    maxCompanies: 1,
    searchImpl: async () => ({
      results: [
        { url: 'https://www.wlw.de/', title: 'WLW B2B Marktplatz' },
        { url: 'not-a-url', title: 'Bad URL' },
        { url: 'https://existing.example/', title: 'Existing Autoteile' },
        { url: 'https://new-qualified.example/', title: 'New Autoteile Großhandel' },
      ],
    }),
    inspectDuplicateCandidate: (candidate) => candidate.domain === 'existing.example'
      ? { duplicate: true, kind: 'history_match', matchedCompanyId: 'cmp_history' }
      : { duplicate: false },
    recordCandidate: (record) => records.set(record.id, record),
    assessCandidate: async (candidate) => ({
      qualification: candidate.domain === 'new-qualified.example' ? 'qualified' : 'insufficient_evidence',
      reason: candidate.domain === 'new-qualified.example' ? 'verified_direct_buyer' : 'official_business_page_missing',
      evidenceSources: [],
    }),
  });
  const rows = [...records.values()];
  assert.ok(rows.some((row) => ['platform_host', 'blocked_domain'].includes(row.reasonCode)));
  assert.ok(rows.some((row) => row.reasonCode === 'invalid_url'));
  assert.ok(rows.some((row) => row.reasonCode === 'history_match' && row.matchedCompanyId === 'cmp_history'));
  assert.ok(rows.some((row) => row.outcome === 'qualified'));
  assert.equal(result.searchStats.qualified, 1);
});
