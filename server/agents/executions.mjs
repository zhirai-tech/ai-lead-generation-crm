/**
 * Persistence for agent executions and usage accounting.
 *
 * Every run writes one `agent_executions` row (status running -> succeeded /
 * failed) plus two `usage_records` rows:
 *   - category 'agent_run', quantity 1, unit 'run'
 *   - category 'ai_tokens', quantity tokens_in + tokens_out, unit 'tokens'
 *
 * Stored inputs are sanitised (secrets redacted) and capped, so prompts and
 * credentials can never leak into the execution log.
 */
import { all, get, parseJson, run } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { dayKey, nowIso } from '../core/time.mjs';

const SENSITIVE_KEY_RE = /(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|token|authorization|cookie|credential|private[_-]?key)/i;
const MAX_STRING_CHARS = 4000;
const MAX_STORED_INPUT_CHARS = 50_000;
const MAX_STORED_OUTPUT_CHARS = 150_000;

export const EXECUTION_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

/** Redact secret-looking keys and truncate long strings before storage. */
export function sanitizeForStorage(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForStorage(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : sanitizeForStorage(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  return value;
}

function serializeCapped(value, maxChars) {
  let text;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ truncated: true, reason: 'not_json_serialisable' });
  }
  if (typeof text !== 'string') text = 'null';
  if (text.length <= maxChars) return text;
  return JSON.stringify({ truncated: true, originalLength: text.length, preview: text.slice(0, Math.floor(maxChars / 2)) });
}

/** Insert the initial `running` execution row. */
export function createExecutionRecord({ workspaceId, role, input, promptVersion, provider, model, jobId = null, createdBy = null }) {
  const executionId = id('agx');
  const now = nowIso();
  run(
    `INSERT INTO agent_executions
       (id, workspace_id, agent_role, status, input_json, output_json, prompt_version, provider, model,
        tokens_in, tokens_out, cost_estimate, latency_ms, error, job_id, created_by, started_at, finished_at, created_at)
     VALUES (?, ?, ?, 'running', ?, '{}', ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, ?, NULL, ?)`,
    [
      executionId,
      workspaceId,
      role,
      serializeCapped(sanitizeForStorage(input), MAX_STORED_INPUT_CHARS),
      promptVersion || null,
      provider || null,
      model || null,
      jobId,
      createdBy,
      now,
      now,
    ],
  );
  return executionId;
}

export function markExecutionSucceeded({ executionId, workspaceId, output, tokensIn, tokensOut, costEstimate, latencyMs }) {
  run(
    `UPDATE agent_executions
        SET status = 'succeeded', output_json = ?, tokens_in = ?, tokens_out = ?, cost_estimate = ?,
            latency_ms = ?, error = NULL, finished_at = ?
      WHERE id = ? AND workspace_id = ?`,
    [
      serializeCapped(output, MAX_STORED_OUTPUT_CHARS),
      Math.max(0, Math.trunc(tokensIn || 0)),
      Math.max(0, Math.trunc(tokensOut || 0)),
      Number(costEstimate) || 0,
      Math.max(0, Math.trunc(latencyMs || 0)),
      nowIso(),
      executionId,
      workspaceId,
    ],
  );
}

export function markExecutionFailed({ executionId, workspaceId, errorCode, errorMessage, output = null, tokensIn, tokensOut, costEstimate, latencyMs }) {
  const error = `${errorCode || 'AGENT_ERROR'}: ${String(errorMessage || '执行失败')}`.slice(0, 1000);
  run(
    `UPDATE agent_executions
        SET status = 'failed', output_json = ?, tokens_in = ?, tokens_out = ?, cost_estimate = ?,
            latency_ms = ?, error = ?, finished_at = ?
      WHERE id = ? AND workspace_id = ?`,
    [
      serializeCapped(output ?? {}, MAX_STORED_OUTPUT_CHARS),
      Math.max(0, Math.trunc(tokensIn || 0)),
      Math.max(0, Math.trunc(tokensOut || 0)),
      Number(costEstimate) || 0,
      Math.max(0, Math.trunc(latencyMs || 0)),
      error,
      nowIso(),
      executionId,
      workspaceId,
    ],
  );
}

export function recordUsageRecord({
  workspaceId,
  category,
  agentRole = null,
  provider = null,
  model = null,
  quantity = 0,
  unit = 'count',
  costEstimate = 0,
  currency = 'USD',
  jobId = null,
  agentExecutionId = null,
  occurredAt = null,
}) {
  const now = nowIso();
  const safeQuantity = Number.isFinite(Number(quantity)) ? Math.max(0, Number(quantity)) : 0;
  run(
    `INSERT INTO usage_records
       (id, workspace_id, category, agent_role, provider, model, quantity, unit, cost_estimate, currency,
        job_id, agent_execution_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id('usg'),
      workspaceId,
      category,
      agentRole,
      provider,
      model,
      safeQuantity,
      unit,
      Number(costEstimate) || 0,
      currency,
      jobId,
      agentExecutionId,
      occurredAt || now,
      now,
    ],
  );
}

/** AI tokens consumed by one workspace during the current UTC day. */
export function getDailyAiTokenUsage(workspaceId) {
  const since = `${dayKey()}T00:00:00.000Z`;
  const row = get(
    `SELECT COALESCE(SUM(quantity), 0) AS tokens
       FROM usage_records
      WHERE workspace_id = ? AND category = 'ai_tokens' AND occurred_at >= ?`,
    [workspaceId, since],
  );
  return Number(row?.tokens || 0);
}

function mapExecutionRow(row, { includePayload = false } = {}) {
  const mapped = {
    id: row.id,
    workspaceId: row.workspace_id,
    role: row.agent_role,
    status: row.status,
    promptVersion: row.prompt_version || null,
    provider: row.provider || null,
    model: row.model || null,
    tokensIn: Number(row.tokens_in || 0),
    tokensOut: Number(row.tokens_out || 0),
    totalTokens: Number(row.tokens_in || 0) + Number(row.tokens_out || 0),
    costEstimate: Number(row.cost_estimate || 0),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    error: row.error || null,
    jobId: row.job_id || null,
    createdBy: row.created_by || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
  };
  if (includePayload) {
    mapped.input = parseJson(row.input_json, {});
    mapped.output = parseJson(row.output_json, {});
  }
  return mapped;
}

export function getExecution(workspaceId, executionId, { includePayload = true } = {}) {
  const row = get('SELECT * FROM agent_executions WHERE workspace_id = ? AND id = ?', [workspaceId, executionId]);
  return row ? mapExecutionRow(row, { includePayload }) : null;
}

export function listExecutions(workspaceId, { page = 1, pageSize = 25, role = '', status = '' } = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (role) {
    where.push('agent_role = ?');
    params.push(role);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const total = get(`SELECT COUNT(*) AS c FROM agent_executions WHERE ${where.join(' AND ')}`, params)?.c ?? 0;
  const rows = all(
    `SELECT * FROM agent_executions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items: rows.map((row) => mapExecutionRow(row)), total, page, pageSize };
}

export default {
  EXECUTION_STATUSES,
  sanitizeForStorage,
  createExecutionRecord,
  markExecutionSucceeded,
  markExecutionFailed,
  recordUsageRecord,
  getDailyAiTokenUsage,
  getExecution,
  listExecutions,
};
