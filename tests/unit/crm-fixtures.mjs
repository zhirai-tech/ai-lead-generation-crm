/**
 * OWNER: t-crm. Test fixtures for the outreach / CRM domain.
 *
 * The data domain (t-data) owns company/contact/product writes; until those
 * routes exist the CRM tests seed the shared master records directly so that
 * the tests only depend on the published schema.
 */
import { get, run } from '../../server/core/db.mjs';
import { id } from '../../server/core/ids.mjs';
import { nowIso, addDays } from '../../server/core/time.mjs';
import { normalizeEmail, normalizeName } from '../../server/core/validate.mjs';

export function seedCompany({
  workspaceId,
  name = 'Test Autoteile GmbH',
  domain = 'test-autoteile.de',
  country = 'DE',
  industry = 'Automotive',
  companyType = 'importer',
  status = 'new',
  description = 'European automotive parts importer.',
} = {}) {
  const companyId = id('cmp');
  const now = nowIso();
  run(
    `INSERT INTO companies
      (id, workspace_id, name, normalized_name, domain, website, country, industry, company_type, description,
       status, tags_json, data_quality_score, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 70, 'medium', ?, ?)`,
    [
      companyId,
      workspaceId,
      name,
      normalizeName(name).toLowerCase(),
      domain,
      domain ? `https://${domain}` : null,
      country,
      industry,
      companyType,
      description,
      status,
      now,
      now,
    ],
  );
  return { id: companyId, workspaceId, name, domain, country };
}

export function seedContact({
  workspaceId,
  companyId,
  firstName = 'Anna',
  lastName = 'Müller',
  email = `anna-${Math.random().toString(16).slice(2, 8)}@test-autoteile.de`,
  title = 'Purchasing Manager',
  language = 'de',
  isPrimary = true,
  roleCategory = 'decision_maker',
} = {}) {
  const contactId = id('con');
  const now = nowIso();
  const normalized = normalizeEmail(email);
  run(
    `INSERT INTO contacts
      (id, workspace_id, company_id, first_name, last_name, full_name, title, role_category, email, email_normalized,
       email_type, email_status, language, is_primary, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'business', 'valid', ?, ?, 'high', ?, ?)`,
    [
      contactId,
      workspaceId,
      companyId,
      firstName,
      lastName,
      `${firstName} ${lastName}`,
      title,
      roleCategory,
      email,
      normalized,
      language,
      isPrimary ? 1 : 0,
      now,
      now,
    ],
  );
  return { id: contactId, workspaceId, companyId, email, emailNormalized: normalized, fullName: `${firstName} ${lastName}` };
}

export function seedProduct({ workspaceId, name = 'Battery Pack Bracket', category = 'EV parts' } = {}) {
  const productId = id('prd');
  const now = nowIso();
  run(
    `INSERT INTO products (id, workspace_id, name, category, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Aluminium battery pack bracket for EV.', 'active', ?, ?)`,
    [productId, workspaceId, name, category, now, now],
  );
  return { id: productId, workspaceId, name };
}

export function seedAccount({ workspaceId, address = `sales-${Math.random().toString(16).slice(2, 8)}@zhirai.test`, name = '销售邮箱' } = {}) {
  const accountId = id('acc');
  const now = nowIso();
  run(
    `INSERT INTO email_accounts
      (id, workspace_id, name, address, display_name, protocol, smtp_host, smtp_port, smtp_secure,
       imap_host, imap_port, imap_secure, username, daily_limit, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ZHIRAI Sales', 'simulation', NULL, NULL, 1, NULL, NULL, 1, ?, 50, 'active', ?, ?)`,
    [accountId, workspaceId, name, address, address, now, now],
  );
  return { id: accountId, workspaceId, address };
}

export function seedThread({
  workspaceId,
  companyId = null,
  contactId = null,
  accountId = null,
  subject = 'Re: Battery pack bracket inquiry',
  status = 'open',
} = {}) {
  const threadId = id('thr');
  const now = nowIso();
  run(
    `INSERT INTO email_threads
      (id, workspace_id, account_id, company_id, contact_id, subject, last_message_at, message_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [threadId, workspaceId, accountId, companyId, contactId, subject, now, status, now, now],
  );
  return { id: threadId, workspaceId, companyId, contactId, subject };
}

export function seedMessage({
  workspaceId,
  threadId = null,
  companyId = null,
  contactId = null,
  accountId = null,
  direction = 'inbound',
  fromAddress = 'buyer@test-autoteile.de',
  fromName = 'Anna Müller',
  toAddresses = ['sales@zhirai.test'],
  subject = 'Re: Battery pack bracket inquiry',
  bodyText = 'Hello, we are interested in your battery pack bracket. Please send a quotation.',
  receivedAt = nowIso(),
  isRead = false,
  status = null,
} = {}) {
  const messageId = id('eml');
  const now = nowIso();
  const effectiveStatus = status || (direction === 'inbound' ? 'received' : 'sent');
  run(
    `INSERT INTO email_messages
      (id, workspace_id, account_id, thread_id, company_id, contact_id, direction, from_address, from_name,
       to_addresses_json, cc_json, bcc_json, subject, body_text, body_html, message_id_header, in_reply_to,
       references_json, sent_at, received_at, status, is_read, raw_headers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, NULL, ?, NULL, '[]', ?, ?, ?, ?, '{}', ?)`,
    [
      messageId,
      workspaceId,
      accountId,
      threadId,
      companyId,
      contactId,
      direction,
      fromAddress,
      fromName,
      JSON.stringify(toAddresses),
      subject,
      bodyText,
      `<${messageId}@test.local>`,
      direction === 'outbound' ? receivedAt : null,
      direction === 'inbound' ? receivedAt : null,
      effectiveStatus,
      isRead ? 1 : 0,
      now,
    ],
  );
  return { id: messageId, threadId, companyId, contactId, direction, subject };
}

export function seedDeal({ workspaceId, companyId, contactId = null, title = '商机', stage = 'lead' } = {}) {
  const dealId = id('deal');
  const now = nowIso();
  run(
    `INSERT INTO deals (id, workspace_id, company_id, contact_id, title, stage, value_amount, currency, probability, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 20000, 'EUR', 10, 'open', ?, ?)`,
    [dealId, workspaceId, companyId, contactId, title, stage, now, now],
  );
  return { id: dealId, workspaceId, companyId, title, stage };
}

export function seedFollowUpTask({ workspaceId, companyId, title = '跟进', dueAt = addDays(1), status = 'pending' } = {}) {
  const taskId = id('fut');
  const now = nowIso();
  run(
    `INSERT INTO follow_up_tasks (id, workspace_id, company_id, due_at, type, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'follow_up', ?, ?, ?, ?)`,
    [taskId, workspaceId, companyId, dueAt, title, status, now, now],
  );
  return { id: taskId, workspaceId, companyId, title };
}

export function auditActions(workspaceId, action) {
  return get('SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND action = ?', [workspaceId, action])?.c ?? 0;
}

export function getState(workspaceId, companyId) {
  return get('SELECT * FROM automation_states WHERE workspace_id = ? AND company_id = ?', [workspaceId, companyId]);
}

export function pendingTaskCount(workspaceId, companyId) {
  return get("SELECT COUNT(*) AS c FROM follow_up_tasks WHERE workspace_id = ? AND company_id = ? AND status = 'pending'", [
    workspaceId,
    companyId,
  ])?.c ?? 0;
}
