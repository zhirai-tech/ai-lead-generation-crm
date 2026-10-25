/**
 * Output schemas for the ten agent roles.
 *
 * The runner validates every model response against these definitions before
 * an execution is marked succeeded, so a model that ignores the contract can
 * never write an unstable structure into the database or the UI.
 *
 * Supported schema nodes (validated by `schema.mjs`):
 *   object / array / string (enum, minLength, maxLength) /
 *   integer (minimum, maximum) / number (minimum, maximum) / boolean
 */
import { WORKER_ROLES } from './roles.mjs';

export const CLASSIFICATION_LABELS = Object.freeze([
  'positive_interest',
  'price_inquiry',
  'quote_request',
  'sample_request',
  'technical_question',
  'follow_up_needed',
  'no_need_now',
  'rejection',
  'unsubscribe',
  'auto_reply',
  'unknown',
]);

export const QUALIFICATION_GRADES = Object.freeze(['A', 'B', 'C', 'D']);
export const EVIDENCE_KINDS = Object.freeze(['fact', 'inference', 'unknown']);
export const RULE_SEVERITIES = Object.freeze(['blocker', 'warning']);
export const FOLLOWUP_PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const QUALITY_VERDICTS = Object.freeze(['pass', 'revise', 'reject']);
export const ISSUE_SEVERITIES = Object.freeze(['low', 'medium', 'high']);

// ----------------------------------------------------------- node builders
const text = (maxLength = 500, minLength = 1) => ({ type: 'string', minLength, maxLength });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const enumOf = (values, maxLength = 100) => ({ type: 'string', enum: [...values], maxLength });
const list = (items, maxItems = 20, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

const evidenceItem = object({
  field: text(120),
  value: text(500),
  source: text(300),
  kind: enumOf(EVIDENCE_KINDS, 20),
});

// -------------------------------------------------------------- role schemas
export const OUTPUT_SCHEMAS = Object.freeze({
  orchestrator: object({
    objective: text(2000),
    steps: list(
      object(
        {
          order: integer(1, 20),
          role: enumOf(WORKER_ROLES, 40),
          title: text(200),
          rationale: text(1000),
          dependsOn: list(integer(1, 20), 10),
        },
        ['order', 'role', 'title', 'rationale'],
      ),
      10,
      1,
    ),
    assumptions: list(text(500), 20),
    risks: list(text(500), 20),
  }),

  market_research: object({
    searchStrategies: list(
      object({
        name: text(120),
        query: text(500),
        sources: list(text(200), 10),
        signals: list(text(200), 10),
      }),
      10,
      1,
    ),
    targetSegments: list(
      object({
        segment: text(200),
        rationale: text(1000),
        keywords: list(text(120), 20),
      }),
      10,
    ),
    exclusions: list(text(300), 20),
    unknowns: list(text(300), 20),
    notes: text(2000),
  }),

  company_qualification: object({
    score: integer(0, 100),
    grade: enumOf(QUALIFICATION_GRADES, 2),
    factors: list(
      object({
        name: text(120),
        impact: integer(-50, 50),
        kind: enumOf(EVIDENCE_KINDS, 20),
        evidence: text(500),
      }),
      20,
      1,
    ),
    exclusions: list(
      object({
        reason: text(500),
        severity: enumOf(RULE_SEVERITIES, 20),
      }),
      10,
    ),
    evidence: list(evidenceItem, 20),
    summary: text(2000),
    confidence: number(0, 1),
  }),

  contact_research: object({
    targetRoles: list(
      object({
        role: text(120),
        department: text(120),
        priority: integer(1, 5),
        reason: text(500),
      }),
      10,
      1,
    ),
    departments: list(text(120), 10),
    prioritizedTitles: list(text(200), 15),
    searchApproaches: list(text(300), 10),
    unknowns: list(text(300), 20),
    notes: text(2000),
  }),

  product_matching: object({
    matches: list(
      object({
        productRef: text(200),
        matchScore: integer(0, 100),
        useCase: text(500),
        rationale: text(1000),
        evidence: list(text(500), 10),
      }),
      10,
      1,
    ),
    recommendedRef: text(200),
    notes: text(2000),
    unknowns: list(text(300), 20),
  }),

  outreach_writer: object({
    subject: text(300),
    body: text(6000),
    language: text(10),
    claims: list(
      object({
        text: text(300),
        source: text(300),
      }),
      20,
    ),
    riskNotes: list(text(500), 20),
    personalizationPoints: list(text(300), 20),
  }),

  reply_classification: object({
    label: enumOf(CLASSIFICATION_LABELS, 40),
    confidence: number(0, 1),
    intentScore: integer(0, 100),
    evidence: list(
      object({
        quote: text(500, 0),
        explanation: text(500),
      }),
      10,
    ),
    rationale: text(2000),
    suggestedReply: text(4000, 0),
    nextAction: text(300, 0),
  }),

  follow_up_planning: object({
    nextStep: text(300),
    dueInDays: integer(0, 60),
    taskTitle: text(200),
    draftHint: text(2000),
    priority: enumOf(FOLLOWUP_PRIORITIES, 20),
    rationale: text(2000),
  }),

  compliance_guard: object({
    allowed: { type: 'boolean' },
    blockers: list(
      object({
        code: text(60),
        message: text(500),
      }),
      10,
    ),
    warnings: list(
      object({
        code: text(60),
        message: text(500),
      }),
      10,
    ),
    requiredActions: list(text(300), 20),
    checkedItems: list(text(200), 20),
  }),

  quality_review: object({
    verdict: enumOf(QUALITY_VERDICTS, 20),
    score: integer(0, 100),
    issues: list(
      object({
        severity: enumOf(ISSUE_SEVERITIES, 20),
        category: text(80),
        message: text(500),
        suggestion: text(500),
      }),
      20,
    ),
    strengths: list(text(300), 20),
    summary: text(2000),
  }),

  // v1.1: product keyword expansion for lead discovery (see
  // docs/MEDIA-ATTACHMENTS-CONTRACT.md section 2).
  keyword_research: object({
    keywords: list(text(80), 30),
    negativeKeywords: list(text(80), 15),
    searchQueries: list(text(200), 10),
    notes: text(1000),
  }),

  // Internal Phase-1 role: one bounded read-only action per model decision.
  tool_agent: object({
    action: enumOf(['call_tool', 'finish'], 20),
    tool: enumOf(['company.list', 'company.get', 'company.evidence', 'browser.search'], 40),
    reason: text(1000),
    arguments: object({
      q: text(200, 0),
      country: text(2, 0),
      status: text(40, 0),
      hasEmail: { type: 'boolean' },
      hasPhone: { type: 'boolean' },
      pageSize: integer(1, 50),
      companyId: text(120, 0),
      query: text(500, 0),
      engine: enumOf(['duckduckgo', 'bing'], 20),
      maxResults: integer(1, 10),
    }, []),
    answer: text(4000, 0),
  }, ['action', 'reason']),
});

export function getOutputSchema(role) {
  return OUTPUT_SCHEMAS[role] || null;
}

export default { OUTPUT_SCHEMAS, CLASSIFICATION_LABELS, QUALIFICATION_GRADES, getOutputSchema };
