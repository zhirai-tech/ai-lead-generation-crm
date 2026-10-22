/**
 * Campaign integration: CRUD, steps, enrollment guards (dedupe / suppression /
 * automation), lifecycle and statistics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { seedCompany, seedContact, seedProduct } from '../unit/crm-fixtures.mjs';
import { advanceAfterSend } from '../../server/services/campaigns.mjs';
import { setAgentImplementation, resetAgentImplementations } from '../../server/services/agent-client.mjs';
import { run } from '../../server/core/db.mjs';

test('campaign: create, steps, enroll guards and stats', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const product = seedProduct({ workspaceId });
  const companyA = seedCompany({ workspaceId, name: 'Alpha GmbH', domain: 'alpha.de' });
  const contactA = seedContact({ workspaceId, companyId: companyA.id, email: 'anna@alpha.de' });
  const companyB = seedCompany({ workspaceId, name: 'Blocked GmbH', domain: 'blocked.de' });
  const contactB = seedContact({ workspaceId, companyId: companyB.id, email: 'buyer@blocked.de' });
  const companyC = seedCompany({ workspaceId, name: 'OptOut GmbH', domain: 'optout.de' });
  seedContact({ workspaceId, companyId: companyC.id, email: 'boss@optout.de' });

  // B's recipient is suppressed, C is under do-not-contact.
  await ctx.request('POST', '/api/v1/suppression', { body: { scope: 'email', value: contactB.email, reason: 'unsubscribe' } });
  await ctx.request('POST', `/api/v1/automation/${companyC.id}/do-not-contact`, { body: { reason: 'gdpr_request' } });

  const created = await ctx.request('POST', '/api/v1/campaigns', { body: { name: '欧洲汽配 Q4', productId: product.id, goal: '找到 20 个进口商' } });
  assert.equal(created.status, 200, created.text);
  const campaign = created.body.data;
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.requireApproval, true);
  assert.equal(campaign.dailyLimit, 30);
  assert.equal(campaign.productId, product.id);

  const step1 = await ctx.request('POST', `/api/v1/campaigns/${campaign.id}/steps`, {
    body: { name: '首封', subjectTemplate: 'Hello {{company}}', bodyTemplate: 'We supply battery brackets.', language: 'de', delayDays: 0 },
  });
  assert.equal(step1.status, 200, step1.text);
  assert.equal(step1.body.data.stepNo, 1);
  const step2 = await ctx.request('POST', `/api/v1/campaigns/${campaign.id}/steps`, {
    body: { name: '第二封跟进', subjectTemplate: 'Follow up', bodyTemplate: 'Just following up.', language: 'de', delayDays: 3 },
  });
  assert.equal(step2.body.data.stepNo, 2);

  const steps = await ctx.request('GET', `/api/v1/campaigns/${campaign.id}/steps`);
  assert.deepEqual(steps.body.data.items.map((step) => step.stepNo), [1, 2]);

  const updatedStep = await ctx.request('PATCH', `/api/v1/campaigns/${campaign.id}/steps/${step2.body.data.id}`, {
    body: { delayDays: 5, isActive: false },
  });
  assert.equal(updatedStep.status, 200, updatedStep.text);
  assert.equal(updatedStep.body.data.delayDays, 5);
  assert.equal(updatedStep.body.data.isActive, false);

  const enrolled = await ctx.request('POST', `/api/v1/campaigns/${campaign.id}/enroll`, {
    body: { companyIds: [companyA.id, companyB.id, companyC.id] },
  });
  assert.equal(enrolled.status, 200, enrolled.text);
  assert.equal(enrolled.body.data.enrolled, 1);
  assert.equal(enrolled.body.data.suppressed, 1);
  assert.equal(enrolled.body.data.automationBlocked, 1);
  assert.deepEqual(enrolled.body.data.targetIds, [contactA.id]);

  const again = await ctx.request('POST', `/api/v1/campaigns/${campaign.id}/enroll`, {
    body: { companyIds: [companyA.id] },
  });
  assert.equal(again.body.data.enrolled, 0);
  assert.equal(again.body.data.duplicate, 1);

  const stats = await ctx.request('GET', `/api/v1/campaigns/${campaign.id}/stats`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.targets, 1);
  assert.equal(stats.body.data.sent, 0);
  assert.equal(stats.body.data.replied, 0);
  assert.equal(stats.body.data.unsubscribed, 0);
  assert.equal(stats.body.data.pendingApproval, 0);

  const targets = await ctx.request('GET', `/api/v1/campaigns/${campaign.id}/targets`);
  assert.equal(targets.status, 200);
  assert.equal(targets.body.data.items.length, 1);
  assert.equal(targets.body.data.items[0].contactEmail, 'anna@alpha.de');
  assert.equal(targets.body.data.items[0].companyName, 'Alpha GmbH');

  const paused = await ctx.request('POST', `/api/v1/campaigns/${campaign.id}/resume`, { body: {} });
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.body.data.status, 'active');
  assert.equal((await ctx.request('POST', `/api/v1/campaigns/${campaign.id}/pause`, { body: {} })).body.data.status, 'paused');

  const detail = await ctx.request('GET', `/api/v1/campaigns/${campaign.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.campaign.id, campaign.id);
  assert.equal(detail.body.data.steps.length, 2);
  assert.equal(detail.body.data.stats.targets, 1);

  // List responses must carry the summary fields the frontend renders without
  // extra per-row requests (step count, reply/pending counts, product/ICP names).
  setAgentImplementation('generateOutreachDraft', async () => ({
    subject: 'Generated subject',
    bodyText: 'Generated body long enough for validation.',
    language: 'de',
  }));
  const pendingDraft = await ctx.request('POST', '/api/v1/drafts', {
    body: { companyId: companyA.id, contactId: contactA.id, campaignId: campaign.id, subject: 'x', bodyText: 'draft body' },
  });
  await ctx.request('POST', `/api/v1/drafts/${pendingDraft.body.data.id}/generate`, { body: {} });
  resetAgentImplementations();
  run("UPDATE campaign_targets SET status = 'replied' WHERE workspace_id = ? AND campaign_id = ?", [workspaceId, campaign.id]);

  const list = await ctx.request('GET', '/api/v1/campaigns');
  assert.equal(list.status, 200, list.text);
  const row = list.body.data.items.find((item) => item.id === campaign.id);
  assert.ok(row, 'campaign should appear in the list');
  assert.equal(row.stepCount, 2);
  assert.equal(row.targetCount, 1);
  assert.equal(row.repliedCount, 1);
  assert.equal(row.pendingApprovalCount, 1);
  assert.equal(row.sentCount, 0);
  assert.equal(row.productName, product.name);
  assert.equal(row.icpName, null);
});

test('campaign: advanceAfterSend moves targets through steps and completes', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });

  const created = await ctx.request('POST', '/api/v1/campaigns', { body: { name: '两步跟进' } });
  const campaignId = created.body.data.id;
  await ctx.request('POST', `/api/v1/campaigns/${campaignId}/steps`, { body: { name: '首封', subjectTemplate: 'A', bodyTemplate: 'A', delayDays: 0 } });
  await ctx.request('POST', `/api/v1/campaigns/${campaignId}/steps`, { body: { name: '第二封', subjectTemplate: 'B', bodyTemplate: 'B', delayDays: 2 } });
  await ctx.request('POST', `/api/v1/campaigns/${campaignId}/enroll`, { body: { companyIds: [company.id] } });

  const first = advanceAfterSend({ workspaceId, campaignId, contactId: contact.id, draftId: 'drf_test' });
  assert.equal(first.advanced, true);
  assert.equal(first.completed, false);
  assert.equal(first.sentStepNo, 1);
  const afterFirst = await ctx.request('GET', `/api/v1/campaigns/${campaignId}/targets`);
  const target = afterFirst.body.data.items[0];
  assert.equal(target.currentStep, 1);
  assert.equal(target.status, 'active');
  assert.ok(target.lastContactedAt);
  const delayMs = new Date(target.nextRunAt).getTime() - Date.now();
  assert.ok(delayMs > 86_000_000, 'next run should honour the second step delay (~2 days)');

  const second = advanceAfterSend({ workspaceId, campaignId, contactId: contact.id, draftId: 'drf_test2' });
  assert.equal(second.completed, true);
  const afterSecond = await ctx.request('GET', `/api/v1/campaigns/${campaignId}/targets`);
  assert.equal(afterSecond.body.data.items[0].status, 'completed');
  assert.equal(afterSecond.body.data.items[0].currentStep, 2);
  assert.equal((await ctx.request('GET', `/api/v1/campaigns/${campaignId}/stats`)).body.data.completed, 1);
});

test('campaign: tenant isolation and archived guard', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const created = await ctx.request('POST', '/api/v1/campaigns', { body: { name: '私有活动' } });
  const campaignId = created.body.data.id;
  const other = ctx.createWorkspace({ name: '隔离空间' });

  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/campaigns/${campaignId}`)).status, 404);
  assert.equal((await ctx.request('PATCH', `/api/v1/campaigns/${campaignId}`, { body: { name: 'hacked' } })).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/campaigns')).body.data.items.length, 0);

  ctx.as(ctx.owner);
  assert.equal((await ctx.request('DELETE', `/api/v1/campaigns/${campaignId}`)).status, 200);
  assert.equal((await ctx.request('GET', `/api/v1/campaigns/${campaignId}`)).status, 404);
});

test('campaign: viewer cannot mutate', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const viewer = ctx.createMember({ email: 'viewer-campaign@test.local', role: 'viewer' });
  ctx.as(viewer);
  const denied = await ctx.request('POST', '/api/v1/campaigns', { body: { name: 'not allowed' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
});
