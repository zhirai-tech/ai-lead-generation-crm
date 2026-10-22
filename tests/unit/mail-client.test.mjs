/**
 * t-worker unit tests: unified mail-client facade used by the CRM settings page
 * (`services/email-accounts.mjs` discovers `../mail/client.mjs`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { testConnection, verifyAccount, testAccount } from '../../server/mail/client.mjs';
import { resolveSmtpConfig } from '../../server/mail/smtp.mjs';
import { resolveImapConfig } from '../../server/mail/imap.mjs';

test('simulation accounts report a working connection without touching the network', async () => {
  const result = await testConnection({ account: { protocol: 'simulation', address: 'demo@zhirai.example' } });
  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.mode, 'simulation');
});

test('verifyAccount and testAccount are aliases for the CRM discovery contract', () => {
  assert.equal(verifyAccount, testConnection);
  assert.equal(testAccount, testConnection);
});

test('unsupported protocols fail closed with a message', async () => {
  const result = await testConnection({ account: { protocol: 'pop3', address: 'x@y.example' } });
  assert.equal(result.ok, false);
  assert.match(result.message, /不支持的邮箱协议/);
});

test('smtp_imap account without hosts fails closed and reports SMTP detail', async () => {
  const result = await testConnection({
    account: { protocol: 'smtp_imap', address: 'x@y.example' },
    secret: { password: 'secret' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'smtp_imap');
  assert.equal(result.details.smtp.ok, false);
  assert.match(result.message, /SMTP/);
});

test('resolveSmtpConfig understands camelCase accounts, t-crm nested config and secret username', () => {
  const config = resolveSmtpConfig(
    { address: 'sales@zhirai.example', smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true },
    { password: 'pw', username: 'login-user' },
    { smtp: { host: 'smtp.nested.example', port: 587, secure: false }, signature: 'ZHIRAI' },
  );
  assert.equal(config.host, 'smtp.nested.example');
  assert.equal(config.port, 587);
  assert.equal(config.secure, false);
  assert.equal(config.username, 'login-user');
  assert.equal(config.password, 'pw');
});

test('resolveImapConfig understands camelCase accounts and t-crm nested config', () => {
  const config = resolveImapConfig(
    { address: 'sales@zhirai.example', imapHost: 'imap.example.com', imapPort: 993, imapSecure: true },
    { password: 'pw' },
    { imap: { host: 'imap.nested.example', port: 143, secure: false } },
  );
  assert.equal(config.host, 'imap.nested.example');
  assert.equal(config.port, 143);
  assert.equal(config.secure, false);
  assert.equal(config.username, 'sales@zhirai.example');
  assert.equal(config.password, 'pw');
});
