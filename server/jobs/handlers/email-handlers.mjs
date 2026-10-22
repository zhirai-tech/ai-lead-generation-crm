/**
 * OWNER: t-worker. Email handlers: outbound send (through the safety pipeline)
 * and inbox sync (IMAP for real accounts, simulation for demo accounts).
 *
 * Outbound is never sent directly from here — every send goes through
 * `sendDraft`, which enforces approval, suppression, automation state, send
 * window, limits, duplicate checks and the bounce circuit breaker.
 */
import { get, run } from '../../core/db.mjs';
import { id } from '../../core/ids.mjs';
import { addDays, nowIso } from '../../core/time.mjs';
import { getSettings } from '../../services/settings.mjs';
import { createNotification } from '../../services/notifications.mjs';
import { imapFetchMessages, resolveImapConfig } from '../../mail/imap.mjs';
import { isSimulationAccount, simulateInboundReply } from '../../mail/simulation.mjs';
import { loadUpstream, tryCallUpstream } from '../contracts.mjs';
import { enqueueJob } from '../queue.mjs';
import { isWithinSendWindow, sendDraft } from '../send-pipeline.mjs';
import { recordJobAudit } from '../job-log.mjs';
import { JobError, requirePayloadField } from './index.mjs';

const RETRYABLE_BLOCKS = new Set([
  'outside_send_window',
  'account_daily_limit',
  'workspace_daily_limit',
  'account_credentials_missing',
  'account_unavailable',
  'send_error',
]);

function retryDelayFor(blockedBy, workspaceId) {
  const nowMs = Date.now();
  if (blockedBy === 'outside_send_window') {
    const window = getSettings(workspaceId)?.outreach?.sendWindow;
    for (let minute = 1; minute <= 24 * 60; minute += 1) {
      const candidate = new Date(nowMs + minute * 60_000);
      if (isWithinSendWindow(window, candidate).allowed) return minute * 60_000;
    }
    return 60 * 60_000;
  }
  if (blockedBy === 'account_daily_limit' || blockedBy === 'workspace_daily_limit') {
    const nextDay = new Date(nowMs);
    nextDay.setUTCHours(24, 0, 0, 0);
    return Math.max(60_000, nextDay.getTime() - nowMs + 60_000);
  }
  if (blockedBy === 'account_credentials_missing' || blockedBy === 'account_unavailable') {
    return 5 * 60_000;
  }
  return null;
}

async function emailSend({ job, workspaceId, payload, config, logger }) {
  const draftId = requirePayloadField(payload, 'draftId');
  // `trigger` semantics:
  //  - payload.trigger / payload.actorType is the explicit contract;
  //  - otherwise a job created by a user (createdBy set, e.g. the CRM "send"
  //    button) is a manual approved send, while scheduler-created jobs are
  //    automatic and stay blocked unless settings.outreach.autoSendEnabled=true.
  const explicit = payload.trigger === 'manual' || payload.actorType === 'user'
    ? 'manual'
    : payload.trigger === 'auto'
      ? 'auto'
      : null;
  const trigger = explicit || (job.createdBy ? 'manual' : 'auto');
  const result = await sendDraft({
    workspaceId,
    draftId,
    actorType: 'system',
    actorId: job.createdBy || null,
    jobId: job.id,
    trigger,
    config,
    logger,
  });
  if (result.sent) return result;

  if (result.blockedBy === 'circuit_breaker') {
    createNotification({
      workspaceId,
      type: 'email_circuit_breaker',
      title: '发件账号触发退信熔断',
      body: '近期发送失败次数过多，已暂停自动发送。请检查邮箱配置与地址质量后重试。',
      entityType: 'message_draft',
      entityId: draftId,
      severity: 'critical',
    });
  }
  const retryable = RETRYABLE_BLOCKS.has(result.blockedBy) || (result.blockedBy === 'send_failed' && result.transient === true);
  const retryDelayMs = retryable ? retryDelayFor(result.blockedBy, workspaceId) : null;
  throw new JobError(`发送被安全管线拦截：${result.blockedBy}（${result.reason}）`, {
    retryable,
    code: 'SEND_BLOCKED',
    retryDelayMs,
  });
}

// --------------------------------------------------------------- inbox sync
function findThreadByHeaders(workspaceId, headers = []) {
  for (const header of headers.filter(Boolean)) {
    const parent = get(
      'SELECT thread_id FROM email_messages WHERE workspace_id = ? AND message_id_header = ? AND thread_id IS NOT NULL LIMIT 1',
      [workspaceId, header],
    );
    if (parent?.thread_id) return parent.thread_id;
  }
  return null;
}

function createThread({ workspaceId, accountId, companyId = null, contactId = null, subject = '', at = null }) {
  const threadId = id('thr');
  const now = at || nowIso();
  run(
    `INSERT INTO email_threads
       (id, workspace_id, account_id, company_id, contact_id, subject, last_message_at, message_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?)`,
    [threadId, workspaceId, accountId, companyId, contactId, subject, now, now, now],
  );
  return threadId;
}

function refreshThread(threadId, workspaceId) {
  const aggregate = get(
    `SELECT COUNT(*) AS total, MAX(COALESCE(received_at, sent_at, created_at)) AS last_at
       FROM email_messages WHERE workspace_id = ? AND thread_id = ?`,
    [workspaceId, threadId],
  );
  run("UPDATE email_threads SET message_count = ?, last_message_at = ?, status = 'replied', updated_at = ? WHERE id = ? AND workspace_id = ?", [
    aggregate?.total ?? 0,
    aggregate?.last_at || nowIso(),
    nowIso(),
    threadId,
    workspaceId,
  ]);
}

function insertInboundMessage({ workspaceId, account, message, jobId }) {
  if (!message.messageId) return { inserted: false, reason: 'missing_message_id' };
  const existing = get(
    'SELECT id FROM email_messages WHERE workspace_id = ? AND account_id = ? AND message_id_header = ? LIMIT 1',
    [workspaceId, account.id, message.messageId],
  );
  if (existing) return { inserted: false, messageRowId: existing.id, reason: 'duplicate' };

  const fromAddress = message.from?.address || '';
  const contact = fromAddress
    ? get('SELECT id, company_id FROM contacts WHERE workspace_id = ? AND email_normalized = ? LIMIT 1', [workspaceId, fromAddress])
    : null;
  const companyId = contact?.company_id || null;
  const threadId = findThreadByHeaders(workspaceId, [message.inReplyTo, ...(message.references || [])])
    || createThread({
      workspaceId,
      accountId: account.id,
      companyId,
      contactId: contact?.id || null,
      subject: message.subject || '',
      at: message.date || null,
    });

  const messageRowId = id('msg');
  const now = nowIso();
  run(
    `INSERT INTO email_messages
       (id, workspace_id, account_id, thread_id, company_id, contact_id, direction, from_address, from_name,
        to_addresses_json, cc_json, bcc_json, subject, body_text, body_html, message_id_header, in_reply_to,
        references_json, sent_at, received_at, status, error, is_read, raw_headers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, NULL, ?, 'received', NULL, 0, ?, ?)`,
    [
      messageRowId,
      workspaceId,
      account.id,
      threadId,
      companyId,
      contact?.id || null,
      fromAddress,
      message.from?.name || null,
      JSON.stringify([account.address]),
      JSON.stringify((message.cc || []).map((item) => item.address).filter(Boolean)),
      message.subject || '',
      message.text || '',
      message.html || '',
      message.messageId,
      message.inReplyTo || null,
      JSON.stringify(message.references || []),
      message.date || now,
      JSON.stringify({ demo: Boolean(message.demo), simulation: Boolean(message.demo), jobId, uid: message.uid || null }),
      now,
    ],
  );
  refreshThread(threadId, workspaceId);
  const queued = enqueueJob({
    workspaceId,
    type: 'reply.classify',
    payload: { messageId: messageRowId },
    dedupeKey: `reply.classify:${workspaceId}:${messageRowId}`,
    priority: 60,
  });
  return { inserted: true, messageRowId, threadId, classified: !queued.deduped };
}

function syncSimulation({ workspaceId, account, jobId }) {
  const outbound = get(
    `SELECT * FROM email_messages
      WHERE workspace_id = ? AND account_id = ? AND direction = 'outbound' AND status = 'sent'
      ORDER BY sent_at DESC LIMIT 1`,
    [workspaceId, account.id],
  );
  if (!outbound) return { mode: 'simulation', inserted: 0, note: 'no_outbound_message_to_reply_to' };
  const alreadyReplied = get(
    `SELECT id FROM email_messages
      WHERE workspace_id = ? AND account_id = ? AND direction = 'inbound' AND in_reply_to = ?
        AND raw_headers_json LIKE '%"demo":true%' LIMIT 1`,
    [workspaceId, account.id, outbound.message_id_header],
  );
  if (alreadyReplied) return { mode: 'simulation', inserted: 0, note: 'demo_reply_already_generated' };

  const demo = simulateInboundReply({ outbound, account });
  const result = insertInboundMessage({ workspaceId, account, message: demo, jobId });
  return { mode: 'simulation', demo: true, ...result, inserted: result.inserted ? 1 : 0 };
}

async function syncImap({ workspaceId, account, config, logger, job }) {
  let emailAccountsModule;
  try {
    emailAccountsModule = await loadUpstream('emailAccounts');
  } catch (error) {
    throw new JobError(`邮箱账号服务尚未就绪，无法解密凭据：${String(error && error.message ? error.message : error).slice(0, 300)}`, {
      retryable: true,
      code: 'UPSTREAM_NOT_READY',
    });
  }
  const loader = emailAccountsModule.loadEmailAccount || emailAccountsModule.loadSendAccount;
  if (typeof loader !== 'function') {
    throw new JobError('邮箱账号服务缺少 loadEmailAccount/loadSendAccount 契约函数', { retryable: true, code: 'UPSTREAM_NOT_READY' });
  }
  const loaded = await loader(workspaceId, account.id);
  if (!loaded) throw new JobError('邮箱账号凭据不可用', { retryable: false, code: 'ACCOUNT_CREDENTIALS_MISSING' });
  const imap = resolveImapConfig(loaded.account || account, loaded.secret || {}, loaded.config || {});
  if (!imap.host) throw new JobError('IMAP 主机未配置', { retryable: false, code: 'IMAP_NOT_CONFIGURED' });
  let fetched;
  try {
    fetched = await imapFetchMessages({
      ...imap,
      limit: 50,
      unseen: false,
      since: addDays(-7),
      logger,
    });
  } catch (error) {
    run('UPDATE email_accounts SET last_error = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [
      String(error && error.message ? error.message : error).slice(0, 500),
      nowIso(),
      account.id,
      workspaceId,
    ]);
    await tryCallUpstream('emailAccounts', 'markAccountSynced', workspaceId, account.id, {
      error: String(error && error.message ? error.message : error).slice(0, 300),
    });
    throw new JobError(`IMAP 同步失败：${String(error && error.message ? error.message : error).slice(0, 300)}`, {
      retryable: Boolean(error && error.transient),
      code: 'IMAP_SYNC_FAILED',
    });
  }
  let inserted = 0;
  let duplicates = 0;
  let classified = 0;
  for (const message of fetched.messages) {
    const result = insertInboundMessage({ workspaceId, account, message, jobId: job.id });
    if (result.inserted) inserted += 1;
    else duplicates += 1;
    if (result.classified) classified += 1;
  }
  return { mode: 'imap', fetched: fetched.messages.length, inserted, duplicates, classified, mailboxExists: fetched.exists };
}

async function emailSync({ job, workspaceId, payload, config, logger }) {
  const accountId = requirePayloadField(payload, 'accountId');
  const account = get('SELECT * FROM email_accounts WHERE id = ? AND workspace_id = ?', [accountId, workspaceId]);
  if (!account) throw new JobError('发件邮箱账号不存在', { retryable: false, code: 'ACCOUNT_NOT_FOUND' });
  if (account.status === 'paused') return { accountId, skipped: 'account_paused' };

  const result = isSimulationAccount(account)
    ? syncSimulation({ workspaceId, account, jobId: job.id })
    : await syncImap({ workspaceId, account, config, logger, job });

  const now = nowIso();
  run('UPDATE email_accounts SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?', [
    now,
    now,
    account.id,
    workspaceId,
  ]);
  await tryCallUpstream('emailAccounts', 'markAccountSynced', workspaceId, accountId, { error: null });
  recordJobAudit({
    workspaceId,
    action: 'email.sync.completed',
    entityType: 'email_account',
    entityId: accountId,
    after: { ...result, jobId: job.id },
  });
  return { accountId, ...result };
}

export const handlers = {
  'email.send': emailSend,
  'email.sync': emailSync,
};

export default handlers;
