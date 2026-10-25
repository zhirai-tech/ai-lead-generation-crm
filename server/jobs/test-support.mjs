/**
 * OWNER: t-worker. Test support harness for worker/mail tests.
 *
 * Why not use `tests/helpers.mjs` directly? That harness boots the *entire*
 * application (all route modules, including modules being written by other
 * teammates in parallel). While a sibling module is temporarily inconsistent,
 * every test in the repo fails to import. Worker tests only need the job routes,
 * so this harness boots the same infrastructure (temp DB, migrations, secret,
 * real HTTP server via the shared Router/createApp) with just `/api/v1/jobs`
 * mounted. Full-app integration remains covered by the Lead's helpers.
 *
 * NOT used by production code.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as baseConfig, ensureRuntimeDirs } from '../config.mjs';
import { closeDatabase, migrate, openDatabase, run } from '../core/db.mjs';
import { setSecretForTests } from '../core/secrets.mjs';
import { createLogger } from '../core/logger.mjs';
import { Router, createApp } from '../core/http.mjs';
import { bootstrapWorkspace, createSession } from '../core/auth.mjs';
import { hashPassword } from '../core/crypto.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { ensureWorkspaceDefaults } from '../services/settings.mjs';
import { mount as mountJobsRoutes } from '../routes/jobs.mjs';

const DEFAULT_PASSWORD = 'Testpass12345';

function cookieValue(setCookies, name) {
  for (const cookie of setCookies || []) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return null;
}

/**
 * @param {{withServer?: boolean}} [options]
 */
export async function createWorkerTestContext({ withServer = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-worker-test-'));
  const cfg = {
    ...baseConfig,
    dataDir: dir,
    dbFile: path.join(dir, 'test.sqlite'),
    uploadsDir: path.join(dir, 'uploads'),
    logsDir: path.join(dir, 'logs'),
    secretFile: path.join(dir, 'secret.key'),
    publicBaseUrl: 'http://127.0.0.1:1',
    sessionTtlHours: 2,
    worker: { enabled: false, pollMs: 100 },
    globalSendPaused: false,
    logLevel: 'silent',
  };
  ensureRuntimeDirs(cfg);
  setSecretForTests(randomBytes(48));
  const db = openDatabase(cfg.dbFile);
  const migrationsDir = path.join(baseConfig.rootDir, 'server', 'db', 'migrations');
  const allowlist = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  migrate(db, migrationsDir, { allowlist, expectedDbPath: cfg.dbFile, actualDbPath: cfg.dbFile });
  const logger = createLogger({ level: 'silent' });

  const boot = bootstrapWorkspace({
    workspaceName: 'Worker 测试空间',
    email: `owner-${randomBytes(4).toString('hex')}@test.local`,
    password: DEFAULT_PASSWORD,
    name: '测试管理员',
  });
  ensureWorkspaceDefaults(boot.workspace.id);

  const ctx = {
    db,
    config: cfg,
    dir,
    logger,
    workspace: boot.workspace,
    workspaceId: boot.workspace.id,
    user: boot.user,
    auth: { token: boot.session.token, csrf: boot.session.csrfToken },
    server: null,
    baseUrl: null,
    async request(method, apiPath, { body, token, csrf, anonymous = false, headers = {} } = {}) {
      const requestHeaders = { Accept: 'application/json', ...headers };
      const upper = method.toUpperCase();
      const authToken = anonymous ? null : token === undefined ? ctx.auth.token : token;
      if (authToken) requestHeaders.Cookie = `${cfg.cookies.session}=${encodeURIComponent(authToken)}`;
      if (body !== undefined) {
        requestHeaders['Content-Type'] = 'application/json';
        if (!['GET', 'HEAD', 'OPTIONS'].includes(upper) && authToken) {
          const csrfToken = csrf === undefined ? ctx.auth.csrf : csrf;
          if (csrfToken) requestHeaders['X-CSRF-Token'] = csrfToken;
        }
      }
      const response = await fetch(`${ctx.baseUrl}${apiPath}`, {
        method: upper,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, text, headers: response.headers, setCookies };
    },
    as(auth) {
      ctx.auth = { token: auth.token, csrf: auth.csrfToken || auth.csrf || null };
    },
    resetAuth() {
      ctx.auth = { token: boot.session.token, csrf: boot.session.csrfToken };
    },
    createMember({ email, role = 'member', workspaceId = null } = {}) {
      const targetWorkspace = workspaceId || boot.workspace.id;
      const userId = id('usr');
      const now = nowIso();
      run(
        `INSERT INTO users (id, email, password_hash, name, locale, is_active, created_at, updated_at)
         VALUES (?, ?, ?, '成员', 'zh-CN', 1, ?, ?)`,
        [userId, email, hashPassword(DEFAULT_PASSWORD), now, now],
      );
      run(
        `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [id('mem'), targetWorkspace, userId, role, now, now],
      );
      const session = createSession(userId, targetWorkspace);
      return { userId, workspaceId: targetWorkspace, email, role, token: session.token, csrfToken: session.csrfToken };
    },
    createWorkspace({ email = `other-${randomBytes(4).toString('hex')}@test.local` } = {}) {
      const workspaceId = id('wsp');
      const userId = id('usr');
      const now = nowIso();
      run(
        `INSERT INTO users (id, email, password_hash, name, locale, is_active, created_at, updated_at)
         VALUES (?, ?, ?, '隔离管理员', 'zh-CN', 1, ?, ?)`,
        [userId, email, hashPassword(DEFAULT_PASSWORD), now, now],
      );
      run(
        `INSERT INTO workspaces (id, name, slug, status, settings_json, created_at, updated_at)
         VALUES (?, '隔离工作空间', ?, 'active', '{}', ?, ?)`,
        [workspaceId, `ws-${workspaceId.slice(-8).toLowerCase()}`, now, now],
      );
      run(
        `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
        [id('mem'), workspaceId, userId, now, now],
      );
      ensureWorkspaceDefaults(workspaceId);
      const session = createSession(userId, workspaceId);
      return { workspaceId, userId, email, token: session.token, csrfToken: session.csrfToken };
    },
    async close() {
      if (ctx.server) await new Promise((resolve) => ctx.server.close(resolve));
      closeDatabase();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore Windows cleanup failures
      }
    },
  };
  ctx.owner = {
    userId: boot.user.id,
    workspaceId: boot.workspace.id,
    token: boot.session.token,
    csrf: boot.session.csrfToken,
    email: boot.user.email,
    password: DEFAULT_PASSWORD,
  };

  if (withServer) {
    const router = new Router();
    mountJobsRoutes(router);
    const handler = createApp({ router, config: cfg, logger, db });
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    ctx.server = server;
    const port = server.address().port;
    cfg.publicBaseUrl = `http://127.0.0.1:${port}`;
    ctx.baseUrl = cfg.publicBaseUrl;
  }
  return ctx;
}

export { DEFAULT_PASSWORD, cookieValue, createWorkerTestContext as createTestContext };
