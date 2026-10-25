/**
 * Email verification and inference.
 *
 * Contract:
 *   verifyContactEmail({workspaceId, contactId, actorId}) -> {emailStatus, mx, checkedAt}
 *   inferEmails({workspaceId, companyId, firstName, lastName}) -> [{email, status:'inferred', confidence}]
 *
 * Hard rule: an inferred address can never be marked valid. MX results are
 * recorded separately in data_verifications; "cannot decide" becomes
 * result='unknown' rather than a guess.
 */
import dns from 'node:dns/promises';
import { validationError, notFound } from '../core/errors.mjs';
import { isEmail, normalizeEmail } from '../core/validate.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as contactsRepo from '../repositories/contacts.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import { addVerification } from '../repositories/companies.mjs';
import { getSetting } from './settings.mjs';

export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com', 'guerrillamail.com', 'yopmail.com',
  'trashmail.com', 'throwawaymail.com', 'sharklasers.com', 'maildrop.cc', 'getnada.com', 'dispostable.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'spam4.me', 'mailnesia.com',
]);

export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'yahoo.de', 'hotmail.com', 'hotmail.fr', 'outlook.com',
  'outlook.de', 'live.com', 'msn.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'aol.com', 'icloud.com',
  'orange.fr', 'free.fr', 'laposte.net', 'libero.it', 'virgilio.it', 'wp.pl', 'o2.pl', 'seznam.cz', 'centrum.cz',
  'mail.ru', 'yandex.ru', 'protonmail.com', 'proton.me',
]);

export const ROLE_ACCOUNTS = new Set([
  'info', 'sales', 'contact', 'office', 'admin', 'support', 'marketing', 'hr', 'jobs', 'careers', 'press', 'service',
  'mail', 'newsletter', 'noreply', 'no-reply', 'webmaster', 'postmaster', 'hello', 'enquiries', 'inquiries', 'export',
  'team', 'billing', 'accounts', 'purchasing', 'procurement', 'orders',
]);

const MAX_MX_LOOKUP_MS = 5000;

// Test hook: allows unit tests to stub DNS without touching the network.
let mxResolver = (domain) => dns.resolveMx(domain);
let customMxResolver = false;
export function setMxResolverForTests(resolver) {
  customMxResolver = typeof resolver === 'function';
  mxResolver = typeof resolver === 'function' ? resolver : (domain) => dns.resolveMx(domain);
}
export function resetMxResolverForTests() {
  customMxResolver = false;
  mxResolver = (domain) => dns.resolveMx(domain);
}

function withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  // Always clear the fallback timer once the lookup settles so no timer handle
  // survives a DB/server teardown (avoids libuv close-order flakiness in tests).
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Resolve MX through DNS-over-HTTPS when the host resolver is unavailable
 * (common on locked-down Windows/containers). Returns the same shape as
 * lookupDomainMx or null when DoH also fails.
 */
async function lookupMxViaDoh(domain) {
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
  ];
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const records = (payload.Answer || [])
        .filter((answer) => Number(answer.type) === 15)
        .map((answer) => String(answer.data || '').replace(/^\d+\s+/, '').replace(/\.$/, '').trim())
        .filter(Boolean);
      if (records.length) return { result: 'passed', records, error: null };
    } catch {
      // try the next endpoint
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Look up MX records for a domain.
 * Resolves to {result:'passed'|'failed'|'unknown', records:[], error}
 */
export async function lookupDomainMx(domain) {
  if (!domain) return { result: 'unknown', records: [], error: 'missing_domain' };
  try {
    const records = await withTimeout(mxResolver(domain), MAX_MX_LOOKUP_MS, null);
    if (records === null) return { result: 'unknown', records: [], error: 'timeout' };
    const list = Array.isArray(records) ? records.map((record) => record.exchange).filter(Boolean) : [];
    if (!list.length) return { result: 'failed', records: [], error: 'no_mx_records' };
    return { result: 'passed', records: list.slice(0, 10), error: null };
  } catch (error) {
    const code = error && error.code ? String(error.code) : 'dns_error';
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(code)) {
      return { result: 'failed', records: [], error: code };
    }
    const doh = customMxResolver ? null : await lookupMxViaDoh(domain);
    if (doh) return doh;
    // Network unavailable / SERVFAIL / timeout: cannot decide.
    return { result: 'unknown', records: [], error: code };
  }
}

export function checkEmailSyntax(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { result: 'failed', detail: 'empty' };
  if (!isEmail(normalized)) return { result: 'failed', detail: 'invalid_format' };
  const [local, domain] = normalized.split('@');
  if (local.length > 64 || normalized.length > 320) return { result: 'failed', detail: 'too_long' };
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return { result: 'failed', detail: 'invalid_local_part' };
  return { result: 'passed', detail: 'ok', domain };
}

export function classifyEmailAddress(email) {
  const normalized = normalizeEmail(email);
  const [local = '', domain = ''] = normalized.split('@');
  const roleAccount = ROLE_ACCOUNTS.has(local);
  const disposable = DISPOSABLE_DOMAINS.has(domain);
  const freemail = FREEMAIL_DOMAINS.has(domain);
  return { local, domain, roleAccount, disposable, freemail };
}

function saveCheck(workspaceId, entityType, entityId, checkType, result, confidence, details, verifiedAt) {
  addVerification(workspaceId, {
    id: id('ver'),
    entityType,
    entityId,
    checkType,
    result,
    confidence,
    details,
    verifiedAt,
  });
}

/**
 * Decide the resulting email_status from individual checks.
 * Inferred addresses stay inferred. Role/disposable addresses become risky.
 */
function decideEmailStatus({ syntax, mx, roleAccount, disposable, inferred }) {
  if (inferred) return 'inferred';
  if (syntax.result !== 'passed') return 'invalid';
  if (disposable) return 'risky';
  if (mx.result === 'failed') return 'invalid';
  if (roleAccount) return 'risky';
  if (mx.result === 'passed') return 'valid';
  return 'risky';
}

export async function verifyContactEmail({ workspaceId, contactId, actorId = null, ip = null, userAgent = null, requestId = null } = {}) {
  const contact = contactsRepo.findContact(workspaceId, contactId);
  if (!contact) throw notFound('联系人不存在');
  const email = contact.emailNormalized || normalizeEmail(contact.email || '');
  if (!email) throw validationError('该联系人没有邮箱，无法校验');

  const checkedAt = nowIso();
  const normalized = normalizeEmail(email);
  const syntax = checkEmailSyntax(normalized);
  const address = classifyEmailAddress(normalized);
  const inferred = contact.emailType === 'inferred' || contact.emailStatus === 'inferred';
  let mx = { result: 'unknown', records: [], error: 'skipped' };
  if (syntax.result === 'passed' && address.domain) {
    mx = await lookupDomainMx(address.domain);
  }

  saveCheck(workspaceId, 'contact', contactId, 'email_syntax', syntax.result, syntax.result === 'passed' ? 90 : 0, { email, detail: syntax.detail }, checkedAt);
  saveCheck(workspaceId, 'contact', contactId, 'domain_mx', mx.result, mx.result === 'passed' ? 85 : 0, { domain: address.domain, records: mx.records, error: mx.error }, checkedAt);
  saveCheck(workspaceId, 'contact', contactId, 'role_account', address.roleAccount ? 'failed' : 'passed', address.roleAccount ? 40 : 80, { local: address.local }, checkedAt);
  saveCheck(workspaceId, 'contact', contactId, 'disposable', address.disposable ? 'failed' : 'passed', address.disposable ? 10 : 80, { domain: address.domain }, checkedAt);
  saveCheck(workspaceId, 'contact', contactId, 'freemail', address.freemail ? 'failed' : 'passed', address.freemail ? 50 : 80, { domain: address.domain }, checkedAt);

  const emailStatus = decideEmailStatus({
    syntax,
    mx,
    roleAccount: address.roleAccount,
    disposable: address.disposable,
    inferred,
  });
  const patch = {
    email_status: inferred ? 'inferred' : emailStatus,
    last_verified_at: checkedAt,
    updated_at: checkedAt,
  };
  if (emailStatus === 'valid') patch.confidence = 'high';
  else if (emailStatus === 'risky') patch.confidence = 'low';
  contactsRepo.updateContact(workspaceId, contactId, patch);

  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'contact.verify_email',
    entityType: 'contact',
    entityId: contactId,
    after: {
      email,
      emailStatus: patch.email_status,
      mx: mx.result,
      roleAccount: address.roleAccount,
      disposable: address.disposable,
    },
    ip,
    userAgent,
    requestId,
  });

  return {
    emailStatus: patch.email_status,
    mx: mx.result,
    mxRecords: mx.records,
    checkedAt,
    inferred,
    roleAccount: address.roleAccount,
    disposable: address.disposable,
    freemail: address.freemail,
    checks: {
      emailSyntax: syntax.result,
      domainMx: mx.result,
      roleAccount: address.roleAccount ? 'failed' : 'passed',
      disposable: address.disposable ? 'failed' : 'passed',
    },
  };
}

// ---------------------------------------------------------------- inference
const EMAIL_PATTERNS = [
  { key: 'first.last', build: (first, last) => `${first}.${last}`, confidence: 0.72 },
  { key: 'f.last', build: (first, last) => `${first[0]}.${last}`, confidence: 0.62 },
  { key: 'first', build: (first) => first, confidence: 0.55 },
  { key: 'flast', build: (first, last) => `${first[0]}${last}`, confidence: 0.5 },
  { key: 'first_last', build: (first, last) => `${first}_${last}`, confidence: 0.45 },
  { key: 'last.first', build: (first, last) => `${last}.${first}`, confidence: 0.4 },
  { key: 'last', build: (first, last) => last, confidence: 0.32 },
];

/** Fold accents and strip anything that is not usable in an email local part. */
export function normalizeNamePart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30);
}

/**
 * Generate candidate addresses from a person name + company domain.
 * Never marks anything valid; MX is optional and reported as metadata only.
 *
 * Accepts both contract forms:
 *   inferEmails({ workspaceId, companyId, firstName, lastName })
 *   inferEmails(workspaceId, companyId, firstName, lastName, options)
 */
export async function inferEmails(...args) {
  let workspaceId;
  let companyId;
  let firstName;
  let lastName;
  let options = {};
  if (args.length === 1 && args[0] && typeof args[0] === 'object') {
    ({ workspaceId, companyId, firstName, lastName, options = {} } = args[0]);
  } else {
    [workspaceId, companyId, firstName, lastName, options = {}] = args;
  }
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  const first = normalizeNamePart(firstName);
  const last = normalizeNamePart(lastName);
  if (!first && !last) throw validationError('请至少提供联系人的姓或名');
  const domain = company.domain || '';
  if (!domain) return [];
  const enrichment = getSetting(workspaceId, 'enrichment');
  const limit = Math.max(1, Math.min(20, Number(enrichment.maxEmailsPerDomain) || 5));
  const verifyMx = options.verifyMx !== undefined ? Boolean(options.verifyMx) : Boolean(enrichment.verifyMx);

  const candidates = [];
  const seen = new Set();
  for (const pattern of EMAIL_PATTERNS) {
    if (!first && (pattern.key === 'first' || pattern.key === 'f.last' || pattern.key === 'flast' || pattern.key === 'first.last' || pattern.key === 'first_last')) continue;
    const local = pattern.build(first, last);
    if (!local || local.length < 2) continue;
    const email = `${local}@${domain}`;
    if (seen.has(email) || !isEmail(email)) continue;
    seen.add(email);
    candidates.push({ email, pattern: pattern.key, confidence: pattern.confidence });
    if (candidates.length >= limit) break;
  }
  const existing = new Map(contactsRepo.findContactsByEmails(workspaceId, candidates.map((item) => item.email)).map((row) => [row.email_normalized, row.id]));

  let mx = null;
  if (verifyMx) mx = await lookupDomainMx(domain);

  return candidates.map((candidate) => {
    const result = {
      email: candidate.email,
      status: 'inferred',
      confidence: candidate.confidence,
      pattern: candidate.pattern,
      exists: existing.has(candidate.email),
      contactId: existing.get(candidate.email) || null,
    };
    if (mx) {
      result.mx = mx.result;
      if (mx.result === 'failed') result.confidence = Math.min(result.confidence, 0.35);
    }
    return result;
  });
}
