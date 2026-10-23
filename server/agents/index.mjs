/**
 * Public API of the agent layer.
 *
 * Other modules (t-crm services, t-worker jobs, HTTP routes) must import from
 * this file only — never from internals — to avoid circular dependencies:
 *
 *   import { runAgent, generateOutreachDraft, AGENT_CATALOG } from '../agents/index.mjs';
 *
 * Prompt bodies and output schemas are internal assets; only the catalogue is
 * browser-safe.
 */
import { AGENT_CATALOG } from './catalog.mjs';
import { runAgent } from './runner.mjs';
import { getProviderInfo, testProvider } from './providers/index.mjs';

export { AGENT_ROLES, WORKER_ROLES, isAgentRole } from './roles.mjs';
export { AGENT_CATALOG, getAgent } from './catalog.mjs';
export { OUTPUT_SCHEMAS, CLASSIFICATION_LABELS, QUALIFICATION_GRADES, getOutputSchema } from './schemas.mjs';
export { parseJsonOutput, validateOutput } from './schema.mjs';
export { runAgent, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from './runner.mjs';
export { resolveProvider, getProviderInfo, testProvider } from './providers/index.mjs';
export { EXECUTION_STATUSES, getExecution, listExecutions } from './executions.mjs';

/**
 * Minimal context assembled for each role. Callers (t-crm, t-worker) may pass
 * a wide object; only these fields are forwarded to the model, which keeps
 * tokens/cost low and prevents accidental bulk data exfiltration.
 */
const CONTEXT_KEYS = Object.freeze({
  orchestrator: ['goal', 'context'],
  market_research: ['objective', 'icp', 'countries', 'keywords', 'existingCompanies', 'locale'],
  company_qualification: ['company', 'icp', 'product', 'signals', 'sources'],
  contact_research: ['company', 'icp', 'existingContacts', 'locale'],
  product_matching: ['company', 'product', 'products', 'icp', 'signals'],
  outreach_writer: [
    'company',
    'contact',
    'product',
    'products',
    'icp',
    'facts',
    'sender',
    'signature',
    'campaign',
    'campaignStep',
    'step',
    'preferences',
    'settings',
    'compliance',
    'productFiles',
    'history',
    'score',
    'includeUnsubscribe',
    'locale',
  ],
  reply_classification: ['message', 'thread', 'company', 'contact', 'history', 'focusMessageId', 'locale'],
  follow_up_planning: [
    'thread',
    'message',
    'messages',
    'classification',
    'history',
    'company',
    'contact',
    'focusMessageId',
    'today',
    'locale',
  ],
  compliance_guard: [
    'draft',
    'email',
    'message',
    'contact',
    'company',
    'settings',
    'preferences',
    'suppression',
    'suppressions',
    'suppressionMatches',
    'suppressionHit',
    'automationState',
    'automation',
    'includeUnsubscribe',
    'requireLegalBasis',
    'legalBasis',
    'locale',
  ],
  quality_review: [
    'draft',
    'email',
    'message',
    'claims',
    'product',
    'company',
    'campaign',
    'campaignStep',
    'step',
    'sender',
    'preferences',
    'language',
    'locale',
  ],
  keyword_research: ['product', 'products', 'icp', 'company', 'locale'],
});

function clampValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clampValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) out[key] = clampValue(item, depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  return value;
}

/** Build the minimal, size-capped model input for one role. */
export function prepareAgentContext(role, context = {}) {
  const source = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const allowed = CONTEXT_KEYS[role];
  if (!allowed) return clampValue(source);
  const out = {};
  for (const key of allowed) {
    if (source[key] !== undefined && source[key] !== null) out[key] = clampValue(source[key]);
  }
  return out;
}

function createConvenience(role) {
  return async function runConvenience({ workspaceId, context = {}, language, actorType = 'system', actorId = null, jobId = null, createdBy = null } = {}) {
    const input = prepareAgentContext(role, context);
    if (language) input.language = String(language).slice(0, 10).toLowerCase();
    const result = await runAgent({ workspaceId, role, input, actorType, actorId, jobId, createdBy });
    return result.output;
  };
}

// ------------------------------------------------ convenience functions (7.3)
export const generateOutreachDraft = createConvenience('outreach_writer');
export const qualifyCompany = createConvenience('company_qualification');
export const classifyReply = createConvenience('reply_classification');
export const planFollowUp = createConvenience('follow_up_planning');
export const companyResearch = createConvenience('market_research');
export const matchProduct = createConvenience('product_matching');
export const complianceCheck = createConvenience('compliance_guard');
export const reviewQuality = createConvenience('quality_review');

/**
 * v1.1: generate English B2B discovery keywords for one product.
 * Writes agent_executions / usage_records like every other convenience helper.
 * @returns {Promise<{keywords:string[], negativeKeywords:string[], searchQueries:string[], notes:string}>}
 */
export async function generateProductKeywords({
  workspaceId,
  product = {},
  actorType = 'system',
  actorId = null,
  jobId = null,
  createdBy = null,
  locale = null,
} = {}) {
  const input = { product: clampValue(product && typeof product === 'object' ? product : {}) };
  if (locale) input.locale = String(locale).slice(0, 12);
  const result = await runAgent({ workspaceId, role: 'keyword_research', input, actorType, actorId, jobId, createdBy });
  return result.output;
}

/** Optional orchestrator helper (declared in the catalogue, not required by 7.3). */
export async function orchestratePlan({ workspaceId, goal, context = {}, actorType = 'system', actorId = null, jobId = null, createdBy = null } = {}) {
  const input = prepareAgentContext('orchestrator', { goal, context });
  const result = await runAgent({ workspaceId, role: 'orchestrator', input, actorType, actorId, jobId, createdBy });
  return result.output;
}

export const CONVENIENCE_ROLES = Object.freeze({
  generateOutreachDraft: 'outreach_writer',
  qualifyCompany: 'company_qualification',
  classifyReply: 'reply_classification',
  planFollowUp: 'follow_up_planning',
  companyResearch: 'market_research',
  matchProduct: 'product_matching',
  complianceCheck: 'compliance_guard',
  reviewQuality: 'quality_review',
  generateProductKeywords: 'keyword_research',
});

export default {
  AGENT_CATALOG,
  runAgent,
  testProvider,
  getProviderInfo,
  generateOutreachDraft,
  qualifyCompany,
  classifyReply,
  planFollowUp,
  companyResearch,
  matchProduct,
  complianceCheck,
  reviewQuality,
  generateProductKeywords,
  orchestratePlan,
};
