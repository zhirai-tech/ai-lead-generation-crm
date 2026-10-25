import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as baseConfig } from '../../server/config.mjs';
import { closeDatabase, get, migrate, openDatabase, upsertSetting } from '../../server/core/db.mjs';
import { setSecretForTests } from '../../server/core/secrets.mjs';
import { bootstrapTestWorkspace } from '../helpers.mjs';
import * as companiesService from '../../server/services/companies.mjs';
import * as contactsService from '../../server/services/contacts.mjs';
import {
  checkEmailSyntax,
  classifyEmailAddress,
  lookupDomainMx,
  setMxResolverForTests,
  resetMxResolverForTests,
  inferEmails,
  verifyContactEmail,
} from '../../server/services/verification.mjs';

// This is a unit test: it runs against a direct in-process database without an
// HTTP server, so no sockets/timers can race the test-runner teardown.
let dir;
let workspaceId;
let actorId;
let companyId;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-verification-'));
  setSecretForTests(randomBytes(48));
  const dbFile = path.join(dir, 'test.sqlite');
  const db = openDatabase(dbFile);
  const migrationsDir = path.join(baseConfig.rootDir, 'server', 'db', 'migrations');
  const allowlist = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  migrate(db, migrationsDir, { allowlist, expectedDbPath: dbFile, actualDbPath: dbFile });
  const bootstrap = bootstrapTestWorkspace({ email: 'unit-verify@test.local' });
  workspaceId = bootstrap.workspace.id;
  actorId = bootstrap.user.id;
  upsertSetting(workspaceId, 'enrichment', { verifyMx: false, maxEmailsPerDomain: 5 });
  const company = companiesService.createCompany(
    workspaceId,
    { name: 'Nordkap Autoteile GmbH', domain: 'nordkap-autoteile.example', country: 'DE' },
    { actorId },
  );
  companyId = company.id;
});

after(() => {
  resetMxResolverForTests();
  closeDatabase();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures on Windows
  }
});

async function createContact(input) {
  return contactsService.createContact(workspaceId, { companyId, ...input }, { actorId });
}

test('email syntax checks', () => {
  assert.equal(checkEmailSyntax('anna.schmidt@example.com').result, 'passed');
  assert.equal(checkEmailSyntax('bad@@example.com').result, 'failed');
  assert.equal(checkEmailSyntax('').result, 'failed');
  assert.equal(checkEmailSyntax('a..b@example.com').result, 'failed');
});

test('email address classification detects role, disposable and freemail', () => {
  const role = classifyEmailAddress('info@nordkap-autoteile.example');
  assert.equal(role.roleAccount, true);
  const disposable = classifyEmailAddress('user@mailinator.com');
  assert.equal(disposable.disposable, true);
  const freemail = classifyEmailAddress('someone@gmail.com');
  assert.equal(freemail.freemail, true);
  const business = classifyEmailAddress('anna.schmidt@nordkap-autoteile.example');
  assert.equal(business.roleAccount, false);
  assert.equal(business.disposable, false);
  assert.equal(business.freemail, false);
});

test('MX lookup reports passed / failed / unknown separately', async () => {
  setMxResolverForTests(async () => [{ exchange: 'mx1.example.com', priority: 10 }]);
  const passed = await lookupDomainMx('example.com');
  assert.equal(passed.result, 'passed');
  assert.deepEqual(passed.records, ['mx1.example.com']);

  setMxResolverForTests(async () => {
    const error = new Error('not found');
    error.code = 'ENOTFOUND';
    throw error;
  });
  const failed = await lookupDomainMx('missing.example');
  assert.equal(failed.result, 'failed');

  setMxResolverForTests(async () => {
    const error = new Error('refused');
    error.code = 'ECONNREFUSED';
    throw error;
  });
  const unknown = await lookupDomainMx('offline.example');
  assert.equal(unknown.result, 'unknown');
  resetMxResolverForTests();
});

test('inferEmails generates inferred candidates only', async () => {
  const candidates = await inferEmails(workspaceId, companyId, 'Anna', 'Schmidt');
  assert.ok(candidates.length >= 3);
  assert.ok(candidates.length <= 5);
  for (const candidate of candidates) {
    assert.equal(candidate.status, 'inferred');
    assert.ok(candidate.confidence > 0 && candidate.confidence <= 1);
    assert.match(candidate.email, /@nordkap-autoteile\.example$/);
    assert.notEqual(candidate.status, 'valid');
  }
  assert.equal(candidates[0].email, 'anna.schmidt@nordkap-autoteile.example');
  assert.equal(candidates[0].pattern, 'first.last');
});

test('inferEmails supports the object-form worker contract signature', async () => {
  const candidates = await inferEmails({ workspaceId, companyId, firstName: 'Anna', lastName: 'Schmidt' });
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].status, 'inferred');
});

test('inferEmails honours the configured cap', async () => {
  upsertSetting(workspaceId, 'enrichment', { verifyMx: false, maxEmailsPerDomain: 2 });
  const candidates = await inferEmails(workspaceId, companyId, 'Anna', 'Schmidt');
  assert.equal(candidates.length, 2);
  upsertSetting(workspaceId, 'enrichment', { verifyMx: false, maxEmailsPerDomain: 5 });
});

test('inferEmails marks unreliable MX without ever marking valid', async () => {
  upsertSetting(workspaceId, 'enrichment', { verifyMx: true, maxEmailsPerDomain: 3 });
  setMxResolverForTests(async () => {
    const error = new Error('not found');
    error.code = 'ENOTFOUND';
    throw error;
  });
  const candidates = await inferEmails(workspaceId, companyId, 'Anna', 'Schmidt');
  for (const candidate of candidates) {
    assert.equal(candidate.status, 'inferred');
    assert.equal(candidate.mx, 'failed');
    assert.ok(candidate.confidence <= 0.35);
  }
  resetMxResolverForTests();
  upsertSetting(workspaceId, 'enrichment', { verifyMx: false, maxEmailsPerDomain: 5 });
});

test('verifyContactEmail marks a deliverable business address valid and stores checks', async () => {
  const contact = await createContact({ fullName: 'Anna Schmidt', email: 'anna.schmidt@nordkap-autoteile.example', roleCategory: 'decision_maker' });
  setMxResolverForTests(async () => [{ exchange: 'mx.nordkap-autoteile.example', priority: 5 }]);
  const result = await verifyContactEmail({ workspaceId, contactId: contact.id, actorId });
  assert.equal(result.emailStatus, 'valid');
  assert.equal(result.mx, 'passed');
  assert.ok(result.checkedAt);
  const row = get('SELECT email_status, last_verified_at, confidence FROM contacts WHERE id = ?', [contact.id]);
  assert.equal(row.email_status, 'valid');
  assert.ok(row.last_verified_at);
  assert.equal(row.confidence, 'high');
  const checks = get(
    `SELECT GROUP_CONCAT(check_type) AS types FROM data_verifications
      WHERE workspace_id = ? AND entity_type = 'contact' AND entity_id = ?`,
    [workspaceId, contact.id],
  );
  const types = String(checks.types).split(',').sort();
  assert.deepEqual(types, ['disposable', 'domain_mx', 'email_syntax', 'freemail', 'role_account']);
  resetMxResolverForTests();
});

test('verifyContactEmail marks missing MX as invalid', async () => {
  const contact = await createContact({ fullName: 'Ben Weber', email: 'ben.weber@no-mx-domain.example' });
  setMxResolverForTests(async () => {
    const error = new Error('not found');
    error.code = 'ENOTFOUND';
    throw error;
  });
  const result = await verifyContactEmail({ workspaceId, contactId: contact.id, actorId });
  assert.equal(result.emailStatus, 'invalid');
  assert.equal(result.mx, 'failed');
  resetMxResolverForTests();
});

test('verifyContactEmail marks role accounts risky even when MX passes', async () => {
  const contact = await createContact({ fullName: null, email: 'info@nordkap-autoteile.example' });
  setMxResolverForTests(async () => [{ exchange: 'mx.nordkap-autoteile.example', priority: 5 }]);
  const result = await verifyContactEmail({ workspaceId, contactId: contact.id, actorId });
  assert.equal(result.roleAccount, true);
  assert.equal(result.emailStatus, 'risky');
  resetMxResolverForTests();
});

test('verifyContactEmail never promotes an inferred email to valid', async () => {
  const contact = await createContact({
    fullName: 'Clara Hoffmann',
    email: 'clara.hoffmann@nordkap-autoteile.example',
    emailType: 'inferred',
  });
  assert.equal(contact.emailStatus, 'inferred');
  setMxResolverForTests(async () => [{ exchange: 'mx.nordkap-autoteile.example', priority: 5 }]);
  const result = await verifyContactEmail({ workspaceId, contactId: contact.id, actorId });
  assert.equal(result.inferred, true);
  assert.equal(result.emailStatus, 'inferred');
  const row = get('SELECT email_status FROM contacts WHERE id = ?', [contact.id]);
  assert.equal(row.email_status, 'inferred');
  resetMxResolverForTests();
});

test('verify is rejected for contacts without an email', async () => {
  const contact = await createContact({ fullName: 'No Email Person' });
  await assert.rejects(
    () => verifyContactEmail({ workspaceId, contactId: contact.id, actorId }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});
