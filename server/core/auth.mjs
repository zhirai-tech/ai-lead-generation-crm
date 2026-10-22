/**
 * Authentication and authorisation.
 *
 * Two credential types are supported:
 *  - Browser sessions: random opaque token in an HttpOnly cookie; only its
 *    SHA-256 hash is stored. Sessions are bound to one workspace.
 *  - API keys: `zrk_…` bearer tokens for automation / future MCP access.
 *
 * Authorisation is enforced on the server for every request; the frontend is
 * never trusted to declare its own role or workspace.
 */
import { all, get, run, tx } from './db.mjs';
import { hashPassword, randomToken, sha256Hex, timingSafeEqualString, verifyPassword } from './crypto.mjs';
import { unauthorized, forbidden, conflict, notFound, validationError } from './errors.mjs';
import { id } from './ids.mjs';
import { nowIso, addHours, isPast } from './time.mjs';
import { recordAudit } from './audit.mjs';
import { normalizeEmail } from './validate.mjs';

export const ROLES = ['owner', 'admin', 'member', 'viewer'];
export const ROLE_LABELS = { owner: '拥有者', admin: '管理员', member: '成员', viewer: '只读' };

const ROLE_RANK = { owner: 40, admin: 30, member: 20, viewer: 10 };

const CAPABILITIES = {
  'workspace.read': ['viewer', 'member', 'admin', 'owner'],
  'workspace.update': ['admin', 'owner'],
  'workspace.delete': ['owner'],
  'members.manage': ['admin', 'owner'],
  'settings.read': ['viewer', 'member', 'admin', 'owner'],
  'settings.manage': ['admin', 'owner'],
  'credentials.manage': ['admin', 'owner'],
  'data.read': ['viewer', 'member', 'admin', 'owner'],
  'data.write': ['member', 'admin', 'owner'],
  'data.delete': ['admin', 'owner'],
  'import.run': ['member', 'admin', 'owner'],
  'export.run': ['member', 'admin', 'owner'],
  'discovery.run': ['member', 'admin', 'owner'],
  'agents.run': ['member', 'admin', 'owner'],
  'campaigns.write': ['member', 'admin', 'owner'],
  'drafts.approve': ['member', 'admin', 'owner'],
  'email.accounts.manage': ['admin', 'owner'],
  'email.sync': ['member', 'admin', 'owner'],
  'deals.write': ['member', 'admin', 'owner'],
  'automation.manage': ['member', 'admin', 'owner'],
  'suppression.write': ['member', 'admin', 'owner'],
  'audit.read': ['admin', 'owner'],
  'jobs.read': ['viewer', 'member', 'admin', 'owner'],
  'jobs.manage': ['admin', 'owner'],
  'backup.run': ['owner'],
};

export function roleRank(role) {
  return ROLE_RANK[role] ?? 0;
}

export function roleCan(role, capability) {
  const allowed = CAPABILITIES[capability];
  if (!allowed) return false;
  return allowed.includes(role);
}

export function capabilityList(role) {
  return Object.keys(CAPABILITIES).filter((capability) => roleCan(role, capability)).sort();
}

export function requireCapability(ctx, capability) {
  requireUser(ctx);
  if (!roleCan(ctx.membership?.role, capability)) {
    throw forbidden(`当前角色（${ROLE_LABELS[ctx.membership?.role] || '未知'}）没有该操作权限`);
  }
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function requireWorkspace(ctx) {
  requireUser(ctx);
  if (!ctx.workspace) throw forbidden('当前会话没有关联工作空间');
  return ctx.workspace;
}

export function hasUsers() {
  return (get('SELECT COUNT(*) AS c FROM users')?.c ?? 0) > 0;
}

export function findUserByEmail(email) {
  return get('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND is_active = 1', [normalizeEmail(email)]);
}

export function findUserById(userId) {
  return get('SELECT * FROM users WHERE id = ?', [userId]);
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale || 'zh-CN',
    mustChangePassword: Boolean(user.must_change_password),
    lastLoginAt: user.last_login_at || null,
    createdAt: user.created_at,
  };
}

export function publicWorkspace(workspace) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    status: workspace.status,
    createdAt: workspace.created_at,
  };
}

export function publicMembership(membership) {
  if (!membership) return null;
  return {
    workspaceId: membership.workspace_id,
    userId: membership.user_id,
    role: membership.role,
    roleLabel: ROLE_LABELS[membership.role] || membership.role,
    status: membership.status,
    capabilities: capabilityList(membership.role),
  };
}

export function createSessionToken() {
  const token = `zrs_${randomToken(32)}`;
  const csrfToken = randomToken(24);
  return { token, csrfToken, tokenHash: sha256Hex(token), csrfHash: sha256Hex(csrfToken) };
}

export function createSession(userId, workspaceId, { ip = null, userAgent = null, ttlHours = null } = {}) {
  const { token, csrfToken, tokenHash, csrfHash } = createSessionToken();
  const hours = ttlHours || 24 * 7;
  const sessionId = id('ses');
  const now = nowIso();
  run(
    `INSERT INTO sessions (id, user_id, workspace_id, token_hash, csrf_hash, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, workspaceId, tokenHash, csrfHash, ip, userAgent ? String(userAgent).slice(0, 300) : null, now, now, addHours(hours)],
  );
  return { sessionId, token, csrfToken, expiresAt: addHours(hours) };
}

export function revokeSessionByToken(token) {
  if (!token) return false;
  const result = run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [nowIso(), sha256Hex(token)]);
  return result.changes > 0;
}

export function revokeUserSessions(userId, exceptSessionId = null) {
  if (exceptSessionId) {
    return run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [nowIso(), userId, exceptSessionId]).changes;
  }
  return run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]).changes;
}

export function cleanupExpiredSessions() {
  return run("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL", [nowIso()]).changes;
}

/**
 * Resolve a browser session token to an authenticated context.
 * @returns {null | {type:'session', session, user, workspace, membership, csrfHash}}
 */
export function resolveSession(token) {
  if (!token) return null;
  const row = get(
    `SELECT s.id AS session_id, s.csrf_hash, s.expires_at, s.revoked_at, s.last_seen_at,
            u.id AS user_id, u.email, u.name, u.locale, u.is_active, u.last_login_at, u.must_change_password, u.created_at AS user_created_at,
            w.id AS ws_id, w.name AS ws_name, w.slug AS ws_slug, w.status AS ws_status, w.created_at AS ws_created_at,
            m.role, m.status AS membership_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
       LEFT JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = u.id
      WHERE s.token_hash = ?`,
    [sha256Hex(token)],
  );
  if (!row) return null;
  if (row.revoked_at || isPast(row.expires_at)) return null;
  if (!row.is_active || row.membership_status !== 'active') return null;
  if (row.ws_status === 'suspended') return null;
  const now = nowIso();
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, row.session_id]);
  }
  return {
    type: 'session',
    session: { id: row.session_id, expiresAt: row.expires_at, csrfHash: row.csrf_hash },
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      locale: row.locale,
      must_change_password: row.must_change_password,
      last_login_at: row.last_login_at,
      created_at: row.user_created_at,
    },
    workspace: { id: row.ws_id, name: row.ws_name, slug: row.ws_slug, status: row.ws_status, created_at: row.ws_created_at },
    membership: {
      workspace_id: row.ws_id,
      user_id: row.user_id,
      role: row.role || 'viewer',
      status: row.membership_status || 'inactive',
    },
    csrfHash: row.csrf_hash,
  };
}

export function createApiKey(workspaceId, userId, { name = 'API Key', scopes = [] } = {}) {
  const raw = `zrk_${randomToken(32)}`;
  const keyId = id('key');
  const prefix = raw.slice(0, 12);
  run(
    `INSERT INTO api_keys (id, workspace_id, user_id, name, key_prefix, key_hash, scopes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [keyId, workspaceId, userId, name, prefix, sha256Hex(raw), JSON.stringify(scopes), nowIso()],
  );
  return { id: keyId, token: raw, prefix, name, scopes };
}

export function resolveApiKey(token) {
  if (!token || !token.startsWith('zrk_')) return null;
  const row = get(
    `SELECT k.id AS key_id, k.workspace_id, k.scopes_json, k.expires_at, k.revoked_at,
            u.id AS user_id, u.email, u.name, u.locale, u.is_active, u.must_change_password,
            w.id AS ws_id, w.name AS ws_name, w.slug AS ws_slug, w.status AS ws_status,
            m.role, m.status AS membership_status
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       JOIN workspaces w ON w.id = k.workspace_id AND w.deleted_at IS NULL
       LEFT JOIN memberships m ON m.workspace_id = k.workspace_id AND m.user_id = k.user_id
      WHERE k.key_hash = ?`,
    [sha256Hex(token)],
  );
  if (!row) return null;
  if (row.revoked_at || (row.expires_at && isPast(row.expires_at))) return null;
  if (!row.is_active || row.membership_status !== 'active' || row.ws_status === 'suspended') return null;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), row.key_id]);
  return {
    type: 'api_key',
    session: null,
    user: { id: row.user_id, email: row.email, name: row.name, locale: row.locale },
    workspace: { id: row.ws_id, name: row.ws_name, slug: row.ws_slug, status: row.ws_status },
    membership: { workspace_id: row.ws_id, user_id: row.user_id, role: row.role || 'viewer', status: row.membership_status || 'inactive' },
    scopes: JSON.parse(row.scopes_json || '[]'),
    apiKeyId: row.key_id,
  };
}

export function verifyCsrf(auth, headerToken) {
  if (!auth || auth.type !== 'session') return true;
  if (!headerToken) return false;
  return timingSafeEqualString(sha256Hex(headerToken), auth.session.csrfHash);
}

/**
 * First-run bootstrap: create the owner user, workspace, membership and default
 * workspace settings in a single transaction.
 */
export function bootstrapWorkspace({ workspaceName, email, password, name, ip = null, userAgent = null, requestId = null }) {
  if (hasUsers()) throw conflict('系统已经初始化，请直接登录');
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw validationError('邮箱不能为空');
  if (typeof password !== 'string' || password.length < 10) throw validationError('密码至少需要 10 位');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw validationError('密码必须同时包含字母和数字');

  const userId = id('usr');
  const workspaceId = id('wsp');
  const membershipId = id('mem');
  const now = nowIso();
  const slug = `ws-${workspaceId.slice(-8).toLowerCase()}`;
  const passwordHash = hashPassword(password);

  tx(() => {
    run(
      `INSERT INTO users (id, email, password_hash, name, locale, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'zh-CN', 1, ?, ?)`,
      [userId, normalizedEmail, passwordHash, name || normalizedEmail.split('@')[0], now, now],
    );
    run(
      `INSERT INTO workspaces (id, name, slug, status, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
      [workspaceId, workspaceName || '我的工作空间', slug, now, now],
    );
    run(
      `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
      [membershipId, workspaceId, userId, now, now],
    );
    run(
      `INSERT INTO settings (workspace_id, key, value_json, updated_at) VALUES
        (?, 'outreach', ?, ?),
        (?, 'limits', ?, ?),
        (?, 'retention', ?, ?),
        (?, 'ai', ?, ?)`,
      [
        workspaceId, JSON.stringify({ requireApproval: true, autoSendEnabled: false, dailySendLimit: 50, sendWindow: { start: 9, end: 17, weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' } }), now,
        workspaceId, JSON.stringify({ dailyEmailLimit: 50, dailyAiTokens: 500000, hourlyJobLimit: 300 }), now,
        workspaceId, JSON.stringify({ messageDays: 730, contactDays: 1095, jobDays: 30, auditDays: 730 }), now,
        workspaceId, JSON.stringify({ provider: 'simulation', model: 'zhirai-sim-1', temperature: 0.3, maxTokensPerRun: 4096, allowAutoSend: false }), now,
      ],
    );
  });

  const session = createSession(userId, workspaceId, { ip, userAgent });
  recordAudit({ workspaceId, actorType: 'user', actorId: userId, action: 'workspace.bootstrap', entityType: 'workspace', entityId: workspaceId, ip, userAgent, requestId });
  return {
    user: { id: userId, email: normalizedEmail, name: name || normalizedEmail.split('@')[0], locale: 'zh-CN' },
    workspace: { id: workspaceId, name: workspaceName || '我的工作空间', slug, status: 'active' },
    membership: { workspace_id: workspaceId, user_id: userId, role: 'owner', status: 'active' },
    session,
  };
}

export function authenticate({ email, password, workspaceId = null, ip = null, userAgent = null, requestId = null }) {
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordAudit({ workspaceId, actorType: 'anonymous', action: 'auth.login_failed', entityType: 'user', after: { email: normalizeEmail(email) }, ip, userAgent, requestId });
    throw unauthorized('邮箱或密码不正确');
  }
  if (!user.is_active) throw forbidden('账号已被停用');

  const memberships = all(
    `SELECT m.*, w.name AS workspace_name, w.slug AS workspace_slug
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
      WHERE m.user_id = ? AND m.status = 'active'
      ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, m.created_at ASC`,
    [user.id],
  );
  if (!memberships.length) throw forbidden('该账号没有可用的工作空间');
  const membership = workspaceId ? memberships.find((item) => item.workspace_id === workspaceId) : memberships[0];
  if (!membership) throw forbidden('无权访问该工作空间');

  const session = createSession(user.id, membership.workspace_id, { ip, userAgent });
  run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), user.id]);
  recordAudit({ workspaceId: membership.workspace_id, actorType: 'user', actorId: user.id, action: 'auth.login', entityType: 'session', ip, userAgent, requestId });
  return {
    user,
    workspace: { id: membership.workspace_id, name: membership.workspace_name, slug: membership.workspace_slug, status: 'active' },
    membership,
    session,
    memberships,
  };
}

export function changePassword(userId, currentPassword, newPassword, { ip = null, userAgent = null, requestId = null } = {}) {
  const user = findUserById(userId);
  if (!user) throw notFound('用户不存在');
  if (!verifyPassword(currentPassword, user.password_hash)) throw unauthorized('当前密码不正确');
  if (typeof newPassword !== 'string' || newPassword.length < 10) throw validationError('新密码至少需要 10 位');
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) throw validationError('新密码必须同时包含字母和数字');
  if (currentPassword === newPassword) throw validationError('新密码不能与当前密码相同');
  run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', [hashPassword(newPassword), nowIso(), userId]);
  const revoked = revokeUserSessions(userId);
  recordAudit({ workspaceId: null, actorType: 'user', actorId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId, after: { revokedSessions: revoked }, ip, userAgent, requestId });
  return { revokedSessions: revoked };
}

export const DEFAULT_ROLE = 'member';
export { CAPABILITIES };
