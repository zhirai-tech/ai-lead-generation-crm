/**
 * t-worker unit tests: send-safety pipeline.
 *
 * Every send interception rule required by the spec is exercised against a real
 * temp SQLite database with a simulation mail account:
 *   not approved · suppression (email + domain) · HUMAN_TAKEOVER ·
 *   DO_NOT_CONTACT · PAUSED · CLOSED · outside send window · account daily
 *   limit · workspace daily limit · duplicate draft · duplicate recipient ·
 *   bounce circuit breaker · auto-send disabled · global pause ·
 *   missing credentials.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, get, all, upsertSetting } from '../../server/core/db.mjs';
import { id } from '../../server/core/ids.mjs';
import { nowIso, addHours } from '../../server/core/time.mjs';
import {
  buildCatalogueLinkLines,
  loadDraftAttachments,
  resolveUploadFilePath,
  sendDraft,
  assertSendAllowed,
  isWithinSendWindow,
} from '../../server/jobs/send-pipeline.mjs';
import { MIME_ATTACHMENT_MAX_BYTES, parseMimeMessage } from '../../server/mail/mime.mjs';
import { createTestContext } from '../../server/jobs/test-support.mjs';

let ctx;
let workspaceId;
let seq = 0;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
const ALL_DAY_WINDOW = { start: 0, end: 24, weekdays: ALL_WEEK, timezone: 'UTC' };

before(async () => {
  ctx = await createTestContext({ withServer: false });
  workspaceId = ctx.owner.workspaceId;
});

after(async () => {
  await ctx.close();
});

function resetSettings() {
  upsertSetting(workspaceId, 'outreach', {
    requireApproval: true,
    autoSendEnabled: false,
    dailySendLimit: 50,
    sendWindow: ALL_DAY_WINDOW,
    signature: 'ZHIRAI · 智睿科技',
  });
  upsertSetting(workspaceId, 'limits', { dailyEmailLimit: 1000 });
}

beforeEach(() => {
  run('DELETE FROM email_messages WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM message_drafts WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM email_accounts WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM automation_states WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM suppression_records WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM product_files WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM products WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM contacts WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM companies WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM usage_records WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM audit_events WHERE workspace_id = ?', [workspaceId]);
  run('DELETE FROM background_jobs WHERE workspace_id = ?', [workspaceId]);
  resetSettings();
});

/**
 * Insert a company + contact + simulation account + approved draft.
 * @returns {{companyId,contactId,accountId,draftId,email}}
 */
function seed({
  draftStatus = 'approved',
  subject = 'Reliable industrial components from ZHIRAI',
  bodyText = 'Dear buyer, we would like to introduce our product line.',
  automationState = null,
  suppression = null,
  account = {},
  contact = {},
  draft = {},
} = {}) {
  seq += 1;
  const now = nowIso();
  const companyId = id('cmp');
  const contactId = id('con');
  const accountId = id('acc');
  const draftId = id('drf');
  const domain = `company${seq}.example`;
  const email = `buyer${seq}@${domain}`;
  run(
    `INSERT INTO companies (id, workspace_id, name, normalized_name, domain, country, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DE', ?, ?)`,
    [companyId, workspaceId, `Company ${seq} GmbH`, `company ${seq} gmbh`, domain, now, now],
  );
  run(
    `INSERT INTO contacts (id, workspace_id, company_id, full_name, email, email_normalized, role_category, email_type, email_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'decision_maker', 'business', 'valid', ?, ?)`,
    [contactId, workspaceId, companyId, `Buyer ${seq}`, contact.email || email, contact.email || email, now, now],
  );
  run(
    `INSERT INTO email_accounts (id, workspace_id, name, address, display_name, protocol, daily_limit, status, created_at, updated_at)
     VALUES (?, ?, 'Simulation', ?, 'ZHIRAI Sales', ?, ?, 'active', ?, ?)`,
    [
      accountId,
      workspaceId,
      account.address || `sender${seq}@zhirai.example`,
      account.protocol || 'simulation',
      account.dailyLimit ?? 50,
      now,
      now,
    ],
  );
  run(
    `INSERT INTO message_drafts
       (id, workspace_id, company_id, contact_id, account_id, subject, body_text, language, status, quality_json, guard_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'en', ?, '{}', '{}', ?, ?)`,
    [
      draftId,
      workspaceId,
      companyId,
      contactId,
      accountId,
      draft.subject || subject,
      draft.bodyText || bodyText,
      draft.status || draftStatus,
      now,
      now,
    ],
  );
  if (automationState) {
    run(
      `INSERT INTO automation_states (id, workspace_id, company_id, state, reason, changed_by, changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', 'test', ?, ?, ?)`,
      [id('aut'), workspaceId, companyId, automationState, now, now, now],
    );
  }
  if (suppression) {
    run(
      `INSERT INTO suppression_records (id, workspace_id, scope, value_normalized, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'test', ?)`,
      [id('sup'), workspaceId, suppression.scope, suppression.value, suppression.reason || 'unsubscribe', now],
    );
  }
  return { companyId, contactId, accountId, draftId, email, domain };
}

function auditCount(action) {
  return get('SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ? AND action = ?', [workspaceId, action])?.c ?? 0;
}

const PDF_CONTENT = Buffer.from('%PDF-1.4\n% ZHIRAI catalogue test\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'binary');

/** Insert a product + product_files row and (optionally) write the real file. */
function seedProductFile({ filename = 'catalogue.pdf', mimeType = 'application/pdf', content = PDF_CONTENT, publicUrl = null, writeFile = true } = {}) {
  seq += 1;
  const now = nowIso();
  const productId = id('prd');
  const fileId = id('pfl');
  run("INSERT INTO products (id, workspace_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)", [
    productId,
    workspaceId,
    `Attachment Product ${seq}`,
    now,
    now,
  ]);
  const extension = String(mimeType).includes('/') ? String(mimeType).split('/')[1].replace(/[^a-z0-9]/gi, '') || 'bin' : 'bin';
  const storagePath = `products/${workspaceId}/${productId}/${fileId}.${extension}`;
  const absolutePath = path.join(ctx.config.uploadsDir, storagePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (writeFile) fs.writeFileSync(absolutePath, content);
  run(
    `INSERT INTO product_files (id, workspace_id, product_id, filename, mime_type, size_bytes, storage_path, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'document', ?)`,
    [fileId, workspaceId, productId, filename, mimeType, content.length, storagePath, now],
  );
  return {
    productId,
    fileId,
    filename,
    mimeType,
    content,
    sizeBytes: content.length,
    storagePath,
    absolutePath,
    publicUrl: publicUrl || `/api/v1/public/product-files/token-${fileId.toLowerCase()}`,
  };
}

function declareAttachments(draftId, files) {
  run('UPDATE message_drafts SET attachments_json = ? WHERE id = ? AND workspace_id = ?', [
    JSON.stringify(
      files.map((file) => ({
        productFileId: file.fileId || file.productFileId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        publicUrl: file.publicUrl,
      })),
    ),
    draftId,
    workspaceId,
  ]);
}

function storedAttachments(messageRowId) {
  const row = get('SELECT attachments_json FROM email_messages WHERE id = ?', [messageRowId]);
  return JSON.parse(row?.attachments_json || '[]');
}

function messageRows() {
  return all('SELECT * FROM email_messages WHERE workspace_id = ? AND direction = ?', [workspaceId, 'outbound']);
}

async function expectBlocked(seedOptions, expectedBlockedBy, options = {}) {
  const ids = seed(seedOptions);
  const result = await sendDraft({
    workspaceId,
    draftId: ids.draftId,
    actorType: options.actorType || 'user',
    trigger: options.trigger,
    config: options.config || ctx.config,
    now: options.now,
  });
  assert.equal(result.sent, false, `expected blocked send for ${expectedBlockedBy}`);
  assert.equal(result.blockedBy, expectedBlockedBy);
  assert.equal(messageRows().length, 0, 'no email message row may be created for a blocked send');
  assert.ok(auditCount('email.send_blocked') >= 1, 'blocked send must be audited');
  return result;
}

test('approved draft sends through the simulation account with unsubscribe headers and full bookkeeping', async () => {
  const ids = seed({ subject: 'Reliable components', bodyText: 'Hello buyer, price list attached.' });
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(result.simulation, true);
  assert.ok(result.outboxPath && fs.existsSync(result.outboxPath), 'simulation outbox file exists');

  const messages = messageRows();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, 'sent');
  assert.equal(messages[0].to_addresses_json, JSON.stringify([ids.email]));
  assert.ok(messages[0].sent_at);
  const raw = fs.readFileSync(result.outboxPath, 'utf8');
  assert.match(raw, /List-Unsubscribe: <mailto:/);
  assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(raw, /\/api\/v1\/public\/unsubscribe\//);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="/);
  const parsed = parseMimeMessage(raw);
  assert.match(parsed.text, /Unsubscribe \/ 退订: http:\/\/127\.0\.0\.1/);
  assert.match(parsed.html, /<a href="http:\/\/127\.0\.0\.1/);

  const draft = get('SELECT status, sent_message_id FROM message_drafts WHERE id = ?', [ids.draftId]);
  assert.equal(draft.status, 'sent');
  assert.equal(draft.sent_message_id, messages[0].id);
  const usage = get("SELECT COUNT(*) AS c FROM usage_records WHERE workspace_id = ? AND category = 'email_sent'", [workspaceId]);
  assert.equal(usage.c, 1);
  assert.equal(auditCount('email.sent'), 1);
});

test('unapproved draft is refused', async () => {
  await expectBlocked({ draftStatus: 'pending_approval' }, 'draft_not_approved');
  await expectBlocked({ draftStatus: 'draft' }, 'draft_not_approved');
  await expectBlocked({ draftStatus: 'rejected' }, 'draft_not_approved');
});

test('scheduled draft is allowed (approval model)', async () => {
  const ids = seed({ draftStatus: 'scheduled' });
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true);
});

test('suppression by email address blocks the send', async () => {
  const ids = seed();
  run(
    `INSERT INTO suppression_records (id, workspace_id, scope, value_normalized, reason, source, created_at)
     VALUES (?, ?, 'email', ?, 'unsubscribe', 'test', ?)`,
    [id('sup'), workspaceId, ids.email, nowIso()],
  );
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, false);
  assert.equal(result.blockedBy, 'suppression');
  assert.equal(result.details.hits[0].scope, 'email');
});

test('suppression by domain blocks the send', async () => {
  await expectBlocked({ suppression: { scope: 'domain', value: `company${seq + 1}.example` } }, 'suppression');
});

test('HUMAN_TAKEOVER blocks sending', async () => {
  await expectBlocked({ automationState: 'HUMAN_TAKEOVER' }, 'automation_human_takeover');
});

test('DO_NOT_CONTACT always blocks sending', async () => {
  await expectBlocked({ automationState: 'DO_NOT_CONTACT' }, 'automation_do_not_contact');
  // Even an explicit manual trigger cannot bypass DNC.
  await expectBlocked({ automationState: 'DO_NOT_CONTACT' }, 'automation_do_not_contact', { actorType: 'user', trigger: 'manual' });
});

test('PAUSED and CLOSED automation states block sending', async () => {
  await expectBlocked({ automationState: 'PAUSED' }, 'automation_paused');
  await expectBlocked({ automationState: 'CLOSED' }, 'automation_closed');
});

test('NEEDS_HUMAN_REVIEW blocks automatic sends but allows an explicit manual send', async () => {
  const ids = seed({ automationState: 'NEEDS_HUMAN_REVIEW' });
  const auto = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'system', trigger: 'auto', config: ctx.config });
  assert.equal(auto.sent, false);
  assert.equal(auto.blockedBy, 'automation_needs_review');
  const manual = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(manual.sent, true);
});

test('outside the send window blocks sending', async () => {
  const otherWeekday = (new Date().getUTCDay() + 2) % 7;
  upsertSetting(workspaceId, 'outreach', {
    requireApproval: true,
    autoSendEnabled: true,
    sendWindow: { start: 0, end: 24, weekdays: [otherWeekday], timezone: 'UTC' },
  });
  const result = await expectBlocked({}, 'outside_send_window');
  assert.equal(result.details.timezone, 'UTC');
});

test('account daily limit blocks sending', async () => {
  const ids = seed({ account: { dailyLimit: 1 } });
  run(
    `INSERT INTO email_messages (id, workspace_id, account_id, direction, from_address, to_addresses_json, subject, status, sent_at, created_at)
     VALUES (?, ?, ?, 'outbound', 'sender@zhirai.example', '["x@y.example"]', 'earlier', 'sent', ?, ?)`,
    [id('msg'), workspaceId, ids.accountId, nowIso(), nowIso()],
  );
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, false);
  assert.equal(result.blockedBy, 'account_daily_limit');
  assert.ok(auditCount('email.send_blocked') >= 1);
});

test('workspace daily limit blocks sending', async () => {
  const ids = seed({ account: { dailyLimit: 100 } });
  upsertSetting(workspaceId, 'limits', { dailyEmailLimit: 1 });
  run(
    `INSERT INTO email_messages (id, workspace_id, account_id, direction, from_address, to_addresses_json, subject, status, sent_at, created_at)
     VALUES (?, ?, ?, 'outbound', 'sender@zhirai.example', '["x@y.example"]', 'earlier', 'sent', ?, ?)`,
    [id('msg'), workspaceId, ids.accountId, nowIso(), nowIso()],
  );
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, false);
  assert.equal(result.blockedBy, 'workspace_daily_limit');
  assert.equal(result.details.limit, 1);
});

test('the same draft cannot be sent twice', async () => {
  const ids = seed();
  const first = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(first.sent, true);
  const second = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(second.sent, false);
  assert.equal(second.blockedBy, 'duplicate_send');
  assert.equal(messageRows().filter((row) => row.status === 'sent').length, 1);
});

test('same recipient + same subject within 24h is a duplicate recipient', async () => {
  const ids = seed({ subject: 'Same subject here' });
  const first = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(first.sent, true);
  const draft2 = id('drf');
  run(
    `INSERT INTO message_drafts
       (id, workspace_id, company_id, contact_id, account_id, subject, body_text, language, status, quality_json, guard_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Same subject here', 'Another body', 'en', 'approved', '{}', '{}', ?, ?)`,
    [draft2, workspaceId, ids.companyId, ids.contactId, ids.accountId, nowIso(), nowIso()],
  );
  const second = await sendDraft({ workspaceId, draftId: draft2, actorType: 'user', config: ctx.config });
  assert.equal(second.sent, false);
  assert.equal(second.blockedBy, 'duplicate_recipient');
});

test('bounce circuit breaker blocks an account with recent failures', async () => {
  const ids = seed();
  for (let index = 0; index < 5; index += 1) {
    run(
      `INSERT INTO email_messages (id, workspace_id, account_id, direction, from_address, to_addresses_json, subject, status, error, created_at)
       VALUES (?, ?, ?, 'outbound', 'sender@zhirai.example', '["x@y.example"]', 'failed', 'failed', '550 mailbox unavailable', ?)`,
      [id('msg'), workspaceId, ids.accountId, nowIso()],
    );
  }
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, false);
  assert.equal(result.blockedBy, 'circuit_breaker');
  assert.equal(result.details.failures, 5);
  assert.ok(auditCount('email.send_blocked') >= 1);
});

test('automatic sends are blocked when autoSendEnabled is off (manual stays allowed)', async () => {
  const ids = seed();
  const auto = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'system', trigger: 'auto', config: ctx.config });
  assert.equal(auto.sent, false);
  assert.equal(auto.blockedBy, 'auto_send_disabled');
  const manual = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(manual.sent, true);
});

test('global send pause blocks even manual sends', async () => {
  await expectBlocked({}, 'global_send_paused', { config: { ...ctx.config, globalSendPaused: true } });
});

test('missing SMTP credentials fail closed with a clear block code', async () => {
  const ids = seed({ account: { protocol: 'smtp_imap', address: 'smtp-sender@zhirai.example' } });
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, false);
  assert.equal(result.blockedBy, 'account_credentials_missing');
  assert.equal(messageRows().length, 0, 'a configuration failure must not create an outbound message row');
  assert.ok(auditCount('email.send_blocked') >= 1);
});

test('draft with missing subject or body is not sendable', async () => {
  await expectBlocked({ subject: '' }, 'draft_empty');
});

test('assertSendAllowed is a pure decision function (no DB access)', () => {
  const base = {
    requireApproval: true,
    mode: 'auto',
    autoSendEnabled: false,
    globalSendPaused: false,
    draft: { id: 'drf_1', status: 'approved', subject: 'Hi', bodyText: 'Body' },
    contact: { id: 'con_1', email: 'buyer@example.com', deleted: false },
    company: { id: 'cmp_1' },
    account: { id: 'acc_1', status: 'active', protocol: 'simulation' },
    automationState: 'DO_NOT_CONTACT',
    suppressionHits: [],
    sendWindow: ALL_DAY_WINDOW,
    sentToday: { account: 0, workspace: 0 },
    limits: { accountDaily: 50, workspaceDaily: 50 },
    duplicates: { draftSent: false, recipient: false },
    failures: { failures: 0 },
    now: new Date().toISOString(),
  };
  assert.equal(assertSendAllowed(base).blockedBy, 'automation_do_not_contact');
  assert.equal(assertSendAllowed({ ...base, automationState: null }).blockedBy, 'auto_send_disabled');
  const manual = assertSendAllowed({ ...base, automationState: null, mode: 'manual' });
  assert.equal(manual.allowed, true);
  const missingRecipient = assertSendAllowed({ ...base, automationState: null, mode: 'manual', contact: null });
  assert.equal(missingRecipient.blockedBy, 'recipient_missing');
});

test('isWithinSendWindow handles timezones, overnight windows and weekdays', () => {
  const at = new Date('2026-10-22T10:00:00.000Z'); // Thursday 12:00 Europe/Berlin (CEST)
  assert.equal(isWithinSendWindow({ start: 9, end: 17, weekdays: [4], timezone: 'Europe/Berlin' }, at).allowed, true);
  assert.equal(isWithinSendWindow({ start: 9, end: 17, weekdays: [1], timezone: 'Europe/Berlin' }, at).allowed, false);
  assert.equal(isWithinSendWindow({ start: 0, end: 11, weekdays: [4], timezone: 'Europe/Berlin' }, at).allowed, false);
  // overnight window 22:00 -> 06:00
  const night = new Date('2026-10-22T23:30:00.000Z'); // 01:30 Berlin next day
  assert.equal(isWithinSendWindow({ start: 22, end: 6, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' }, night).allowed, true);
  void addHours;
});

// ------------------------------------------------------------- attachments
test('sendDraft attaches PDFs, appends catalogue links before the unsubscribe block and snapshots attachments', async () => {
  const ids = seed({ bodyText: 'Dear buyer, please find our latest catalogue.' });
  const first = seedProductFile({ filename: 'catalogue-2026.pdf' });
  const second = seedProductFile({ filename: 'spec-sheet.pdf', content: Buffer.from('%PDF-1.4\nsecond document\n%%EOF\n') });
  declareAttachments(ids.draftId, [first, second]);

  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(result.attachments.length, 2);
  assert.deepEqual(result.attachmentWarnings, []);

  // Snapshot persisted on the sent email_messages row.
  const snapshot = storedAttachments(result.messageRowId);
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot.map((item) => item.filename), ['catalogue-2026.pdf', 'spec-sheet.pdf']);
  assert.equal(snapshot[0].productFileId, first.fileId);
  assert.equal(snapshot[0].mimeType, 'application/pdf');
  assert.equal(snapshot[0].sizeBytes, first.content.length);
  assert.equal(snapshot[0].publicUrl, first.publicUrl);

  // MIME structure and payloads in the simulation outbox.
  const raw = fs.readFileSync(result.outboxPath, 'utf8');
  assert.match(raw, /^Content-Type: multipart\/mixed; boundary="/m);
  const parsed = parseMimeMessage(raw);
  assert.equal(parsed.attachments, 2);
  assert.deepEqual(parsed.attachmentList.map((item) => item.filename), ['catalogue-2026.pdf', 'spec-sheet.pdf']);
  assert.deepEqual(parsed.attachmentList[0].content, first.content);
  assert.deepEqual(parsed.attachmentList[1].content, second.content);

  const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');
  const linkOne = `Product catalogue (PDF): ${base}${first.publicUrl}`;
  const linkTwo = `Product catalogue (PDF): ${base}${second.publicUrl}`;
  assert.ok(parsed.text.includes(linkOne), parsed.text);
  assert.ok(parsed.text.includes(linkTwo), parsed.text);
  assert.ok(parsed.text.indexOf(linkOne) < parsed.text.indexOf('Unsubscribe / 退订:'), 'catalogue line must be before the compliance block');
  assert.ok(parsed.text.indexOf(linkOne) > parsed.text.indexOf('Dear buyer'));

  const audit = get("SELECT after_json FROM audit_events WHERE workspace_id = ? AND action = 'email.sent' ORDER BY created_at DESC LIMIT 1", [workspaceId]);
  assert.match(audit.after_json, /"attachmentCount":2/);
});

test('catalogue link is not duplicated when the draft body already contains the publicUrl', async () => {
  const file = seedProductFile({ filename: 'catalogue.pdf' });
  const ids = seed({ bodyText: `Please download our catalogue here: ${file.publicUrl} — thank you.` });
  declareAttachments(ids.draftId, [file]);
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true);
  const parsed = parseMimeMessage(fs.readFileSync(result.outboxPath, 'utf8'));
  assert.equal(parsed.attachments, 1);
  assert.equal(parsed.text.split('Product catalogue (PDF):').length - 1, 0, 'no duplicate catalogue line');
  assert.equal(parsed.text.split(file.publicUrl).length - 1, 1, 'the existing publicUrl appears exactly once');
});

test('missing attachment file logs a warning and the mail is still delivered without it', async () => {
  const missing = seedProductFile({ filename: 'gone.pdf', writeFile: false });
  const ids = seed();
  declareAttachments(ids.draftId, [missing]);
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true, 'a missing attachment must not fail the whole send');
  assert.deepEqual(result.attachments, []);
  assert.equal(result.attachmentWarnings.length, 1);
  assert.equal(result.attachmentWarnings[0].code, 'attachment_file_missing');
  assert.deepEqual(storedAttachments(result.messageRowId), []);
  const parsed = parseMimeMessage(fs.readFileSync(result.outboxPath, 'utf8'));
  assert.equal(parsed.attachments, 0);
  assert.ok(!parsed.text.includes('Product catalogue (PDF):'));
});

test('oversized attachment is skipped with a warning while the send continues', async () => {
  const huge = seedProductFile({
    filename: 'huge.pdf',
    content: Buffer.alloc(MIME_ATTACHMENT_MAX_BYTES + 1024, 7),
  });
  const ids = seed();
  declareAttachments(ids.draftId, [huge]);
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true);
  assert.deepEqual(result.attachments, []);
  assert.equal(result.attachmentWarnings[0].code, 'MIME_ATTACHMENT_TOO_LARGE');
  assert.deepEqual(storedAttachments(result.messageRowId), []);
  const parsed = parseMimeMessage(fs.readFileSync(result.outboxPath, 'utf8'));
  assert.equal(parsed.attachments, 0);
  assert.ok(!parsed.text.includes('Product catalogue (PDF):'), 'no link for a skipped attachment');
});

test('non-PDF attachments are sent but do not add a catalogue line', async () => {
  const png = seedProductFile({
    filename: 'product-image.png',
    mimeType: 'image/png',
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const ids = seed();
  declareAttachments(ids.draftId, [png]);
  const result = await sendDraft({ workspaceId, draftId: ids.draftId, actorType: 'user', config: ctx.config });
  assert.equal(result.sent, true);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].mimeType, 'image/png');
  const parsed = parseMimeMessage(fs.readFileSync(result.outboxPath, 'utf8'));
  assert.equal(parsed.attachments, 1);
  assert.ok(!parsed.text.includes('Product catalogue (PDF):'));
});

test('attachment helpers reject path traversal, missing rows and duplicate catalogue links', () => {
  const uploadsDir = ctx.config.uploadsDir;
  assert.equal(resolveUploadFilePath(uploadsDir, '../../etc/passwd'), null);
  assert.equal(resolveUploadFilePath(uploadsDir, 'products/x/y.pdf'), path.join(path.resolve(uploadsDir), 'products/x/y.pdf'));
  assert.equal(resolveUploadFilePath(uploadsDir, '/etc/passwd'), null);
  assert.equal(resolveUploadFilePath(null, 'products/x/y.pdf'), null);

  const missingRow = loadDraftAttachments({ workspaceId, draft: { id: 'drf_test', attachments_json: JSON.stringify([{ productFileId: 'pfl_missing', publicUrl: '/u/1' }]) }, config: ctx.config });
  assert.deepEqual(missingRow.contents, []);
  assert.equal(missingRow.warnings[0].code, 'attachment_missing');

  const snapshot = [
    { filename: 'a.pdf', mimeType: 'application/pdf', publicUrl: '/api/v1/public/product-files/tok-a' },
    { filename: 'a-dup.pdf', mimeType: 'application/pdf', publicUrl: '/api/v1/public/product-files/tok-a' },
    { filename: 'b.pdf', mimeType: 'application/pdf', publicUrl: '/api/v1/public/product-files/tok-b' },
    { filename: 'image.png', mimeType: 'image/png', publicUrl: '/api/v1/public/product-files/tok-c' },
  ];
  const lines = buildCatalogueLinkLines({ draftBodyText: 'Body mentions /api/v1/public/product-files/tok-b already.', snapshot, config: ctx.config });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Product catalogue \(PDF\): http:\/\/127\.0\.0\.1:1\/api\/v1\/public\/product-files\/tok-a$/);
});
