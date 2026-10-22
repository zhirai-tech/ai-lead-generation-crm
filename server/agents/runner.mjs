/**
 * Agent runner: prompt assembly, model call, structured-output validation with
 * one corrective retry, execution logging and usage accounting.
 *
 * Contract: `runAgent({ workspaceId, role, input, actorType, actorId, jobId,
 * createdBy }) -> { executionId, output, usage }`.
 *
 * Failure behaviour:
 *   - invalid/illegal JSON or schema violations -> retry once with a stricter
 *     instruction, then throw AppError('AGENT_INVALID_OUTPUT').
 *   - provider/network/auth errors are not retried automatically (avoid
 *     duplicate billing); the execution is recorded as failed.
 *   - daily token budget exhaustion rejects the run before any model call.
 */
import { AppError, badRequest, validationError } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';
import { getSettings } from '../services/settings.mjs';
import { nowIso } from '../core/time.mjs';
import { getAgent } from './catalog.mjs';
import { loadPrompt } from './prompts.mjs';
import { parseJsonOutput, validateOutput } from './schema.mjs';
import { resolveProvider } from './providers/index.mjs';
import {
  createExecutionRecord,
  getDailyAiTokenUsage,
  markExecutionFailed,
  markExecutionSucceeded,
  recordUsageRecord,
  sanitizeForStorage,
} from './executions.mjs';

export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 120 * 1024;
export const MAX_ATTEMPTS = 2;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOKENS_CAP = 8192;
const AUDIT_ACTOR_TYPES = new Set(['user', 'agent', 'system', 'api_key']);

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function estimateCost(pricing, tokensIn, tokensOut, isSimulation) {
  if (isSimulation) return 0;
  const inputPer1k = Math.max(0, numberOr(pricing?.inputPer1k, 0));
  const outputPer1k = Math.max(0, numberOr(pricing?.outputPer1k, 0));
  const cost = (Math.max(0, tokensIn) / 1000) * inputPer1k + (Math.max(0, tokensOut) / 1000) * outputPer1k;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function addUsage(accumulator, usage) {
  const promptTokens = Math.max(0, Math.trunc(numberOr(usage?.promptTokens, 0)));
  const completionTokens = Math.max(0, Math.trunc(numberOr(usage?.completionTokens, 0)));
  const totalTokens = Math.max(0, Math.trunc(numberOr(usage?.totalTokens, 0)));
  accumulator.tokensIn += promptTokens;
  accumulator.tokensOut += completionTokens + Math.max(0, totalTokens - promptTokens - completionTokens);
}

function buildMessages({ agent, prompt, input, attempt, validationErrors }) {
  let system = prompt.system.trim();
  system +=
    '\n\n## Structured output contract\n' +
    'Return exactly one JSON object that conforms to the JSON Schema below. ' +
    'Do not wrap it in markdown code fences and do not add any commentary outside the JSON object.\n' +
    JSON.stringify(agent.outputSchema);
  if (attempt > 1) {
    system +=
      '\n\n## Retry instruction\nYour previous reply was rejected by the validator. ' +
      'Follow the schema literally: every required field must be present, enum values must match exactly and numbers must stay inside the allowed ranges. Output JSON only.';
  }
  let user = `Task: ${agent.role}\nInput JSON:\n${safeStringify(input)}`;
  if (attempt > 1 && validationErrors.length) {
    user += `\n\nThe previous JSON was rejected for these reasons:\n- ${validationErrors.slice(0, 12).join('\n- ')}\nReturn a corrected JSON object only.`;
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function writeAudit({ workspaceId, actorType, actorId, executionId, role, provider, model, status, tokensIn, tokensOut, costEstimate, jobId, errorCode }) {
  try {
    recordAudit({
      workspaceId,
      actorType,
      actorId,
      action: 'agent.run',
      entityType: 'agent_execution',
      entityId: executionId,
      after: {
        role,
        provider,
        model,
        status,
        tokensIn,
        tokensOut,
        costEstimate,
        jobId,
        errorCode: errorCode || null,
      },
    });
  } catch {
    // Audit must not mask the run result; database errors are surfaced elsewhere.
  }
}

/**
 * Execute one agent role. See module header for the failure contract.
 * @param {object} options
 * @param {string} options.workspaceId
 * @param {string} options.role
 * @param {object} [options.input]
 * @param {'user'|'agent'|'system'|'api_key'} [options.actorType]
 * @param {string|null} [options.actorId]
 * @param {string|null} [options.jobId]
 * @param {string|null} [options.createdBy]
 * @param {object|null} [options.provider] internal/test injection only
 */
export async function runAgent({
  workspaceId,
  role,
  input = {},
  actorType = 'system',
  actorId = null,
  jobId = null,
  createdBy = null,
  provider: providerOverride = null,
} = {}) {
  if (!workspaceId || typeof workspaceId !== 'string') throw badRequest('workspaceId 不能为空');
  const agent = getAgent(role);
  if (!agent) throw validationError(`未知的 Agent 角色：${role || ''}`, { role: role || null });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('Agent 输入必须是 JSON 对象');
  }
  const inputJson = safeStringify(input);
  if (!inputJson) throw validationError('Agent 输入无法序列化为 JSON');
  if (Buffer.byteLength(inputJson) > MAX_INPUT_BYTES) {
    throw new AppError('AGENT_INPUT_TOO_LARGE', `Agent 输入过大（上限 ${MAX_INPUT_BYTES} 字节）`, { status: 413 });
  }

  const settings = getSettings(workspaceId);
  const dailyLimit = Math.max(0, Math.trunc(numberOr(settings.limits?.dailyAiTokens, 0)));
  const usedTokens = getDailyAiTokenUsage(workspaceId);
  if (dailyLimit > 0 && usedTokens >= dailyLimit) {
    throw new AppError(
      'AGENT_BUDGET_EXCEEDED',
      `今日 AI Token 预算已用尽（${Math.round(usedTokens)}/${dailyLimit}），请明日再试或调整额度设置。`,
      { status: 429, details: { limit: dailyLimit, used: usedTokens } },
    );
  }

  const prompt = loadPrompt(role);
  const provider = providerOverride || resolveProvider(workspaceId);
  const providerKey = provider.key || 'simulation';
  const model = provider.model || null;
  const temperature = numberOr(settings.ai?.temperature, DEFAULT_TEMPERATURE);
  const configuredMaxTokens = Math.trunc(numberOr(settings.ai?.maxTokensPerRun, DEFAULT_MAX_TOKENS));
  const maxTokens = Math.max(64, Math.min(MAX_TOKENS_CAP, configuredMaxTokens));
  const auditActorType = AUDIT_ACTOR_TYPES.has(actorType) ? actorType : 'system';

  const executionId = createExecutionRecord({
    workspaceId,
    role,
    input,
    promptVersion: prompt.promptVersion,
    provider: providerKey,
    model,
    jobId,
    createdBy: createdBy ?? actorId ?? null,
  });

  const startedAt = Date.now();
  const usage = { tokensIn: 0, tokensOut: 0 };
  let lastOutput = null;
  let lastErrors = [];

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const messages = buildMessages({ agent, prompt, input, attempt, validationErrors: lastErrors });
      const response = await provider.complete({ role, input, messages, temperature, maxTokens, jsonMode: true });
      addUsage(usage, response?.usage);

      const parsed = parseJsonOutput(response?.text);
      if (!parsed.ok) {
        lastErrors = [parsed.error];
        lastOutput = typeof response?.text === 'string' ? response.text.slice(0, 20_000) : null;
        continue;
      }
      const validation = validateOutput(parsed.value, agent.outputSchema, { maxBytes: MAX_OUTPUT_BYTES });
      if (!validation.ok) {
        lastErrors = validation.errors;
        lastOutput = parsed.value;
        continue;
      }

      const latencyMs = Date.now() - startedAt;
      const costEstimate = estimateCost(provider.pricing, usage.tokensIn, usage.tokensOut, provider.isSimulation === true);
      markExecutionSucceeded({
        executionId,
        workspaceId,
        output: sanitizeForStorage(parsed.value),
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costEstimate,
        latencyMs,
      });
      recordUsageRecord({
        workspaceId,
        category: 'agent_run',
        agentRole: role,
        provider: providerKey,
        model,
        quantity: 1,
        unit: 'run',
        costEstimate,
        jobId,
        agentExecutionId: executionId,
      });
      recordUsageRecord({
        workspaceId,
        category: 'ai_tokens',
        agentRole: role,
        provider: providerKey,
        model,
        quantity: usage.tokensIn + usage.tokensOut,
        unit: 'tokens',
        costEstimate,
        jobId,
        agentExecutionId: executionId,
      });
      writeAudit({
        workspaceId,
        actorType: auditActorType,
        actorId,
        executionId,
        role,
        provider: providerKey,
        model,
        status: 'succeeded',
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costEstimate,
        jobId,
      });
      return {
        executionId,
        output: parsed.value,
        usage: {
          provider: providerKey,
          model,
          isSimulation: provider.isSimulation === true,
          promptVersion: prompt.promptVersion,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          totalTokens: usage.tokensIn + usage.tokensOut,
          costEstimate,
          latencyMs,
          jobId,
        },
      };
    }

    throw new AppError('AGENT_INVALID_OUTPUT', `Agent 输出未通过结构校验（已重试 ${MAX_ATTEMPTS - 1} 次）`, {
      status: 502,
      details: { role, errors: lastErrors.slice(0, 12) },
    });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError('AGENT_PROVIDER_ERROR', `Agent 执行失败：${String(error?.message || '未知错误').slice(0, 300)}`, {
            status: 502,
          });
    const latencyMs = Date.now() - startedAt;
    const costEstimate = estimateCost(provider.pricing, usage.tokensIn, usage.tokensOut, provider.isSimulation === true);
    markExecutionFailed({
      executionId,
      workspaceId,
      errorCode: appError.code,
      errorMessage: appError.message,
      output: lastOutput === null ? null : { rejectedOutput: sanitizeForStorage(lastOutput) },
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costEstimate,
      latencyMs,
    });
    recordUsageRecord({
      workspaceId,
      category: 'agent_run',
      agentRole: role,
      provider: providerKey,
      model,
      quantity: 1,
      unit: 'run',
      costEstimate,
      jobId,
      agentExecutionId: executionId,
    });
    recordUsageRecord({
      workspaceId,
      category: 'ai_tokens',
      agentRole: role,
      provider: providerKey,
      model,
      quantity: usage.tokensIn + usage.tokensOut,
      unit: 'tokens',
      costEstimate,
      jobId,
      agentExecutionId: executionId,
    });
    writeAudit({
      workspaceId,
      actorType: auditActorType,
      actorId,
      executionId,
      role,
      provider: providerKey,
      model,
      status: 'failed',
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costEstimate,
      jobId,
      errorCode: appError.code,
    });
    throw appError;
  }
}

export default { runAgent, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_ATTEMPTS };
