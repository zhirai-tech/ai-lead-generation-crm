/**
 * Unit tests for the automation state machine (highest-priority safety logic).
 * The module is exercised directly against a real (temporary) database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { run } from '../../server/core/db.mjs';
import { seedCompany, seedContact, seedFollowUpTask, getState, pendingTaskCount, auditActions } from './crm-fixtures.mjs';
import {
  getCompanyAutomationState,
  takeoverCompany,
  resumeAutomation,
  pauseAutomation,
  closeCompany,
  markDoNotContact,
  flagNeedsHumanReview,
} from '../../server/services/automation.mjs';

test('automation: default state is deterministic and allows sending', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const snapshot = getCompanyAutomationState(workspaceId, company.id);
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.state, 'AUTOMATION_ACTIVE');
  assert.equal(snapshot.canSend, true);
  assert.equal(snapshot.canAutoSend, true);
  assert.equal(snapshot.suppressed, false);
  // Deterministic: repeated calls return the same state.
  assert.deepEqual(getCompanyAutomationState(workspaceId, company.id), snapshot);
  // Unknown company is deterministically blocked instead of throwing.
  const missing = getCompanyAutomationState(workspaceId, 'cmp_missing');
  assert.equal(missing.exists, false);
  assert.equal(missing.canSend, false);
});

test('automation: takeover is transactional (state + task cancellation + audit)', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  seedContact({ workspaceId, companyId: company.id });
  seedFollowUpTask({ workspaceId, companyId: company.id, title: 'pending 1' });
  seedFollowUpTask({ workspaceId, companyId: company.id, title: 'pending 2' });
  assert.equal(pendingTaskCount(workspaceId, company.id), 2);

  const result = takeoverCompany(workspaceId, company.id, { reason: '人工跟进', actor: { actorType: 'user', actorId: ctx.owner.userId } });
  assert.equal(result.state, 'HUMAN_TAKEOVER');
  assert.equal(result.previousState, 'AUTOMATION_ACTIVE');
  assert.equal(result.cancelledTasks, 2);
  const row = getState(workspaceId, company.id);
  assert.equal(row.state, 'HUMAN_TAKEOVER');
  assert.equal(row.reason, '人工跟进');
  assert.equal(row.changed_by, ctx.owner.userId);
  assert.equal(pendingTaskCount(workspaceId, company.id), 0);
  assert.equal(auditActions(workspaceId, 'automation.takeover'), 1);

  const snapshot = getCompanyAutomationState(workspaceId, company.id);
  assert.equal(snapshot.canSend, false);
  assert.equal(snapshot.canAutoSend, false);
});

test('automation: resume only from takeover/paused/needs-review', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });

  takeoverCompany(workspaceId, company.id);
  resumeAutomation(workspaceId, company.id, { actor: { actorType: 'user', actorId: ctx.owner.userId } });
  assert.equal(getState(workspaceId, company.id).state, 'AUTOMATION_ACTIVE');
  assert.equal(auditActions(workspaceId, 'automation.resume'), 1);

  pauseAutomation(workspaceId, company.id);
  resumeAutomation(workspaceId, company.id);
  assert.equal(getState(workspaceId, company.id).state, 'AUTOMATION_ACTIVE');

  flagNeedsHumanReview(workspaceId, company.id, { reason: '高意向回复' });
  assert.equal(getState(workspaceId, company.id).state, 'NEEDS_HUMAN_REVIEW');
  resumeAutomation(workspaceId, company.id);
  assert.equal(getState(workspaceId, company.id).state, 'AUTOMATION_ACTIVE');
  assert.equal(auditActions(workspaceId, 'automation.review_required'), 1);
});

test('automation: DO_NOT_CONTACT cannot be resumed until suppression is removed (owner only)', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId, domain: 'dnc-test.de' });
  const contact = seedContact({ workspaceId, companyId: company.id, email: 'buyer@dnc-test.de' });

  const result = markDoNotContact(workspaceId, company.id, { reason: 'gdpr_request', actor: { actorType: 'user', actorId: ctx.owner.userId } });
  assert.equal(result.state, 'DO_NOT_CONTACT');
  assert.ok(result.suppressionCreated >= 2, 'domain + contact email suppression records expected');
  const row = getState(workspaceId, company.id);
  assert.equal(row.state, 'DO_NOT_CONTACT');

  // Direct resume is rejected while suppression records exist.
  assert.throws(
    () => resumeAutomation(workspaceId, company.id, { actor: { actorType: 'user', actorId: ctx.owner.userId, actorRole: 'owner' } }),
    (error) => error.code === 'CONFLICT' && error.details?.code === 'DO_NOT_CONTACT_LOCKED',
  );

  // Removing the suppression records is the only way out; still requires owner/admin.
  run('DELETE FROM suppression_records WHERE workspace_id = ? AND (value_normalized = ? OR value_normalized = ?)', [
    workspaceId,
    company.domain,
    contact.emailNormalized,
  ]);
  assert.throws(
    () => resumeAutomation(workspaceId, company.id, { actor: { actorType: 'user', actorId: ctx.owner.userId, actorRole: 'member' } }),
    (error) => error.code === 'FORBIDDEN',
  );
  resumeAutomation(workspaceId, company.id, { actor: { actorType: 'user', actorId: ctx.owner.userId, actorRole: 'owner' } });
  assert.equal(getState(workspaceId, company.id).state, 'AUTOMATION_ACTIVE');
  assert.equal(auditActions(workspaceId, 'automation.do_not_contact'), 1);
});

test('automation: CLOSED is terminal and cannot be resumed or taken over', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  closeCompany(workspaceId, company.id, { reason: '项目结束' });
  assert.equal(getState(workspaceId, company.id).state, 'CLOSED');
  assert.throws(() => resumeAutomation(workspaceId, company.id), (error) => error.details?.code === 'CLOSED_LOCKED');
  assert.throws(() => takeoverCompany(workspaceId, company.id), (error) => error.details?.code === 'CLOSED_LOCKED');
});

test('automation: tenant isolation and needs-review never downgrades stronger states', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;
  const company = seedCompany({ workspaceId });
  const other = ctx.createWorkspace({ name: '另一个工作空间' });

  assert.equal(getCompanyAutomationState(other.workspaceId, company.id).exists, false);
  takeoverCompany(workspaceId, company.id);
  flagNeedsHumanReview(workspaceId, company.id, { reason: '无效应降级' });
  assert.equal(getState(workspaceId, company.id).state, 'HUMAN_TAKEOVER');
});
