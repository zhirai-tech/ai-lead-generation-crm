/**
 * Suppression list integration: CRUD, normalisation, dedupe, permissions and
 * tenancy isolation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';

test('suppression: create, dedupe, list and reason/labels', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const created = await ctx.request('POST', '/api/v1/suppression', {
    body: { scope: 'email', value: 'Buyer@Example.COM', reason: 'unsubscribe', note: '客户回复退订' },
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.body.data.created, true);
  assert.equal(created.body.data.record.valueNormalized, 'buyer@example.com');
  assert.equal(created.body.data.record.reason, 'unsubscribe');
  assert.equal(created.body.data.record.reasonLabel, '客户退订');

  // Idempotent de-dupe by (scope, normalized value).
  const duplicate = await ctx.request('POST', '/api/v1/suppression', {
    body: { scope: 'email', value: 'buyer@example.com', reason: 'manual' },
  });
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.body.data.created, false);
  assert.equal(duplicate.body.data.record.id, created.body.data.record.id);

  const domain = await ctx.request('POST', '/api/v1/suppression', {
    body: { scope: 'domain', value: 'https://www.Example.com/about', reason: 'do_not_contact' },
  });
  assert.equal(domain.status, 200, domain.text);
  assert.equal(domain.body.data.record.valueNormalized, 'example.com');

  const list = await ctx.request('GET', '/api/v1/suppression?scope=email');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].valueNormalized, 'buyer@example.com');

  const invalid = await ctx.request('POST', '/api/v1/suppression', { body: { scope: 'email', value: 'not-an-email', reason: 'manual' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
});

test('suppression: only owner/admin can delete', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const member = ctx.createMember({ email: 'member-suppression@test.local', role: 'member' });
  const admin = ctx.createMember({ email: 'admin-suppression@test.local', role: 'admin' });

  const created = await ctx.request('POST', '/api/v1/suppression', { body: { scope: 'email', value: 'blocked@example.com', reason: 'manual' } });
  const suppressionId = created.body.data.record.id;

  ctx.as(member);
  const denied = await ctx.request('DELETE', `/api/v1/suppression/${suppressionId}`);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');

  // A viewer can read but not write.
  const viewer = ctx.createMember({ email: 'viewer-suppression@test.local', role: 'viewer' });
  ctx.as(viewer);
  assert.equal((await ctx.request('GET', '/api/v1/suppression')).status, 200);
  assert.equal((await ctx.request('POST', '/api/v1/suppression', { body: { scope: 'email', value: 'x@example.com', reason: 'manual' } })).status, 403);

  ctx.as(admin);
  const removed = await ctx.request('DELETE', `/api/v1/suppression/${suppressionId}`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.data.removed, true);
  assert.equal((await ctx.request('GET', '/api/v1/suppression')).body.data.items.length, 0);
});

test('suppression: records are workspace isolated', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const other = ctx.createWorkspace({ name: '隔离空间' });
  const mine = await ctx.request('POST', '/api/v1/suppression', { body: { scope: 'email', value: 'isolated@example.com', reason: 'manual' } });
  assert.equal(mine.status, 200);

  ctx.as(other);
  assert.equal((await ctx.request('GET', '/api/v1/suppression')).body.data.items.length, 0);
  assert.equal((await ctx.request('DELETE', `/api/v1/suppression/${mine.body.data.record.id}`)).status, 404);
});
