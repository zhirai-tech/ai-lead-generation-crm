/**
 * Inbox + reply classification integration: thread listing/detail, read state,
 * manual reply under human takeover, classification persistence and the
 * unsubscribe escalation path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { get, all } from '../../server/core/db.mjs';
import { seedCompany, seedContact, seedThread, seedMessage, getState, auditActions } from '../unit/crm-fixtures.mjs';
import { setAgentImplementation, resetAgentImplementations } from '../../server/services/agent-client.mjs';
import { classifyInboundMessage } from '../../server/services/replies.mjs';

function seedInboxThread({ workspaceId, label = 'Inbox GmbH', domain = 'inbox.de' }) {
  const company = seedCompany({ workspaceId, name: label, domain });
  const contact = seedContact({ workspaceId, companyId: company.id, email: `buyer@${domain}` });
  const thread = seedThread({ workspaceId, companyId: company.id, contactId: contact.id, subject: 'Re: Battery brackets' });
  const message = seedMessage({ workspaceId, threadId: thread.id, companyId: company.id, contactId: contact.id, fromAddress: contact.email });
  return { company, contact, thread, message };
}

test('inbox: threads list/detail/read state', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const { company, thread } = seedInboxThread({ workspaceId });

  const unread = await ctx.request('GET', '/api/v1/inbox/threads?unread=1');
  assert.equal(unread.status, 200, unread.text);
  assert.equal(unread.body.data.total, 1);
  const item = unread.body.data.items[0];
  assert.equal(item.id, thread.id);
  assert.equal(item.companyName, 'Inbox GmbH');
  assert.equal(item.unread, true);
  assert.equal(typeof item.snippet, 'string');
  assert.equal(item.contactName, 'Anna Müller');
  assert.ok('classification' in item);

  const detail = await ctx.request('GET', `/api/v1/inbox/threads/${thread.id}`);
  assert.equal(detail.status, 200, detail.text);
  assert.ok(detail.body.data.thread);
  assert.equal(detail.body.data.messages.length, 1);
  assert.equal(detail.body.data.messages[0].direction, 'inbound');
  assert.equal(detail.body.data.company.id, company.id);
  assert.equal(detail.body.data.contact.id !== undefined, true);
  assert.ok('classification' in detail.body.data);
  assert.ok('suggestedReply' in detail.body.data);

  const read = await ctx.request('POST', `/api/v1/inbox/threads/${thread.id}/read`, { body: {} });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.data.markedRead, 1);
  assert.equal((await ctx.request('GET', '/api/v1/inbox/threads?unread=1')).body.data.total, 0);
});

test('inbox: high-intent classification persists, notifies and flags human review', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const { company, contact, thread, message } = seedInboxThread({ workspaceId, label: 'High Intent GmbH', domain: 'highintent.de' });

  setAgentImplementation('classifyReply', async () => ({
    label: 'price_inquiry',
    confidence: 0.92,
    intentScore: 90,
    evidence: ['Please send us your best price for 5000 units.', 'What is your MOQ?'],
    rationale: '客户明确询价并询问起订量',
    suggestedReply: 'Thank you for your interest. Our MOQ is 500 units...',
  }));

  const result = await classifyInboundMessage({ workspaceId, messageId: message.id, actorType: 'agent' });
  assert.equal(result.classification.label, 'price_inquiry');
  assert.equal(result.classification.status, 'ai_suggested');
  assert.equal(result.classification.messageId, message.id);
  assert.equal(result.classification.confidence, 0.92);
  assert.equal(result.classification.intentScore, 90);
  assert.equal(result.classification.evidence.length, 2);

  const stored = get('SELECT * FROM conversation_classifications WHERE workspace_id = ? AND message_id = ?', [workspaceId, message.id]);
  assert.ok(stored, 'classification row should be persisted');
  assert.equal(stored.label, 'price_inquiry');
  assert.equal(stored.rationale, '客户明确询价并询问起订量');
  assert.equal(get('SELECT classification FROM email_threads WHERE id = ?', [thread.id]).classification, 'price_inquiry');
  assert.equal(get('SELECT status FROM companies WHERE id = ?', [company.id]).status, 'replied');
  assert.equal(getState(workspaceId, company.id)?.state, 'NEEDS_HUMAN_REVIEW');
  assert.ok(get("SELECT id FROM notifications WHERE workspace_id = ? AND type = 'high_intent'", [workspaceId]));
  assert.equal(auditActions(workspaceId, 'reply.classified'), 1);
  assert.equal(result.automationState.state, 'NEEDS_HUMAN_REVIEW');

  const highIntent = await ctx.request('GET', '/api/v1/inbox/high-intent');
  assert.equal(highIntent.status, 200);
  assert.equal(highIntent.body.data.total, 1);
  assert.equal(highIntent.body.data.items[0].id, thread.id);

  // Manual classification correction is appended as user_corrected + audited.
  const corrected = await ctx.request('POST', `/api/v1/inbox/threads/${thread.id}/classification`, {
    body: { label: 'quote_request', note: '应该是索要报价' },
  });
  assert.equal(corrected.status, 200, corrected.text);
  assert.equal(corrected.body.data.classification.status, 'user_corrected');
  assert.equal(corrected.body.data.classification.label, 'quote_request');
  assert.equal(get('SELECT classification FROM email_threads WHERE id = ?', [thread.id]).classification, 'quote_request');
  assert.equal(auditActions(workspaceId, 'classification.correct'), 1);
  assert.equal(contact.id, result.classification.contactId);
});

test('inbox: manual reply is allowed under HUMAN_TAKEOVER and queues an approved draft', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const { company, thread } = seedInboxThread({ workspaceId, label: 'Takeover GmbH', domain: 'takeover.de' });
  await ctx.request('POST', `/api/v1/automation/${company.id}/takeover`, { body: { reason: '人工接管' } });

  const reply = await ctx.request('POST', `/api/v1/inbox/threads/${thread.id}/reply`, {
    body: { bodyText: 'Dear Anna, thank you for your message. We will send the quotation today.' },
  });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.body.data.draft.status, 'scheduled');
  assert.equal(reply.body.data.automationState, 'HUMAN_TAKEOVER');
  const draftRow = get('SELECT * FROM message_drafts WHERE id = ?', [reply.body.data.draftId]);
  assert.equal(draftRow.status, 'scheduled');
  assert.equal(draftRow.approved_by, ctx.owner.userId);
  assert.ok(draftRow.approved_at);
  assert.equal(get('SELECT status FROM email_threads WHERE id = ?', [thread.id]).status, 'waiting');
  assert.equal(auditActions(workspaceId, 'thread.reply'), 1);
});

test('inbox: unsubscribe reply creates suppression, DO_NOT_CONTACT and cancels tasks', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => {
    resetAgentImplementations();
    await ctx.close();
  });
  const workspaceId = ctx.owner.workspaceId;
  const { company, contact, thread, message } = seedInboxThread({ workspaceId, label: 'OptOut Reply GmbH', domain: 'optout-reply.de' });
  await ctx.request('POST', '/api/v1/follow-up-tasks', {
    body: { companyId: company.id, title: '三天后跟进', dueAt: new Date(Date.now() + 86_400_000).toISOString() },
  });

  setAgentImplementation('classifyReply', async () => ({
    label: 'unsubscribe',
    confidence: 0.99,
    intentScore: 100,
    evidence: ['Please remove me from your mailing list.'],
    rationale: '客户明确要求退订',
  }));

  const result = await classifyInboundMessage({ workspaceId, messageId: message.id, actorType: 'agent' });
  assert.equal(result.classification.label, 'unsubscribe');
  assert.equal(result.automationState.state, 'DO_NOT_CONTACT');
  assert.equal(getState(workspaceId, company.id).state, 'DO_NOT_CONTACT');
  assert.equal(get('SELECT status FROM email_threads WHERE id = ?', [thread.id]).status, 'closed');
  const suppression = get('SELECT * FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?', [
    workspaceId,
    'email',
    contact.emailNormalized,
  ]);
  assert.ok(suppression, 'unsubscribe should create a suppression record');
  assert.equal(suppression.reason, 'unsubscribe');
  const pendingTasks = get("SELECT COUNT(*) AS c FROM follow_up_tasks WHERE workspace_id = ? AND status = 'pending'", [workspaceId]).c;
  assert.equal(pendingTasks, 0);
  assert.ok(get("SELECT id FROM notifications WHERE workspace_id = ? AND type = 'unsubscribe'", [workspaceId]));

  // Inbox reply to an unsubscribed customer must be rejected.
  const blocked = await ctx.request('POST', `/api/v1/inbox/threads/${thread.id}/reply`, { body: { bodyText: 'Hello again' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.code, 'RECIPIENT_SUPPRESSED');
});

test('inbox: thread takeover shortcut switches automation state', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const { company, thread } = seedInboxThread({ workspaceId, label: 'Shortcut GmbH', domain: 'shortcut.de' });
  const result = await ctx.request('POST', `/api/v1/inbox/threads/${thread.id}/takeover`, { body: { reason: '收件箱接管' } });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.data.state, 'HUMAN_TAKEOVER');
  assert.equal(getState(workspaceId, company.id).state, 'HUMAN_TAKEOVER');
});

test('inbox: tenant isolation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const { thread } = seedInboxThread({ workspaceId });
  const other = ctx.createWorkspace({ name: '隔离空间' });
  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/inbox/threads/${thread.id}`)).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/inbox/threads')).body.data.items.length, 0);
  assert.equal(all('SELECT id FROM email_threads WHERE workspace_id = ?', [other.workspaceId]).length, 0);
});
