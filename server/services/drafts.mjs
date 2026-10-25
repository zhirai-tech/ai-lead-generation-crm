/**
 * OWNER: t-crm.
 *
 * Draft generation + approval + send queueing. The actual delivery happens in
 * the worker (`email.send`); this service validates every precondition the
 * business requires before a message may enter the pipeline.
 */
import { AppError, conflict, notFound, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { asString } from '../core/validate.mjs';
import { config } from '../config.mjs';
import { id } from '../core/ids.mjs';
import { nowIso, dayKey } from '../core/time.mjs';
import { getSettings } from './settings.mjs';
import { callAgent } from './agent-client.mjs';
import { enqueueJobSafe } from './queue-client.mjs';
import { assertCompanySendable, getCompanyAutomationState } from './automation.mjs';
import { checkSuppression } from './suppression.mjs';
import {
  listDrafts,
  getDraft,
  createDraft as repoCreateDraft,
  updateDraft,
  countApprovedSince,
  countScheduledSince,
  listPendingApprovals,
  listCompanyDraftHistory,
  agentExecutionExists,
} from '../repositories/drafts.mjs';
import { listCompanyMessages, countOutboundSentSince, getActiveAccount, getAccount } from '../repositories/email.mjs';
import { listActivities } from '../repositories/deals.mjs';
import { getCampaign } from '../repositories/campaigns.mjs';
import { getCompany, getContact, getProduct, getIcp, getLatestLeadScore, getMatchedProduct, latestAgentExecutionId } from '../repositories/crm-shared.mjs';
import { getCampaignSendContext } from './campaigns.mjs';

export const DRAFT_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'sent', 'failed', 'discarded'];
export const EDITABLE_STATUSES = ['draft', 'pending_approval', 'rejected'];
const APPROVABLE_STATUSES = ['draft', 'pending_approval', 'rejected'];
/** Maximum number of product PDFs attached to one outreach draft. */
export const MAX_DRAFT_ATTACHMENTS = 3;

// ------------------------------------------------- product PDF attachment bridge
/**
 * Test seam (same pattern as agent-client): lets tests provide deterministic
 * product files without depending on the t-data module being present.
 */
let productFilesLoaderOverride = null;

export function setProductFilesLoaderForTests(loader) {
  productFilesLoaderOverride = typeof loader === 'function' ? loader : null;
}

export function resetProductFilesLoaderForTests() {
  productFilesLoaderOverride = null;
}

/** Keep only sendable PDFs (with a public link) and product images, cap at 3. */
function normalizeProductAttachments(files) {
  if (!Array.isArray(files)) return [];
  const normalized = [];
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const mimeType = String(file.mimeType ?? file.mime_type ?? '').toLowerCase();
    const isPdf = mimeType === 'application/pdf';
    const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType);
    if (!isPdf && !isImage) continue;
    const publicUrl = typeof file.publicUrl === 'string' ? file.publicUrl.trim() : '';
    // PDFs are useful in the body via a public link; images are attached directly.
    if (isPdf && !publicUrl) continue;
    const productFileId = file.productFileId ?? file.id ?? null;
    if (!productFileId || seen.has(productFileId)) continue;
    seen.add(productFileId);
    normalized.push({
      productFileId,
      filename: String(file.filename || (isPdf ? 'document.pdf' : 'product-image.png')).slice(0, 255),
      mimeType,
      sizeBytes: Number(file.sizeBytes ?? file.size_bytes ?? 0) || 0,
      publicUrl: isPdf ? publicUrl : '',
    });
    if (normalized.length >= MAX_DRAFT_ATTACHMENTS) break;
  }
  return normalized;
}

/** Absolute public URL for a stored product PDF (used inside email bodies). */
function absolutePublicUrl(url) {
  const value = String(url || '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  return `${base}${value.startsWith('/') ? value : `/${value}`}`;
}

/**
 * Load the product's PDFs for an email. The t-data module is imported
 * dynamically and any failure (module not deployed yet, query error) degrades to
 * "no attachments" so draft generation never breaks because of media.
 */
async function loadProductAttachments(workspaceId, productId) {
  if (!productId) return [];
  if (productFilesLoaderOverride) {
    try {
      return normalizeProductAttachments(await productFilesLoaderOverride(workspaceId, productId));
    } catch {
      return [];
    }
  }
  try {
    const module = await import('./product-files.mjs');
    const listForEmail = module?.listProductFilesForEmail;
    if (typeof listForEmail !== 'function') return [];
    return normalizeProductAttachments(await listForEmail(workspaceId, productId));
  } catch {
    return [];
  }
}

function normalizeActor(actor = {}) {
  return {
    actorType: actor.actorType || (actor.actorId ? 'user' : 'system'),
    actorId: actor.actorId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
  };
}

function auditActorType(actorType) {
  return ['user', 'agent', 'system', 'api_key'].includes(actorType) ? actorType : 'system';
}

function requireDraft(workspaceId, draftId) {
  const draft = getDraft(workspaceId, draftId);
  if (!draft) throw notFound('草稿不存在');
  return draft;
}

function dayStartIso() {
  return `${dayKey()}T00:00:00.000Z`;
}

function sendLimits(workspaceId) {
  const settings = getSettings(workspaceId);
  const outreach = settings.outreach || {};
  const limits = settings.limits || {};
  return {
    settings,
    outreach,
    approvalLimit: Math.max(1, Number(limits.dailyEmailLimit || 50)),
    sendLimit: Math.max(1, Math.min(Number(outreach.dailySendLimit || 50), Number(limits.dailyEmailLimit || 50))),
  };
}

function historyFor(workspaceId, draft) {
  const messages = draft.companyId ? listCompanyMessages(workspaceId, draft.companyId, 8) : [];
  const drafts = draft.companyId
    ? listCompanyDraftHistory(workspaceId, draft.companyId, 8).filter((item) => item.id !== draft.id)
    : [];
  const activities = listActivities(workspaceId, { companyId: draft.companyId, pageSize: 10, page: 1, limit: 10 }).items;
  const events = [
    ...messages.map((message) => ({
      kind: 'message',
      id: message.id,
      direction: message.direction,
      title: message.subject || (message.direction === 'inbound' ? '客户来信' : '外发邮件'),
      preview: String(message.bodyText || '').replace(/\s+/g, ' ').slice(0, 240),
      at: message.receivedAt || message.sentAt || message.createdAt,
      status: message.status,
    })),
    ...drafts.map((item) => ({
      kind: 'draft',
      id: item.id,
      status: item.status,
      title: item.subject || '草稿',
      preview: String(item.bodyText || '').replace(/\s+/g, ' ').slice(0, 240),
      at: item.updatedAt || item.createdAt,
    })),
    ...activities.map((activity) => ({
      kind: 'activity',
      id: activity.id,
      type: activity.type,
      title: activity.subject || '销售活动',
      preview: String(activity.body || '').slice(0, 240),
      at: activity.occurredAt,
    })),
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return events.slice(0, 20);
}

// ------------------------------------------------------------------- listing
export function list(workspaceId, filters = {}) {
  const pagination = {
    page: Math.max(1, Number(filters.page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(filters.pageSize) || 25)),
  };
  const result = listDrafts(
    workspaceId,
    {
      status: filters.status || null,
      statuses: filters.statuses || null,
      campaignId: filters.campaignId || null,
      companyId: filters.companyId || null,
      contactId: filters.contactId || null,
      accountId: filters.accountId || null,
      language: filters.language || null,
      search: filters.search || '',
    },
    { page: pagination.page, pageSize: pagination.pageSize, offset: (pagination.page - 1) * pagination.pageSize, limit: pagination.pageSize },
  );
  return result;
}

export function detail(workspaceId, draftId) {
  const draft = requireDraft(workspaceId, draftId);
  const company = draft.companyId ? getCompany(workspaceId, draft.companyId) : null;
  const contact = draft.contactId ? getContact(workspaceId, draft.contactId) : null;
  const sendContext = draft.campaignId ? getCampaignSendContext(workspaceId, draft) : null;
  const product = sendContext?.campaign?.productId
    ? getProduct(workspaceId, sendContext.campaign.productId)
    : draft.companyId
      ? getMatchedProduct(workspaceId, draft.companyId)
      : null;
  const icp = sendContext?.campaign?.icpId ? getIcp(workspaceId, sendContext.campaign.icpId) : company?.icpId ? getIcp(workspaceId, company.icpId) : null;
  const score = draft.companyId
    ? getLatestLeadScore(workspaceId, draft.companyId, product?.id || null)
    : null;
  const automationState = draft.companyId ? getCompanyAutomationState(workspaceId, draft.companyId) : null;
  const suppression = draft.companyId
    ? checkSuppression(workspaceId, { email: contact?.emailNormalized || null, domain: company?.domain || null })
    : { suppressed: false, matches: [] };
  return {
    draft,
    guard: draft.guard,
    quality: draft.quality,
    attachments: draft.attachments,
    company,
    contact,
    campaign: sendContext?.campaign || null,
    step: sendContext?.step || null,
    target: sendContext?.target || null,
    product,
    icp,
    score,
    history: historyFor(workspaceId, draft),
    automationState,
    suppression: { suppressed: suppression.suppressed, matches: suppression.matches },
  };
}

export function pendingApprovals(workspaceId, query = {}) {
  return listPendingApprovals(workspaceId, {
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 25)),
    offset: (Math.max(1, Number(query.page) || 1) - 1) * Math.min(100, Math.max(1, Number(query.pageSize) || 25)),
    limit: Math.min(100, Math.max(1, Number(query.pageSize) || 25)),
    search: query.search || '',
    campaignId: query.campaignId || null,
  });
}

// -------------------------------------------------------------------- writing
export function create(workspaceId, input = {}, actor = {}) {
  const companyId = asString(input.companyId, { required: true, max: 80, label: '企业' });
  const contactId = asString(input.contactId, { required: true, max: 80, label: '联系人' });
  const company = getCompany(workspaceId, companyId);
  if (!company) throw notFound('客户不存在');
  const contact = getContact(workspaceId, contactId);
  if (!contact) throw notFound('联系人不存在');
  if (contact.companyId !== companyId) throw validationError('联系人与企业不匹配');
  const settings = getSettings(workspaceId);
  const language = asString(input.language || settings.outreach?.defaultLanguage || 'en', { max: 20, label: '语言' }).toLowerCase();
  const subject = asString(input.subject || '', { max: 500, label: '主题' });
  const bodyText = asString(input.bodyText || '', { max: 20000, label: '正文' });
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const campaignId = input.campaignId ? asString(input.campaignId, { max: 80 }) : null;
  if (campaignId && !getCampaign(workspaceId, campaignId)) throw notFound('活动不存在');
  const draft = repoCreateDraft(workspaceId, {
    id: id('drf'),
    companyId,
    contactId,
    campaignId,
    campaignStepId: input.campaignStepId ? asString(input.campaignStepId, { max: 80 }) : null,
    accountId: input.accountId ? asString(input.accountId, { max: 80 }) : null,
    subject,
    bodyText,
    language,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'draft.create',
    entityType: 'message_draft',
    entityId: draft.id,
    after: { companyId, contactId, campaignId: draft.campaignId, language },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return draft;
}

export function update(workspaceId, draftId, input = {}, actor = {}) {
  const draft = requireDraft(workspaceId, draftId);
  if (!EDITABLE_STATUSES.includes(draft.status)) throw conflict('当前状态的草稿不能编辑', { code: 'DRAFT_NOT_EDITABLE', status: draft.status });
  const patch = {};
  if (input.subject !== undefined) patch.subject = asString(input.subject, { max: 500, label: '主题' });
  if (input.bodyText !== undefined) patch.bodyText = asString(input.bodyText, { max: 20000, label: '正文' });
  if (input.language !== undefined) patch.language = asString(input.language, { max: 20, label: '语言' }).toLowerCase();
  if (input.accountId !== undefined) patch.accountId = input.accountId ? asString(input.accountId, { max: 80 }) : null;
  if (!Object.keys(patch).length) return draft;
  if (draft.status === 'rejected') {
    patch.status = 'draft';
    patch.rejectionReason = null;
  }
  patch.updatedAt = nowIso();
  const updated = updateDraft(workspaceId, draftId, patch);
  recordAudit({
    workspaceId,
    actorType: normalizeActor(actor).actorType,
    actorId: normalizeActor(actor).actorId,
    action: 'draft.update',
    entityType: 'message_draft',
    entityId: draftId,
    before: { subject: draft.subject, language: draft.language, status: draft.status },
    after: { subject: updated.subject, language: updated.language, status: updated.status },
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
  return updated;
}

// ------------------------------------------------------------------ generation
function buildGenerationContext(workspaceId, draft) {
  const company = getCompany(workspaceId, draft.companyId);
  const contact = getContact(workspaceId, draft.contactId);
  const sendContext = draft.campaignId ? getCampaignSendContext(workspaceId, draft) : null;
  const campaign = sendContext?.campaign || null;
  const step = sendContext?.step || null;
  const product = campaign?.productId ? getProduct(workspaceId, campaign.productId) : getMatchedProduct(workspaceId, draft.companyId);
  const icp = campaign?.icpId ? getIcp(workspaceId, campaign.icpId) : company?.icpId ? getIcp(workspaceId, company.icpId) : null;
  const score = getLatestLeadScore(workspaceId, draft.companyId, product?.id || null);
  const messages = listCompanyMessages(workspaceId, draft.companyId, 5).map((message) => ({
    direction: message.direction,
    subject: message.subject,
    body: String(message.bodyText || '').slice(0, 1200),
    at: message.receivedAt || message.sentAt || message.createdAt,
  }));
  const previousDrafts = listCompanyDraftHistory(workspaceId, draft.companyId, 3).map((item) => ({
    subject: item.subject,
    body: String(item.bodyText || '').slice(0, 1200),
    status: item.status,
    at: item.updatedAt,
  }));
  return {
    company: company
      ? {
          name: company.name,
          domain: company.domain,
          website: company.website,
          country: company.country,
          region: company.region,
          city: company.city,
          industry: company.industry,
          companyType: company.companyType,
          employeeRange: company.employeeRange,
          description: company.description,
          certifications: [],
        }
      : null,
    contact: contact
      ? {
          fullName: contact.fullName,
          firstName: contact.firstName,
          lastName: contact.lastName,
          title: contact.title,
          roleCategory: contact.roleCategory,
          email: contact.email,
          language: contact.language || draft.language,
        }
      : null,
    product: product || null,
    icp: icp || null,
    score: score || null,
    campaign: campaign ? { id: campaign.id, name: campaign.name, goal: campaign.goal, requireApproval: campaign.requireApproval } : null,
    step: step
      ? {
          stepNo: step.stepNo,
          name: step.name,
          subjectTemplate: step.subjectTemplate,
          bodyTemplate: step.bodyTemplate,
          language: step.language,
        }
      : null,
    history: { messages, previousDrafts },
    preferences: getSettings(workspaceId).compliance,
  };
}

function normalizeGeneratedOutput(output, { fallbackLanguage }) {
  const source = output && typeof output === 'object' ? output : {};
  const subject = typeof source.subject === 'string' ? source.subject.trim() : '';
  if (!subject) throw new AppError('AGENT_OUTPUT_INVALID', 'AI 生成的主题为空', { status: 502 });
  if (subject.length > 500) throw new AppError('AGENT_OUTPUT_INVALID', 'AI 生成的主题过长', { status: 502 });
  const bodyCandidate =
    typeof source.body === 'string'
      ? source.body
      : typeof source.bodyText === 'string'
        ? source.bodyText
        : typeof source.body_text === 'string'
          ? source.body_text
          : '';
  const bodyText = bodyCandidate.trim();
  if (bodyText.length < 20) throw new AppError('AGENT_OUTPUT_INVALID', 'AI 生成的正文为空或过短', { status: 502 });
  if (bodyText.length > 20000) throw new AppError('AGENT_OUTPUT_INVALID', 'AI 生成的正文过长', { status: 502 });
  const languageRaw = typeof source.language === 'string' ? source.language.trim().toLowerCase() : fallbackLanguage;
  const language = /^[a-z]{2}(-[a-z]{2})?$/.test(languageRaw) ? languageRaw : fallbackLanguage;
  const claims = Array.isArray(source.claims) ? source.claims.slice(0, 30) : [];
  const riskNotes = Array.isArray(source.riskNotes) ? source.riskNotes.slice(0, 30) : [];
  const personalizationPoints = Array.isArray(source.personalizationPoints) ? source.personalizationPoints.slice(0, 30) : [];
  const quality =
    source.quality && typeof source.quality === 'object'
      ? source.quality
      : source.qualityJson && typeof source.qualityJson === 'object'
        ? source.qualityJson
        : { claims, personalizationPoints, riskNotes, source: 'outreach_writer' };
  const guard =
    source.guard && typeof source.guard === 'object'
      ? source.guard
      : source.guardJson && typeof source.guardJson === 'object'
        ? source.guardJson
        : { riskNotes, hasRiskNotes: riskNotes.length > 0, claimsUsed: claims.length, source: 'outreach_writer' };
  return {
    subject,
    bodyText,
    language,
    quality,
    guard,
    executionId: source.executionId || source.execution_id || source.agentExecutionId || null,
  };
}

/**
 * Deterministic fallback used only when the configured model is unavailable.
 * It never invents certifications, prices or customer facts; it simply turns
 * the product/company facts already in the workspace into a reviewable draft.
 */
function buildTemplateDraft(context, language) {
  const company = context.company || {};
  const product = context.product || {};
  const contact = context.contact || {};
  const recipient = contact.fullName || contact.firstName || 'Purchasing Team';
  const productName = product.name || 'our product';
  const companyName = company.name || 'your company';
  const applications = Array.isArray(product.applications) && product.applications.length
    ? product.applications.slice(0, 3).join(', ')
    : null;
  const german = String(language || '').toLowerCase().startsWith('de');
  const subject = german
    ? `Anfrage: ${productName} – mögliche Zusammenarbeit mit ${companyName}`
    : `Partnership inquiry: ${productName} for ${companyName}`;
  const body = german
    ? `Guten Tag ${recipient},\n\nwir haben ${companyName} als möglichen Partner im Bereich ${company.industry || 'B2B'} gefunden.\n\nWir liefern ${productName}${applications ? ` für ${applications}` : ''}. Wenn Sie Interesse an einer möglichen Zusammenarbeit haben, senden wir Ihnen gerne weitere Informationen und ein unverbindliches Angebot.\n\nMit freundlichen Grüßen`
    : `Hello ${recipient},\n\nWe found ${companyName} while researching potential B2B partners${company.industry ? ` in ${company.industry}` : ''}.\n\nWe supply ${productName}${applications ? ` for ${applications}` : ''}. If this is relevant, we would be happy to send more information and a non-binding quotation.\n\nBest regards`;
  return {
    subject,
    bodyText: body,
    language: german ? 'de' : String(language || 'en'),
    quality: { score: 45, notes: ['model_unavailable_template_fallback'] },
    guard: {},
    templateFallback: true,
  };
}

/**
 * Contract 7.2: generate a personalised outreach draft for an existing draft
 * row. Loads company facts + product + ICP + campaign step + history, calls the
 * agent layer and persists the validated result.
 */
export async function generateDraft({ workspaceId, draftId, actorType = 'system', actorId = null }) {
  const draft = requireDraft(workspaceId, draftId);
  if (['sent', 'scheduled'].includes(draft.status)) throw conflict('已发送或已排队的草稿不能重新生成');
  const settings = getSettings(workspaceId);
  const context = buildGenerationContext(workspaceId, draft);
  const language = context.step?.language || draft.language || settings.outreach?.defaultLanguage || 'en';
  // Product PDFs: load before the model call so the writer can reference the
  // public links in the body. Missing media never blocks generation. The AI is
  // given absolute URLs because relative paths are not clickable in emails.
  const attachments = await loadProductAttachments(workspaceId, context.product?.id || null);
  context.productFiles = attachments.map((attachment) => ({
    filename: attachment.filename,
    publicUrl: absolutePublicUrl(attachment.publicUrl),
  }));
  const startedAt = nowIso();
  let templateFallback = false;
  let normalized;
  try {
    const output = await callAgent('generateOutreachDraft', { workspaceId, context, language });
    normalized = normalizeGeneratedOutput(output, { fallbackLanguage: language });
    normalized.templateFallback = false;
  } catch (error) {
    if (process.env.DRAFT_TEMPLATE_FALLBACK !== '1') throw error;
    normalized = buildTemplateDraft(context, language);
    templateFallback = true;
  }
  const requireApproval = context.campaign ? context.campaign.requireApproval !== false : Boolean(settings.outreach?.requireApproval ?? true);
  const nextStatus = requireApproval ? 'pending_approval' : 'approved';
  const candidateExecutionId = normalized.executionId || latestAgentExecutionId(workspaceId, 'outreach_writer', startedAt);
  const generatedBy = agentExecutionExists(candidateExecutionId) ? candidateExecutionId : null;
  // Only reached after a successful, validated generation: attachments are
  // always overwritten (including []) so a failed/older run cannot leak stale PDFs.
  const updated = updateDraft(workspaceId, draftId, {
    subject: normalized.subject,
    bodyText: normalized.bodyText,
    language: normalized.language,
    status: nextStatus,
    generatedBy,
    quality: normalized.quality,
    guard: normalized.guard,
    attachments,
    rejectionReason: null,
    updatedAt: nowIso(),
  });
  recordAudit({
    workspaceId,
    actorType: auditActorType(actorType),
    actorId,
    action: 'draft.generate',
    entityType: 'message_draft',
    entityId: draftId,
    before: { subject: draft.subject, status: draft.status, language: draft.language },
    after: {
      subject: updated.subject,
      status: updated.status,
      language: updated.language,
      quality: normalized.quality,
      guard: normalized.guard,
      agentExecutionId: generatedBy,
      templateFallback,
      attachmentCount: attachments.length,
      attachmentFilenames: attachments.map((attachment) => attachment.filename),
    },
  });
  return { draft: updated };
}

// ------------------------------------------------------------------ approvals
export function approveDraft(workspaceId, draftId, actor = {}) {
  const draft = requireDraft(workspaceId, draftId);
  if (draft.status === 'approved') return draft;
  if (!APPROVABLE_STATUSES.includes(draft.status)) {
    throw conflict('当前状态的草稿不能审批', { code: 'APPROVAL_NOT_ALLOWED', status: draft.status });
  }
  if (!draft.subject || !draft.bodyText.trim()) throw validationError('草稿主题或正文为空，不能审批');
  const automation = getCompanyAutomationState(workspaceId, draft.companyId);
  if (['DO_NOT_CONTACT', 'CLOSED'].includes(automation.state)) {
    throw conflict('该客户处于禁止联系或已关闭状态，不能审批草稿', { code: 'AUTOMATION_BLOCKED', state: automation.state });
  }
  const contact = getContact(workspaceId, draft.contactId);
  const company = getCompany(workspaceId, draft.companyId);
  const suppression = checkSuppression(workspaceId, { email: contact?.emailNormalized || null, domain: company?.domain || null });
  if (suppression.suppressed) {
    throw conflict('该收件人已在禁止联系名单中，不能审批草稿', { code: 'RECIPIENT_SUPPRESSED' });
  }
  const { approvalLimit } = sendLimits(workspaceId);
  const approvedToday = countApprovedSince(workspaceId, dayStartIso());
  if (approvedToday >= approvalLimit) {
    throw new AppError('DAILY_LIMIT_REACHED', `今日审批数量已达上限（${approvalLimit}）`, { status: 429 });
  }
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const updated = updateDraft(workspaceId, draftId, {
    status: 'approved',
    approvedBy: actorInfo.actorId,
    approvedAt: now,
    rejectionReason: null,
    updatedAt: now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'draft.approve',
    entityType: 'message_draft',
    entityId: draftId,
    before: { status: draft.status },
    after: { status: 'approved', approvedBy: actorInfo.actorId },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return updated;
}

export function rejectDraft(workspaceId, draftId, { reason = '' } = {}, actor = {}) {
  const draft = requireDraft(workspaceId, draftId);
  if (!['pending_approval', 'draft', 'approved'].includes(draft.status)) {
    throw conflict('当前状态的草稿不能驳回', { code: 'REJECT_NOT_ALLOWED', status: draft.status });
  }
  const rejectionReason = asString(reason || '未通过审批', { max: 1000, label: '驳回原因' });
  const actorInfo = normalizeActor(actor);
  const updated = updateDraft(workspaceId, draftId, {
    status: 'rejected',
    rejectionReason,
    approvedBy: null,
    approvedAt: null,
    updatedAt: nowIso(),
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'draft.reject',
    entityType: 'message_draft',
    entityId: draftId,
    before: { status: draft.status },
    after: { status: 'rejected', reason: rejectionReason },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return updated;
}

export function batchApprove(workspaceId, draftIds = [], actor = {}) {
  if (!Array.isArray(draftIds) || !draftIds.length) throw validationError('请选择要审批的草稿');
  if (draftIds.length > 100) throw validationError('一次最多审批 100 条草稿');
  const approved = [];
  const failed = [];
  for (const draftId of [...new Set(draftIds)]) {
    try {
      approved.push(approveDraft(workspaceId, asString(draftId, { max: 80 }), actor));
    } catch (error) {
      failed.push({ draftId, code: error?.code || 'ERROR', message: error?.message || '审批失败' });
    }
  }
  return { approved: approved.map((draft) => ({ id: draft.id, status: draft.status })), failed };
}

// -------------------------------------------------------------------- sending
/**
 * Queue an already-approved draft for `email.send`. Performs the outbound
 * safety checks (status, suppression, automation state, campaign status, daily
 * limits) and marks the draft as scheduled. Shared by the drafts and inbox
 * routes.
 */
export async function enqueueDraftSend(workspaceId, draftId, actor = {}, { manual = false } = {}) {
  const draft = requireDraft(workspaceId, draftId);
  if (draft.status === 'scheduled') throw conflict('该草稿已在发送队列中', { code: 'DRAFT_ALREADY_QUEUED' });
  if (draft.status !== 'approved') throw conflict('草稿未审批，不能发送', { code: 'DRAFT_NOT_APPROVED', status: draft.status });
  const company = getCompany(workspaceId, draft.companyId);
  if (!company) throw notFound('客户不存在');
  const contact = getContact(workspaceId, draft.contactId);
  if (!contact) throw notFound('联系人不存在');
  if (!contact.emailNormalized) throw validationError('联系人缺少有效邮箱，不能发送');
  if (manual) {
    // A human reply is always allowed (even under HUMAN_TAKEOVER / PAUSED /
    // NEEDS_HUMAN_REVIEW) but never to a do-not-contact / closed customer.
    const state = getCompanyAutomationState(workspaceId, draft.companyId);
    if (['DO_NOT_CONTACT', 'CLOSED'].includes(state.state)) {
      throw conflict('该客户处于禁止联系或已关闭状态，不能发送', { code: 'AUTOMATION_BLOCKED', state: state.state });
    }
  } else {
    assertCompanySendable(workspaceId, draft.companyId);
  }
  checkSuppressionOrThrow(workspaceId, { email: contact.emailNormalized, domain: company.domain });
  const { sendLimit } = sendLimits(workspaceId);
  if (draft.campaignId) {
    const campaign = getCampaignSendContext(workspaceId, draft)?.campaign;
    if (!campaign) throw notFound('活动不存在');
    if (campaign.status !== 'active') throw conflict('活动未启用，不能发送该草稿', { code: 'CAMPAIGN_NOT_ACTIVE', status: campaign.status });
  }
  const since = dayStartIso();
  const sentToday = countOutboundSentSince(workspaceId, since);
  const queuedToday = countScheduledSince(workspaceId, since);
  if (sentToday + queuedToday >= sendLimit) {
    throw new AppError('DAILY_LIMIT_REACHED', `今日发送数量已达上限（${sendLimit}）`, { status: 429 });
  }
  let accountId = draft.accountId;
  if (accountId) {
    const account = getAccount(workspaceId, accountId);
    if (!account) throw notFound('邮箱账户不存在');
    if (account.status !== 'active') throw conflict('邮箱账户不可用', { code: 'ACCOUNT_UNAVAILABLE' });
  } else {
    const fallback = getActiveAccount(workspaceId);
    accountId = fallback?.id ?? null;
  }
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const updated = updateDraft(workspaceId, draftId, {
    status: 'scheduled',
    scheduledAt: now,
    accountId,
    updatedAt: now,
  });
  const queueResult = await enqueueJobSafe({
    workspaceId,
    type: 'email.send',
    payload: { draftId, trigger: manual ? 'manual_reply' : 'manual_approved' },
    dedupeKey: `email.send:${workspaceId}:${draftId}`,
    priority: 50,
    createdBy: actorInfo.actorId,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'draft.send_queued',
    entityType: 'message_draft',
    entityId: draftId,
    before: { status: draft.status },
    after: {
      status: 'scheduled',
      accountId,
      campaignId: draft.campaignId,
      queued: queueResult.queued,
      jobId: queueResult.jobId,
      queueError: queueResult.error,
    },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return { draft: updated, queued: queueResult.queued, jobId: queueResult.jobId, queueError: queueResult.error };
}

function checkSuppressionOrThrow(workspaceId, { email, domain }) {
  const suppression = checkSuppression(workspaceId, { email, domain });
  if (suppression.suppressed) {
    throw conflict('该收件人已在禁止联系名单中，不能发送', { code: 'RECIPIENT_SUPPRESSED' });
  }
}

export async function sendDraft(workspaceId, draftId, actor = {}) {
  return enqueueDraftSend(workspaceId, draftId, actor);
}

/** Create an approved human reply draft from the inbox and queue it. */
export async function createApprovedReplyDraft(workspaceId, { companyId, contactId, campaignId = null, accountId = null, subject, bodyText, language = 'en' }, actor = {}) {
  const actorInfo = normalizeActor(actor);
  const now = nowIso();
  const draft = repoCreateDraft(workspaceId, {
    id: id('drf'),
    companyId,
    contactId,
    campaignId,
    accountId,
    subject,
    bodyText,
    language,
    status: 'approved',
    approvedBy: actorInfo.actorId,
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  recordAudit({
    workspaceId,
    actorType: actorInfo.actorType,
    actorId: actorInfo.actorId,
    action: 'draft.create',
    entityType: 'message_draft',
    entityId: draft.id,
    after: { companyId, contactId, source: 'inbox_reply', language },
    ip: actorInfo.ip,
    userAgent: actorInfo.userAgent,
    requestId: actorInfo.requestId,
  });
  return draft;
}

export default {
  DRAFT_STATUSES,
  list,
  detail,
  pendingApprovals,
  create,
  update,
  generateDraft,
  approveDraft,
  rejectDraft,
  batchApprove,
  sendDraft,
  enqueueDraftSend,
  createApprovedReplyDraft,
};
