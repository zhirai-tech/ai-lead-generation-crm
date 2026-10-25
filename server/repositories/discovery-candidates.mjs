/** Candidate-level discovery audit repository. */
import { all, get, json, run } from '../core/db.mjs';
import { paged } from './helpers.mjs';

function parseJsonSafe(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

export function mapCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    query: row.query || null,
    rawUrl: row.raw_url || null,
    normalizedUrl: row.normalized_url || null,
    title: row.title || null,
    stage: row.stage,
    outcome: row.outcome,
    reasonCode: row.reason_code || null,
    identityKeys: parseJsonSafe(row.identity_keys_json, []),
    matchedCompanyId: row.matched_company_id || null,
    duplicateOfCandidateId: row.duplicate_of_candidate_id || null,
    websiteCheckStatus: row.website_check_status || null,
    qualification: row.qualification || null,
    qualificationReason: row.qualification_reason || null,
    evidenceUrls: parseJsonSafe(row.evidence_urls_json, []),
    evidenceExcerpt: row.evidence_excerpt || null,
    savedCompanyId: row.saved_company_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertCandidate(data) {
  run(
    `INSERT INTO discovery_candidates
      (id, workspace_id, run_id, query, raw_url, normalized_url, title, stage, outcome, reason_code,
       identity_keys_json, matched_company_id, duplicate_of_candidate_id, website_check_status,
       qualification, qualification_reason, evidence_urls_json, evidence_excerpt, saved_company_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id, data.workspaceId, data.runId, data.query || null, data.rawUrl || null, data.normalizedUrl || null,
      data.title || null, data.stage, data.outcome, data.reasonCode || null,
      json(Array.isArray(data.identityKeys) ? data.identityKeys : []),
      data.matchedCompanyId || null, data.duplicateOfCandidateId || null, data.websiteCheckStatus || null,
      data.qualification || null, data.qualificationReason || null,
      json(Array.isArray(data.evidenceUrls) ? data.evidenceUrls : []),
      data.evidenceExcerpt ? String(data.evidenceExcerpt).slice(0, 2000) : null,
      data.savedCompanyId || null, data.createdAt, data.updatedAt,
    ],
  );
  return findCandidate(data.workspaceId, data.id);
}

const UPDATE_COLUMNS = new Set([
  'stage', 'outcome', 'reason_code', 'identity_keys_json', 'matched_company_id', 'duplicate_of_candidate_id',
  'website_check_status', 'qualification', 'qualification_reason', 'evidence_urls_json', 'evidence_excerpt',
  'saved_company_id', 'updated_at',
]);

export function updateCandidate(workspaceId, id, patch) {
  const entries = Object.entries(patch).filter(([column]) => UPDATE_COLUMNS.has(column));
  if (!entries.length) return findCandidate(workspaceId, id);
  run(
    `UPDATE discovery_candidates SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND workspace_id = ?`,
    [...entries.map(([, value]) => value), id, workspaceId],
  );
  return findCandidate(workspaceId, id);
}

export function findCandidate(workspaceId, id) {
  return mapCandidate(get('SELECT * FROM discovery_candidates WHERE id = ? AND workspace_id = ?', [id, workspaceId]));
}

export function listCandidates(workspaceId, runId, { limit = 500, offset = 0 } = {}) {
  const total = get('SELECT COUNT(*) AS c FROM discovery_candidates WHERE workspace_id = ? AND run_id = ?', [workspaceId, runId])?.c ?? 0;
  const rows = all(
    'SELECT * FROM discovery_candidates WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    [workspaceId, runId, limit, offset],
  );
  return paged(rows.map(mapCandidate), total, 1, limit);
}

export function countCandidatesByRun(workspaceId, runId) {
  return all(
    'SELECT outcome, COUNT(*) AS c FROM discovery_candidates WHERE workspace_id = ? AND run_id = ? GROUP BY outcome',
    [workspaceId, runId],
  );
}
