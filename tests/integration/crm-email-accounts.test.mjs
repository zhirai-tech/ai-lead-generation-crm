/**
 * Email account integration: encrypted credentials at rest, masked API output,
 * simulation connection test, sync queueing and permissions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { get } from '../../server/core/db.mjs';
import { loadSendAccount } from '../../server/services/email-accounts.mjs';

const PASSWORD = 'super-secret-app-password-123';

test('email accounts: simulation account CRUD and masked output', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const created = await ctx.request('POST', '/api/v1/email-accounts', {
    body: { name: '模拟销售邮箱', address: 'sales@zhirai.test', protocol: 'simulation', dailyLimit: 40 },
  });
  assert.equal(created.status, 200, created.text);
  const account = created.body.data;
  assert.equal(account.protocol, 'simulation');
  assert.equal(account.dailyLimit, 40);
  assert.equal(account.hasCredential, false);
  assert.ok(!/password/i.test(created.text), 'API must not leak password fields');

  const duplicate = await ctx.request('POST', '/api/v1/email-accounts', {
    body: { name: '重复', address: 'SALES@zhirai.test', protocol: 'simulation' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'CONFLICT');

  const testConnection = await ctx.request('POST', `/api/v1/email-accounts/${account.id}/test-connection`, { body: {} });
  assert.equal(testConnection.status, 200, testConnection.text);
  assert.equal(testConnection.body.data.ok, true);
  assert.equal(testConnection.body.data.mode, 'simulation');

  const sync = await ctx.request('POST', `/api/v1/email-accounts/${account.id}/sync`, { body: {} });
  assert.equal(sync.status, 200, sync.text);
  assert.equal(typeof sync.body.data.queued, 'boolean');

  const updated = await ctx.request('PATCH', `/api/v1/email-accounts/${account.id}`, { body: { dailyLimit: 25, status: 'paused' } });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.body.data.dailyLimit, 25);
  assert.equal(updated.body.data.status, 'paused');

  const removed = await ctx.request('DELETE', `/api/v1/email-accounts/${account.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await ctx.request('GET', `/api/v1/email-accounts/${account.id}`)).status, 404);
});

test('email accounts: SMTP credentials are AES-GCM encrypted and never returned in plaintext', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const workspaceId = ctx.owner.workspaceId;

  const created = await ctx.request('POST', '/api/v1/email-accounts', {
    body: {
      name: 'SMTP 邮箱',
      address: 'outreach@zhirai.test',
      protocol: 'smtp_imap',
      smtpHost: 'smtp.zhirai.test',
      smtpPort: 465,
      smtpSecure: true,
      imapHost: 'imap.zhirai.test',
      imapPort: 993,
      username: 'outreach@zhirai.test',
      password: PASSWORD,
      signature: 'ZHIRAI Sales',
    },
  });
  assert.equal(created.status, 200, created.text);
  const account = created.body.data;
  assert.equal(account.hasCredential, true);
  assert.ok(account.credentialPreview);
  assert.ok(!created.text.includes(PASSWORD), 'plaintext password must not be returned');

  const row = get('SELECT * FROM email_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, account.id]);
  assert.ok(row.credential_enc.startsWith('v1.'), 'credential must be sealed with v1 envelope');
  assert.ok(!row.credential_enc.includes(PASSWORD));
  assert.notEqual(row.credential_enc, PASSWORD);

  const loaded = loadSendAccount(workspaceId, account.id);
  assert.ok(loaded);
  assert.equal(loaded.secret.password, PASSWORD);
  assert.equal(loaded.config.signature, 'ZHIRAI Sales');
  assert.equal(loaded.account.address, 'outreach@zhirai.test');

  // Updating without a password keeps the existing credential usable.
  const patched = await ctx.request('PATCH', `/api/v1/email-accounts/${account.id}`, { body: { name: 'SMTP 主邮箱' } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(loadSendAccount(workspaceId, account.id).secret.password, PASSWORD);

  // A non-simulation connection test degrades to a clear result when the mail
  // client (t-worker) is not present yet.
  const tested = await ctx.request('POST', `/api/v1/email-accounts/${account.id}/test-connection`, { body: {} });
  assert.equal(tested.status, 200, tested.text);
  assert.equal(typeof tested.body.data.ok, 'boolean');

  const list = await ctx.request('GET', '/api/v1/email-accounts');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(PASSWORD));
  assert.equal(list.body.data.items.length, 1);
});

test('email accounts: permissions and tenancy', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const created = await ctx.request('POST', '/api/v1/email-accounts', {
    body: { name: 'owner account', address: 'owner-acc@zhirai.test', protocol: 'simulation' },
  });
  const accountId = created.body.data.id;

  const member = ctx.createMember({ email: 'member-mail@test.local', role: 'member' });
  ctx.as(member);
  assert.equal((await ctx.request('POST', '/api/v1/email-accounts', { body: { name: 'x', address: 'x@zhirai.test', protocol: 'simulation' } })).status, 403);
  assert.equal((await ctx.request('PATCH', `/api/v1/email-accounts/${accountId}`, { body: { name: 'y' } })).status, 403);
  // Members can still trigger a sync (email.sync capability).
  assert.equal((await ctx.request('POST', `/api/v1/email-accounts/${accountId}/sync`, { body: {} })).status, 200);

  const other = ctx.createWorkspace({ name: '隔离空间' });
  ctx.as(other);
  assert.equal((await ctx.request('GET', `/api/v1/email-accounts/${accountId}`)).status, 404);
  assert.equal((await ctx.request('GET', '/api/v1/email-accounts')).body.data.items.length, 0);
});
