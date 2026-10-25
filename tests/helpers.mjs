/**
 * Test harness: isolated temp SQLite database, migrations, a real HTTP server on
 * an ephemeral port and helpers for sessions / tenancy tests.
 *
 * Usage:
 *   import { createTestContext } from '../helpers.mjs';
 *   const ctx = await createTestContext();
 *   const res = await ctx.request('GET', '/api/v1/companies');
 *   await ctx.close();
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as baseConfig, ensureRuntimeDirs } from '../server/config.mjs';
import { closeDatabase, migrate, openDatabase, run } from '../server/core/db.mjs';
import { setSecretForTests } from '../server/core/secrets.mjs';
import { createLogger } from '../server/core/logger.mjs';
import { createServerApp } from '../server/app.mjs';
import { bootstrapWorkspace, createSession } from '../server/core/auth.mjs';
import { hashPassword } from '../server/core/crypto.mjs';
import { id } from '../server/core/ids.mjs';
import { nowIso } from '../server/core/time.mjs';
import { ensureWorkspaceDefaults } from '../server/services/settings.mjs';
import { resetAll as resetRateLimiter } from '../server/core/rate-limit.mjs';

const DEFAULT_PASSWORD = 'Testpass12345';

function cookieValue(setCookies, name) {
  for (const cookie of setCookies || []) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return null;
}

export async function createTestContext({ initialize = true, setupBody = {} } = {}) {
  resetRateLimiter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-test-'));
  const cfg = {
    ...baseConfig,
    dataDir: dir,
    dbFile: path.join(dir, 'test.sqlite'),
    uploadsDir: path.join(dir, 'uploads'),
    logsDir: path.join(dir, 'logs'),
    secretFile: path.join(dir, 'secret.key'),
    publicBaseUrl: 'http://127.0.0.1:1',
    sessionTtlHours: 2,
    worker: { enabled: false, pollMs: 1000 },
    logLevel: 'silent',
  };
  ensureRuntimeDirs(cfg);
  setSecretForTests(randomBytes(48));
  const db = openDatabase(cfg.dbFile);
  const migrationsDir = path.join(baseConfig.rootDir, 'server', 'db', 'migrations');
  const allowlist = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  migrate(db, migrationsDir, { allowlist, expectedDbPath: cfg.dbFile, actualDbPath: cfg.dbFile });

  const logger = createLogger({ level: 'silent' });
  const server = createServerApp({ config: cfg, logger, db });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  cfg.publicBaseUrl = `http://127.0.0.1:${port}`;

  const ctx = {
    db,
    config: cfg,
    dir,
    server,
    baseUrl: cfg.publicBaseUrl,
    auth: { token: null, csrf: null },
    owner: null,
    async request(method, apiPath, { body, token, csrf, anonymous = false, headers = {}, raw = false } = {}) {
      const requestHeaders = { Accept: 'application/json', ...headers };
      const upper = method.toUpperCase();
      const authToken = anonymous ? null : token === undefined ? ctx.auth.token : token;
      if (authToken) requestHeaders.Cookie = `${cfg.cookies.session}=${encodeURIComponent(authToken)}`;
      if (body !== undefined) {
        if (typeof body === 'string') {
          requestHeaders['Content-Type'] = headers['Content-Type'] || 'text/plain';
        } else {
          requestHeaders['Content-Type'] = 'application/json';
        }
      }
      const csrfToken = csrf === undefined ? ctx.auth.csrf : csrf;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(upper) && authToken && csrfToken) {
        requestHeaders['X-CSRF-Token'] = csrfToken;
      }
      const response = await fetch(`${ctx.baseUrl}${apiPath}`, {
        method: upper,
        headers: requestHeaders,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      const text = await response.text();
      let parsed = null;
      if (!raw) {
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed, text, headers: response.headers, setCookies };
    },
    async login(email, password = DEFAULT_PASSWORD) {
      const response = await ctx.request('POST', '/api/v1/auth/login', { body: { email, password }, anonymous: true });
      if (response.status !== 200) throw new Error(`login failed: ${response.status} ${response.text}`);
      const token = cookieValue(response.setCookies, cfg.cookies.session);
      const csrf = cookieValue(response.setCookies, cfg.cookies.csrf);
      ctx.auth = { token, csrf };
      return response.body.data;
    },
    as(auth) {
      ctx.auth = { token: auth.token, csrf: auth.csrfToken || auth.csrf || null };
    },
    /** Create an additional user in the current workspace directly in the DB. */
    createMember({ email, password = DEFAULT_PASSWORD, name = '成员', role = 'member', workspaceId = null } = {}) {
      const targetWorkspace = workspaceId || ctx.owner.workspaceId;
      const userId = id('usr');
      const now = nowIso();
      run(
        `INSERT INTO users (id, email, password_hash, name, locale, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'zh-CN', 1, ?, ?)`,
        [userId, email, hashPassword(password), name, now, now],
      );
      run(
        `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [id('mem'), targetWorkspace, userId, role, now, now],
      );
      const session = createSession(userId, targetWorkspace);
      return { userId, workspaceId: targetWorkspace, email, password, role, token: session.token, csrfToken: session.csrfToken };
    },
    /** Create a completely separate workspace with its own owner (tenancy tests). */
    createWorkspace({ name = '隔离工作空间', email = `owner-${randomBytes(4).toString('hex')}@test.local`, password = DEFAULT_PASSWORD, userName = '隔离管理员' } = {}) {
      const workspaceId = id('wsp');
      const userId = id('usr');
      const now = nowIso();
      run(
        `INSERT INTO users (id, email, password_hash, name, locale, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'zh-CN', 1, ?, ?)`,
        [userId, email, hashPassword(password), userName, now, now],
      );
      run(
        `INSERT INTO workspaces (id, name, slug, status, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
        [workspaceId, name, `ws-${workspaceId.slice(-8).toLowerCase()}`, now, now],
      );
      run(
        `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
        [id('mem'), workspaceId, userId, now, now],
      );
      ensureWorkspaceDefaults(workspaceId);
      const session = createSession(userId, workspaceId);
      return { workspaceId, userId, email, password, token: session.token, csrfToken: session.csrfToken };
    },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        // Node's fetch keeps keep-alive sockets; close them so the test process exits.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      closeDatabase();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures on Windows
      }
    },
  };

  if (initialize) {
    const response = await ctx.request('POST', '/api/v1/auth/setup', {
      anonymous: true,
      csrf: false,
      body: {
        workspaceName: '测试工作空间',
        name: '测试管理员',
        email: 'owner@test.local',
        password: DEFAULT_PASSWORD,
        ...setupBody,
      },
    });
    if (response.status !== 200) {
      await ctx.close();
      throw new Error(`setup failed: ${response.status} ${response.text}`);
    }
    const token = cookieValue(response.setCookies, cfg.cookies.session);
    const csrf = cookieValue(response.setCookies, cfg.cookies.csrf);
    ctx.auth = { token, csrf };
    ctx.owner = {
      userId: response.body.data.user.id,
      workspaceId: response.body.data.workspace.id,
      token,
      csrf,
      email: 'owner@test.local',
      password: DEFAULT_PASSWORD,
    };
  }

  return ctx;
}

/** Directly bootstrap a workspace without HTTP (used by unit tests). */
export function bootstrapTestWorkspace({ workspaceName = '单元测试空间', email = 'unit@test.local', password = DEFAULT_PASSWORD } = {}) {
  const result = bootstrapWorkspace({ workspaceName, email, password, name: '单元管理员' });
  ensureWorkspaceDefaults(result.workspace.id);
  return { ...result, password };
}

export { DEFAULT_PASSWORD };
