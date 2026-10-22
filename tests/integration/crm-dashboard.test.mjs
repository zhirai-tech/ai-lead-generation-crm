/**
 * Dashboard integration: aggregated summary shape, alerts and activity feed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { seedCompany, seedContact, seedThread, seedMessage } from '../unit/crm-fixtures.mjs';
import { setAgentImplementation, resetAgentImplementations } from '../../server/services/agent-client.mjs';
import { classifyInboundMessage } from '../../server/services/replies.mjs';

test('dashboard: summary aggregates real data and matches the frontend contract', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;

  const company = seedCompany({ workspaceId, name: 'Dashboard GmbH', domain: 'dashboard.de', status: 'qualified' });
  const contact = seedContact({ workspaceId, companyId: company.id, email: 'buyer@dashboard.de' });
  const thread = seedThread({ workspaceId, companyId: company.id, contactId: contact.id });
  const message = seedMessage({ workspaceId, threadId: thread.id, companyId: company.id, contactId: contact.id, fromAddress: contact.email });
  seedCompany({ workspaceId, name: 'Other Qualified GmbH', domain: 'other-qualified.de', status: 'qualified' });

  setAgentImplementation('classifyReply', async () => ({ label: 'quote_request', confidence: 0.9, intentScore: 85, evidence: [], rationale: '报价' }));
  await classifyInboundMessage({ workspaceId, messageId: message.id, actorType: 'agent' });

  const campaign = await ctx.request('POST', '/api/v1/campaigns', { body: { name: '看板活动' } });
  await ctx.request('POST', `/api/v1/campaigns/${campaign.body.data.id}/resume`, { body: {} });
  const draft = await ctx.request('POST', '/api/v1/drafts', { body: { companyId: company.id, contactId: contact.id, subject: 'Hi', bodyText: 'Hello, quick intro.' } });
  setAgentImplementation('generateOutreachDraft', async () => ({ subject: 'Generated', bodyText: 'Generated body for the dashboard test.' }));
  await ctx.request('POST', `/api/v1/drafts/${draft.body.data.id}/generate`, { body: {} });

  await ctx.request('POST', '/api/v1/deals', { body: { companyId: company.id, title: 'Deal', valueAmount: 12000, stage: 'proposal' } });

  const summary = await ctx.request('GET', '/api/v1/dashboard/summary');
  assert.equal(summary.status, 200, summary.text);
  const data = summary.body.data;
  for (const key of ['companies', 'contacts', 'drafts', 'campaigns', 'inbox', 'deals', 'sends', 'agents', 'jobs', 'trend', 'funnel', 'alerts', 'recent']) {
    assert.ok(key in data, `summary should include ${key}`);
  }
  assert.equal(data.companies.total, 2);
  assert.equal(data.companies.qualified, 1);
  assert.equal(data.companies.replied, 1);
  assert.equal(data.contacts.total, 1);
  assert.equal(data.contacts.withEmail, 1);
  assert.equal(data.drafts.pendingApproval, 1);
  assert.equal(data.campaigns.active, 1);
  assert.equal(data.campaigns.total, 1);
  assert.equal(data.inbox.unreadThreads, 1);
  assert.equal(data.inbox.highIntent, 1);
  assert.equal(data.deals.open, 1);
  assert.equal(data.deals.pipelineValue, 12000);
  assert.equal(data.sends.dailyUsed, 0);
  assert.ok(data.sends.dailyLimit >= 1);
  assert.equal(data.trend.length, 14);
  assert.equal(data.funnel.length, 5);
  assert.ok(Array.isArray(data.alerts));
  assert.ok(Array.isArray(data.recent));

  const alertTypes = data.alerts.map((alert) => alert.type);
  assert.ok(alertTypes.includes('pending_approval'), 'pending approval alert expected');
  assert.ok(alertTypes.includes('high_intent'), 'high intent alert expected');
  for (const alert of data.alerts) {
    for (const field of ['type', 'severity', 'title', 'detail', 'createdAt']) {
      assert.ok(field in alert, `alert should include ${field}`);
    }
  }

  const alerts = await ctx.request('GET', '/api/v1/dashboard/alerts');
  assert.equal(alerts.status, 200);
  assert.ok(Array.isArray(alerts.body.data.items));

  const activity = await ctx.request('GET', '/api/v1/dashboard/activity?limit=2');
  assert.equal(activity.status, 200);
  assert.equal(activity.body.data.items.length, 2);
  for (const item of activity.body.data.items) {
    for (const field of ['type', 'title', 'at']) {
      assert.ok(field in item, `activity should include ${field}`);
    }
  }
});

test('dashboard: tenant isolation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  seedCompany({ workspaceId });
  const other = ctx.createWorkspace({ name: '隔离空间' });
  ctx.as(other);
  const summary = await ctx.request('GET', '/api/v1/dashboard/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.companies.total, 0);
  assert.equal(summary.body.data.contacts.total, 0);
  assert.equal((await ctx.request('GET', '/api/v1/dashboard/alerts')).body.data.items.length, 0);
  assert.equal((await ctx.request('GET', '/api/v1/dashboard/activity')).body.data.items.length, 0);
});
