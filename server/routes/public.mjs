/**
 * Public endpoints used by email recipients and the unauthenticated app shell:
 * unsubscribe (preview + one-click POST) and public brand metadata.
 */
import { get, run } from '../core/db.mjs';
import { verifyToken } from '../core/crypto.mjs';
import { getSecret } from '../core/secrets.mjs';
import { badRequest, notFound } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import { cancelJobsForCompany } from '../jobs/queue.mjs';

function resolveToken(token) {
  const payload = verifyToken(getSecret(), token);
  if (!payload || !payload.w || !payload.e) return null;
  const workspace = get('SELECT id, name FROM workspaces WHERE id = ? AND deleted_at IS NULL', [payload.w]);
  if (!workspace) return null;
  return { payload, workspace };
}

function maskEmail(email) {
  return String(email || '').replace(/^(.).*(@.*)$/, (_, first, rest) => `${first}***${rest}`);
}

export function mount(router) {
  router.get(
    '/api/v1/public/meta',
    async (ctx) => ({
      appName: ctx.config.appName,
      version: ctx.config.version,
      brand: {
        nameZh: '智睿科技',
        nameEn: 'ZHIRAI',
        slogan: '把想法变成现实',
        website: 'https://zhirai.cloud',
        author: 'ZHIRAI · 智睿科技 · 独立开发者',
        copyright: '© 2026 智睿科技 保留所有权利。',
      },
    }),
    { auth: 'public', csrf: false },
  );

  router.get(
    '/api/v1/public/unsubscribe/:token',
    async (ctx) => {
      const resolved = resolveToken(ctx.params.token);
      if (!resolved) throw notFound('退订链接无效或已过期');
      const contact = resolved.payload.c
        ? get('SELECT id, email, full_name FROM contacts WHERE id = ? AND workspace_id = ?', [resolved.payload.c, resolved.payload.w])
        : null;
      const existing = get(
        'SELECT id FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?',
        [resolved.payload.w, 'email', resolved.payload.e],
      );
      return {
        valid: true,
        workspaceName: resolved.workspace.name,
        email: maskEmail(resolved.payload.e),
        contactName: contact?.full_name || null,
        alreadyUnsubscribed: Boolean(existing),
      };
    },
    { auth: 'public', csrf: false, rateLimit: { windowMs: 60_000, max: 30 } },
  );

  router.post(
    '/api/v1/public/unsubscribe/:token',
    async (ctx) => {
      const resolved = resolveToken(ctx.params.token);
      if (!resolved) throw notFound('退订链接无效或已过期');
      const { payload } = resolved;
      const email = String(payload.e || '').toLowerCase();
      if (!email) throw badRequest('退订信息不完整');
      const now = nowIso();
      const existing = get(
        'SELECT id FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?',
        [payload.w, 'email', email],
      );
      if (!existing) {
        run(
          `INSERT INTO suppression_records (id, workspace_id, scope, value_normalized, reason, source, note, created_by, created_at)
           VALUES (?, ?, 'email', ?, 'unsubscribe', 'public_link', '收件人通过邮件退订链接提交', NULL, ?)`,
          [id('sup'), payload.w, email, now],
        );
        run('DELETE FROM follow_up_tasks WHERE workspace_id = ? AND status = ? AND contact_id = ?', [payload.w, 'pending', payload.c || '__none__']);
        const contact = payload.c ? get('SELECT company_id FROM contacts WHERE id = ? AND workspace_id = ?', [payload.c, payload.w]) : null;
        const companyId = contact?.company_id || payload.co || null;
        if (companyId) {
          const existingState = get('SELECT id FROM automation_states WHERE workspace_id = ? AND company_id = ?', [payload.w, companyId]);
          if (existingState) {
            run(
              'UPDATE automation_states SET state = ?, reason = ?, changed_by = ?, changed_at = ?, updated_at = ? WHERE id = ?',
              ['DO_NOT_CONTACT', '邮件退订', 'recipient', now, now, existingState.id],
            );
          } else {
            run(
              `INSERT INTO automation_states (id, workspace_id, company_id, state, reason, changed_by, changed_at, created_at, updated_at)
               VALUES (?, ?, ?, 'DO_NOT_CONTACT', '邮件退订', 'recipient', ?, ?, ?)`,
              [id('aut'), payload.w, companyId, now, now, now],
            );
          }
          cancelJobsForCompany(payload.w, companyId, 'recipient_unsubscribed');
        }
      }
      recordAudit({
        workspaceId: payload.w,
        actorType: 'anonymous',
        action: 'suppression.unsubscribe',
        entityType: 'suppression',
        entityId: existing?.id || null,
        after: { email, source: 'public_link' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return { unsubscribed: true, alreadyUnsubscribed: Boolean(existing) };
    },
    { auth: 'public', csrf: false, rateLimit: { windowMs: 60_000, max: 30 } },
  );
}
