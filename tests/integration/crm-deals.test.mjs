/**
 * Deals / pipeline / activities / follow-up task integration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { seedCompany, seedContact, seedDeal } from '../unit/crm-fixtures.mjs';

test('deals: CRUD, stage transitions and pipeline aggregation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });

  const created = await ctx.request('POST', '/api/v1/deals', {
    body: { companyId: company.id, contactId: contact.id, title: '5000 支架订单', valueAmount: 48000, currency: 'eur', stage: 'lead' },
  });
  assert.equal(created.status, 200, created.text);
  const deal = created.body.data;
  assert.equal(deal.stage, 'lead');
  assert.equal(deal.status, 'open');
  assert.equal(deal.currency, 'EUR');
  assert.equal(deal.probability, 10);

  const qualified = await ctx.request('PATCH', `/api/v1/deals/${deal.id}`, { body: { stage: 'qualified' } });
  assert.equal(qualified.status, 200, qualified.text);
  assert.equal(qualified.body.data.stage, 'qualified');
  assert.equal(qualified.body.data.probability, 30);

  const won = await ctx.request('PATCH', `/api/v1/deals/${deal.id}`, { body: { stage: 'won' } });
  assert.equal(won.status, 200, won.text);
  assert.equal(won.body.data.stage, 'won');
  assert.equal(won.body.data.status, 'won');
  assert.equal(won.body.data.probability, 100);
  assert.ok(won.body.data.closedAt);

  const revert = await ctx.request('PATCH', `/api/v1/deals/${deal.id}`, { body: { stage: 'lead' } });
  assert.equal(revert.status, 409);
  assert.equal(revert.body.error.details.code, 'DEAL_CLOSED');

  const invalidStage = await ctx.request('PATCH', `/api/v1/deals/${deal.id}`, { body: { stage: 'unknown' } });
  assert.equal(invalidStage.status, 422);

  // A second open deal feeds the pipeline.
  await ctx.request('POST', '/api/v1/deals', { body: { companyId: company.id, title: '样品订单', valueAmount: 5000, stage: 'proposal' } });
  const pipeline = await ctx.request('GET', '/api/v1/deals/pipeline');
  assert.equal(pipeline.status, 200, pipeline.text);
  assert.ok(Array.isArray(pipeline.body.data.stages));
  assert.deepEqual(
    pipeline.body.data.stages.map((stage) => stage.stage),
    ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
    'pipeline stages must keep the fixed order and include lost',
  );
  for (const stage of pipeline.body.data.stages) {
    assert.ok(Array.isArray(stage.items), `stage ${stage.stage} must expose an items array`);
    assert.equal(stage.count, stage.items.length, `stage ${stage.stage} count must match items length`);
  }
  const proposal = pipeline.body.data.stages.find((stage) => stage.stage === 'proposal');
  assert.equal(proposal.count, 1);
  assert.equal(proposal.totalValue, 5000);
  const card = proposal.items[0];
  for (const field of ['id', 'title', 'companyId', 'companyName', 'contactId', 'contactName', 'valueAmount', 'currency', 'probability', 'expectedCloseDate', 'ownerUserId', 'updatedAt']) {
    assert.ok(field in card, `pipeline card must contain ${field}`);
  }
  assert.equal(card.title, '样品订单');
  assert.equal(card.companyId, company.id);
  assert.equal(card.companyName, 'Test Autoteile GmbH');
  assert.equal(card.contactId, null);
  assert.equal(card.contactName, null);
  assert.equal(card.valueAmount, 5000);
  assert.equal(card.currency, 'EUR');
  assert.equal(card.probability, 50);
  assert.equal(card.expectedCloseDate, null);
  assert.equal(typeof card.updatedAt, 'string');

  const wonStage = pipeline.body.data.stages.find((stage) => stage.stage === 'won');
  assert.equal(wonStage.count, 1);
  assert.equal(wonStage.items[0].title, '5000 支架订单');
  assert.equal(wonStage.items[0].valueAmount, 48000);
  const lostStage = pipeline.body.data.stages.find((stage) => stage.stage === 'lost');
  assert.equal(lostStage.count, 0);
  assert.deepEqual(lostStage.items, []);
  assert.equal(pipeline.body.data.totals.totalValue, 5000);
  assert.equal(pipeline.body.data.totals.openCount, 1);
  assert.equal(pipeline.body.data.totals.wonValue, 48000);

  const detail = await ctx.request('GET', `/api/v1/deals/${deal.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.deal.id, deal.id);
  assert.equal(detail.body.data.company.id, company.id);

  const removed = await ctx.request('DELETE', `/api/v1/deals/${deal.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await ctx.request('GET', `/api/v1/deals/${deal.id}`)).status, 404);
});

test('deals: activities and follow-up tasks CRUD', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const deal = seedDeal({ workspaceId, companyId: company.id });

  const activity = await ctx.request('POST', '/api/v1/activities', {
    body: { companyId: company.id, dealId: deal.id, type: 'call', subject: '电话沟通', body: '客户确认需要样品' },
  });
  assert.equal(activity.status, 200, activity.text);
  assert.equal(activity.body.data.type, 'call');

  const activities = await ctx.request('GET', `/api/v1/activities?companyId=${company.id}`);
  assert.equal(activities.status, 200);
  assert.equal(activities.body.data.items.length, 1);
  assert.equal(activities.body.data.items[0].subject, '电话沟通');

  const createdTask = await ctx.request('POST', '/api/v1/follow-up-tasks', {
    body: { companyId: company.id, dealId: deal.id, title: '发送样品照片', dueAt: new Date(Date.now() + 172_800_000).toISOString(), type: 'follow_up' },
  });
  assert.equal(createdTask.status, 200, createdTask.text);
  const taskId = createdTask.body.data.id;
  assert.equal(createdTask.body.data.status, 'pending');

  const done = await ctx.request('PATCH', `/api/v1/follow-up-tasks/${taskId}`, { body: { status: 'done' } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.data.status, 'done');

  const list = await ctx.request('GET', `/api/v1/follow-up-tasks?status=done`);
  assert.equal(list.body.data.items.length, 1);

  const invalidAssignee = await ctx.request('POST', '/api/v1/follow-up-tasks', {
    body: { companyId: company.id, title: '无效指派', assignedTo: 'usr_unknown' },
  });
  assert.equal(invalidAssignee.status, 422);

  const deleted = await ctx.request('DELETE', `/api/v1/follow-up-tasks/${taskId}`);
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await ctx.request('GET', '/api/v1/follow-up-tasks?status=done')).body.data.items.length, 0);
});

test('deals: tenant isolation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const deal = seedDeal({ workspaceId, companyId: company.id });
  const other = ctx.createWorkspace({ name: '隔离空间' });

  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/deals/${deal.id}`)).status, 404);
  assert.equal((await ctx.request('PATCH', `/api/v1/deals/${deal.id}`, { body: { title: 'x' } })).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/deals')).body.data.items.length, 0);
  assert.equal((await ctx.request('GET', '/api/v1/follow-up-tasks')).body.data.items.length, 0);
});
