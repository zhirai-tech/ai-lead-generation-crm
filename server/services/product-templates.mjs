/**
 * OWNER: t-data. Product-level email templates (v1.2).
 *
 * Model: one product has many versions, but at most ONE approved template. The
 * approved template is the only one that may be used for batch outreach.
 *
 * Flow:
 *   generate (Agent `outreach_writer`) -> pending_approval
 *   edit pending                        -> in-place update
 *   edit approved                       -> copy into a new pending version
 *   approve                             -> approve one, disable the old approved one
 *
 * The generated content is personalised with placeholders so one template can
 * be reused for every lead: {{companyName}} / {{contactFirstName}} / {{country}}.
 * Nothing is fabricated: when the Agent is unavailable the API fails with
 * AGENT_UNAVAILABLE and no template row is written.
 */
import { config as defaultConfig } from '../config.mjs';
import { AppError, conflict, notFound, validationError } from '../core/errors.mjs';
import { tx } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as productsRepo from '../repositories/products.mjs';
import * as templatesRepo from '../repositories/product-templates.mjs';
import { listProductFilesForEmail } from './product-files.mjs';

export const TEMPLATE_STATUSES = ['draft', 'pending_approval', 'approved', 'disabled'];
export const MAX_TEMPLATE_ATTACHMENTS = 3;
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 20000;
export const MAX_INSTRUCTIONS_LENGTH = 1000;

export const PLACEHOLDERS = Object.freeze({
  companyName: '{{companyName}}',
  contactFirstName: '{{contactFirstName}}',
  country: '{{country}}',
  productCatalogueUrl: '{{productCatalogueUrl}}',
});

export const VARIABLE_DEFINITIONS = Object.freeze([
  {
    key: 'companyName',
    placeholder: '{{companyName}}',
    label: '企业名称',
    description: '收件企业名称，发送前由系统替换为线索企业名称；缺失时不得留空发送。',
    required: true,
  },
  {
    key: 'contactFirstName',
    placeholder: '{{contactFirstName}}',
    label: '联系人名字',
    description: '收件联系人名字，发送前替换；没有名字时应回退为通用称呼。',
    required: true,
  },
  {
    key: 'country',
    placeholder: '{{country}}',
    label: '国家/地区',
    description: '线索所在国家或地区，发送前替换为企业国家。',
    required: true,
  },
  {
    key: 'productCatalogueUrl',
    placeholder: '{{productCatalogueUrl}}',
    label: '产品目录链接',
    description: '发送前替换为该产品 PDF 的公开链接；没有 PDF 时应删除该变量所在的句子。',
    required: false,
  },
]);

function contextOf(context = {}) {
  return {
    actorId: context.actorId || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    requestId: context.requestId || null,
    config: context.config || null,
  };
}

function auditRecord(workspaceId, action, templateId, after, context, before = null) {
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action,
    entityType: 'product_email_template',
    entityId: templateId,
    before,
    after,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
}

function agentUnavailable(reason = '') {
  throw new AppError('AGENT_UNAVAILABLE', '邮件模板生成服务暂不可用，请稍后重试', {
    status: 503,
    details: { agent: 'generateOutreachDraft', ...(reason ? { reason: String(reason).slice(0, 200) } : {}) },
  });
}

export function normalizeLanguage(value, fallback = 'en') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (!/^[a-z]{2}$/.test(text)) throw validationError('语言必须是两位 ISO-639-1 代码（如 en、de）');
  return text;
}

function truncate(value, max) {
  return String(value || '').slice(0, max);
}

/** Remove stray leading punctuation some models prepend to the body. */
function cleanGeneratedBody(value) {
  return String(value || '')
    .replace(/^\s*[:;,\-–—]\s*/, '')
    .trim();
}

/** Map legacy/agent-written placeholder spellings to the canonical three. */
export function canonicalizePlaceholders(text) {
  return String(text || '')
    .replace(/\{\{\s*(?:companyName|company_name|company|company\.name|name)\s*\}\}/gi, PLACEHOLDERS.companyName)
    .replace(
      /\{\{\s*(?:contactFirstName|contact_first_name|firstName|first_name|contact\.firstName)\s*\}\}/gi,
      PLACEHOLDERS.contactFirstName,
    )
    .replace(/\{\{\s*(?:country|company\.country|contact\.country)\s*\}\}/gi, PLACEHOLDERS.country)
    .replace(
      /\{\{\s*(?:productCatalogueUrl|catalogueUrl|catalogue_url|product\.catalogueUrl)\s*\}\}/gi,
      PLACEHOLDERS.productCatalogueUrl,
    );
}

/**
 * Generated templates must never embed a deployment-specific localhost/PDF URL.
 * Replace any real signed product URL with a reusable placeholder; batch sending
 * resolves it to the current PUBLIC_BASE_URL.
 */
export function sanitizeCatalogueLinks(subjectInput, bodyInput, attachments = [], config = null) {
  const urls = attachments
    .map((attachment) => absolutePublicUrl(attachment.publicUrl, config))
    .filter(Boolean);
  let subject = String(subjectInput || '');
  let body = String(bodyInput || '');
  for (const url of urls) {
    subject = subject.split(url).join(PLACEHOLDERS.productCatalogueUrl);
    body = body.split(url).join(PLACEHOLDERS.productCatalogueUrl);
  }
  body = body
    .replace(/<https?:\/\/[^\s>]+\/api\/v1\/public\/product-files\/[^\s>]+>/gi, PLACEHOLDERS.productCatalogueUrl)
    .replace(/https?:\/\/[^\s>)]*\/api\/v1\/public\/product-files\/[^\s>)]*/gi, PLACEHOLDERS.productCatalogueUrl);
  return { subject, body };
}

/**
 * Deterministically guarantee the three reusable placeholders are present, so
 * every generated template can be rendered for any lead. Only structural
 * personalisation is added here; no product facts are invented.
 */
export function ensureTemplatePlaceholders(subjectInput, bodyInput) {
  let subject = canonicalizePlaceholders(subjectInput).trim();
  let body = canonicalizePlaceholders(bodyInput).trim();

  if (!body.includes(PLACEHOLDERS.contactFirstName)) {
    const lines = body.split('\n');
    const firstLine = lines[0] || '';
    const greeting = /^(hi|hello|hey|dear|guten tag|hallo|bonjour|hola|buongiorno|dzień dobry|olà|olá|geachte|sehr geehrte|sehr geehrter)\b/i.exec(firstLine);
    if (greeting) {
      lines[0] = `${greeting[1]} ${PLACEHOLDERS.contactFirstName},`;
      body = lines.join('\n');
    } else {
      body = `Hello ${PLACEHOLDERS.contactFirstName},\n\n${body}`;
    }
  }

  if (!`${subject}\n${body}`.includes(PLACEHOLDERS.companyName)) {
    subject = truncate(`${subject} — ${PLACEHOLDERS.companyName}`, MAX_SUBJECT_LENGTH);
  }

  if (!`${subject}\n${body}`.includes(PLACEHOLDERS.country)) {
    if (body.includes(PLACEHOLDERS.companyName)) {
      body = body.replace(PLACEHOLDERS.companyName, `${PLACEHOLDERS.companyName} (${PLACEHOLDERS.country})`);
    } else if (subject.includes(PLACEHOLDERS.companyName)) {
      subject = subject.replace(PLACEHOLDERS.companyName, `${PLACEHOLDERS.companyName} (${PLACEHOLDERS.country})`);
    }
  }
  return { subject: subject.trim(), body: body.trim() };
}

/** Variable documentation for the UI: canonical variables used + custom ones. */
export function buildVariables(...texts) {
  const text = texts.filter(Boolean).join('\n');
  const variables = VARIABLE_DEFINITIONS.filter((definition) => text.includes(definition.placeholder)).map((definition) => ({
    ...definition,
  }));
  const placeholders = new Set(text.match(/\{\{[a-zA-Z0-9_.]+\}\}/g) || []);
  for (const placeholder of placeholders) {
    if (variables.some((variable) => variable.placeholder === placeholder)) continue;
    variables.push({
      key: placeholder.slice(2, -2),
      placeholder,
      label: placeholder.slice(2, -2),
      description: '自定义变量：发送前必须提供值，否则不得发送。',
      required: false,
    });
  }
  return variables;
}

function absolutePublicUrl(url, config) {
  const value = String(url || '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = String((config || defaultConfig).publicBaseUrl || '').replace(/\/+$/, '');
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}

function requireProduct(workspaceId, productId) {
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw notFound('产品不存在');
  return product;
}

function productAgentFacts(product) {
  return {
    name: product.name,
    category: product.category,
    description: product.description,
    specs: product.specs,
    applications: product.applications,
    materials: product.materials,
    certifications: product.certifications,
    capacity: product.capacity,
    moq: product.moq,
    pricingTerms: product.pricingTerms,
    samples: product.samples,
    leadTime: product.leadTime,
    keywords: product.keywords,
  };
}

// -------------------------------------------------------------------- read
export function getProductTemplateOverview(workspaceId, productId) {
  requireProduct(workspaceId, productId);
  return {
    template: templatesRepo.findLatestProductTemplate(workspaceId, productId),
    approved: templatesRepo.findApprovedProductTemplate(workspaceId, productId),
  };
}

export function listProductTemplateVersions(workspaceId, productId) {
  requireProduct(workspaceId, productId);
  return { items: templatesRepo.listProductTemplates(workspaceId, productId) };
}

/**
 * Contract for batch outreach: only the approved template may be used.
 * Returns null when the product has no approved template yet.
 */
export function getApprovedProductTemplate(workspaceId, productId) {
  return templatesRepo.findApprovedProductTemplate(workspaceId, productId);
}

/** Strict variant: throws a clear conflict when no template is approved. */
export function requireApprovedProductTemplate(workspaceId, productId) {
  requireProduct(workspaceId, productId);
  const template = templatesRepo.findApprovedProductTemplate(workspaceId, productId);
  if (!template) throw conflict('该产品尚未确认邮件模板，不能用于批量外发');
  return template;
}

// ---------------------------------------------------------------- generate
export async function generateProductTemplate(workspaceId, productId, input = {}, context = {}) {
  const ctx = contextOf(context);
  const product = requireProduct(workspaceId, productId);
  // Task contract: templates snapshot product PDF documents only (drafts may
  // also attach images, but a reusable email template links catalogues).
  const attachments = listProductFilesForEmail(workspaceId, productId)
    .filter((file) => file.mimeType === 'application/pdf' && file.publicUrl)
    .slice(0, MAX_TEMPLATE_ATTACHMENTS);
  const languageInput = input.language === undefined || input.language === null || input.language === ''
    ? null
    : normalizeLanguage(input.language, 'en');
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH) : '';

  const agentContext = {
    company: {
      name: PLACEHOLDERS.companyName,
      country: PLACEHOLDERS.country,
      industry: product.category || 'B2B distribution',
    },
    contact: {
      firstName: PLACEHOLDERS.contactFirstName,
      fullName: PLACEHOLDERS.contactFirstName,
    },
    product: productAgentFacts(product),
    productFiles: attachments.map((attachment) => ({
      filename: attachment.filename,
      publicUrl: absolutePublicUrl(attachment.publicUrl, ctx.config),
    })),
    // Templates are reusable content only; compliance boilerplate is added when
    // a real draft is generated from this template.
    settings: { includeUnsubscribe: false },
  };
  if (instructions) {
    agentContext.facts = [{ text: instructions, source: 'user.instructions' }];
  }

  let agentModule;
  try {
    agentModule = await import('../agents/index.mjs');
  } catch (error) {
    agentUnavailable(error && error.message);
  }
  const generate = agentModule && agentModule.generateOutreachDraft;
  if (typeof generate !== 'function') agentUnavailable('generateOutreachDraft is not exported');

  let output;
  try {
    output = await generate({
      workspaceId,
      context: agentContext,
      language: languageInput || 'en',
      actorType: ctx.actorId ? 'user' : 'system',
      actorId: ctx.actorId,
      createdBy: ctx.actorId,
    });
  } catch (error) {
    agentUnavailable(error && error.message);
  }
  if (!output || typeof output !== 'object' || typeof output.subject !== 'string' || typeof output.body !== 'string') {
    agentUnavailable('outreach agent returned an unexpected payload');
  }
  const sanitized = sanitizeCatalogueLinks(output.subject, cleanGeneratedBody(output.body), attachments, ctx.config);
  const placeholders = ensureTemplatePlaceholders(sanitized.subject, sanitized.body);
  if (!placeholders.subject || !placeholders.body) agentUnavailable('outreach agent returned empty content');

  const language = normalizeLanguage(output.language, languageInput || 'en');
  const variables = buildVariables(placeholders.subject, placeholders.body);
  const now = nowIso();
  const template = tx(() => {
    const version = templatesRepo.nextTemplateVersion(workspaceId, productId);
    return templatesRepo.insertProductTemplate({
      id: id('ptm'),
      workspace_id: workspaceId,
      product_id: productId,
      version,
      subject: truncate(placeholders.subject, MAX_SUBJECT_LENGTH),
      body_text: truncate(placeholders.body, MAX_BODY_LENGTH),
      language,
      status: 'pending_approval',
      variables_json: JSON.stringify(variables),
      attachments_json: JSON.stringify(attachments),
      generated_by: ctx.actorId,
      approved_by: null,
      approved_at: null,
      created_by: ctx.actorId,
      created_at: now,
      updated_at: now,
    });
  });

  auditRecord(workspaceId, 'product.template_generate', template.id, {
    productId,
    version: template.version,
    language,
    status: template.status,
    placeholders: variables.map((variable) => variable.placeholder),
    attachmentCount: template.attachments.length,
    instructionsUsed: Boolean(instructions),
  }, ctx);
  return template;
}

// ------------------------------------------------------------------ update
function cleanSubject(value) {
  const subject = String(value ?? '').trim();
  if (!subject) throw validationError('邮件主题不能为空');
  if (subject.length > MAX_SUBJECT_LENGTH) throw validationError(`邮件主题不能超过 ${MAX_SUBJECT_LENGTH} 个字符`);
  return subject;
}

function cleanBody(value) {
  const body = String(value ?? '');
  if (!body.trim()) throw validationError('邮件正文不能为空');
  if (body.length > MAX_BODY_LENGTH) throw validationError(`邮件正文不能超过 ${MAX_BODY_LENGTH} 个字符`);
  return body;
}

export function updateProductTemplate(workspaceId, productId, templateId, patch = {}, context = {}) {
  const ctx = contextOf(context);
  const existing = templatesRepo.findProductTemplate(workspaceId, productId, templateId);
  if (!existing) throw notFound('邮件模板不存在');
  const hasSubject = patch.subject !== undefined;
  const hasBody = patch.bodyText !== undefined;
  const hasLanguage = patch.language !== undefined;
  if (!hasSubject && !hasBody && !hasLanguage) {
    throw validationError('请至少提供 subject、bodyText 或 language 之一');
  }
  const nextSubject = hasSubject ? canonicalizePlaceholders(cleanSubject(patch.subject)) : existing.subject;
  const nextBody = hasBody ? canonicalizePlaceholders(cleanBody(patch.bodyText)) : existing.bodyText;
  const nextLanguage = hasLanguage ? normalizeLanguage(patch.language, existing.language) : existing.language;
  const now = nowIso();
  const variables = buildVariables(nextSubject, nextBody);

  if (existing.status === 'approved') {
    // Editing an approved template never mutates history: create a new pending
    // version, keeping the currently approved one usable until re-approval.
    const created = tx(() => {
      const version = templatesRepo.nextTemplateVersion(workspaceId, productId);
      return templatesRepo.insertProductTemplate({
        id: id('ptm'),
        workspace_id: workspaceId,
        product_id: productId,
        version,
        subject: nextSubject,
        body_text: nextBody,
        language: nextLanguage,
        status: 'pending_approval',
        variables_json: JSON.stringify(variables),
        attachments_json: JSON.stringify(existing.attachments),
        generated_by: existing.generatedBy,
        approved_by: null,
        approved_at: null,
        created_by: ctx.actorId,
        created_at: now,
        updated_at: now,
      });
    });
    auditRecord(workspaceId, 'product.template_version_create', created.id, {
      productId,
      fromTemplateId: existing.id,
      fromVersion: existing.version,
      version: created.version,
      status: created.status,
    }, ctx, { templateId: existing.id, version: existing.version, status: existing.status });
    return created;
  }

  const updated = templatesRepo.updateProductTemplate(workspaceId, productId, templateId, {
    subject: nextSubject,
    body_text: nextBody,
    language: nextLanguage,
    variables_json: JSON.stringify(variables),
    updated_at: now,
  });
  auditRecord(workspaceId, 'product.template_update', templateId, {
    productId,
    subject: updated.subject,
    language: updated.language,
    status: updated.status,
  }, ctx, { subject: existing.subject, bodyText: existing.bodyText, language: existing.language, status: existing.status });
  return updated;
}

// ----------------------------------------------------------------- approve
export function approveProductTemplate(workspaceId, productId, templateId, context = {}) {
  const ctx = contextOf(context);
  requireProduct(workspaceId, productId);
  const existing = templatesRepo.findProductTemplate(workspaceId, productId, templateId);
  if (!existing) throw notFound('邮件模板不存在');
  if (existing.status === 'approved') return existing;

  const now = nowIso();
  const approved = tx(() => {
    templatesRepo.disableOtherApprovedTemplates(workspaceId, productId, templateId);
    return templatesRepo.updateProductTemplate(workspaceId, productId, templateId, {
      status: 'approved',
      approved_by: ctx.actorId,
      approved_at: now,
      updated_at: now,
    });
  });
  auditRecord(workspaceId, 'product.template_approve', templateId, {
    productId,
    version: approved.version,
    status: approved.status,
    approvedBy: approved.approvedBy,
  }, ctx, { status: existing.status, approvedBy: existing.approvedBy, approvedAt: existing.approvedAt });
  return approved;
}
