/**
 * Automation / human takeover integration: HTTP contract, transactional task
 * cancellation, resume rules and DO_NOT_CONTACT release path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { seedCompany, seedContact, seedFollowUpTask, getState, pendingTaskCount, auditActions } from '../unit/crm-fixtures.mjs';

test('automation: takeover cancels pending tasks and blocks sends', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId, name: 'Handover GmbH' });
  seedContact({ workspaceId, companyId: company.id });
  seedFollowUpTask({ workspaceId, companyId: company.id });
  seedFollowUpTask({ workspaceId, companyId: company.id, title: '第二封跟进' });

  const takeover = await ctx.request('POST', `/api/v1/automation/${company.id}/takeover`, { body: { reason: '销售人工跟进' } });
  assert.equal(takeover.status, 200, takeover.text);
  assert.equal(takeover.body.data.state, 'HUMAN_TAKEOVER');
  assert.equal(takeover.body.data.cancelledTasks, 2);
  assert.equal(pendingTaskCount(workspaceId, company.id), 0);
  assert.equal(auditActions(workspaceId, 'automation.takeover'), 1);

  const detail = await ctx.request('GET', `/api/v1/automation/${company.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.state, 'HUMAN_TAKEOVER');
  assert.equal(detail.body.data.canSend, false);
  assert.equal(detail.body.data.canAutoSend, false);

  const states = await ctx.request('GET', '/api/v1/automation/states');
  assert.equal(states.status, 200);
  assert.equal(states.body.data.items.length, 1);
  const item = states.body.data.items[0];
  for (const field of ['companyId', 'companyName', 'state', 'reason', 'changedAt']) {
    assert.ok(field in item, `automation state item should contain ${field}`);
  }
  assert.equal(item.companyName, 'Handover GmbH');

  const resume = await ctx.request('POST', `/api/v1/automation/${company.id}/resume`, { body: {} });
  assert.equal(resume.status, 200, resume.text);
  assert.equal(getState(workspaceId, company.id).state, 'AUTOMATION_ACTIVE');
});

test('automation: DO_NOT_CONTACT cannot be resumed until owner/admin removes suppression', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId, name: 'OptOut GmbH', domain: 'optout-test.de' });
  seedContact({ workspaceId, companyId: company.id, email: 'buyer@optout-test.de' });

  const dnc = await ctx.request('POST', `/api/v1/automation/${company.id}/do-not-contact`, { body: { reason: 'gdpr_request', note: '客户明确要求' } });
  assert.equal(dnc.status, 200, dnc.text);
  assert.equal(dnc.body.data.state, 'DO_NOT_CONTACT');
  assert.ok(dnc.body.data.suppressionCreated >= 2);

  const blocked = await ctx.request('POST', `/api/v1/automation/${company.id}/resume`, { body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.code, 'DO_NOT_CONTACT_LOCKED');

  // Remove every suppression record for this company (owner action).
  const suppression = await ctx.request('GET', '/api/v1/suppression');
  assert.ok(suppression.body.data.items.length >= 2);
  for (const record of suppression.body.data.items) {
    const removed = await ctx.request('DELETE', `/api/v1/suppression/${record.id}`);
    assert.equal(removed.status, 200, removed.text);
  }

  // A member still cannot release DO_NOT_CONTACT, even without suppression.
  const member = ctx.createMember({ email: 'member-dnc@test.local', role: 'member' });
  ctx.as(member);
  const forbidden = await ctx.request('POST', `/api/v1/automation/${company.id}/resume`, { body: {} });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'FORBIDDEN');

  ctx.as(ctx.owner);
  const resumed = await ctx.request('POST', `/api/v1/automation/${company.id}/resume`, { body: {} });
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(getState(workspaceId, company.id).state, 'AUTOMATION_ACTIVE');
});

test('automation: CLOSED is terminal', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const closed = await ctx.request('POST', `/api/v1/automation/${company.id}/close`, { body: { reason: '项目关闭' } });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.body.data.state, 'CLOSED');
  const resume = await ctx.request('POST', `/api/v1/automation/${company.id}/resume`, { body: {} });
  assert.equal(resume.status, 409);
  assert.equal(resume.body.error.details.code, 'CLOSED_LOCKED');
});

test('automation: tenant isolation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const other = ctx.createWorkspace({ name: '隔离空间' });

  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/automation/${company.id}`)).status, 404);
  assert.equal((await ctx.request('POST', `/api/v1/automation/${company.id}/takeover`, { body: {} })).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/automation/states')).body.data.items.length, 0);
});
