/**
 * Contact service. Invariants:
 *  - (workspace_id, email_normalized) is unique;
 *  - an inferred email can only ever have email_status='inferred', never 'valid';
 *  - every externally sourced email stores a contact_sources row.
 */
import { conflict, notFound, validationError } from '../core/errors.mjs';
import { normalizeEmail, normalizeName } from '../core/validate.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as contactsRepo from '../repositories/contacts.mjs';
import * as companiesRepo from '../repositories/companies.mjs';

export const ROLE_CATEGORIES = ['decision_maker', 'influencer', 'gatekeeper', 'technical', 'unknown'];
export const EMAIL_TYPES = ['business', 'personal', 'role', 'inferred', 'unknown'];
export const EMAIL_STATUSES = ['unverified', 'valid', 'risky', 'invalid', 'inferred'];
export const CONFIDENCE_LEVELS = ['unverified', 'low', 'medium', 'high'];

const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'contact', 'office', 'admin', 'support', 'marketing', 'hr', 'jobs', 'careers', 'press', 'service',
  'mail', 'newsletter', 'noreply', 'no-reply', 'webmaster', 'postmaster', 'hello', 'enquiries', 'inquiries', 'export',
]);

/** Derive email_type for a crawled/imported address from its local part. */
export function deriveEmailType(email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  if (!local) return 'unknown';
  if (ROLE_LOCAL_PARTS.has(local)) return 'role';
  return 'business';
}

export function isRoleAccountEmail(email) {
  return deriveEmailType(email) === 'role';
}

export function listContacts(workspaceId, filters, sort) {
  return contactsRepo.listContacts(workspaceId, {
    ...filters,
    sortKey: sort?.key,
    sortDirection: sort?.direction,
  });
}

export function getContactOrThrow(workspaceId, contactId) {
  const contact = contactsRepo.findContact(workspaceId, contactId);
  if (!contact) throw notFound('联系人不存在');
  return contact;
}

function resolveCompany(workspaceId, companyId) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('所属企业不存在');
  return company;
}

function normalizeSourceInput(source, method) {
  if (!source || typeof source !== 'object') return null;
  const confidence = Number(source.confidence);
  return {
    type: String(source.type || source.sourceType || (method === 'manual' ? 'manual' : method)).slice(0, 40),
    url: source.url || source.sourceUrl || null,
    method: source.method || method,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 50,
    payload: source.payload && typeof source.payload === 'object' ? source.payload : {},
  };
}

export function addContactSource(workspaceId, contactId, source, fallbackMethod = 'manual') {
  const normalized = normalizeSourceInput(source, fallbackMethod);
  if (!normalized) return null;
  return contactsRepo.addContactSource(workspaceId, contactId, {
    id: id('csrc'),
    sourceType: normalized.type,
    sourceUrl: normalized.url,
    method: normalized.method,
    retrievedAt: nowIso(),
    confidence: normalized.confidence,
    payload: normalized.payload,
  });
}

/**
 * Create a contact. `source` (optional) is recorded in contact_sources.
 * Pass `{audit:false}` from bulk import flows that audit the run themselves.
 */
export function createContact(workspaceId, input, context = {}) {
  const company = resolveCompany(workspaceId, input.companyId);
  const email = input.email ? normalizeEmail(input.email) : '';
  const inferred = input.emailType === 'inferred' || input.inferred === true;
  if (email) {
    const existing = contactsRepo.findContactByEmail(workspaceId, email);
    if (existing) throw conflict(`该邮箱已存在于联系人：${existing.fullName || existing.email}`);
  }
  const firstName = normalizeName(input.firstName || '') || null;
  const lastName = normalizeName(input.lastName || '') || null;
  const fullName = normalizeName(input.fullName || '') || [firstName, lastName].filter(Boolean).join(' ') || null;
  let emailType = 'unknown';
  let emailStatus = 'unverified';
  if (email) {
    emailType = inferred ? 'inferred' : EMAIL_TYPES.includes(input.emailType) ? input.emailType : deriveEmailType(email);
    if (emailType === 'inferred') emailStatus = 'inferred';
    else if (input.emailStatus && EMAIL_STATUSES.includes(input.emailStatus)) emailStatus = input.emailStatus;
  }
  const roleCategory = ROLE_CATEGORIES.includes(input.roleCategory) ? input.roleCategory : 'unknown';
  const confidence = CONFIDENCE_LEVELS.includes(input.confidence) ? input.confidence : 'unverified';
  const now = nowIso();
  const contactId = id('ctc');
  const data = {
    id: contactId,
    workspace_id: workspaceId,
    company_id: company.id,
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    title: input.title ? String(input.title).slice(0, 200) : null,
    role_category: roleCategory,
    email: email || null,
    email_normalized: email || null,
    email_type: emailType,
    email_status: emailStatus,
    phone: input.phone ? String(input.phone).slice(0, 60) : null,
    linkedin_url: input.linkedinUrl ? String(input.linkedinUrl).slice(0, 2000) : null,
    country: input.country || null,
    language: input.language ? String(input.language).slice(0, 20) : null,
    department: input.department ? String(input.department).slice(0, 120) : null,
    is_primary: input.isPrimary ? 1 : 0,
    confidence,
    last_verified_at: input.lastVerifiedAt || null,
    created_by: context.actorId || null,
    created_at: now,
    updated_at: now,
  };
  const contact = contactsRepo.insertContact(data);
  if (data.is_primary) contactsRepo.clearPrimaryContacts(workspaceId, company.id, contactId);
  addContactSource(workspaceId, contactId, input.source || { type: 'manual', method: 'manual', confidence: 60 }, context.sourceMethod || 'manual');
  if (context.audit !== false) {
    recordAudit({
      workspaceId,
      actorType: context.actorId ? 'user' : 'system',
      actorId: context.actorId || null,
      action: 'contact.create',
      entityType: 'contact',
      entityId: contactId,
      after: contact,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  }
  return contact;
}

const UPDATABLE_TEXT_FIELDS = [
  ['firstName', 'first_name', 120],
  ['lastName', 'last_name', 120],
  ['fullName', 'full_name', 240],
  ['title', 'title', 200],
  ['phone', 'phone', 60],
  ['linkedinUrl', 'linkedin_url', 2000],
  ['country', 'country', 8],
  ['language', 'language', 20],
  ['department', 'department', 120],
  ['lastVerifiedAt', 'last_verified_at', 40],
];

export function updateContact(workspaceId, contactId, patch, context = {}) {
  const before = getContactOrThrow(workspaceId, contactId);
  const changes = {};
  for (const [apiField, column, max] of UPDATABLE_TEXT_FIELDS) {
    if (patch[apiField] !== undefined) {
      const value = patch[apiField] === null ? null : String(patch[apiField]).trim().slice(0, max);
      changes[column] = value || null;
    }
  }
  if (patch.roleCategory !== undefined) {
    if (!ROLE_CATEGORIES.includes(patch.roleCategory)) throw validationError('联系人角色不在允许范围内');
    changes.role_category = patch.roleCategory;
  }
  if (patch.confidence !== undefined) {
    if (!CONFIDENCE_LEVELS.includes(patch.confidence)) throw validationError('可信度不在允许范围内');
    changes.confidence = patch.confidence;
  }
  if (patch.isPrimary !== undefined) changes.is_primary = patch.isPrimary ? 1 : 0;

  const emailTouched = patch.email !== undefined || patch.emailType !== undefined || patch.inferred !== undefined || patch.emailStatus !== undefined;
  if (emailTouched) {
    const currentIsInferred = before.emailType === 'inferred' || before.emailStatus === 'inferred';
    const nextEmail = patch.email !== undefined ? normalizeEmail(patch.email || '') : before.emailNormalized || '';
    const nextInferred = patch.emailType === 'inferred' || patch.inferred === true || (patch.emailType === undefined && currentIsInferred);
    if (nextEmail) {
      const existing = contactsRepo.findContactByEmail(workspaceId, nextEmail);
      if (existing && existing.id !== contactId) throw conflict(`该邮箱已存在于联系人：${existing.fullName || existing.email}`);
    }
    let nextType;
    let nextStatus;
    if (!nextEmail) {
      nextType = 'unknown';
      nextStatus = 'unverified';
    } else if (nextInferred) {
      nextType = 'inferred';
      // An inferred address can never be marked valid, even on an explicit PATCH.
      if (patch.emailStatus === 'valid') throw validationError('推测邮箱不能标记为有效，请先完成邮箱校验');
      nextStatus = 'inferred';
    } else {
      nextType = EMAIL_TYPES.includes(patch.emailType) ? patch.emailType : before.emailType === 'inferred' ? deriveEmailType(nextEmail) : before.emailType;
      if (patch.emailStatus !== undefined) {
        if (!EMAIL_STATUSES.includes(patch.emailStatus)) throw validationError('邮箱状态不在允许范围内');
        nextStatus = patch.emailStatus;
      } else {
        nextStatus = before.emailStatus === 'inferred' ? 'unverified' : before.emailStatus;
      }
      if (nextStatus === 'inferred') nextStatus = 'unverified';
    }
    // Hard invariant: inferred emails must never be marked valid.
    if (nextInferred && nextStatus === 'valid') {
      throw validationError('推测邮箱不能标记为有效，请先完成邮箱校验');
    }
    changes.email = nextEmail || null;
    changes.email_normalized = nextEmail || null;
    changes.email_type = nextType;
    changes.email_status = nextStatus;
  }
  if (changes.first_name !== undefined || changes.last_name !== undefined) {
    if (patch.fullName === undefined) {
      const first = changes.first_name !== undefined ? changes.first_name : before.firstName;
      const last = changes.last_name !== undefined ? changes.last_name : before.lastName;
      changes.full_name = [first, last].filter(Boolean).join(' ') || null;
    }
  }
  changes.updated_at = nowIso();
  const contact = contactsRepo.updateContact(workspaceId, contactId, changes);
  if (changes.is_primary === 1) contactsRepo.clearPrimaryContacts(workspaceId, before.companyId, contactId);
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'contact.update',
    entityType: 'contact',
    entityId: contactId,
    before,
    after: contact,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return contact;
}

/** Attach an inferred email to an existing contact (never sets valid). */
export function attachInferredEmail(workspaceId, contactId, { email, confidence = 0.5 }) {
  const contact = getContactOrThrow(workspaceId, contactId);
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const existing = contactsRepo.findContactByEmail(workspaceId, normalized);
  if (existing && existing.id !== contactId) return null;
  const updated = contactsRepo.updateContact(workspaceId, contactId, {
    email: normalized,
    email_normalized: normalized,
    email_type: 'inferred',
    email_status: 'inferred',
    confidence: confidence >= 0.6 ? 'medium' : 'low',
    updated_at: nowIso(),
  });
  addContactSource(
    workspaceId,
    contactId,
    {
      type: 'inference',
      method: 'inference',
      confidence: Math.round(confidence * 100),
      payload: { patterns: 'name+domain', email: normalized, note: 'inferred email, not verified' },
    },
    'inference',
  );
  return updated || contact;
}

export function deleteContact(workspaceId, contactId, context = {}) {
  const before = getContactOrThrow(workspaceId, contactId);
  if (!contactsRepo.softDeleteContact(workspaceId, contactId)) throw notFound('联系人不存在');
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'contact.delete',
    entityType: 'contact',
    entityId: contactId,
    before,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { deleted: true, id: contactId };
}

export function getContactSources(workspaceId, contactId, { page = 1, pageSize = 25 } = {}) {
  getContactOrThrow(workspaceId, contactId);
  const total = contactsRepo.countContactSources(workspaceId, contactId);
  const items = contactsRepo.listContactSources(workspaceId, contactId, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

/** Contact detail with owning company, sources and verification history. */
export function getContactDetail(workspaceId, contactId) {
  const contact = getContactOrThrow(workspaceId, contactId);
  const company = companiesRepo.findCompany(workspaceId, contact.companyId);
  const sources = contactsRepo.listContactSources(workspaceId, contactId);
  const verifications = companiesRepo.listVerifications(workspaceId, 'contact', contactId);
  return { contact, company, sources, verifications };
}
