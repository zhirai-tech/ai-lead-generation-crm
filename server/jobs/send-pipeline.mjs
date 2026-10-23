/**
 * OWNER: t-worker. Send pipeline — the highest-safety part of the system.
 *
 * Every outbound email passes `assertSendAllowed` first. The checks are
 * deliberately ordered by business priority:
 *
 *   1. draft exists and has not already been sent
 *   2. draft is approved (approval is mandatory by default)
 *   3. recipient exists and is a syntactically valid address
 *   4. suppression list (email + domain) — unsubscribe / hard bounce / DNC
 *   5. automation state — HUMAN_TAKEOVER / DO_NOT_CONTACT / PAUSED / CLOSED
 *      always block; NEEDS_HUMAN_REVIEW blocks automatic delivery only
 *   6. global pause (config.globalSendPaused) and automatic-send switch
 *      (settings.outreach.autoSendEnabled — manual approved sends still work)
 *   7. send window (settings.outreach.sendWindow, default Europe/Berlin 9-17)
 *   8. account + workspace daily limits
 *   9. duplicate send (same draft / same recipient+subject within 24h)
 *  10. bounce circuit breaker (too many recent failures for the account)
 *
 * A blocked send returns `{ sent:false, blockedBy, reason }` and writes an
 * audit event; it never throws for expected business conditions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { get, parseJson, run } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { addHours, dayKey, nowIso, zonedParts } from '../core/time.mjs';
import { normalizeDomain, normalizeEmail } from '../core/validate.mjs';
import { signToken } from '../core/crypto.mjs';
import { getSecret } from '../core/secrets.mjs';
import { recordAudit } from '../core/audit.mjs';
import { createNotification } from '../services/notifications.mjs';
import { getSettings } from '../services/settings.mjs';
import { config as defaultConfig } from '../config.mjs';
import { buildMimeMessage, escapeHtml, MIME_ATTACHMENT_MAX_BYTES, MIME_ATTACHMENTS_TOTAL_MAX_BYTES, textToHtml } from '../mail/mime.mjs';
import { resolveSmtpConfig, smtpSend } from '../mail/smtp.mjs';
import { isSimulationAccount, sendSimulated } from '../mail/simulation.mjs';
import { callUpstream, tryCallUpstream } from './contracts.mjs';
import { recordJobUsage } from './job-log.mjs';

export const DEFAULT_SEND_WINDOW = Object.freeze({ start: 9, end: 17, weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' });
const DEFAULT_DAILY_LIMIT = 50;
const DUPLICATE_WINDOW_HOURS = 24;
const CIRCUIT_BREAKER_FAILURES = 5;
const CIRCUIT_BREAKER_WINDOW_HOURS = 24;
const RECENT_FAILURE_SAMPLE = 10;

export const SEND_BLOCK_CODES = Object.freeze([
  'draft_missing',
  'duplicate_send',
  'draft_not_approved',
  'draft_empty',
  'recipient_missing',
  'recipient_invalid',
  'suppression',
  'automation_human_takeover',
  'automation_do_not_contact',
  'automation_paused',
  'automation_closed',
  'automation_needs_review',
  'global_send_paused',
  'auto_send_disabled',
  'outside_send_window',
  'account_daily_limit',
  'workspace_daily_limit',
  'duplicate_recipient',
  'circuit_breaker',
  'account_unavailable',
  'account_credentials_missing',
  'send_failed',
  'send_error',
]);

function blocked(blockedBy, reason, details = undefined) {
  return { sent: false, allowed: false, blockedBy, reason, details };
}

function startOfUtcDay(nowMs) {
  const date = new Date(nowMs);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function toMs(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid date');
  return date.getTime();
}

/**
 * Pure send-window check. Supports overnight windows (start > end).
 * @param {{start:number,end:number,weekdays:number[],timezone:string}} [window]
 */
export function isWithinSendWindow(window = DEFAULT_SEND_WINDOW, now = new Date()) {
  const config = { ...DEFAULT_SEND_WINDOW, ...(window && typeof window === 'object' ? window : {}) };
  const timezone = typeof config.timezone === 'string' && config.timezone ? config.timezone : DEFAULT_SEND_WINDOW.timezone;
  let parts;
  try {
    parts = zonedParts(now, timezone);
  } catch {
    parts = zonedParts(now, DEFAULT_SEND_WINDOW.timezone);
  }
  const weekdays = Array.isArray(config.weekdays) && config.weekdays.length
    ? config.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : DEFAULT_SEND_WINDOW.weekdays;
  if (!weekdays.includes(parts.weekday)) return { allowed: false, reason: 'weekday', parts };
  const start = Math.max(0, Math.min(24, Number(config.start)));
  const end = Math.max(0, Math.min(24, Number(config.end)));
  const minutes = parts.minutes;
  const allowed = start <= end ? minutes >= start * 60 && minutes < end * 60 : minutes >= start * 60 || minutes < end * 60;
  return { allowed, reason: allowed ? null : 'time', parts, start, end };
}

function suppressionHits(workspaceId, email, domain) {
  const hits = [];
  if (email) {
    const record = get(
      'SELECT id, reason FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?',
      [workspaceId, 'email', email],
    );
    if (record) hits.push({ scope: 'email', value: email, reason: record.reason });
  }
  if (domain) {
    const record = get(
      'SELECT id, reason FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?',
      [workspaceId, 'domain', domain],
    );
    if (record) hits.push({ scope: 'domain', value: domain, reason: record.reason });
  }
  return hits;
}

function countSentToday({ workspaceId, accountId, nowMs }) {
  const dayStart = startOfUtcDay(nowMs);
  const workspace = get(
    "SELECT COUNT(*) AS c FROM email_messages WHERE workspace_id = ? AND direction = 'outbound' AND status = 'sent' AND sent_at >= ?",
    [workspaceId, dayStart],
  )?.c ?? 0;
  const account = accountId
    ? get(
        "SELECT COUNT(*) AS c FROM email_messages WHERE workspace_id = ? AND account_id = ? AND direction = 'outbound' AND status = 'sent' AND sent_at >= ?",
        [workspaceId, accountId, dayStart],
      )?.c ?? 0
    : 0;
  return { workspace, account, dayStart };
}

function countRecentFailures({ workspaceId, accountId, nowMs }) {
  if (!accountId) return { failures: 0, total: 0 };
  const since = addHours(-CIRCUIT_BREAKER_WINDOW_HOURS, nowMs);
  const rows = get(
    `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status IN ('failed', 'bounced') THEN 1 ELSE 0 END), 0) AS failures
       FROM (SELECT status FROM email_messages
              WHERE workspace_id = ? AND account_id = ? AND direction = 'outbound' AND created_at >= ?
              ORDER BY created_at DESC LIMIT ?)`,
    [workspaceId, accountId, since, RECENT_FAILURE_SAMPLE],
  );
  return { failures: rows?.failures ?? 0, total: rows?.total ?? 0 };
}

function detectDuplicates({ workspaceId, draft, contact, nowMs }) {
  const result = { draftSent: false, recipient: false, evidence: null };
  if (draft.sent_message_id) result.draftSent = true;
  const existing = get(
    `SELECT id, status FROM email_messages
      WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sending', 'sent')
        AND raw_headers_json LIKE ? ESCAPE '\\'
      LIMIT 1`,
    [workspaceId, `%"draftId":"${String(draft.id).replace(/[%_\\]/g, '\\$&')}"%`],
  );
  if (existing) {
    result.draftSent = true;
    result.evidence = existing.id;
  }
  if (contact?.email_normalized && draft.subject) {
    const since = addHours(-DUPLICATE_WINDOW_HOURS, nowMs);
    const duplicate = get(
      `SELECT id FROM email_messages
        WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sending', 'sent')
          AND to_addresses_json LIKE ? AND subject = ? AND created_at >= ?
        LIMIT 1`,
      [workspaceId, `%${String(contact.email_normalized).replace(/[%_\\]/g, '\\$&')}%`, draft.subject, since],
    );
    if (duplicate) {
      result.recipient = true;
      result.evidence = duplicate.id;
    }
  }
  return result;
}

/**
 * Load every read-only input needed by `assertSendAllowed`. All SQL is scoped by
 * workspace id. Role/lifecycle changes are never written here.
 */
export function loadSendContext({ workspaceId, draftId, now = null, config = null, trigger = null } = {}) {
  const effectiveConfig = config || defaultConfig;
  const nowMs = now ? toMs(now) : Date.now();
  const at = new Date(nowMs).toISOString();
  const draft = get('SELECT * FROM message_drafts WHERE id = ? AND workspace_id = ?', [draftId, workspaceId]);
  if (!draft) return { workspaceId, draftId, now: at, context: null };
  const contact = draft.contact_id
    ? get('SELECT * FROM contacts WHERE id = ? AND workspace_id = ?', [draft.contact_id, workspaceId])
    : null;
  const company = draft.company_id
    ? get('SELECT * FROM companies WHERE id = ? AND workspace_id = ?', [draft.company_id, workspaceId])
    : null;
  const campaign = draft.campaign_id
    ? get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [draft.campaign_id, workspaceId])
    : null;
  const step = draft.campaign_step_id
    ? get('SELECT * FROM campaign_steps WHERE id = ? AND workspace_id = ?', [draft.campaign_step_id, workspaceId])
    : null;
  const account = draft.account_id
    ? get('SELECT * FROM email_accounts WHERE id = ? AND workspace_id = ?', [draft.account_id, workspaceId])
    : get(
        "SELECT * FROM email_accounts WHERE workspace_id = ? AND status = 'active' ORDER BY CASE WHEN protocol = 'simulation' THEN 1 ELSE 0 END, created_at ASC LIMIT 1",
        [workspaceId],
      );
  const automation = company
    ? get('SELECT state, reason FROM automation_states WHERE workspace_id = ? AND company_id = ?', [workspaceId, company.id])
    : null;
  const settings = getSettings(workspaceId);
  const email = normalizeEmail(contact?.email_normalized || contact?.email || '');
  const domain = normalizeDomain(contact?.email || company?.domain || '');
  const hits = suppressionHits(workspaceId, email, domain);
  const sent = countSentToday({ workspaceId, accountId: account?.id || null, nowMs });
  const failures = countRecentFailures({ workspaceId, accountId: account?.id || null, nowMs });
  const duplicates = detectDuplicates({ workspaceId, draft, contact, nowMs });
  const autoSendEnabled = settings?.outreach?.autoSendEnabled === true;
  const mode = trigger || 'auto';
  const context = {
    now: at,
    mode,
    requireApproval: settings?.outreach?.requireApproval !== false,
    autoSendEnabled,
    globalSendPaused: Boolean(effectiveConfig.globalSendPaused),
    draft: {
      id: draft.id,
      status: draft.status,
      subject: draft.subject || '',
      bodyText: draft.body_text || '',
      scheduledAt: draft.scheduled_at || null,
      sentMessageId: draft.sent_message_id || null,
      accountId: draft.account_id || null,
      campaignStatus: campaign?.status || null,
      hasStep: Boolean(step),
    },
    contact: contact
      ? {
          id: contact.id,
          email,
          name: contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
          emailStatus: contact.email_status,
          deleted: Boolean(contact.deleted_at),
        }
      : null,
    company: company ? { id: company.id, name: company.name, domain, state: automation?.state || null, automationReason: automation?.reason || null } : null,
    automationState: automation?.state || null,
    account: account
      ? {
          id: account.id,
          address: account.address,
          protocol: account.protocol,
          status: account.status,
          dailyLimit: Number(account.daily_limit) || null,
        }
      : null,
    suppressionHits: hits,
    sendWindow: settings?.outreach?.sendWindow || DEFAULT_SEND_WINDOW,
    sentToday: sent,
    limits: {
      accountDaily: account ? Number(account.daily_limit) || DEFAULT_DAILY_LIMIT : DEFAULT_DAILY_LIMIT,
      workspaceDaily: Number(settings?.limits?.dailyEmailLimit) || Number(settings?.outreach?.dailySendLimit) || DEFAULT_DAILY_LIMIT,
    },
    failures,
    duplicates,
    settings,
    raw: { draft, contact, company, campaign, step, account },
  };
  return { workspaceId, draftId, now: at, context };
}

/**
 * Pure send decision. Never reads the database, never sends. Returns
 * `{allowed:true}` or `{allowed:false, blockedBy, reason, details}`.
 */
export function assertSendAllowed(context) {
  if (!context || typeof context !== 'object') return blocked('draft_missing', '发送上下文为空');
  const draft = context.draft || {};
  const contact = context.contact;
  if (!draft.id) return blocked('draft_missing', '草稿不存在');

  if (draft.status === 'sent' || draft.sentMessageId) {
    return blocked('duplicate_send', '该草稿已经发送过，不能重复发送', { messageId: draft.sentMessageId });
  }
  const approvedStatuses = context.requireApproval === false ? ['approved', 'scheduled', 'pending_approval', 'draft'] : ['approved', 'scheduled'];
  if (!approvedStatuses.includes(draft.status)) {
    return blocked('draft_not_approved', '草稿尚未通过人工审批，禁止发送', { status: draft.status });
  }
  if (!String(draft.subject || '').trim() || !String(draft.bodyText || '').trim()) {
    return blocked('draft_empty', '草稿主题或正文为空');
  }
  if (!contact) return blocked('recipient_missing', '草稿没有关联联系人');
  if (contact.deleted) return blocked('recipient_missing', '联系人已删除');
  if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    return blocked('recipient_invalid', '联系人邮箱地址无效');
  }
  if (context.suppressionHits && context.suppressionHits.length) {
    const hit = context.suppressionHits[0];
    return blocked('suppression', `命中抑制名单（${hit.scope}: ${hit.value}，原因 ${hit.reason}），禁止发送`, { hits: context.suppressionHits });
  }
  const state = context.automationState;
  const stateBlocks = {
    HUMAN_TAKEOVER: ['automation_human_takeover', '客户已由人工接管，自动发送被禁止'],
    DO_NOT_CONTACT: ['automation_do_not_contact', '客户处于禁止联系状态（Do Not Contact），永不发送'],
    PAUSED: ['automation_paused', '客户自动化已暂停，禁止发送'],
    CLOSED: ['automation_closed', '客户已关闭，禁止发送'],
  };
  if (state && stateBlocks[state]) return blocked(stateBlocks[state][0], stateBlocks[state][1], { state });
  if (state === 'NEEDS_HUMAN_REVIEW' && context.mode !== 'manual') {
    return blocked('automation_needs_review', '客户需要人工复核，自动发送被阻止', { state });
  }
  if (context.globalSendPaused) return blocked('global_send_paused', '系统全局发送已暂停');
  if (context.mode !== 'manual' && context.autoSendEnabled !== true) {
    return blocked('auto_send_disabled', '自动发送未开启，请人工审批后手动发送');
  }
  const window = isWithinSendWindow(context.sendWindow || DEFAULT_SEND_WINDOW, context.now || new Date());
  if (!window.allowed) {
    return blocked('outside_send_window', '当前不在允许的发送时间窗内', {
      timezone: (context.sendWindow && context.sendWindow.timezone) || DEFAULT_SEND_WINDOW.timezone,
      weekday: window.parts?.weekday,
      hour: window.parts?.hour,
    });
  }
  const account = context.account;
  if (!account) return blocked('account_unavailable', '没有可用的发件邮箱账号');
  if (account.status !== 'active') {
    return blocked('account_unavailable', '发件邮箱账号未启用', { status: account.status });
  }
  const limits = context.limits || {};
  if (context.sentToday && Number(context.sentToday.account) >= Number(limits.accountDaily || DEFAULT_DAILY_LIMIT)) {
    return blocked('account_daily_limit', '该邮箱账号今日发送额度已用完', {
      limit: limits.accountDaily,
      sent: context.sentToday.account,
    });
  }
  if (context.sentToday && Number(context.sentToday.workspace) >= Number(limits.workspaceDaily || DEFAULT_DAILY_LIMIT)) {
    return blocked('workspace_daily_limit', '工作空间今日发送额度已用完', {
      limit: limits.workspaceDaily,
      sent: context.sentToday.workspace,
    });
  }
  if (context.duplicates?.draftSent) return blocked('duplicate_send', '检测到该草稿已有发送记录', { evidence: context.duplicates.evidence });
  if (context.duplicates?.recipient) {
    return blocked('duplicate_recipient', '该收件人最近已收到相同主题邮件，避免重复打扰', { evidence: context.duplicates.evidence });
  }
  if (context.failures && context.failures.failures >= CIRCUIT_BREAKER_FAILURES) {
    return blocked('circuit_breaker', '发件账号近期失败过多，已触发退信熔断，请检查后手动恢复', {
      failures: context.failures.failures,
      windowHours: CIRCUIT_BREAKER_WINDOW_HOURS,
    });
  }
  return { allowed: true, sent: false, blockedBy: null, reason: null };
}

function buildComplianceText({ text, settings, unsubscribeUrl, senderCompany, senderAddress }) {
  const parts = [String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()];
  const signature = String(settings?.outreach?.signature || '').trim();
  const companyName = senderCompany || settings?.compliance?.senderCompanyName || '';
  const address = senderAddress || settings?.compliance?.senderAddress || '';
  const privacyUrl = settings?.compliance?.privacyUrl || '';
  const lines = [];
  if (companyName) lines.push(companyName);
  if (address) lines.push(address);
  if (privacyUrl) lines.push(`Privacy / 隐私政策: ${privacyUrl}`);
  if (lines.length) parts.push(lines.join('\n'));
  if (signature) parts.push(signature);
  parts.push(`Unsubscribe / 退订: ${unsubscribeUrl}`);
  return parts.filter(Boolean).join('\n\n---\n\n');
}

function buildUnsubscribe({ workspaceId, contact, company, config = null }) {
  const token = signToken(getSecret(), {
    w: workspaceId,
    e: contact.email,
    c: contact.id,
    co: company?.id || null,
  });
  const base = String((config || defaultConfig).publicBaseUrl || '').replace(/\/+$/, '');
  return {
    token,
    url: `${base}/api/v1/public/unsubscribe/${encodeURIComponent(token)}`,
    mailto: `unsubscribe@${normalizeDomain(company?.domain || contact.email.split('@')[1] || '') || 'zhirai.local'}`,
  };
}

// --------------------------------------------------------------- attachments
/** Only safe, product-document style attachment types are ever sent. */
const ATTACHMENT_ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

/**
 * Resolve a product_file.storage_path (relative to uploadsDir) to a real file
 * path, refusing path traversal outside the uploads directory.
 */
export function resolveUploadFilePath(uploadsDir, storagePath) {
  if (!uploadsDir || !storagePath) return null;
  const root = path.resolve(String(uploadsDir));
  const candidate = path.isAbsolute(String(storagePath)) ? path.resolve(String(storagePath)) : path.resolve(root, String(storagePath));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

/**
 * Load the file contents for the attachments declared on a draft
 * (`message_drafts.attachments_json`). Missing / unsafe / oversized files are
 * skipped with a warning — the mail is still sent without them.
 * @returns {{contents:Array<{filename,mimeType,content:Buffer}>, snapshot:Array, warnings:Array}}
 */
export function loadDraftAttachments({ workspaceId, draft, config = null, logger = null } = {}) {
  const declared = parseJson(draft && draft.attachments_json, []);
  const result = { contents: [], snapshot: [], warnings: [] };
  if (!Array.isArray(declared) || declared.length === 0) return result;
  const uploadsDir = config && config.uploadsDir;
  const warn = (warning) => {
    result.warnings.push(warning);
    if (logger) logger.warn('email attachment skipped', { draftId: draft.id, ...warning });
  };
  let totalBytes = 0;
  declared.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      warn({ code: 'attachment_invalid', index, message: '附件条目格式不正确' });
      return;
    }
    const productFileId = item.productFileId || null;
    if (!productFileId) {
      warn({ code: 'attachment_invalid', index, filename: item.filename || null, message: '附件缺少 productFileId' });
      return;
    }
    const row = get(
      'SELECT id, filename, mime_type, storage_path FROM product_files WHERE id = ? AND workspace_id = ?',
      [productFileId, workspaceId],
    );
    if (!row) {
      warn({ code: 'attachment_missing', productFileId, filename: item.filename || null, message: '附件记录不存在或已删除' });
      return;
    }
    const mimeType = String(row.mime_type || item.mimeType || '').toLowerCase();
    if (!ATTACHMENT_ALLOWED_MIME.has(mimeType)) {
      warn({ code: 'attachment_type_blocked', productFileId, mimeType, message: `不支持的附件类型 ${mimeType}` });
      return;
    }
    const filePath = resolveUploadFilePath(uploadsDir, row.storage_path);
    if (!filePath) {
      warn({ code: 'attachment_path_invalid', productFileId, message: '附件存储路径不合法' });
      return;
    }
    let content;
    try {
      content = fs.readFileSync(filePath);
    } catch (error) {
      warn({
        code: 'attachment_file_missing',
        productFileId,
        filename: row.filename || item.filename || null,
        message: `附件文件缺失或不可读：${String(error && error.message ? error.message : error).slice(0, 200)}`,
      });
      return;
    }
    if (!content.length) {
      warn({ code: 'attachment_empty', productFileId, filename: row.filename || null, message: '附件文件为空' });
      return;
    }
    if (content.length > MIME_ATTACHMENT_MAX_BYTES) {
      warn({
        code: 'MIME_ATTACHMENT_TOO_LARGE',
        productFileId,
        filename: row.filename || item.filename || null,
        sizeBytes: content.length,
        message: `附件超过单文件上限 ${MIME_ATTACHMENT_MAX_BYTES} 字节，已跳过`,
      });
      return;
    }
    if (totalBytes + content.length > MIME_ATTACHMENTS_TOTAL_MAX_BYTES) {
      warn({
        code: 'MIME_ATTACHMENTS_TOTAL_TOO_LARGE',
        productFileId,
        filename: row.filename || item.filename || null,
        message: `附件总量超过上限 ${MIME_ATTACHMENTS_TOTAL_MAX_BYTES} 字节，已跳过`,
      });
      return;
    }
    totalBytes += content.length;
    const filename = row.filename || item.filename || `attachment-${index + 1}.pdf`;
    result.contents.push({ filename, mimeType, content });
    result.snapshot.push({
      productFileId,
      filename,
      mimeType,
      sizeBytes: content.length,
      publicUrl: typeof item.publicUrl === 'string' && item.publicUrl ? item.publicUrl : null,
    });
  });
  return result;
}

/** Build an absolute public URL for an email recipient. */
export function absolutePublicUrl(publicUrl, config = null) {
  const text = String(publicUrl || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  const base = String((config || defaultConfig).publicBaseUrl || '').replace(/\/+$/, '');
  return `${base}${text.startsWith('/') ? '' : '/'}${text}`;
}

/**
 * Catalogue lines appended to the email body when the draft does not already
 * mention the PDF's public URL. Only PDFs actually attached get a line, and the
 * same URL is never added twice.
 */
export function buildCatalogueLinkLines({ draftBodyText = '', snapshot = [], config = null } = {}) {
  const body = String(draftBodyText || '');
  const lines = [];
  const seen = new Set();
  for (const item of snapshot) {
    if (item.mimeType !== 'application/pdf' || !item.publicUrl) continue;
    const absolute = absolutePublicUrl(item.publicUrl, config);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    if (body.includes(item.publicUrl) || body.includes(absolute)) continue;
    lines.push(`Product catalogue (PDF): ${absolute}`);
  }
  return lines;
}

function updateDraftFailed(workspaceId, draftId, error) {
  run("UPDATE message_drafts SET status = 'failed', updated_at = ? WHERE id = ? AND workspace_id = ? AND status <> 'sent'", [
    nowIso(),
    draftId,
    workspaceId,
  ]);
  void error;
}

/**
 * The public entry point: check everything, then either send or return a
 * structured block. Never throws for expected business conditions.
 */
export async function sendDraft({
  workspaceId,
  draftId,
  actorType = 'system',
  actorId = null,
  jobId = null,
  trigger = null,
  config = null,
  now = null,
  logger = null,
} = {}) {
  const effectiveConfig = config || defaultConfig;
  const mode = trigger || (actorType === 'user' ? 'manual' : 'auto');
  let loaded;
  try {
    loaded = loadSendContext({ workspaceId, draftId, now, config: effectiveConfig, trigger: mode });
  } catch (error) {
    if (logger) logger.error('send context load failed', { workspaceId, draftId, error });
    return blocked('send_error', '加载发送上下文失败', { error: String(error && error.message ? error.message : error) });
  }
  if (!loaded.context) {
    return blocked('draft_missing', '草稿不存在或不属于当前工作空间');
  }
  const context = loaded.context;
  const decision = assertSendAllowed(context);

  if (!decision.allowed) {
    try {
      recordAudit({
        workspaceId,
        actorType: actorType === 'user' ? 'user' : 'system',
        actorId,
        action: 'email.send_blocked',
        entityType: 'message_draft',
        entityId: draftId,
        after: { blockedBy: decision.blockedBy, reason: decision.reason, jobId },
      });
    } catch (error) {
      if (logger) logger.warn('audit for blocked send failed', { error });
    }
    return blocked(decision.blockedBy, decision.reason, decision.details);
  }

  const { draft, contact, company, account } = context.raw;
  const nowMs = toMs(context.now);
  const nowIsoValue = new Date(nowMs).toISOString();

  // Late-stage failures (credentials, message construction, reservation) are
  // also audited in the same "send blocked" trail.
  const deny = (blockedBy, reason, details) => {
    try {
      recordAudit({
        workspaceId,
        actorType: actorType === 'user' ? 'user' : 'system',
        actorId,
        action: 'email.send_blocked',
        entityType: 'message_draft',
        entityId: draftId,
        after: { blockedBy, reason, jobId, stage: 'pre_send' },
      });
    } catch (error) {
      if (logger) logger.warn('audit for blocked send failed', { error });
    }
    return blocked(blockedBy, reason, details);
  };

  // Load credentials only for real SMTP accounts; simulation never needs them.
  let sendAccount = null;
  let smtpConfig = null;
  if (!isSimulationAccount(account)) {
    let loadedAccount = null;
    try {
      loadedAccount = await callUpstream('emailAccounts', 'loadSendAccount', workspaceId, account.id);
    } catch (error) {
      return deny('account_credentials_missing', `发件账号凭据未就绪：${String(error && error.message ? error.message : error).slice(0, 300)}`);
    }
    if (!loadedAccount || !loadedAccount.account) {
      return deny('account_credentials_missing', '发件账号凭据不可用，请联系管理员重新保存邮箱凭据');
    }
    sendAccount = loadedAccount;
    smtpConfig = resolveSmtpConfig(sendAccount.account, sendAccount.secret, sendAccount.config || {});
    if (!smtpConfig.host) {
      return deny('account_credentials_missing', 'SMTP 主机未配置，无法发送');
    }
  }

  let unsubscribe;
  try {
    unsubscribe = buildUnsubscribe({ workspaceId, contact, company, config: effectiveConfig });
  } catch (error) {
    return deny('send_error', '生成退订链接失败', { error: String(error && error.message ? error.message : error) });
  }

  const senderAddress = account.address;
  const senderName = account.display_name || company?.name || '';
  // Attachments: read declared snapshots + real files from the uploads dir.
  // Missing/oversized files never fail the send; they are logged as warnings.
  const attachments = loadDraftAttachments({ workspaceId, draft, config: effectiveConfig, logger });
  const catalogueLines = buildCatalogueLinkLines({
    draftBodyText: draft.body_text,
    snapshot: attachments.snapshot,
    config: effectiveConfig,
  });
  const bodyWithCatalogue = [String(draft.body_text || '').trim(), catalogueLines.join('\n')]
    .filter(Boolean)
    .join('\n\n');
  const fullText = buildComplianceText({
    text: bodyWithCatalogue,
    settings: context.settings,
    unsubscribeUrl: unsubscribe.url,
    senderCompany: context.settings?.compliance?.senderCompanyName || '',
    senderAddress: context.settings?.compliance?.senderAddress || '',
  });
  const html = textToHtml(fullText).replace(escapeHtml(unsubscribe.url), `<a href="${escapeHtml(unsubscribe.url)}">${escapeHtml(unsubscribe.url)}</a>`);

  let built;
  try {
    built = buildMimeMessage({
      from: { name: senderName, address: senderAddress },
      to: [{ name: contact.full_name || '', address: contact.email_normalized || contact.email }],
      subject: draft.subject || '',
      text: fullText,
      html,
      date: new Date(nowMs),
      unsubscribe: { url: unsubscribe.url, mailto: unsubscribe.mailto },
      attachments: attachments.contents,
      headers: {
        'X-ZHIRAI-Draft': draft.id,
        'X-Mailer': 'ZHIRAI Outreach',
      },
    });
  } catch (error) {
    return deny('draft_empty', `无法构建邮件（${String(error && error.message ? error.message : error)}）`);
  }

  // 1) Reserve the outbound message row *before* the network call. This is the
  // idempotency anchor: a retried job hits `duplicate_send` instead of sending twice.
  const messageRowId = id('msg');
  const rawHeaders = {
    draftId: draft.id,
    campaignId: draft.campaign_id || null,
    jobId,
    trigger: mode,
    actorType,
    simulation: isSimulationAccount(account),
    unsubscribe: true,
    attachmentCount: attachments.snapshot.length,
    attachmentWarnings: attachments.warnings.map((warning) => warning.code),
  };
  try {
    run(
      `INSERT INTO email_messages
         (id, workspace_id, account_id, thread_id, company_id, contact_id, direction, from_address, from_name,
          to_addresses_json, cc_json, bcc_json, subject, body_text, body_html, message_id_header, in_reply_to,
          references_json, sent_at, received_at, status, error, is_read, raw_headers_json, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'outbound', ?, ?, ?, '[]', '[]', ?, ?, ?, ?, NULL, '[]', NULL, NULL, 'sending', NULL, 0, ?, ?)`,
      [
        messageRowId,
        workspaceId,
        account.id,
        company?.id || null,
        contact.id,
        senderAddress,
        senderName,
        JSON.stringify([contact.email_normalized || contact.email]),
        draft.subject || '',
        fullText,
        html,
        built.messageId,
        JSON.stringify(rawHeaders),
        nowIsoValue,
      ],
    );
  } catch (error) {
    return deny('send_error', '创建发送记录失败', { error: String(error && error.message ? error.message : error) });
  }

  let delivery;
  try {
    if (isSimulationAccount(account)) {
      delivery = sendSimulated({
        account,
        message: { raw: built.raw, messageId: built.messageId, from: senderAddress, to: [contact.email_normalized || contact.email], subject: draft.subject },
        workspaceId,
        dataDir: effectiveConfig.dataDir,
        logger,
      });
    } else {
      const smtp = smtpConfig || resolveSmtpConfig(sendAccount.account, sendAccount.secret, sendAccount.config || {});
      const result = await smtpSend({
        ...smtp,
        from: senderAddress,
        to: [contact.email_normalized || contact.email],
        raw: built.raw,
        timeoutMs: Number(sendAccount.config?.timeoutMs || 20_000),
        logger,
      });
      delivery = { ok: true, result, messageId: built.messageId };
    }
  } catch (error) {
    const errorMessage = String(error && error.message ? error.message : error).slice(0, 1000);
    const transient = Boolean(error && error.transient);
    try {
      run("UPDATE email_messages SET status = 'failed', error = ? WHERE id = ? AND workspace_id = ?", [errorMessage, messageRowId, workspaceId]);
      updateDraftFailed(workspaceId, draftId, errorMessage);
      createNotification({
        workspaceId,
        type: 'email_send_failed',
        title: '邮件发送失败',
        body: `草稿「${String(draft.subject || '').slice(0, 60)}」发送失败：${errorMessage.slice(0, 200)}`,
        entityType: 'message_draft',
        entityId: draftId,
        severity: 'warning',
      });
      recordAudit({
        workspaceId,
        actorType: actorType === 'user' ? 'user' : 'system',
        actorId,
        action: 'email.send_failed',
        entityType: 'email_message',
        entityId: messageRowId,
        after: { draftId, error: errorMessage.slice(0, 300), transient },
      });
    } catch (inner) {
      if (logger) logger.error('failed to record send failure', { error: inner });
    }
    if (logger) logger.error('email send failed', { workspaceId, draftId, messageRowId, error: errorMessage, transient });
    return { sent: false, allowed: true, blockedBy: 'send_failed', reason: '邮件发送失败', transient, error: errorMessage };
  }

  // 2) Success: finalise message, attachment snapshot, draft, usage, audit.
  try {
    run("UPDATE email_messages SET status = 'sent', sent_at = ?, error = NULL, attachments_json = ? WHERE id = ? AND workspace_id = ?", [
      nowIsoValue,
      JSON.stringify(attachments.snapshot),
      messageRowId,
      workspaceId,
    ]);
    run(
      "UPDATE message_drafts SET status = 'sent', sent_message_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      [messageRowId, nowIsoValue, draftId, workspaceId],
    );
    recordJobUsage({ workspaceId, category: 'email_sent', quantity: 1, jobId, provider: account.protocol, agentRole: null });
    recordAudit({
      workspaceId,
      actorType: actorType === 'user' ? 'user' : 'system',
      actorId,
      action: 'email.sent',
      entityType: 'email_message',
      entityId: messageRowId,
      after: {
        draftId,
        accountId: account.id,
        to: contact.email_normalized || contact.email,
        messageId: built.messageId,
        simulation: isSimulationAccount(account),
        jobId,
        attachmentCount: attachments.snapshot.length,
        attachmentWarnings: attachments.warnings.map((warning) => warning.code),
      },
    });
  } catch (error) {
    if (logger) logger.error('post-send bookkeeping failed', { error, messageRowId });
  }

  if (draft.campaign_id && draft.contact_id) {
    const advanced = await tryCallUpstream('campaigns', 'advanceAfterSend', {
      workspaceId,
      campaignId: draft.campaign_id,
      contactId: draft.contact_id,
      draftId,
    });
    if (!advanced.ok && logger) {
      logger.warn('advanceAfterSend unavailable after successful send', {
        campaignId: draft.campaign_id,
        error: String(advanced.error && advanced.error.message ? advanced.error.message : advanced.error).slice(0, 300),
      });
    }
  }

  return {
    sent: true,
    allowed: true,
    blockedBy: null,
    messageId: built.messageId,
    messageRowId,
    accountId: account.id,
    draftId,
    simulation: isSimulationAccount(account),
    outboxPath: delivery.outboxPath || null,
    sentAt: nowIsoValue,
    attachments: attachments.snapshot,
    attachmentWarnings: attachments.warnings,
  };
}

/** Non-blocking defaults used by routes/UI to explain the send rules. */
export function describeSendPolicy(settings = null) {
  const outreach = settings?.outreach || {};
  return {
    requireApproval: outreach.requireApproval !== false,
    autoSendEnabled: outreach.autoSendEnabled === true,
    sendWindow: outreach.sendWindow || DEFAULT_SEND_WINDOW,
    dailyWorkspaceLimit: Number(settings?.limits?.dailyEmailLimit) || DEFAULT_DAILY_LIMIT,
    timezone: (outreach.sendWindow && outreach.sendWindow.timezone) || DEFAULT_SEND_WINDOW.timezone,
    duplicateWindowHours: DUPLICATE_WINDOW_HOURS,
    circuitBreaker: { failures: CIRCUIT_BREAKER_FAILURES, windowHours: CIRCUIT_BREAKER_WINDOW_HOURS },
    day: dayKey(),
  };
}

export default {
  sendDraft,
  loadSendContext,
  assertSendAllowed,
  isWithinSendWindow,
  describeSendPolicy,
  loadDraftAttachments,
  buildCatalogueLinkLines,
  resolveUploadFilePath,
  absolutePublicUrl,
  SEND_BLOCK_CODES,
  DEFAULT_SEND_WINDOW,
};
