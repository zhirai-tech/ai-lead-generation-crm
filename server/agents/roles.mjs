/**
 * Agent role identifiers.
 *
 * This list is the single whitelist used by the HTTP route, the execution log,
 * the prompt loader and the output schemas. Keep it in sync with
 * `server/agents/prompts/*.md`.
 */
export const AGENT_ROLES = Object.freeze([
  'orchestrator',
  'market_research',
  'company_qualification',
  'contact_research',
  'product_matching',
  'outreach_writer',
  'reply_classification',
  'follow_up_planning',
  'compliance_guard',
  'quality_review',
]);

/** Roles a plan may delegate to (everything except the orchestrator itself). */
export const WORKER_ROLES = Object.freeze(AGENT_ROLES.filter((role) => role !== 'orchestrator'));

export function isAgentRole(value) {
  return typeof value === 'string' && AGENT_ROLES.includes(value);
}

export default { AGENT_ROLES, WORKER_ROLES, isAgentRole };
