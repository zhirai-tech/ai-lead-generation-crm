/**
 * OWNER: t-crm.
 *
 * Email account / thread / message / classification persistence. SQL + row
 * mapping only; the send pipeline (t-worker) owns actual delivery. Sealed
 * credentials never leave this layer unless explicitly decrypted by the
 * email-accounts service for an internal caller.
 */
import { all, get, run } from '../core/db.mjs';
import { bool, jsonArray, jsonObject, paged } from './helpers.mjs';

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

// ------------------------------------------------------------------- accounts
export function mapAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    address: row.address,
    displayName: row.display_name,
    protocol: row.protocol,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: bool(row.smtp_secure),
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: bool(row.imap_secure),
    username: row.username,
    hasCredential: Boolean(row.credential_enc),
    signature: row.signature,
    dailyLimit: row.daily_limit,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(workspaceId) {
  return all('SELECT * FROM email_accounts WHERE workspace_id = ? ORDER BY created_at ASC', [workspaceId]).map(mapAccount);
}

export function getAccount(workspaceId, accountId) {
  if (!accountId) return null;
  return mapAccount(get('SELECT * FROM email_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, accountId]));
}

/** Raw account row (includes credential_enc) — internal service use only. */
export function getAccountRow(workspaceId, accountId) {
  if (!accountId) return null;
  return get('SELECT * FROM email_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, accountId]) || null;
}

export function getAccountByAddress(workspaceId, address) {
  if (!address) return null;
  return get('SELECT * FROM email_accounts WHERE workspace_id = ? AND address = ? COLLATE NOCASE', [workspaceId, address]) || null;
}

export function getActiveAccount(workspaceId) {
  const row = get("SELECT * FROM email_accounts WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1", [workspaceId]);
  return mapAccount(row);
}

export function createAccount(workspaceId, data) {
  run(
    `INSERT INTO email_accounts
      (id, workspace_id, name, address, display_name, protocol, smtp_host, smtp_port, smtp_secure,
       imap_host, imap_port, imap_secure, username, credential_enc, signature, daily_limit, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.name,
      data.address,
      data.displayName ?? null,
      data.protocol || 'smtp_imap',
      data.smtpHost ?? null,
      data.smtpPort ?? null,
      data.smtpSecure === false ? 0 : 1,
      data.imapHost ?? null,
      data.imapPort ?? null,
      data.imapSecure === false ? 0 : 1,
      data.username ?? null,
      data.credentialEnc ?? null,
      data.signature ?? null,
      data.dailyLimit ?? 50,
      data.status || 'active',
      data.createdBy ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return getAccount(workspaceId, data.id);
}

const ACCOUNT_UPDATE_COLUMNS = {
  name: 'name',
  address: 'address',
  displayName: 'display_name',
  protocol: 'protocol',
  smtpHost: 'smtp_host',
  smtpPort: 'smtp_port',
  smtpSecure: 'smtp_secure',
  imapHost: 'imap_host',
  imapPort: 'imap_port',
  imapSecure: 'imap_secure',
  username: 'username',
  credentialEnc: 'credential_enc',
  signature: 'signature',
  dailyLimit: 'daily_limit',
  status: 'status',
  lastSyncAt: 'last_sync_at',
  lastError: 'last_error',
};

export function updateAccount(workspaceId, accountId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(ACCOUNT_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (key === 'smtpSecure' || key === 'imapSecure') params.push(patch[key] ? 1 : 0);
    else params.push(patch[key]);
  }
  if (!sets.length) return getAccount(workspaceId, accountId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE email_accounts SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, accountId]);
  return getAccount(workspaceId, accountId);
}

export function deleteAccount(workspaceId, accountId) {
  return run('DELETE FROM email_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, accountId]).changes;
}

export function countAccounts(workspaceId) {
  const row = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored
       FROM email_accounts WHERE workspace_id = ?`,
    [workspaceId],
  );
  return { total: Number(row?.total || 0), active: Number(row?.active || 0), error: Number(row?.errored || 0) };
}

// -------------------------------------------------------------------- threads
const THREAD_SELECT = `
  SELECT th.*,
         c.name AS company_name,
         c.domain AS company_domain,
         ct.full_name AS contact_name,
         ct.email AS contact_email,
         (SELECT COUNT(*) FROM email_messages m
           WHERE m.thread_id = th.id AND m.direction = 'inbound' AND m.is_read = 0) AS unread_count,
         (SELECT m.body_text FROM email_messages m
           WHERE m.thread_id = th.id
           ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC LIMIT 1) AS last_body,
         (SELECT m.direction FROM email_messages m
           WHERE m.thread_id = th.id
           ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC LIMIT 1) AS last_direction,
         (SELECT cc.label FROM conversation_classifications cc
           WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) AS latest_label,
         (SELECT cc.intent_score FROM conversation_classifications cc
           WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) AS latest_intent_score,
         (SELECT cc.suggested_reply FROM conversation_classifications cc
           WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) AS latest_suggested_reply
    FROM email_threads th
    LEFT JOIN companies c ON c.id = th.company_id AND c.workspace_id = th.workspace_id
    LEFT JOIN contacts ct ON ct.id = th.contact_id AND ct.workspace_id = th.workspace_id`;

export const HIGH_INTENT_LABELS = ['positive_interest', 'price_inquiry', 'quote_request', 'sample_request'];

export function mapThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    subject: row.subject,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    status: row.status,
    classification: row.classification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    companyName: row.company_name ?? null,
    companyDomain: row.company_domain ?? null,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    unreadCount: Number(row.unread_count || 0),
    latestLabel: row.latest_label ?? null,
    latestIntentScore: row.latest_intent_score !== null && row.latest_intent_score !== undefined ? Number(row.latest_intent_score) : 0,
    latestSuggestedReply: row.latest_suggested_reply ?? null,
    lastMessagePreview: row.last_body ? String(row.last_body).replace(/\s+/g, ' ').slice(0, 240) : null,
    lastMessageDirection: row.last_direction ?? null,
  };
}

function threadFilters(workspaceId, { unread = false, highIntent = false, companyId = null, classification = null, status = null, search = '' } = {}) {
  const where = ['th.workspace_id = ?'];
  const params = [workspaceId];
  if (unread) {
    where.push("EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = th.id AND m.direction = 'inbound' AND m.is_read = 0)");
  }
  if (highIntent) {
    where.push(
      `(SELECT cc.label FROM conversation_classifications cc WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) IN (${placeholders(
        HIGH_INTENT_LABELS.length,
      )})`,
    );
    params.push(...HIGH_INTENT_LABELS);
  }
  if (companyId) {
    where.push('th.company_id = ?');
    params.push(companyId);
  }
  if (classification) {
    where.push(
      `(SELECT cc.label FROM conversation_classifications cc WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) = ?`,
    );
    params.push(classification);
  }
  if (status) {
    where.push('th.status = ?');
    params.push(status);
  }
  if (search) {
    where.push("(th.subject LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR ct.email LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like);
  }
  return { clause: where.join(' AND '), params };
}

export function listThreads(workspaceId, filters = {}, { page = 1, pageSize = 25, offset = 0, limit = 25 } = {}) {
  const { clause, params } = threadFilters(workspaceId, filters);
  const rows = all(
    `${THREAD_SELECT}
      WHERE ${clause}
      ORDER BY COALESCE(th.last_message_at, th.updated_at) DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(mapThread);
  const total = get(
    `SELECT COUNT(*) AS c
       FROM email_threads th
       LEFT JOIN companies c ON c.id = th.company_id AND c.workspace_id = th.workspace_id
       LEFT JOIN contacts ct ON ct.id = th.contact_id AND ct.workspace_id = th.workspace_id
      WHERE ${clause}`,
    params,
  )?.c ?? 0;
  return paged(rows, total, page, pageSize);
}

export function getThread(workspaceId, threadId) {
  if (!threadId) return null;
  const row = get(`${THREAD_SELECT} WHERE th.workspace_id = ? AND th.id = ?`, [workspaceId, threadId]);
  return mapThread(row);
}

export function countThreads(workspaceId) {
  return get('SELECT COUNT(*) AS c FROM email_threads WHERE workspace_id = ?', [workspaceId])?.c ?? 0;
}

export function countUnreadThreads(workspaceId) {
  return (
    get(
      `SELECT COUNT(*) AS c FROM email_threads th
        WHERE th.workspace_id = ?
          AND EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = th.id AND m.direction = 'inbound' AND m.is_read = 0)`,
      [workspaceId],
    )?.c ?? 0
  );
}

export function countHighIntentThreads(workspaceId) {
  const labels = HIGH_INTENT_LABELS.map(() => '?').join(', ');
  return (
    get(
      `SELECT COUNT(*) AS c FROM email_threads th
        WHERE th.workspace_id = ?
          AND (SELECT cc.label FROM conversation_classifications cc WHERE cc.thread_id = th.id ORDER BY cc.created_at DESC LIMIT 1) IN (${labels})`,
      [workspaceId, ...HIGH_INTENT_LABELS],
    )?.c ?? 0
  );
}

export function createThread(workspaceId, data) {
  run(
    `INSERT INTO email_threads
      (id, workspace_id, account_id, company_id, contact_id, subject, last_message_at, message_count, status, classification, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.accountId ?? null,
      data.companyId ?? null,
      data.contactId ?? null,
      data.subject ?? null,
      data.lastMessageAt ?? null,
      data.messageCount ?? 0,
      data.status || 'open',
      data.classification ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return getThread(workspaceId, data.id);
}

const THREAD_UPDATE_COLUMNS = {
  accountId: 'account_id',
  companyId: 'company_id',
  contactId: 'contact_id',
  subject: 'subject',
  lastMessageAt: 'last_message_at',
  messageCount: 'message_count',
  status: 'status',
  classification: 'classification',
};

export function updateThread(workspaceId, threadId, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(THREAD_UPDATE_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  return run(`UPDATE email_threads SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, threadId]).changes;
}

// ------------------------------------------------------------------- messages
export function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    threadId: row.thread_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    direction: row.direction,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddresses: jsonArray(row.to_addresses_json),
    cc: jsonArray(row.cc_json),
    bcc: jsonArray(row.bcc_json),
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: jsonArray(row.references_json),
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    status: row.status,
    error: row.error,
    isRead: Boolean(row.is_read),
    rawHeaders: jsonObject(row.raw_headers_json),
    createdAt: row.created_at,
  };
}

export function listMessages(workspaceId, threadId) {
  const rows = all(
    `SELECT * FROM email_messages
      WHERE workspace_id = ? AND thread_id = ?
      ORDER BY COALESCE(received_at, sent_at, created_at) ASC`,
    [workspaceId, threadId],
  );
  return rows.map(mapMessage);
}

export function getMessage(workspaceId, messageId) {
  if (!messageId) return null;
  return mapMessage(get('SELECT * FROM email_messages WHERE workspace_id = ? AND id = ?', [workspaceId, messageId]));
}

/** Recent messages for a company (draft / classification context). */
export function listCompanyMessages(workspaceId, companyId, limit = 10) {
  const rows = all(
    `SELECT * FROM email_messages
      WHERE workspace_id = ? AND company_id = ?
      ORDER BY COALESCE(received_at, sent_at, created_at) DESC
      LIMIT ?`,
    [workspaceId, companyId, limit],
  );
  return rows.map(mapMessage);
}

/** Recent inbound messages for a thread, newest first. */
export function listThreadMessages(workspaceId, threadId, { direction = null, limit = 20 } = {}) {
  const params = [workspaceId, threadId];
  let sql = 'SELECT * FROM email_messages WHERE workspace_id = ? AND thread_id = ?';
  if (direction) {
    sql += ' AND direction = ?';
    params.push(direction);
  }
  sql += ' ORDER BY COALESCE(received_at, sent_at, created_at) DESC LIMIT ?';
  params.push(limit);
  return all(sql, params).map(mapMessage);
}

export function createMessage(workspaceId, data) {
  run(
    `INSERT INTO email_messages
      (id, workspace_id, account_id, thread_id, company_id, contact_id, direction, from_address, from_name,
       to_addresses_json, cc_json, bcc_json, subject, body_text, body_html, message_id_header, in_reply_to,
       references_json, sent_at, received_at, status, error, is_read, raw_headers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.accountId ?? null,
      data.threadId ?? null,
      data.companyId ?? null,
      data.contactId ?? null,
      data.direction,
      data.fromAddress ?? null,
      data.fromName ?? null,
      JSON.stringify(data.toAddresses || []),
      JSON.stringify(data.cc || []),
      JSON.stringify(data.bcc || []),
      data.subject ?? null,
      data.bodyText ?? null,
      data.bodyHtml ?? null,
      data.messageIdHeader ?? null,
      data.inReplyTo ?? null,
      JSON.stringify(data.references || []),
      data.sentAt ?? null,
      data.receivedAt ?? null,
      data.status || (data.direction === 'inbound' ? 'received' : 'sent'),
      data.error ?? null,
      data.isRead ? 1 : 0,
      JSON.stringify(data.rawHeaders || {}),
      data.createdAt,
    ],
  );
  return getMessage(workspaceId, data.id);
}

export function markThreadRead(workspaceId, threadId) {
  return run("UPDATE email_messages SET is_read = 1 WHERE workspace_id = ? AND thread_id = ? AND direction = 'inbound' AND is_read = 0", [
    workspaceId,
    threadId,
  ]).changes;
}

/** Count outbound messages actually sent since an ISO timestamp (daily limits). */
export function countOutboundSentSince(workspaceId, sinceIso, { accountId = null } = {}) {
  const params = [workspaceId, sinceIso];
  let sql = `SELECT COUNT(*) AS c FROM email_messages
              WHERE workspace_id = ? AND direction = 'outbound' AND status IN ('sent', 'sending')
                AND COALESCE(sent_at, created_at) >= ?`;
  if (accountId) {
    sql += ' AND account_id = ?';
    params.push(accountId);
  }
  return get(sql, params)?.c ?? 0;
}

// ----------------------------------------------------------- classifications
export function mapClassification(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    label: row.label,
    confidence: row.confidence,
    intentScore: row.intent_score,
    evidence: jsonArray(row.evidence_json),
    rationale: row.rationale,
    suggestedReply: row.suggested_reply,
    status: row.status,
    agentExecutionId: row.agent_execution_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createClassification(workspaceId, data) {
  run(
    `INSERT INTO conversation_classifications
      (id, workspace_id, thread_id, message_id, company_id, contact_id, label, confidence, intent_score,
       evidence_json, rationale, suggested_reply, status, agent_execution_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      workspaceId,
      data.threadId ?? null,
      data.messageId ?? null,
      data.companyId ?? null,
      data.contactId ?? null,
      data.label,
      data.confidence ?? 0,
      data.intentScore ?? 0,
      JSON.stringify(data.evidence || []),
      data.rationale ?? null,
      data.suggestedReply ?? null,
      data.status || 'ai_suggested',
      data.agentExecutionId ?? null,
      data.createdAt,
      data.updatedAt,
    ],
  );
  return mapClassification(get('SELECT * FROM conversation_classifications WHERE workspace_id = ? AND id = ?', [workspaceId, data.id]));
}

export function getClassification(workspaceId, classificationId) {
  return mapClassification(
    get('SELECT * FROM conversation_classifications WHERE workspace_id = ? AND id = ?', [workspaceId, classificationId]),
  );
}

export function latestClassificationForThread(workspaceId, threadId) {
  return mapClassification(
    get(
      'SELECT * FROM conversation_classifications WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 1',
      [workspaceId, threadId],
    ),
  );
}

export function latestClassificationForMessage(workspaceId, messageId) {
  return mapClassification(
    get(
      'SELECT * FROM conversation_classifications WHERE workspace_id = ? AND message_id = ? ORDER BY created_at DESC LIMIT 1',
      [workspaceId, messageId],
    ),
  );
}

export function listClassifications(workspaceId, { threadId = null, messageId = null, label = null, limit = 50, offset = 0 } = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (threadId) {
    where.push('thread_id = ?');
    params.push(threadId);
  }
  if (messageId) {
    where.push('message_id = ?');
    params.push(messageId);
  }
  if (label) {
    where.push('label = ?');
    params.push(label);
  }
  return all(
    `SELECT * FROM conversation_classifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(mapClassification);
}

export function updateClassification(workspaceId, classificationId, patch) {
  const sets = [];
  const params = [];
  if (patch.label !== undefined) {
    sets.push('label = ?');
    params.push(patch.label);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.rationale !== undefined) {
    sets.push('rationale = ?');
    params.push(patch.rationale);
  }
  if (!sets.length) return getClassification(workspaceId, classificationId);
  sets.push('updated_at = ?');
  params.push(patch.updatedAt);
  run(`UPDATE conversation_classifications SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [
    ...params,
    workspaceId,
    classificationId,
  ]);
  return getClassification(workspaceId, classificationId);
}

export function countClassifications(workspaceId, label = null) {
  if (label) {
    return get('SELECT COUNT(*) AS c FROM conversation_classifications WHERE workspace_id = ? AND label = ?', [workspaceId, label])?.c ?? 0;
  }
  return get('SELECT COUNT(*) AS c FROM conversation_classifications WHERE workspace_id = ?', [workspaceId])?.c ?? 0;
}

/** FK-safety check for generated_by / agent_execution_id columns. */
export function agentExecutionExists(executionId) {
  if (!executionId) return false;
  return Boolean(get('SELECT 1 AS ok FROM agent_executions WHERE id = ?', [executionId]));
}

/**
 * Reflect "customer replied" on the company master record. The data domain owns
 * writes to companies, but replies are the CRM-owned trigger for this status.
 */
export function updateCompanyStatus(workspaceId, companyId, status, updatedAt) {
  return run('UPDATE companies SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?', [
    status,
    updatedAt,
    workspaceId,
    companyId,
  ]).changes;
}
