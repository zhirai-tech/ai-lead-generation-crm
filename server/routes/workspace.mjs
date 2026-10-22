/** Workspace profile and membership management (Lead-owned). */
import { all, get, run, tx } from '../core/db.mjs';
import { hashPassword } from '../core/crypto.mjs';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.mjs';
import { asEmail, asEnum, asString } from '../core/validate.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { ROLE_LABELS, ROLES, publicMembership } from '../core/auth.mjs';
import { recordAudit } from '../core/audit.mjs';

function memberRow(row) {
  return {
    userId: row.user_id,
    membershipId: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] || row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function assertOwnerExists(workspaceId) {
  const owner = get("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner' AND status = 'active'", [workspaceId]);
  if (!owner) throw conflict('工作空间必须至少保留一位拥有者');
  return owner.user_id;
}

export function mount(router) {
  router.get(
    '/api/v1/workspace',
    async (ctx) => {
      const counts = {
        members: get("SELECT COUNT(*) AS c FROM memberships WHERE workspace_id = ? AND status = 'active'", [ctx.workspace.id])?.c ?? 0,
        companies: get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ? AND deleted_at IS NULL', [ctx.workspace.id])?.c ?? 0,
        contacts: get('SELECT COUNT(*) AS c FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL', [ctx.workspace.id])?.c ?? 0,
        products: get('SELECT COUNT(*) AS c FROM products WHERE workspace_id = ? AND deleted_at IS NULL', [ctx.workspace.id])?.c ?? 0,
      };
      return {
        workspace: {
          id: ctx.workspace.id,
          name: ctx.workspace.name,
          slug: ctx.workspace.slug,
          status: ctx.workspace.status,
          createdAt: ctx.workspace.created_at || ctx.workspace.createdAt,
        },
        membership: publicMembership(ctx.membership),
        counts,
      };
    },
    { auth: 'required' },
  );

  router.patch(
    '/api/v1/workspace',
    async (ctx) => {
      ctx.requireCapability('workspace.update');
      const name = asString(ctx.body?.name, { required: true, max: 100, label: '工作空间名称' });
      run('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?', [name, nowIso(), ctx.workspace.id]);
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'workspace.update', entityType: 'workspace', entityId: ctx.workspace.id, before: { name: ctx.workspace.name }, after: { name }, ip: ctx.ip, requestId: ctx.requestId });
      return { id: ctx.workspace.id, name };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/workspace/members',
    async (ctx) => {
      const rows = all(
        `SELECT m.*, u.email, u.name, u.last_login_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, m.created_at`,
        [ctx.workspace.id],
      );
      return { items: rows.map(memberRow), roles: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })) };
    },
    { auth: 'required' },
  );

  router.post(
    '/api/v1/workspace/members',
    async (ctx) => {
      ctx.requireCapability('members.manage');
      const body = ctx.body || {};
      const email = asEmail(body.email);
      const name = asString(body.name, { max: 80, label: '姓名' });
      const role = asEnum(body.role, ['admin', 'member', 'viewer'], { required: true, label: '角色' });
      const password = asString(body.password, { max: 200, label: '初始密码', trim: false });
      if (role === 'admin' && ctx.membership.role !== 'owner') throw forbidden('只有拥有者可以添加管理员');
      if (password && password.length < 10) throw badRequest('初始密码至少需要 10 位');

      let user = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
      const now = nowIso();
      let temporaryPassword = null;
      tx(() => {
        if (user) {
          const existingMembership = get('SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?', [ctx.workspace.id, user.id]);
          if (existingMembership) throw conflict('该用户已经是当前工作空间成员');
          run(
            `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            [id('mem'), ctx.workspace.id, user.id, role, now, now],
          );
        } else {
          const userId = id('usr');
          temporaryPassword = password || null;
          if (!temporaryPassword) throw badRequest('新用户需要设置初始密码');
          run(
            `INSERT INTO users (id, email, password_hash, name, locale, is_active, must_change_password, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'zh-CN', 1, 1, ?, ?)`,
            [userId, email, hashPassword(temporaryPassword), name || email.split('@')[0], now, now],
          );
          run(
            `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            [id('mem'), ctx.workspace.id, userId, role, now, now],
          );
          user = get('SELECT * FROM users WHERE id = ?', [userId]);
        }
      });
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'member.create', entityType: 'user', entityId: user.id, after: { email, role }, ip: ctx.ip, requestId: ctx.requestId });
      return { userId: user.id, email, role, mustChangePassword: Boolean(temporaryPassword) };
    },
    { auth: 'required' },
  );

  router.patch(
    '/api/v1/workspace/members/:userId',
    async (ctx) => {
      ctx.requireCapability('members.manage');
      const targetId = ctx.params.userId;
      const row = get(
        `SELECT m.*, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? AND m.user_id = ?`,
        [ctx.workspace.id, targetId],
      );
      if (!row) throw notFound('成员不存在');
      const body = ctx.body || {};
      const nextRole = body.role !== undefined ? asEnum(body.role, ROLES, { required: true, label: '角色' }) : row.role;
      const nextStatus = body.status !== undefined ? asEnum(body.status, ['active', 'suspended'], { required: true, label: '状态' }) : row.status;
      if (row.role === 'owner') throw forbidden('不能修改拥有者的角色或状态');
      if (nextRole === 'owner') throw forbidden('工作空间只能有一位拥有者');
      if (nextRole === 'admin' || row.role === 'admin') {
        if (ctx.membership.role !== 'owner') throw forbidden('只有拥有者可以调整管理员');
      }
      if (targetId === ctx.user.id && nextStatus !== 'active') throw forbidden('不能停用自己的账号');
      run('UPDATE memberships SET role = ?, status = ?, updated_at = ? WHERE id = ?', [nextRole, nextStatus, nowIso(), row.id]);
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'member.update', entityType: 'user', entityId: targetId, before: { role: row.role, status: row.status }, after: { role: nextRole, status: nextStatus }, ip: ctx.ip, requestId: ctx.requestId });
      return { userId: targetId, role: nextRole, status: nextStatus };
    },
    { auth: 'required' },
  );

  router.delete(
    '/api/v1/workspace/members/:userId',
    async (ctx) => {
      ctx.requireCapability('members.manage');
      const targetId = ctx.params.userId;
      const row = get(
        `SELECT m.*, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? AND m.user_id = ?`,
        [ctx.workspace.id, targetId],
      );
      if (!row) throw notFound('成员不存在');
      if (row.role === 'owner') throw forbidden('不能移除工作空间拥有者');
      if (targetId === ctx.user.id) throw forbidden('不能移除自己');
      if (row.role === 'admin' && ctx.membership.role !== 'owner') throw forbidden('只有拥有者可以移除管理员');
      run('DELETE FROM memberships WHERE id = ?', [row.id]);
      run('UPDATE sessions SET revoked_at = ? WHERE workspace_id = ? AND user_id = ?', [nowIso(), ctx.workspace.id, targetId]);
      assertOwnerExists(ctx.workspace.id);
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'member.remove', entityType: 'user', entityId: targetId, before: { email: row.email, role: row.role }, ip: ctx.ip, requestId: ctx.requestId });
      return { removed: true };
    },
    { auth: 'required' },
  );
}
