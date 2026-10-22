/**
 * Follow-up planning unit tests: agent-assisted task/draft persistence and the
 * human-takeover safety gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { get } from '../../server/core/db.mjs';
import { seedCompany, seedContact, seedThread, seedMessage, auditActions } from './crm-fixtures.mjs';
import { setAgentImplementation, resetAgentImplementations } from '../../server/services/agent-client.mjs';
import { planFollowUpForThread } from '../../server/services/followups.mjs';
import { takeoverCompany } from '../../server/services/automation.mjs';

test('follow-ups: planning persists a task plus a draft suggestion', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId, name: 'FollowUp GmbH', domain: 'followup.de' });
  const contact = seedContact({ workspaceId, companyId: company.id, email: 'buyer@followup.de' });
  const thread = seedThread({ workspaceId, companyId: company.id, contactId: contact.id });
  const message = seedMessage({ workspaceId, threadId: thread.id, companyId: company.id, contactId: contact.id, fromAddress: contact.email });

  setAgentImplementation('planFollowUp', async () => ({
    title: '发送样品报价与运费',
    type: 'email',
    dueInDays: 2,
    notes: '客户询问样品与运费，需要准备报价单。',
    rationale: '客户明确表示需要样品',
    draftSubject: 'Sample quotation for battery brackets',
    draftBody: 'Dear Anna, please find our sample quotation attached. We can ship within 10 days.',
  }));

  const plan = await planFollowUpForThread({ workspaceId, threadId: thread.id, messageId: message.id, actorType: 'agent' });
  assert.ok(plan.taskId, 'task should be created');
  assert.ok(plan.draftId, 'draft suggestion should be created');
  assert.equal(plan.skipped, false);

  const task = get('SELECT * FROM follow_up_tasks WHERE workspace_id = ? AND id = ?', [workspaceId, plan.taskId]);
  assert.equal(task.title, '发送样品报价与运费');
  assert.equal(task.type, 'email');
  assert.equal(task.status, 'pending');
  assert.equal(task.company_id, company.id);
  assert.equal(task.contact_id, contact.id);
  assert.ok(task.notes.includes('样品'));

  const draft = get('SELECT * FROM message_drafts WHERE workspace_id = ? AND id = ?', [workspaceId, plan.draftId]);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.company_id, company.id);
  assert.equal(draft.contact_id, contact.id);
  assert.equal(draft.subject, 'Sample quotation for battery brackets');
  assert.ok(draft.body_text.includes('sample quotation'));
  assert.equal(auditActions(workspaceId, 'followup.plan'), 1);
});

test('follow-ups: planning is suppressed under human takeover (no AI follow-up)', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const thread = seedThread({ workspaceId, companyId: company.id, contactId: contact.id });
  const message = seedMessage({ workspaceId, threadId: thread.id, companyId: company.id, contactId: contact.id, fromAddress: contact.email });
  takeoverCompany(workspaceId, company.id, { actor: { actorType: 'user', actorId: ctx.owner.userId } });

  setAgentImplementation('planFollowUp', async () => ({ title: '不应创建' }));
  const plan = await planFollowUpForThread({ workspaceId, threadId: thread.id, messageId: message.id, actorType: 'agent' });
  assert.equal(plan.skipped, true);
  assert.equal(plan.taskId, null);
  assert.equal(plan.draftId, null);
  assert.equal(get('SELECT COUNT(*) AS c FROM follow_up_tasks WHERE workspace_id = ? AND company_id = ?', [workspaceId, company.id]).c, 0);
  assert.equal(auditActions(workspaceId, 'followup.plan_skipped'), 1);
});

test('follow-ups: tenant isolation rejects a foreign thread', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const contact = seedContact({ workspaceId, companyId: company.id });
  const thread = seedThread({ workspaceId, companyId: company.id, contactId: contact.id });
  setAgentImplementation('planFollowUp', async () => ({ title: 'x' }));
  const other = ctx.createWorkspace({ name: '隔离空间' });
  await assert.rejects(
    () => planFollowUpForThread({ workspaceId: other.workspaceId, threadId: thread.id, actorType: 'agent' }),
    (error) => error.code === 'NOT_FOUND',
  );
});
