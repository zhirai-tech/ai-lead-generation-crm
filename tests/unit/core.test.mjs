import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid, id, isId } from '../../server/core/ids.mjs';
import { hashPassword, verifyPassword, encryptCredential, decryptCredential, signToken, verifyToken, loadSecret, sha256Hex } from '../../server/core/crypto.mjs';
import { asEmail, normalizeDomain, normalizeEmail, parsePagination, validateInput } from '../../server/core/validate.mjs';
import { consume, resetAll } from '../../server/core/rate-limit.mjs';
import { openDatabase, closeDatabase, tx, run, get } from '../../server/core/db.mjs';
import { roleCan, capabilityList } from '../../server/core/auth.mjs';

test('ULID ids are sortable, prefixed and unique', () => {
  const first = ulid();
  const second = ulid();
  assert.equal(first.length, 26);
  assert.equal(second.length, 26);
  assert.ok(first <= second);
  assert.ok(isId(id('cmp'), 'cmp'));
  const set = new Set(Array.from({ length: 500 }, () => id('x')));
  assert.equal(set.size, 500);
});

test('password hashing verifies correctly and rejects wrong passwords', () => {
  const hash = hashPassword('StrongPass123');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('StrongPass123', hash), true);
  assert.equal(verifyPassword('StrongPass124', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('credential encryption is bound to its context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-crypto-'));
  const secret = loadSecret(path.join(dir, 'secret.key'));
  const sealed = encryptCredential(secret, 'wsp:ai:provider', { apiKey: 'sk-test-123' });
  assert.equal(decryptCredential(secret, 'wsp:ai:provider', sealed).apiKey, 'sk-test-123');
  assert.throws(() => decryptCredential(secret, 'other:ai:provider', sealed));
  assert.ok(fs.existsSync(path.join(dir, 'secret.key')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('signed tokens verify and expire', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-token-'));
  const secret = loadSecret(path.join(dir, 'secret.key'));
  const token = signToken(secret, { w: 'wsp_1', e: 'a@b.example' }, { expiresInDays: 1 });
  const payload = verifyToken(secret, token);
  assert.equal(payload.w, 'wsp_1');
  assert.equal(payload.e, 'a@b.example');
  const expired = signToken(secret, { w: 'wsp_1' }, { expiresInDays: -1 });
  assert.equal(verifyToken(secret, expired), null);
  assert.equal(verifyToken(secret, 'tampered.token'), null);
  assert.equal(sha256Hex('abc').length, 64);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validation normalises emails and domains and rejects invalid input', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
  assert.equal(asEmail('Foo@Example.COM'), 'foo@example.com');
  assert.throws(() => asEmail('not-an-email'));
  assert.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain('not a domain'), '');
  const parsed = parsePagination(new URLSearchParams('page=2&pageSize=500'));
  assert.equal(parsed.page, 2);
  assert.equal(parsed.pageSize, 100);
  const clean = validateInput({ name: ' Acme ', country: 'de', score: '77' }, {
    name: { type: 'string', required: true, max: 50 },
    country: { type: 'country' },
    score: { type: 'int', min: 0, max: 100 },
  });
  assert.deepEqual(clean, { name: 'Acme', country: 'DE', score: 77 });
  assert.throws(() => validateInput({ name: '' }, { name: { type: 'string', required: true } }));
});

test('rate limiter blocks after the configured maximum', () => {
  resetAll();
  const options = { windowMs: 1000, max: 3 };
  assert.equal(consume('test', options).allowed, true);
  assert.equal(consume('test', options).allowed, true);
  assert.equal(consume('test', options).allowed, true);
  const blocked = consume('test', options);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(consume('other', options).allowed, true);
});

test('database transactions roll back on error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-db-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)');
    run('INSERT INTO t (value) VALUES (?)', ['committed']);
    assert.throws(() =>
      tx(() => {
        run('INSERT INTO t (value) VALUES (?)', ['rolled-back']);
        throw new Error('boom');
      }),
    );
    assert.equal(get('SELECT COUNT(*) AS c FROM t').c, 1);
  } finally {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('role capability matrix separates viewers from writers and admins', () => {
  assert.equal(roleCan('viewer', 'data.read'), true);
  assert.equal(roleCan('viewer', 'data.write'), false);
  assert.equal(roleCan('member', 'data.write'), true);
  assert.equal(roleCan('member', 'settings.manage'), false);
  assert.equal(roleCan('admin', 'settings.manage'), true);
  assert.equal(roleCan('admin', 'backup.run'), false);
  assert.equal(roleCan('owner', 'backup.run'), true);
  assert.ok(capabilityList('owner').includes('workspace.delete'));
});
