import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { all, get, run } from '../../server/core/db.mjs';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

async function createCompany(body) {
  const response = await ctx.request('POST', '/api/v1/companies', { body });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

test('company create / list / detail / update / delete lifecycle', async () => {
  const company = await createCompany({
    name: 'Rheinland Autoteile GmbH',
    domain: 'rheinland-autoteile.example',
    website: 'https://rheinland-autoteile.example',
    country: 'DE',
    region: 'Baden-Württemberg',
    city: 'Stuttgart',
    companyType: 'distributor',
    industry: 'Automotive Aftermarket',
    description: 'Distributor of brake parts and filters for the European aftermarket.',
    tags: ['aftermarket', 'vip'],
  });
  assert.equal(company.name, 'Rheinland Autoteile GmbH');
  assert.equal(company.domain, 'rheinland-autoteile.example');
  assert.equal(company.status, 'new');
  assert.deepEqual(company.tags, ['aftermarket', 'vip']);
  assert.ok(company.dataQualityScore > 0);

  const list = await ctx.request('GET', '/api/v1/companies?q=rheinland');
  assert.equal(list.status, 200, list.text);
  const page = list.body.data;
  assert.equal(page.total, 1);
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 25);
  assert.equal(page.items[0].contactCount, 0);
  assert.equal(page.items[0].emailCount, 0);
  assert.equal(page.items[0].score, null);
  assert.ok('lastActivityAt' in page.items[0]);

  const detailResponse = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(detailResponse.status, 200, detailResponse.text);
  const detail = detailResponse.body.data;
  for (const key of [
    'company', 'contacts', 'sources', 'verifications', 'matches', 'scores', 'automationState', 'threads', 'drafts',
    'deals', 'activities', 'timeline', 'stats',
  ]) {
    assert.ok(key in detail, `missing aggregate key ${key}`);
  }
  assert.equal(detail.automationState, null);
  assert.deepEqual(detail.contacts, []);
  assert.deepEqual(detail.scores, []);

  const patched = await ctx.request('PATCH', `/api/v1/companies/${company.id}`, {
    body: { city: 'Hamburg', status: 'qualified', tags: ['a', 'b'], confidence: 'medium' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.data.city, 'Hamburg');
  assert.equal(patched.body.data.status, 'qualified');
  assert.equal(patched.body.data.confidence, 'medium');
  assert.deepEqual(patched.body.data.tags, ['a', 'b']);

  const audits = all(
    "SELECT action FROM audit_events WHERE workspace_id = ? AND entity_type = 'company' AND entity_id = ? ORDER BY created_at",
    [ctx.owner.workspaceId, company.id],
  ).map((row) => row.action);
  assert.ok(audits.includes('company.create'));
  assert.ok(audits.includes('company.update'));

  const deleted = await ctx.request('DELETE', `/api/v1/companies/${company.id}`);
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(deleted.body.data.deleted, true);
  const gone = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(gone.status, 404);
  const listAfter = await ctx.request('GET', '/api/v1/companies?q=rheinland');
  assert.equal(listAfter.body.data.total, 0);
});

test('duplicate domain in the same workspace is rejected with 409', async () => {
  await createCompany({ name: 'Domain One GmbH', domain: 'duplicate-domain.example' });
  const duplicate = await ctx.request('POST', '/api/v1/companies', {
    body: { name: 'Domain Two GmbH', domain: 'duplicate-domain.example' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'CONFLICT');
});

test('list supports q, country, status, tag, pagination and sort whitelist', async () => {
  await createCompany({ name: 'Alpha Filter GmbH', domain: 'alpha-filter.example', country: 'DE', tags: ['vip'], city: 'Berlin' });
  await createCompany({ name: 'Beta Brake SARL', domain: 'beta-brake.example', country: 'FR', tags: ['tier2'], city: 'Lyon' });
  await createCompany({ name: 'Gamma Ricambi Srl', domain: 'gamma-ricambi.example', country: 'IT', tags: ['vip'], city: 'Milano', status: 'qualified' });

  const byCountry = await ctx.request('GET', '/api/v1/companies?country=FR');
  assert.equal(byCountry.body.data.total, 1);
  assert.equal(byCountry.body.data.items[0].country, 'FR');

  const byStatus = await ctx.request('GET', '/api/v1/companies?status=qualified');
  assert.ok(byStatus.body.data.items.every((item) => item.status === 'qualified'));
  assert.ok(byStatus.body.data.total >= 1);

  const byTag = await ctx.request('GET', '/api/v1/companies?tag=vip');
  assert.equal(byTag.body.data.total, 2);

  const paged = await ctx.request('GET', '/api/v1/companies?page=2&pageSize=2');
  assert.equal(paged.body.data.page, 2);
  assert.equal(paged.body.data.pageSize, 2);
  assert.equal(paged.body.data.items.length, 2);
  assert.ok(paged.body.data.total >= 4);

  const sorted = await ctx.request('GET', '/api/v1/companies?sort=name&order=asc&pageSize=5');
  assert.equal(sorted.status, 200, sorted.text);
  const names = sorted.body.data.items.map((item) => item.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));

  const bogusSort = await ctx.request('GET', '/api/v1/companies?sort=malicious;DROP+TABLE&order=asc');
  assert.equal(bogusSort.status, 200);

  const invalidCountry = await ctx.request('GET', '/api/v1/companies?country=Germany');
  assert.equal(invalidCountry.status, 422);
});

test('scoring endpoint returns explainable factors and persists score + match', async () => {
  const product = await ctx.request('POST', '/api/v1/products', {
    body: {
      name: 'Brake Disc Rotor',
      category: 'Brake System',
      applications: ['brake', 'passenger car', 'aftermarket'],
      certifications: ['ECE R90'],
      moq: '200 pcs',
    },
  });
  assert.equal(product.status, 200, product.text);
  const company = await createCompany({
    name: 'Score Target Autoteile GmbH',
    domain: 'score-target.example',
    country: 'DE',
    companyType: 'distributor',
    industry: 'Automotive Aftermarket',
    description: 'Importer and distributor of brake system parts for passenger cars.',
    confidence: 'medium',
  });
  const scored = await ctx.request('POST', `/api/v1/companies/${company.id}/score`, {
    body: { productId: product.body.data.id },
  });
  assert.equal(scored.status, 200, scored.text);
  const result = scored.body.data;
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.match(result.grade, /^[ABCD]$/);
  assert.equal(result.factors.length, 7);
  assert.ok(Array.isArray(result.exclusions));
  assert.ok(result.explanation.length > 10);
  for (const factor of result.factors) {
    assert.ok(factor.key && factor.label && factor.reason);
    assert.ok(factor.weight > 0);
    assert.ok(factor.score >= 0 && factor.score <= 1);
  }

  const detail = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(detail.body.data.scores.length, 1);
  assert.equal(detail.body.data.scores[0].productId, product.body.data.id);
  assert.equal(detail.body.data.scores[0].score, result.score);
  assert.equal(detail.body.data.matches.length, 1);
  assert.equal(detail.body.data.matches[0].status, 'suggested');

  const list = await ctx.request('GET', `/api/v1/companies?productId=${product.body.data.id}&minScore=0`);
  assert.ok(list.body.data.items.some((item) => item.id === company.id));

  const feedback = await ctx.request('POST', `/api/v1/companies/${company.id}/score-feedback`, {
    body: { productId: product.body.data.id, field: 'company_type', userValue: 'distributor', reason: '已人工确认' },
  });
  assert.equal(feedback.status, 200, feedback.text);
  assert.ok(feedback.body.data.id);
  const detailAfter = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(detailAfter.body.data.scoreFeedback.length, 1);

  const sortedByScore = await ctx.request('GET', '/api/v1/companies?sort=score&order=desc&pageSize=100');
  assert.equal(sortedByScore.status, 200, sortedByScore.text);
  const scores = sortedByScore.body.data.items.map((item) => item.score).filter((value) => value !== null);
  assert.ok(scores.length >= 1, 'score sort must use the lead score sub-query');
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(sortedByScore.body.data.items[0].id, company.id);

  // Re-scoring updates the same lead_scores row instead of duplicating it.
  const rescored = await ctx.request('POST', `/api/v1/companies/${company.id}/score`, {
    body: { productId: product.body.data.id },
  });
  assert.equal(rescored.status, 200, rescored.text);
  const scoresAfter = ctx.db
    .prepare('SELECT COUNT(*) AS c FROM lead_scores WHERE workspace_id = ? AND company_id = ?')
    .get(ctx.owner.workspaceId, company.id);
  assert.equal(scoresAfter.c, 1);
});

test('bulk score / archive / assign actions', async () => {
  const product = await ctx.request('POST', '/api/v1/products', { body: { name: 'Bulk Product', category: 'Brake', applications: ['brake'] } });
  const companies = [];
  for (const suffix of ['one', 'two', 'three']) {
    companies.push(
      await createCompany({
        name: `Bulk ${suffix} Autoteile`,
        domain: `bulk-${suffix}.example`,
        country: 'DE',
        description: 'brake distributor',
      }),
    );
  }
  const ids = companies.map((company) => company.id);

  const scored = await ctx.request('POST', '/api/v1/companies/bulk', { body: { action: 'score', ids, productId: product.body.data.id } });
  assert.equal(scored.status, 200, scored.text);
  assert.equal(scored.body.data.updated, 3);
  for (const id of ids) {
    const row = get('SELECT COUNT(*) AS c FROM lead_scores WHERE workspace_id = ? AND company_id = ?', [ctx.owner.workspaceId, id]);
    assert.equal(row.c, 1);
  }

  const archived = await ctx.request('POST', '/api/v1/companies/bulk', { body: { action: 'archive', ids } });
  assert.equal(archived.status, 200, archived.text);
  for (const id of ids) {
    const row = get('SELECT status FROM companies WHERE id = ?', [id]);
    assert.equal(row.status, 'archived');
  }

  const assigned = await ctx.request('POST', '/api/v1/companies/bulk', {
    body: { action: 'assign', ids, ownerUserId: ctx.owner.userId },
  });
  assert.equal(assigned.status, 200, assigned.text);
  for (const id of ids) {
    const row = get('SELECT owner_user_id FROM companies WHERE id = ?', [id]);
    assert.equal(row.owner_user_id, ctx.owner.userId);
  }

  const invalid = await ctx.request('POST', '/api/v1/companies/bulk', { body: { action: 'explode', ids } });
  assert.equal(invalid.status, 422);
});

test('timeline endpoint returns paginated cross-module events', async () => {
  const company = await createCompany({ name: 'Timeline Handler GmbH', domain: 'timeline-handler.example', country: 'DE' });
  await ctx.request('POST', `/api/v1/companies/${company.id}/contacts`, { body: { fullName: 'Anna Timeline', email: 'anna@timeline-handler.example' } });
  const timeline = await ctx.request('GET', `/api/v1/companies/${company.id}/timeline?pageSize=10`);
  assert.equal(timeline.status, 200, timeline.text);
  assert.ok(timeline.body.data.total >= 2);
  const types = timeline.body.data.items.map((item) => item.type);
  assert.ok(types.includes('company_created'));
  assert.ok(types.includes('contact_created'));

  const filtered = await ctx.request('GET', `/api/v1/companies/${company.id}/timeline?types=company_created`);
  assert.equal(filtered.body.data.items.length, 1);
  assert.equal(filtered.body.data.items[0].type, 'company_created');
});

test('company detail aggregates cross-module threads, drafts, deals, activities and automation', async () => {
  const company = await createCompany({ name: 'Aggregate Handler GmbH', domain: 'aggregate-handler.example', country: 'DE' });
  const contactResponse = await ctx.request('POST', `/api/v1/companies/${company.id}/contacts`, {
    body: { fullName: 'Aggregate Contact', email: 'contact@aggregate-handler.example' },
  });
  assert.equal(contactResponse.status, 200, contactResponse.text);
  const contactId = contactResponse.body.data.id;
  const now = new Date().toISOString();
  const workspaceId = ctx.owner.workspaceId;
  // Simulate data owned by other modules (t-crm / t-worker) to prove the detail
  // aggregation only reads those tables.
  run(
    `INSERT INTO email_threads (id, workspace_id, company_id, contact_id, subject, last_message_at, message_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 2, 'replied', ?, ?)`,
    ['thr_aggregate', workspaceId, company.id, contactId, 'Re: brake pads', now, now, now],
  );
  run(
    `INSERT INTO email_messages (id, workspace_id, thread_id, company_id, contact_id, direction, from_address, subject, body_text, sent_at, status, created_at)
     VALUES (?, ?, 'thr_aggregate', ?, ?, 'outbound', 'me@zhirai.example', 'Brake pads', 'Hello', ?, 'sent', ?)`,
    ['msg_aggregate', workspaceId, company.id, contactId, now, now],
  );
  run(
    `INSERT INTO message_drafts (id, workspace_id, company_id, contact_id, subject, body_text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
    ['drf_aggregate', workspaceId, company.id, contactId, 'Draft subject', 'Draft body', now, now],
  );
  run(
    `INSERT INTO deals (id, workspace_id, company_id, contact_id, title, stage, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Brake pads deal', 'qualified', 'open', ?, ?)`,
    ['deal_aggregate', workspaceId, company.id, contactId, now, now],
  );
  run(
    `INSERT INTO sales_activities (id, workspace_id, company_id, contact_id, type, subject, occurred_at, created_at)
     VALUES (?, ?, ?, ?, 'note', 'Called purchasing', ?, ?)`,
    ['act_aggregate', workspaceId, company.id, contactId, now, now],
  );
  run(
    `INSERT INTO automation_states (id, workspace_id, company_id, state, reason, changed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'HUMAN_TAKEOVER', '需要人工跟进', ?, ?, ?)`,
    ['aut_aggregate', workspaceId, company.id, now, now, now],
  );

  const response = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(response.status, 200, response.text);
  const detail = response.body.data;
  assert.equal(detail.automationState, 'HUMAN_TAKEOVER');
  assert.equal(detail.automation.state, 'HUMAN_TAKEOVER');
  assert.equal(detail.threads.length, 1);
  assert.equal(detail.emailThreads[0].subject, 'Re: brake pads');
  assert.equal(detail.recentMessages.length, 1);
  assert.equal(detail.drafts.length, 1);
  assert.equal(detail.deals.length, 1);
  assert.equal(detail.deals[0].title, 'Brake pads deal');
  assert.equal(detail.activities.length, 1);
  assert.ok(detail.stats.threads >= 1);
  const timelineTypes = detail.timeline.map((event) => event.type);
  for (const type of ['email_thread', 'draft', 'deal', 'activity', 'automation']) {
    assert.ok(timelineTypes.includes(type), `timeline should include ${type}`);
  }

  const list = await ctx.request('GET', '/api/v1/companies?q=Aggregate');
  assert.ok(list.body.data.items[0].lastActivityAt, 'list exposes lastActivityAt');
});

test('crawl endpoint queues a company.crawl job', async () => {
  const company = await createCompany({ name: 'Queued Crawl GmbH', website: 'https://queued-crawl.example', domain: 'queued-crawl.example' });
  const response = await ctx.request('POST', `/api/v1/companies/${company.id}/crawl`, { body: {} });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.data.queued, true);
  assert.ok(response.body.data.jobId);
  const job = get('SELECT type, status, payload_json FROM background_jobs WHERE id = ? AND workspace_id = ?', [
    response.body.data.jobId,
    ctx.owner.workspaceId,
  ]);
  assert.equal(job.type, 'company.crawl');
  assert.equal(job.status, 'queued');
  const payload = JSON.parse(job.payload_json);
  assert.equal(payload.companyId, company.id);
});

test('workspace isolation: other workspaces cannot read or mutate companies', async () => {
  const company = await createCompany({ name: 'Private Handler GmbH', domain: 'private-handler.example' });
  const isolated = ctx.createWorkspace();
  const originalAuth = ctx.auth;
  ctx.as(isolated);
  const list = await ctx.request('GET', '/api/v1/companies');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 0);
  const detail = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(detail.status, 404);
  const patch = await ctx.request('PATCH', `/api/v1/companies/${company.id}`, { body: { city: 'Paris' } });
  assert.equal(patch.status, 404);
  const remove = await ctx.request('DELETE', `/api/v1/companies/${company.id}`);
  assert.equal(remove.status, 404);

  const own = await ctx.request('POST', '/api/v1/companies', { body: { name: 'Isolated Own GmbH', domain: 'private-handler.example' } });
  assert.equal(own.status, 200, 'domain uniqueness must be per workspace');
  assert.notEqual(own.body.data.id, company.id);

  ctx.auth = originalAuth;
  const stillThere = await ctx.request('GET', `/api/v1/companies/${company.id}`);
  assert.equal(stillThere.status, 200);
});
