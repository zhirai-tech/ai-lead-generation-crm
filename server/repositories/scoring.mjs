/** Rule-based lead scoring and product-match persistence. */
import { all, get, run } from '../core/db.mjs';
import { jsonArray } from './helpers.mjs';

function parseJsonSafe(value, fallback) {
  try {
    return JSON.parse(value ?? '');
  } catch {
    return fallback;
  }
}

export function mapLeadScore(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    productId: row.product_id,
    productName: row.product_name || null,
    score: row.score,
    grade: row.grade,
    factors: jsonArray(row.factors_json),
    exclusions: jsonArray(row.exclusions_json),
    explanation: row.explanation || null,
    modelVersion: row.model_version,
    scoredAt: row.scored_at,
  };
}

export function findLeadScore(workspaceId, companyId, productId) {
  return mapLeadScore(
    get(
      `SELECT s.*, p.name AS product_name FROM lead_scores s
         LEFT JOIN products p ON p.id = s.product_id AND p.workspace_id = s.workspace_id
        WHERE s.workspace_id = ? AND s.company_id = ? AND s.product_id = ?`,
      [workspaceId, companyId, productId],
    ),
  );
}

export function listLeadScoresForCompany(workspaceId, companyId) {
  return all(
    `SELECT s.*, p.name AS product_name FROM lead_scores s
       LEFT JOIN products p ON p.id = s.product_id AND p.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.company_id = ? ORDER BY s.score DESC`,
    [workspaceId, companyId],
  ).map(mapLeadScore);
}

export function upsertLeadScore(data) {
  run(
    `INSERT INTO lead_scores (id, workspace_id, company_id, product_id, score, grade, factors_json, exclusions_json, explanation, model_version, scored_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, company_id, product_id) DO UPDATE SET
       score = excluded.score,
       grade = excluded.grade,
       factors_json = excluded.factors_json,
       exclusions_json = excluded.exclusions_json,
       explanation = excluded.explanation,
       model_version = excluded.model_version,
       scored_at = excluded.scored_at`,
    [
      data.id,
      data.workspace_id,
      data.company_id,
      data.product_id,
      data.score,
      data.grade,
      JSON.stringify(data.factors || []),
      JSON.stringify(data.exclusions || []),
      data.explanation || null,
      data.model_version || 'rules-v1',
      data.scored_at,
      data.scored_at,
    ],
  );
  return findLeadScore(data.workspace_id, data.company_id, data.product_id);
}

// ---------------------------------------------------------------- matches
export function mapMatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    productId: row.product_id,
    productName: row.product_name || null,
    matchScore: row.match_score,
    reasons: jsonArray(row.reasons_json),
    evidence: jsonArray(row.evidence_json),
    status: row.status,
    matchedBy: row.matched_by,
    reviewedBy: row.reviewed_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findMatch(workspaceId, companyId, productId) {
  return mapMatch(
    get(
      `SELECT m.*, p.name AS product_name FROM company_product_matches m
         LEFT JOIN products p ON p.id = m.product_id AND p.workspace_id = m.workspace_id
        WHERE m.workspace_id = ? AND m.company_id = ? AND m.product_id = ?`,
      [workspaceId, companyId, productId],
    ),
  );
}

export function listMatchesForCompany(workspaceId, companyId) {
  return all(
    `SELECT m.*, p.name AS product_name FROM company_product_matches m
       LEFT JOIN products p ON p.id = m.product_id AND p.workspace_id = m.workspace_id
      WHERE m.workspace_id = ? AND m.company_id = ? ORDER BY m.match_score DESC`,
    [workspaceId, companyId],
  ).map(mapMatch);
}

/**
 * Upsert a suggested rule match. A user decision (confirmed/rejected) is never
 * overwritten by a later automatic scoring pass.
 */
export function upsertSuggestedMatch(data) {
  const existing = findMatch(data.workspace_id, data.company_id, data.product_id);
  const now = data.updated_at;
  if (existing) {
    run(
      `UPDATE company_product_matches
          SET match_score = ?, reasons_json = ?, evidence_json = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
      [data.match_score, JSON.stringify(data.reasons || []), JSON.stringify(data.evidence || []), now, existing.id, data.workspace_id],
    );
    return findMatch(data.workspace_id, data.company_id, data.product_id);
  }
  run(
    `INSERT INTO company_product_matches (id, workspace_id, company_id, product_id, match_score, reasons_json, evidence_json, status, matched_by, reviewed_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', 'rule', NULL, ?, ?)`,
    [
      data.id,
      data.workspace_id,
      data.company_id,
      data.product_id,
      data.match_score,
      JSON.stringify(data.reasons || []),
      JSON.stringify(data.evidence || []),
      now,
      now,
    ],
  );
  return findMatch(data.workspace_id, data.company_id, data.product_id);
}

export function updateMatchStatus(workspaceId, matchId, { status, reviewedBy }) {
  const now = new Date().toISOString();
  run(
    'UPDATE company_product_matches SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    [status, reviewedBy || null, now, matchId, workspaceId],
  );
  return mapMatch(
    get(
      `SELECT m.*, p.name AS product_name FROM company_product_matches m
         LEFT JOIN products p ON p.id = m.product_id AND p.workspace_id = m.workspace_id
        WHERE m.id = ? AND m.workspace_id = ?`,
      [matchId, workspaceId],
    ),
  );
}

// --------------------------------------------------------------- feedback
export function insertScoreFeedback(data) {
  run(
    `INSERT INTO score_feedback (id, workspace_id, company_id, product_id, field, ai_value_json, user_value_json, reason, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.workspace_id,
      data.company_id,
      data.product_id || null,
      data.field,
      JSON.stringify(data.ai_value ?? null),
      JSON.stringify(data.user_value ?? null),
      data.reason || null,
      data.user_id || null,
      data.created_at,
    ],
  );
  return data.id;
}

export function listScoreFeedbackForCompany(workspaceId, companyId, { limit = 50 } = {}) {
  return all(
    `SELECT * FROM score_feedback WHERE workspace_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, companyId, limit],
  ).map((row) => ({
    id: row.id,
    productId: row.product_id || null,
    field: row.field,
    aiValue: parseJsonSafe(row.ai_value_json, null),
    userValue: parseJsonSafe(row.user_value_json, null),
    reason: row.reason || null,
    userId: row.user_id || null,
    createdAt: row.created_at,
  }));
}
