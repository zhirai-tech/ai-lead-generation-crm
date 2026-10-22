/**
 * Authentication routes (Lead-owned).
 */
import { all, run } from '../core/db.mjs';
import {
  authenticate,
  bootstrapWorkspace,
  changePassword,
  createApiKey,
  hasUsers,
  publicMembership,
  publicUser,
  publicWorkspace,
  resolveSession,
  revokeSessionByToken,
  revokeUserSessions,
  ROLES,
} from '../core/auth.mjs';
import { unauthorized, badRequest, conflict } from '../core/errors.mjs';
import { asEmail, asString } from '../core/validate.mjs';
import { ensureWorkspaceDefaults } from '../services/settings.mjs';
import { recordAudit } from '../core/audit.mjs';

const RATE_LOGIN = { windowMs: 60_000, max: 10 };
const RATE_SETUP = { windowMs: 60_000, max: 5 };

function sessionPayload(ctx) {
  return {
    initialized: true,
    user: publicUser(ctx.user),
    workspace: publicWorkspace(ctx.workspace),
    membership: publicMembership(ctx.membership),
    csrfToken: ctx.cookies[ctx.config.cookies.csrf] || null,
    authType: ctx.authType,
  };
}

export function mount(router) {
  router.get(
    '/api/v1/auth/status',
    async (ctx) => {
      const initialized = hasUsers();
      if (!initialized) return { initialized: false, user: null, workspace: null, membership: null };
      if (!ctx.user) return { initialized: true, user: null, workspace: null, membership: null };
      return sessionPayload(ctx);
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/v1/auth/me',
    async (ctx) => sessionPayload(ctx),
    { auth: 'required' },
  );

  router.post(
    '/api/v1/auth/setup',
    async (ctx) => {
      const body = ctx.body || {};
      const workspaceName = asString(body.workspaceName, { required: true, max: 100, label: '工作空间名称' });
      const name = asString(body.name, { max: 80, label: '姓名' });
      const email = asEmail(body.email);
      const password = asString(body.password, { required: true, min: 10, max: 200, label: '密码', trim: false });
      const result = bootstrapWorkspace({
        workspaceName,
        email,
        password,
        name,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      ensureWorkspaceDefaults(result.workspace.id);
      ctx.setAuthCookies(result.session.token, result.session.csrfToken, result.session.expiresAt);
      const payload = sessionPayload({
        ...ctx,
        user: result.user,
        workspace: result.workspace,
        membership: result.membership,
      });
      payload.csrfToken = result.session.csrfToken;
      return payload;
    },
    { auth: 'public', csrf: false, rateLimit: RATE_SETUP },
  );

  router.post(
    '/api/v1/auth/login',
    async (ctx) => {
      const body = ctx.body || {};
      const email = asEmail(body.email);
      const password = asString(body.password, { required: true, max: 200, label: '密码', trim: false });
      const workspaceId = body.workspaceId ? asString(body.workspaceId, { max: 100, label: '工作空间' }) : null;
      const result = authenticate({ email, password, workspaceId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
      ensureWorkspaceDefaults(result.membership.workspace_id);
      ctx.setAuthCookies(result.session.token, result.session.csrfToken, result.session.expiresAt);
      return {
        initialized: true,
        user: publicUser(result.user),
        workspace: publicWorkspace(result.workspace),
        membership: publicMembership(result.membership),
        memberships: result.memberships.map((membership) => ({
          workspaceId: membership.workspace_id,
          workspaceName: membership.workspace_name,
          role: membership.role,
        })),
        csrfToken: result.session.csrfToken,
      };
    },
    { auth: 'public', csrf: false, rateLimit: RATE_LOGIN },
  );

  router.post(
    '/api/v1/auth/logout',
    async (ctx) => {
      const token = ctx.cookies[ctx.config.cookies.session];
      if (token) revokeSessionByToken(token);
      ctx.clearAuthCookies();
      return { loggedOut: true };
    },
    { auth: 'optional', csrf: false },
  );

  router.post(
    '/api/v1/auth/password',
    async (ctx) => {
      const body = ctx.body || {};
      const currentPassword = asString(body.currentPassword, { required: true, max: 200, label: '当前密码', trim: false });
      const newPassword = asString(body.newPassword, { required: true, min: 10, max: 200, label: '新密码', trim: false });
      changePassword(ctx.user.id, currentPassword, newPassword, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      ctx.clearAuthCookies();
      return { requiresRelogin: true };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/auth/sessions',
    async (ctx) => {
      const currentToken = ctx.cookies[ctx.config.cookies.session];
      const current = currentToken ? resolveSession(currentToken) : null;
      const rows = all(
        `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at
           FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY last_seen_at DESC`,
        [ctx.user.id, new Date().toISOString()],
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          ip: row.ip,
          userAgent: row.user_agent,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          expiresAt: row.expires_at,
          current: Boolean(current && current.session.id === row.id),
        })),
      };
    },
    { auth: 'required' },
  );

  router.delete(
    '/api/v1/auth/sessions/:id',
    async (ctx) => {
      const sessionId = asString(ctx.params.id, { required: true, max: 100 });
      const row = all('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [sessionId, ctx.user.id])[0];
      if (!row) throw badRequest('会话不存在');
      run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', [new Date().toISOString(), sessionId, ctx.user.id]);
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'auth.session_revoked', entityType: 'session', entityId: sessionId, ip: ctx.ip, requestId: ctx.requestId });
      return { revoked: true };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/auth/api-keys',
    async (ctx) => {
      const rows = all(
        `SELECT id, name, key_prefix, scopes_json, last_used_at, expires_at, revoked_at, created_at
           FROM api_keys WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC`,
        [ctx.workspace.id, ctx.user.id],
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.key_prefix,
          scopes: JSON.parse(row.scopes_json || '[]'),
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
          createdAt: row.created_at,
        })),
      };
    },
    { auth: 'required' },
  );

  router.post(
    '/api/v1/auth/api-keys',
    async (ctx) => {
      ctx.requireCapability('credentials.manage');
      const body = ctx.body || {};
      const name = asString(body.name, { required: true, max: 80, label: '名称' });
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope) => typeof scope === 'string').slice(0, 20) : [];
      const key = createApiKey(ctx.workspace.id, ctx.user.id, { name, scopes });
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'api_key.create', entityType: 'api_key', entityId: key.id, after: { name, scopes }, ip: ctx.ip, requestId: ctx.requestId });
      return { id: key.id, name: key.name, token: key.token, scopes: key.scopes, note: '令牌仅显示一次，请立即保存' };
    },
    { auth: 'required' },
  );

  router.delete(
    '/api/v1/auth/api-keys/:id',
    async (ctx) => {
      ctx.requireCapability('credentials.manage');
      const row = all('SELECT id, name FROM api_keys WHERE id = ? AND workspace_id = ?', [ctx.params.id, ctx.workspace.id])[0];
      if (!row) throw badRequest('API 密钥不存在');
      run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'api_key.revoke', entityType: 'api_key', entityId: row.id, before: { name: row.name }, ip: ctx.ip, requestId: ctx.requestId });
      return { revoked: true };
    },
    { auth: 'required' },
  );
}
