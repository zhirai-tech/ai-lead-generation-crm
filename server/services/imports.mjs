/**
 * CSV import (companies / contacts / suppression) and the self-contained
 * RFC 4180 parser used by both imports and exports.
 *
 * Parsing rules: quoted fields, escaped quotes (""), embedded commas/newlines,
 * CRLF/LF/CR line endings and a UTF-8 BOM. Every import creates an import_runs
 * row with per-row error details and records the source of created entities.
 */
import { get, run, tx } from '../core/db.mjs';
import { badRequest, notFound, validationError } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import { isEmail, normalizeDomain, normalizeEmail } from '../core/validate.mjs';
import * as importsRepo from '../repositories/imports.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import * as contactsRepo from '../repositories/contacts.mjs';
import {
  createCompanyRecord,
  normalizeCompanyName,
  computeCompanyDataQuality,
  addCompanySource,
} from './companies.mjs';
import { createContact, ROLE_CATEGORIES, EMAIL_TYPES, EMAIL_STATUSES, CONFIDENCE_LEVELS } from './contacts.mjs';

export const IMPORT_KINDS = ['companies', 'contacts', 'suppression'];
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_ERRORS = 200;

// -------------------------------------------------------------- CSV parsing
/** Parse CSV text into an array of records (arrays of strings). RFC 4180. */
export function parseCsvRecords(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  if (!input.trim()) return [];
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      record.push(field);
      field = '';
      records.push(record);
      record = [];
      index += char === '\r' && input[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (inQuotes) throw validationError('CSV 引号未闭合，请检查文件内容');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Drop a trailing blank record produced by a final newline.
  const cleaned = records.filter((row) => !(row.length === 1 && row[0].trim() === ''));
  return cleaned;
}

/** Parse CSV text into header + row objects. Duplicate headers are suffixed. */
export function parseCsvTable(text) {
  const records = parseCsvRecords(text);
  if (!records.length) return { header: [], rows: [], recordCount: 0 };
  const header = records[0].map((value, index) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || `column_${index + 1}`;
  });
  const seen = new Map();
  const uniqueHeader = header.map((name) => {
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
  const rows = [];
  for (let rowIndex = 1; rowIndex < records.length; rowIndex += 1) {
    const values = records[rowIndex];
    const row = {};
    let hasValue = false;
    for (let column = 0; column < uniqueHeader.length; column += 1) {
      const value = values[column] === undefined ? '' : String(values[column]);
      row[uniqueHeader[column]] = value;
      if (value.trim()) hasValue = true;
    }
    if (!hasValue) continue;
    rows.push({ row, rowNumber: rowIndex + 1 });
  }
  return { header: uniqueHeader, rows, recordCount: records.length - 1 };
}

/** Serialise a cell value, quoting when required by RFC 4180. */
export function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Build CSV text from headers + rows (arrays or objects). */
export function toCsv(headers, rows, { bom = false, lineEnding = '\r\n' } = {}) {
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    if (Array.isArray(row)) lines.push(row.map(escapeCsvValue).join(','));
    else lines.push(headers.map((header) => escapeCsvValue(row[header])).join(','));
  }
  return `${bom ? '\uFEFF' : ''}${lines.join(lineEnding)}${lineEnding}`;
}

// ---------------------------------------------------------------- helpers
function pickColumn(row, aliases) {
  for (const alias of aliases) {
    const key = Object.keys(row).find((candidate) => candidate.trim().toLowerCase() === alias);
    if (key !== undefined) {
      const value = String(row[key] ?? '').trim();
      if (value) return value;
    }
  }
  return '';
}

const COMPANY_ALIASES = {
  name: ['name', 'company_name', 'company', '企业名称', '公司名称', '名称'],
  domain: ['domain', '域名'],
  website: ['website', 'url', '官网', '网站'],
  country: ['country', '国家'],
  region: ['region', '地区', '区域', '省份'],
  city: ['city', '城市'],
  address: ['address', '地址'],
  companyType: ['company_type', 'type', '企业类型', '类型'],
  industry: ['industry', '行业'],
  employeeRange: ['employee_range', 'employees', '员工规模', '规模'],
  revenueRange: ['revenue_range', 'revenue', '营收规模'],
  description: ['description', '描述', '简介'],
  linkedinUrl: ['linkedin', 'linkedin_url', 'linkedin链接'],
  phone: ['phone', '电话'],
  tags: ['tags', '标签'],
};

const CONTACT_ALIASES = {
  companyId: ['company_id', '企业ID', '企业id'],
  companyDomain: ['company_domain', '企业域名'],
  companyName: ['company_name', 'company', '企业名称', '公司名称'],
  firstName: ['first_name', 'firstname', '名'],
  lastName: ['last_name', 'lastname', '姓'],
  fullName: ['full_name', 'fullname', '姓名', '联系人'],
  title: ['title', '职位', '职务'],
  roleCategory: ['role_category', '角色', '角色类别'],
  email: ['email', '邮箱', '电子邮箱', 'e-mail'],
  phone: ['phone', '电话', '手机'],
  linkedinUrl: ['linkedin', 'linkedin_url', 'linkedin链接'],
  country: ['country', '国家'],
  language: ['language', '语言'],
  department: ['department', '部门'],
  isPrimary: ['is_primary', '主联系人'],
  confidence: ['confidence', '可信度'],
  emailStatus: ['email_status', '邮箱状态'],
  emailType: ['email_type', '邮箱类型'],
};

const SUPPRESSION_ALIASES = {
  email: ['email', '邮箱', 'e-mail'],
  domain: ['domain', '域名'],
  value: ['value', '值', '邮箱或域名'],
  scope: ['scope', '范围', '类型'],
  reason: ['reason', '原因', '理由'],
  note: ['note', '备注'],
  source: ['source', '来源'],
};

const SUPPRESSION_REASONS = ['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'do_not_contact', 'gdpr_request'];

function pickSourceConfidence(kind) {
  return kind === 'contacts' ? 75 : 80;
}

function addImportSourceToCompany(workspaceId, companyId, { filename, rowNumber, kind }) {
  addCompanySource(workspaceId, companyId, {
    type: 'import',
    name: filename || 'CSV 导入',
    url: null,
    confidence: pickSourceConfidence(kind),
    payload: { filename, row: rowNumber, kind },
  });
}

function companyPatchFromRow(row) {
  return {
    name: pickColumn(row, COMPANY_ALIASES.name),
    domain: pickColumn(row, COMPANY_ALIASES.domain),
    website: pickColumn(row, COMPANY_ALIASES.website) || null,
    country: pickColumn(row, COMPANY_ALIASES.country).toUpperCase() || null,
    region: pickColumn(row, COMPANY_ALIASES.region) || null,
    city: pickColumn(row, COMPANY_ALIASES.city) || null,
    address: pickColumn(row, COMPANY_ALIASES.address) || null,
    companyType: pickColumn(row, COMPANY_ALIASES.companyType) || null,
    industry: pickColumn(row, COMPANY_ALIASES.industry) || null,
    employeeRange: pickColumn(row, COMPANY_ALIASES.employeeRange) || null,
    revenueRange: pickColumn(row, COMPANY_ALIASES.revenueRange) || null,
    description: pickColumn(row, COMPANY_ALIASES.description) || null,
    linkedinUrl: pickColumn(row, COMPANY_ALIASES.linkedinUrl) || null,
    phone: pickColumn(row, COMPANY_ALIASES.phone) || null,
    tags: pickColumn(row, COMPANY_ALIASES.tags)
      .split(/[,;，；]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 20),
  };
}

function assertCountry(value, errors, rowNumber) {
  if (!value) return null;
  if (!/^[A-Z]{2}$/.test(value)) {
    errors.push({ row: rowNumber, message: '国家必须是两位国家代码（如 DE）' });
    return null;
  }
  return value;
}

// ----------------------------------------------------------- import kinds
function importCompanies(workspaceId, table, { filename, kind }, context) {
  const errors = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seenDomains = new Set();
  const seenNames = new Set();
  tx(() => {
    for (const { row, rowNumber } of table.rows) {
      try {
        const parsed = companyPatchFromRow(row);
        if (!parsed.name) {
          errors.push({ row: rowNumber, message: '企业名称不能为空' });
          continue;
        }
        const domainRaw = parsed.domain;
        const domain = domainRaw ? normalizeDomain(domainRaw) : '';
        if (domainRaw && !domain) {
          errors.push({ row: rowNumber, message: `域名格式不正确：${domainRaw}` });
          continue;
        }
        parsed.country = assertCountry(parsed.country, errors, rowNumber);
        if (errors.length && errors[errors.length - 1].row === rowNumber) continue;
        const normalizedName = normalizeCompanyName(parsed.name);
        if (domain && seenDomains.has(domain)) {
          skipped += 1;
          errors.push({ row: rowNumber, message: `文件内域名重复：${domain}` });
          continue;
        }
        if (!domain && seenNames.has(normalizedName)) {
          skipped += 1;
          errors.push({ row: rowNumber, message: `文件内企业名称重复：${parsed.name}` });
          continue;
        }
        const existing = domain
          ? companiesRepo.findCompanyByDomain(workspaceId, domain)
          : companiesRepo.findCompanyByNormalizedName(workspaceId, normalizedName);
        if (existing) {
          const patch = {};
          const mapping = {
            website: 'website',
            region: 'region',
            city: 'city',
            address: 'address',
            companyType: 'company_type',
            industry: 'industry',
            employeeRange: 'employee_range',
            revenueRange: 'revenue_range',
            description: 'description',
            linkedinUrl: 'linkedin_url',
            phone: 'phone',
          };
          for (const [apiField, column] of Object.entries(mapping)) {
            if (parsed[apiField] && !existing[apiField]) patch[column] = parsed[apiField];
          }
          if (parsed.country && !existing.country) patch.country = parsed.country;
          if (parsed.tags.length && !(existing.tags || []).length) patch.tags_json = JSON.stringify(parsed.tags);
          if (Object.keys(patch).length) {
            patch.updated_at = nowIso();
            companiesRepo.updateCompany(workspaceId, existing.id, patch);
            updated += 1;
          } else {
            skipped += 1;
          }
          addImportSourceToCompany(workspaceId, existing.id, { filename, rowNumber, kind });
        } else {
          createCompanyRecord(
            workspaceId,
            {
              ...parsed,
              domain,
              website: parsed.website || (domain ? `https://${domain}` : null),
              status: 'new',
              confidence: 'low',
              source: {
                type: 'import',
                name: filename || 'CSV 导入',
                confidence: pickSourceConfidence(kind),
                payload: { filename, row: rowNumber },
              },
            },
            { actorId: context.actorId, audit: false },
          );
          created += 1;
        }
        if (domain) seenDomains.add(domain);
        seenNames.add(normalizedName);
      } catch (error) {
        errors.push({ row: rowNumber, message: String(error.message || '导入失败').slice(0, 500) });
      }
    }
  });
  return { created, updated, skipped, errors };
}

function importContacts(workspaceId, table, { filename, kind }, context) {
  const errors = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seenEmails = new Set();
  tx(() => {
    for (const { row, rowNumber } of table.rows) {
      try {
        const companyIdRaw = pickColumn(row, CONTACT_ALIASES.companyId);
        const companyDomainRaw = pickColumn(row, CONTACT_ALIASES.companyDomain);
        const companyNameRaw = pickColumn(row, CONTACT_ALIASES.companyName);
        let company = null;
        if (companyIdRaw) company = companiesRepo.findCompany(workspaceId, companyIdRaw);
        if (!company && companyDomainRaw) {
          const domain = normalizeDomain(companyDomainRaw);
          if (!domain) {
            errors.push({ row: rowNumber, message: `企业域名格式不正确：${companyDomainRaw}` });
            continue;
          }
          company = companiesRepo.findCompanyByDomain(workspaceId, domain);
        }
        if (!company && companyNameRaw) {
          company = companiesRepo.findCompanyByNormalizedName(workspaceId, normalizeCompanyName(companyNameRaw));
          if (!company) {
            company = createCompanyRecord(
              workspaceId,
              {
                name: companyNameRaw,
                status: 'new',
                confidence: 'low',
                source: { type: 'import', name: filename || 'CSV 导入', confidence: 70, payload: { filename, row: rowNumber } },
              },
              { actorId: context.actorId, audit: false },
            );
          }
        }
        if (!company) {
          errors.push({ row: rowNumber, message: '找不到所属企业（请提供 company_id / company_domain / company_name）' });
          continue;
        }
        const emailRaw = pickColumn(row, CONTACT_ALIASES.email);
        const email = emailRaw ? normalizeEmail(emailRaw) : '';
        if (emailRaw && !isEmail(email)) {
          errors.push({ row: rowNumber, message: `邮箱格式不正确：${emailRaw}` });
          continue;
        }
        if (email && seenEmails.has(email)) {
          skipped += 1;
          errors.push({ row: rowNumber, message: `文件内邮箱重复：${email}` });
          continue;
        }
        const firstName = pickColumn(row, CONTACT_ALIASES.firstName) || null;
        const lastName = pickColumn(row, CONTACT_ALIASES.lastName) || null;
        const fullName = pickColumn(row, CONTACT_ALIASES.fullName) || [firstName, lastName].filter(Boolean).join(' ') || null;
        if (!fullName && !email) {
          errors.push({ row: rowNumber, message: '联系人的姓名和邮箱不能同时为空' });
          continue;
        }
        const roleCategory = pickColumn(row, CONTACT_ALIASES.roleCategory);
        const emailType = pickColumn(row, CONTACT_ALIASES.emailType);
        const emailStatus = pickColumn(row, CONTACT_ALIASES.emailStatus);
        const confidence = pickColumn(row, CONTACT_ALIASES.confidence);
        const isPrimary = ['1', 'true', 'yes', '是', 'y'].includes(pickColumn(row, CONTACT_ALIASES.isPrimary).toLowerCase());
        const payload = {
          companyId: company.id,
          firstName,
          lastName,
          fullName,
          title: pickColumn(row, CONTACT_ALIASES.title) || null,
          roleCategory: ROLE_CATEGORIES.includes(roleCategory) ? roleCategory : 'unknown',
          email,
          emailType: EMAIL_TYPES.includes(emailType) ? emailType : undefined,
          emailStatus: EMAIL_STATUSES.includes(emailStatus) ? emailStatus : undefined,
          phone: pickColumn(row, CONTACT_ALIASES.phone) || null,
          linkedinUrl: pickColumn(row, CONTACT_ALIASES.linkedinUrl) || null,
          country: pickColumn(row, CONTACT_ALIASES.country).toUpperCase().slice(0, 2) || null,
          language: pickColumn(row, CONTACT_ALIASES.language) || null,
          department: pickColumn(row, CONTACT_ALIASES.department) || null,
          isPrimary,
          confidence: CONFIDENCE_LEVELS.includes(confidence) ? confidence : 'unverified',
          source: {
            type: 'import',
            method: 'import',
            confidence: pickSourceConfidence(kind),
            payload: { filename, row: rowNumber },
          },
        };
        // Guard the inferred-email invariant for imported rows as well.
        if (payload.emailType === 'inferred' && payload.emailStatus === 'valid') payload.emailStatus = 'inferred';
        if (payload.emailType === 'inferred') payload.emailStatus = 'inferred';
        const existing = email ? contactsRepo.findContactByEmail(workspaceId, email) : null;
        if (existing) {
          const patch = {};
          const textMapping = {
            firstName: 'first_name',
            lastName: 'last_name',
            fullName: 'full_name',
            title: 'title',
            phone: 'phone',
            linkedinUrl: 'linkedin_url',
            country: 'country',
            language: 'language',
            department: 'department',
          };
          for (const [apiField, column] of Object.entries(textMapping)) {
            if (payload[apiField] && !existing[apiField]) patch[column] = payload[apiField];
          }
          if (payload.roleCategory !== 'unknown' && existing.roleCategory === 'unknown') patch.role_category = payload.roleCategory;
          if (Object.keys(patch).length) {
            patch.updated_at = nowIso();
            contactsRepo.updateContact(workspaceId, existing.id, patch);
            updated += 1;
          } else {
            skipped += 1;
          }
          contactsRepo.addContactSource(workspaceId, existing.id, {
            id: id('csrc'),
            sourceType: 'import',
            method: 'import',
            retrievedAt: nowIso(),
            confidence: pickSourceConfidence(kind),
            payload: { filename, row: rowNumber },
          });
        } else {
          createContact(workspaceId, payload, { actorId: context.actorId, audit: false, sourceMethod: 'import' });
          created += 1;
        }
        if (email) seenEmails.add(email);
      } catch (error) {
        errors.push({ row: rowNumber, message: String(error.message || '导入失败').slice(0, 500) });
      }
    }
  });
  return { created, updated, skipped, errors };
}

function importSuppression(workspaceId, table, { filename, kind }, context) {
  const errors = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const now = nowIso();
  tx(() => {
    for (const { row, rowNumber } of table.rows) {
      try {
        const scopeRaw = pickColumn(row, SUPPRESSION_ALIASES.scope).toLowerCase();
        const emailRaw = pickColumn(row, SUPPRESSION_ALIASES.email);
        const domainRaw = pickColumn(row, SUPPRESSION_ALIASES.domain);
        const valueRaw = pickColumn(row, SUPPRESSION_ALIASES.value) || emailRaw || domainRaw;
        if (!valueRaw) {
          errors.push({ row: rowNumber, message: '缺少邮箱或域名' });
          continue;
        }
        let scope;
        let value;
        if (scopeRaw === 'email' || scopeRaw === '邮箱' || (!scopeRaw && valueRaw.includes('@'))) {
          scope = 'email';
          value = normalizeEmail(valueRaw);
          if (!isEmail(value)) {
            errors.push({ row: rowNumber, message: `邮箱格式不正确：${valueRaw}` });
            continue;
          }
        } else {
          scope = 'domain';
          value = normalizeDomain(valueRaw);
          if (!value) {
            errors.push({ row: rowNumber, message: `域名格式不正确：${valueRaw}` });
            continue;
          }
        }
        const reasonRaw = pickColumn(row, SUPPRESSION_ALIASES.reason) || 'manual';
        const reason = SUPPRESSION_REASONS.includes(reasonRaw) ? reasonRaw : 'manual';
        const existing = get('SELECT id FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?', [
          workspaceId,
          scope,
          value,
        ]);
        if (existing) {
          skipped += 1;
          continue;
        }
        run(
          `INSERT INTO suppression_records (id, workspace_id, scope, value_normalized, reason, source, note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id('sup'),
            workspaceId,
            scope,
            value,
            reason,
            pickColumn(row, SUPPRESSION_ALIASES.source) || (filename ? `import:${filename}` : 'import'),
            pickColumn(row, SUPPRESSION_ALIASES.note) || null,
            context.actorId || null,
            now,
          ],
        );
        created += 1;
      } catch (error) {
        errors.push({ row: rowNumber, message: String(error.message || '导入失败').slice(0, 500) });
      }
    }
  });
  return { created, updated, skipped, errors };
}

/**
 * Run an import. Always writes an import_runs row; row-level problems are
 * reported there instead of aborting the whole file.
 */
export function runImport(workspaceId, { kind, filename = null, text }, context = {}) {
  if (!IMPORT_KINDS.includes(kind)) throw badRequest('不支持的导入类型');
  if (typeof text !== 'string' || !text.trim()) throw validationError('导入内容不能为空');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw badRequest('导入文件过大（最大 5MB）');
  const startedAt = nowIso();
  const runId = id('imp');
  importsRepo.insertImportRun({
    id: runId,
    workspace_id: workspaceId,
    kind,
    filename,
    status: 'running',
    created_by: context.actorId || null,
    created_at: startedAt,
  });

  let result;
  try {
    const table = parseCsvTable(text);
    if (!table.header.length) throw validationError('CSV 文件缺少表头');
    if (kind === 'companies') result = importCompanies(workspaceId, table, { filename, kind }, context);
    else if (kind === 'contacts') result = importContacts(workspaceId, table, { filename, kind }, context);
    else result = importSuppression(workspaceId, table, { filename, kind }, context);
  } catch (error) {
    result = { created: 0, updated: 0, skipped: 0, errors: [{ row: 0, message: String(error.message || '导入失败').slice(0, 500) }] };
  }

  const failed = result.errors.length > 0 && result.created === 0 && result.updated === 0 && result.skipped === 0;
  const importRun = importsRepo.finishImportRun(workspaceId, runId, {
    totalRows: (() => {
      try {
        return parseCsvTable(text).rows.length;
      } catch {
        return 0;
      }
    })(),
    createdCount: result.created,
    updatedCount: result.updated,
    skippedCount: result.skipped,
    errorCount: result.errors.length,
    errors: result.errors.slice(0, MAX_ERRORS),
    status: failed ? 'failed' : 'completed',
    finishedAt: nowIso(),
  });

  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'import.run',
    entityType: 'import_run',
    entityId: runId,
    after: {
      kind,
      filename,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors.length,
    },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return importRun;
}

export function listImportRuns(workspaceId, filters, sort) {
  return importsRepo.listImportRuns(workspaceId, { ...filters, sortDirection: sort?.direction });
}

export function getImportRunOrThrow(workspaceId, runId) {
  const importRun = importsRepo.findImportRun(workspaceId, runId);
  if (!importRun) throw notFound('导入记录不存在');
  return importRun;
}

/** Recompute a company data-quality score after import fill-ins. */
export function refreshCompanyQuality(workspaceId, companyId) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) return null;
  const contacts = contactsRepo.listContactsForCompany(workspaceId, companyId);
  const score = computeCompanyDataQuality(company, {
    contactsCount: contacts.length,
    hasEmail: contacts.some((contact) => Boolean(contact.emailNormalized) && contact.emailStatus !== 'invalid'),
  });
  return companiesRepo.updateCompany(workspaceId, companyId, { data_quality_score: score, updated_at: nowIso() });
}
