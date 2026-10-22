/**
 * OWNER: t-crm.
 *
 * Email account configuration. Credentials are sealed with AES-256-GCM using a
 * context bound to the account id (`workspace:email_account:<id>`) and are
 * never returned to clients; only a masked preview is exposed.
 */
import { conflict, notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { asString, asEmail, asInt, asBool, asEnum } from '../core/validate.mjs';
import { getSecret } from '../core/secrets.mjs';
import { encryptCredential, decryptCredential, maskSecret } from '../core/crypto.mjs';
import { getSettings } from './settings.mjs';
import { enqueueJobSafe } from './queue-client.mjs';
import {
  listAccounts,
  getAccount,
  getAccountRow,
  getAccountByAddress,
  createAccount as repoCreateAccount,
  updateAccount as repoUpdateAccount,
  deleteAccount,
  getActiveAccount,
  countAccounts,
} from '../repositories/email.mjs';

export const ACCOUNT_PROTOCOLS = ['smtp_imap', 'simulation'];
export const ACCOUNT_STATUSES = ['active', 'paused', 'error'];
const MAIL_CLIENT_CANDIDATES = ['../mail/client.mjs', '../mail/index.mjs', '../mail/smtp.mjs'];

function normalizeActor(actor = {}) {
  return {
    actorType: actor.actorType || (actor.actorId ? 'user' : 'system'),
    actorId: actor.actorId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
  };
}

/** AES-GCM context binds ciphertext to exactly one workspace account. */
export function credentialContext(accountId) {
  return `workspace:email_account:${accountId}`;
}

function sealSecret(accountId, secret) {
  return encryptCredential(getSecret(), credentialContext(accountId), secret);
}

function openSecret(accountId, sealed) {
  if (!sealed) return null;
  try {
    return decryptCredential(getSecret(), credentialContext(accountId), sealed);
  } catch {
    return null;
  }
}

/** Public (API-safe) representation — never contains the credential. */
export function presentAccount(account) {
  if (!account) return null;
  const row = getAccountRow(account.workspaceId, account.id);
  const secret = row ? openSecret(row.id, row.credential_enc) : null;
  const preview = secret?.password ? maskSecret(secret.password) : null;
  return {
    ...account,
    hasCredential: Boolean(row?.credential_enc),
    credentialPreview: preview,
  };
}

export function list(workspaceId) {
  return { items: listAccounts(workspaceId).map((account) => presentAccount(account)) };
}

export function detail(workspaceId, accountId) {
  const account = getAccount(workspaceId, accountId);
  if (!account) throw notFound('邮箱账户不存在');
  return presentAccount(account);
}

function validateSmtpFields(input, { partial = false, protocol }) {
  const out = {};
  if (!partial || input.smtpHost !== undefined) out.smtpHost = asString(input.smtpHost || '', { max: 255, label: 'SMTP 主机' });
  if (!partial || input.smtpPort !== undefined) out.smtpPort = input.smtpPort === undefined || input.smtpPort === '' || input.smtpPort === null ? null : asInt(input.smtpPort, { min: 1, max: 65535, label: 'SMTP 端口' });
  if (!partial || input.smtpSecure !== undefined) out.smtpSecure = input.smtpSecure === undefined ? true : asBool(input.smtpSecure);
  if (!partial || input.imapHost !== undefined) out.imapHost = asString(input.imapHost || '', { max: 255, label: 'IMAP 主机' });
  if (!partial || input.imapPort !== undefined) out.imapPort = input.imapPort === undefined || input.imapPort === '' || input.imapPort === null ? null : asInt(input.imapPort, { min: 1, max: 65535, label: 'IMAP 端口' });
  if (!partial || input.imapSecure !== undefined) out.imapSecure = input.imapSecure === undefined ? true : asBool(input.imapSecure);
  if (protocol === 'smtp_imap' && (!partial || input.smtpHost !== undefined || input.protocol !== undefined)) {
    if (out.smtpHost === '') throw validationError('SMTP 主机不能为空');
  }
  return out;
}

export function create(workspaceId, input = {}, actor = {}) {
  const name = asString(input.name, { required: true, max: 120, label: '账户名称' });
  const address = asEmail(input.address, { required: true, label: '邮箱地址' });
  const protocol = asEnum(input.protocol || 'smtp_imap', ACCOUNT_PROTOCOLS, { label: '协议', required: true });
  if (getAccountByAddress(workspaceId, address)) throw conflict('该邮箱地址已存在');
  const smtp = validateSmtpFields(input, { partial: false, protocol });
  const username = input.username ? asString(input.username, { max: 255, label: '用户名' }) : address;
  const password = input.password ? asString(input.password, { max: 500, label: '密码' }) : '';
  if (protocol === 'smtp_imap' && !password) throw validationError('SMTP/IMAP 账户需要填写密码或应用专用密码');
  if (protocol === 'smtp_imap' && !smtp.smtpHost) throw validationError('SMTP 主机不能为空');
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const accountId = id('acc');
  const credentialEnc = protocol === 'smtp_imap' ? sealSecret(accountId, { password, username }) : null;
  let account;
  try {
    account = repoCreateAccount(workspaceId, {
      id: accountId,
      name,
      address,
      displayName: input.displayName ? asString(input.displayName, { max: 120, label: '显示名称' }) : null,
      protocol,
      ...smtp,
      username,
      credentialEnc,
      signature: input.signature ? asString(input.signature, { max: 2000, label: '签名' }) : null,
      dailyLimit: input.dailyLimit !== undefined ? asInt(input.dailyLimit, { min: 1, max: 1000, label: '每日限额' }) : 50,
      status: 'active',
      createdBy: actorInfo.actorId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) throw conflict('该邮箱地址已存在');
    throw error;
  }
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'email_account.create',
    entityType: 'email_account',
    entityId: account.id,
    after: { name, address, protocol, smtpHost: account.smtpHost, smtpPort: account.smtpPort, imapHost: account.imapHost, dailyLimit: account.dailyLimit },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return presentAccount(account);
}

export function update(workspaceId, accountId, input = {}, actor = {}) {
  const before = getAccount(workspaceId, accountId);
  if (!before) throw notFound('邮箱账户不存在');
  const patch = {};
  if (input.name !== undefined) patch.name = asString(input.name, { required: true, max: 120, label: '账户名称' });
  if (input.address !== undefined) {
    const address = asEmail(input.address, { required: true, label: '邮箱地址' });
    const existing = getAccountByAddress(workspaceId, address);
    if (existing && existing.id !== accountId) throw conflict('该邮箱地址已存在');
    patch.address = address;
  }
  if (input.displayName !== undefined) patch.displayName = input.displayName ? asString(input.displayName, { max: 120 }) : null;
  if (input.signature !== undefined) patch.signature = input.signature ? asString(input.signature, { max: 2000, label: '签名' }) : null;
  if (input.dailyLimit !== undefined) patch.dailyLimit = asInt(input.dailyLimit, { min: 1, max: 1000, label: '每日限额' });
  if (input.status !== undefined) patch.status = asEnum(input.status, ACCOUNT_STATUSES, { label: '状态', required: true });
  if (input.username !== undefined) patch.username = input.username ? asString(input.username, { max: 255 }) : null;
  if (input.protocol !== undefined) patch.protocol = asEnum(input.protocol, ACCOUNT_PROTOCOLS, { label: '协议', required: true });
  const protocol = patch.protocol || before.protocol;
  Object.assign(patch, validateSmtpFields(input, { partial: true, protocol }));
  if (input.password) {
    const password = asString(input.password, { max: 500, label: '密码' });
    patch.credentialEnc = sealSecret(accountId, { password, username: patch.username || before.username });
  } else if ((patch.protocol || before.protocol) === 'smtp_imap' && !getAccountRow(workspaceId, accountId)?.credential_enc) {
    throw validationError('SMTP/IMAP 账户需要填写密码或应用专用密码');
  }
  patch.updatedAt = nowIso();
  const after = repoUpdateAccount(workspaceId, accountId, patch);
  const actorInfo = normalizeActor(actor);
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'email_account.update',
    entityType: 'email_account',
    entityId: accountId,
    before: { name: before.name, address: before.address, protocol: before.protocol, status: before.status, dailyLimit: before.dailyLimit },
    after: { name: after.name, address: after.address, protocol: after.protocol, status: after.status, dailyLimit: after.dailyLimit, passwordChanged: Boolean(input.password) },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return presentAccount(after);
}

export function remove(workspaceId, accountId, actor = {}) {
  const account = getAccount(workspaceId, accountId);
  if (!account) throw notFound('邮箱账户不存在');
  deleteAccount(workspaceId, accountId);
  const actorInfo = normalizeActor(actor);
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'email_account.delete',
    entityType: 'email_account',
    entityId: accountId,
    before: { name: account.name, address: account.address, protocol: account.protocol },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { deleted: true };
}

async function loadMailClient() {
  for (const candidate of MAIL_CLIENT_CANDIDATES) {
    try {
      const module = await import(candidate);
      if (module && (module.testConnection || module.verifyAccount || module.testAccount)) return module;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Test the configured connection. Simulation accounts always succeed. */
export async function testConnection(workspaceId, accountId) {
  const account = getAccount(workspaceId, accountId);
  if (!account) throw notFound('邮箱账户不存在');
  if (account.protocol === 'simulation') {
    return { ok: true, mode: 'simulation', message: '模拟邮箱可用，无需外部连接', checkedAt: nowIso() };
  }
  const row = getAccountRow(workspaceId, accountId);
  const secret = row ? openSecret(row.id, row.credential_enc) : null;
  if (!secret?.password) return { ok: false, mode: 'smtp_imap', message: '账户缺少可用凭据，请重新填写密码', checkedAt: nowIso() };
  const module = await loadMailClient();
  if (!module) {
    return {
      ok: false,
      mode: 'smtp_imap',
      message: '邮件客户端尚未就绪（发送管线由 t-worker 实现），暂时无法测试 SMTP/IMAP 连接',
      code: 'MAIL_CLIENT_UNAVAILABLE',
      checkedAt: nowIso(),
    };
  }
  const fn = module.testConnection || module.verifyAccount || module.testAccount;
  try {
    const result = await fn({ account: presentAccount(account), secret, config: { signature: account.signature, dailyLimit: account.dailyLimit } });
    return {
      ok: Boolean(result?.ok ?? result?.success),
      mode: 'smtp_imap',
      message: result?.message || (result?.ok ?? result?.success ? '连接成功' : '连接失败'),
      details: result?.details ?? null,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return { ok: false, mode: 'smtp_imap', message: `连接失败：${error?.message || '未知错误'}`, code: 'CONNECTION_FAILED', checkedAt: nowIso() };
  }
}

/** Queue an inbox sync (`email.sync`), handled by the worker. */
export async function syncNow(workspaceId, accountId, actor = {}) {
  const account = getAccount(workspaceId, accountId);
  if (!account) throw notFound('邮箱账户不存在');
  if (account.status === 'paused') throw conflict('邮箱账户已暂停，不能同步');
  const actorInfo = normalizeActor(actor);
  const result = await enqueueJobSafe({
    workspaceId,
    type: 'email.sync',
    payload: { accountId },
    // Manual "sync now" must not be permanently deduplicated: dedupe_key is
    // global and successful jobs are retained, so include a timestamp bucket.
    dedupeKey: `email.sync:${workspaceId}:${accountId}:manual:${Date.now()}`,
    priority: 80,
    createdBy: actorInfo.actorId,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'email_account.sync_queued',
    entityType: 'email_account',
    entityId: accountId,
    after: { queued: result.queued, jobId: result.jobId, queueError: result.error },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return { queued: result.queued, jobId: result.jobId, queueError: result.error };
}

/**
 * Contract 7.2: load the sending account for the worker's send pipeline.
 * `secret` is the decrypted credential payload; never expose it over HTTP.
 */
export function loadSendAccount(workspaceId, accountId) {
  const row = getAccountRow(workspaceId, accountId || '');
  if (!row) return null;
  if (row.status !== 'active') return null;
  const account = getAccount(workspaceId, accountId);
  if (!account) return null;
  const secret = openSecret(row.id, row.credential_enc);
  const settings = getSettings(workspaceId);
  return {
    account: { ...account, hasCredential: Boolean(row.credential_enc) },
    secret,
    config: {
      signature: row.signature || settings.outreach?.signature || '',
      dailyLimit: row.daily_limit,
      protocol: row.protocol,
      smtp: { host: row.smtp_host, port: row.smtp_port, secure: Boolean(row.smtp_secure) },
      imap: { host: row.imap_host, port: row.imap_port, secure: Boolean(row.imap_secure) },
      workspaceId,
    },
  };
}

/** Alias kept for the worker contract (loadSendAccount / loadEmailAccount). */
export const loadEmailAccount = loadSendAccount;

/** Worker callback after a sync attempt: records success/error on the account. */
export function markAccountSynced(workspaceId, accountId, { error = null } = {}) {
  const account = getAccount(workspaceId, accountId);
  if (!account) return null;
  const now = nowIso();
  return repoUpdateAccount(workspaceId, accountId, {
    lastSyncAt: now,
    lastError: error ? String(error).slice(0, 1000) : null,
    status: error ? 'error' : 'active',
    updatedAt: now,
  });
}

/** Resolve a usable sending account (draft without an explicit account). */
export function defaultSendAccount(workspaceId) {
  return getActiveAccount(workspaceId);
}

export function summary(workspaceId) {
  return countAccounts(workspaceId);
}

export default {
  ACCOUNT_PROTOCOLS,
  credentialContext,
  presentAccount,
  list,
  detail,
  create,
  update,
  remove,
  testConnection,
  syncNow,
  loadSendAccount,
  markAccountSynced,
  defaultSendAccount,
  summary,
};
