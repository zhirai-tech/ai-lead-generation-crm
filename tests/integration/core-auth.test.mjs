import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';

test('health endpoint is public and reports initialization', async () => {
  const ctx = await createTestContext();
  try {
    const res = await ctx.request('GET', '/api/v1/health', { anonymous: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.status, 'ok');
    assert.equal(res.body.data.initialized, true);
  } finally {
    await ctx.close();
  }
});

test('unauthenticated API access is rejected with 401', async () => {
  const ctx = await createTestContext();
  try {
    const res = await ctx.request('GET', '/api/v1/companies', { anonymous: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  } finally {
    await ctx.close();
  }
});

test('mutating request without CSRF token is rejected', async () => {
  const ctx = await createTestContext();
  try {
    const res = await ctx.request('PATCH', '/api/v1/workspace', { body: { name: 'Hacked' }, csrf: null });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_FAILED');
  } finally {
    await ctx.close();
  }
});

test('workspace settings can be updated by owner and are persisted', async () => {
  const ctx = await createTestContext();
  try {
    const before = await ctx.request('GET', '/api/v1/settings');
    assert.equal(before.status, 200);
    assert.equal(before.body.data.settings.outreach.requireApproval, true);
    const res = await ctx.request('PATCH', '/api/v1/settings', { body: { outreach: { dailySendLimit: 17 } } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.settings.outreach.dailySendLimit, 17);
    const after = await ctx.request('GET', '/api/v1/settings');
    assert.equal(after.body.data.settings.outreach.dailySendLimit, 17);
  } finally {
    await ctx.close();
  }
});

test('viewer cannot change settings but can read them', async () => {
  const ctx = await createTestContext();
  try {
    const viewer = ctx.createMember({ email: 'viewer@test.local', role: 'viewer', name: '只读成员' });
    ctx.as(viewer);
    const read = await ctx.request('GET', '/api/v1/settings');
    assert.equal(read.status, 200);
    const write = await ctx.request('PATCH', '/api/v1/settings', { body: { outreach: { dailySendLimit: 9 } } });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'FORBIDDEN');
  } finally {
    await ctx.close();
  }
});

test('workspace member management enforces owner-only admin changes', async () => {
  const ctx = await createTestContext();
  try {
    const admin = ctx.createMember({ email: 'admin2@test.local', role: 'admin', name: '管理员二号' });
    ctx.as(admin);
    const createAdmin = await ctx.request('POST', '/api/v1/workspace/members', {
      body: { email: 'admin3@test.local', name: '管理员三号', role: 'admin', password: 'Testpass12345' },
    });
    assert.equal(createAdmin.status, 403);

    ctx.as(ctx.owner);
    const created = await ctx.request('POST', '/api/v1/workspace/members', {
      body: { email: 'admin3@test.local', name: '管理员三号', role: 'admin', password: 'Testpass12345' },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.data.role, 'admin');
  } finally {
    await ctx.close();
  }
});

test('login rejects wrong password and accepts a correct one', async () => {
  const ctx = await createTestContext();
  try {
    const bad = await ctx.request('POST', '/api/v1/auth/login', { anonymous: true, body: { email: 'owner@test.local', password: 'Wrongpass123' } });
    assert.equal(bad.status, 401);
    const good = await ctx.login('owner@test.local');
    assert.equal(good.user.email, 'owner@test.local');
  } finally {
    await ctx.close();
  }
});
