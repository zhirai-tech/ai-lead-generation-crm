/**
 * Provider resolution for the agent layer.
 *
 * Priority (highest first):
 *   1. active workspace credential (`integration_credentials.kind = ai_provider`)
 *   2. workspace settings.ai provider + operator env API key
 *   3. process environment AI_* fallback (config.aiFallback)
 *   4. built-in deterministic simulation provider
 *
 * API keys are read from the encrypted credential store or process env only.
 * Nothing here is ever exposed to the browser; `getProviderInfo()` returns
 * metadata (provider/model/source) without secrets.
 */
import { all } from '../../core/db.mjs';
import { config } from '../../config.mjs';
import { getCredential, getSettings } from '../../services/settings.mjs';
import { createOpenAICompatibleProvider, DEFAULT_PRICING, describeBaseUrl } from './openai-compatible.mjs';
import { createSimulationProvider, SIMULATION_MODEL } from './simulation.mjs';

export const DEFAULT_BASE_URLS = Object.freeze({
  openai_compatible: 'https://api.deepseek.com',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  local: 'http://127.0.0.1:11434/v1',
});

export const DEFAULT_MODELS = Object.freeze({
  openai_compatible: 'deepseek-chat',
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1',
  local: 'llama3.1',
});

export const SIMULATION_PRICING = Object.freeze({ inputPer1k: 0, outputPer1k: 0 });

function normalizeKey(value) {
  const key = String(value || '').trim();
  return /^[a-z0-9_-]{2,60}$/i.test(key) ? key : '';
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function pricingFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const inputPer1k = Number(value.inputPer1k);
  const outputPer1k = Number(value.outputPer1k);
  if (!Number.isFinite(inputPer1k) || !Number.isFinite(outputPer1k)) return null;
  if (inputPer1k < 0 || outputPer1k < 0) return null;
  return { inputPer1k, outputPer1k };
}

function credentialProviderKeys(workspaceId, preferredKey) {
  const rows = all(
    `SELECT provider_key FROM integration_credentials
      WHERE workspace_id = ? AND kind = 'ai_provider' AND status = 'active'
      ORDER BY updated_at DESC`,
    [workspaceId],
  );
  const keys = rows.map((row) => row.provider_key).filter(Boolean);
  const rest = keys.filter((key) => key !== preferredKey);
  if (preferredKey && keys.includes(preferredKey)) return [preferredKey, ...rest];
  if (keys.includes('openai_compatible')) return ['openai_compatible', ...keys.filter((key) => key !== 'openai_compatible')];
  return keys;
}

function buildProviderFromConfig({ providerKey, baseUrl, apiKey, model, temperature, maxTokens, timeoutMs, pricing, source }) {
  return createOpenAICompatibleProvider({
    providerKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    model,
    temperature,
    maxTokens,
    timeoutMs,
    pricing,
    source,
  });
}

/**
 * Resolve the effective provider for a workspace.
 * `overrides.provider` is used by tests to inject a fake in-process provider.
 */
export function resolveProvider(workspaceId, { overrides = {} } = {}) {
  if (overrides && overrides.provider) return overrides.provider;
  if (!workspaceId) throw new Error('workspaceId is required to resolve an AI provider');

  const settings = getSettings(workspaceId);
  const ai = settings.ai || {};
  const env = config.aiFallback || {};
  const preferred = normalizeKey(ai.provider);

  // 1) Workspace credentials (encrypted at rest, decrypted only here).
  for (const key of credentialProviderKeys(workspaceId, preferred)) {
    const credential = getCredential(workspaceId, 'ai_provider', key);
    if (!credential) continue;
    const secret = credential.secret || {};
    const apiKey = firstString(secret.apiKey, secret.token, secret.secret, secret.key);
    if (!apiKey) continue;
    const cfg = credential.config || {};
    return buildProviderFromConfig({
      providerKey: key,
      baseUrl: firstString(cfg.baseUrl, cfg.base_url, ai.baseUrl, DEFAULT_BASE_URLS[key], DEFAULT_BASE_URLS.openai_compatible),
      apiKey,
      model: firstString(cfg.model, ai.model, DEFAULT_MODELS[key], 'deepseek-chat'),
      temperature: numberOr(cfg.temperature, numberOr(ai.temperature, 0.3)),
      maxTokens: Math.trunc(numberOr(cfg.maxTokens, numberOr(ai.maxTokensPerRun, 4096))),
      timeoutMs: Math.trunc(numberOr(cfg.timeoutMs, 60_000)),
      pricing: pricingFrom(cfg.pricing) || pricingFrom(ai.pricing) || DEFAULT_PRICING,
      source: 'credential',
    });
  }

  // 2) Workspace settings select a real provider; operator env supplies the key.
  if (preferred && preferred !== 'simulation') {
    if (env.apiKey) {
      return buildProviderFromConfig({
        providerKey: preferred,
        baseUrl: firstString(ai.baseUrl, env.baseUrl, DEFAULT_BASE_URLS[preferred], DEFAULT_BASE_URLS.openai_compatible),
        apiKey: env.apiKey,
        model: firstString(ai.model, env.model, DEFAULT_MODELS[preferred], 'deepseek-chat'),
        temperature: numberOr(ai.temperature, 0.3),
        maxTokens: Math.trunc(numberOr(ai.maxTokensPerRun, 4096)),
        timeoutMs: 60_000,
        pricing: pricingFrom(ai.pricing) || DEFAULT_PRICING,
        source: 'settings+env',
      });
    }
  }

  // 3) Process environment fallback (operator-level default).
  if (env.apiKey) {
    const providerKey = normalizeKey(env.provider) || 'openai_compatible';
    return buildProviderFromConfig({
      providerKey,
      baseUrl: firstString(env.baseUrl, ai.baseUrl, DEFAULT_BASE_URLS[providerKey], DEFAULT_BASE_URLS.openai_compatible),
      apiKey: env.apiKey,
      model: firstString(env.model, ai.model, DEFAULT_MODELS[providerKey], 'deepseek-chat'),
      temperature: numberOr(ai.temperature, 0.3),
      maxTokens: Math.trunc(numberOr(ai.maxTokensPerRun, 4096)),
      timeoutMs: 60_000,
      pricing: pricingFrom(ai.pricing) || DEFAULT_PRICING,
      source: 'env',
    });
  }

  // 4) Default: deterministic offline provider.
  return createSimulationProvider({ model: SIMULATION_MODEL, source: 'default' });
}

/** Safe, browser-facing provider status (no key, no prompt, host only). */
export function getProviderInfo(workspaceId) {
  let provider;
  try {
    provider = resolveProvider(workspaceId);
  } catch (error) {
    return {
      provider: 'unavailable',
      model: null,
      isSimulation: false,
      source: 'none',
      configured: false,
      baseUrlHost: null,
      timeoutMs: null,
      pricing: null,
      warning: '模型 Provider 配置无效，Agent 暂时无法运行。',
      errorCode: error?.code || 'AGENT_PROVIDER_NOT_CONFIGURED',
    };
  }
  const isSimulation = provider.isSimulation === true;
  return {
    provider: provider.key,
    model: provider.model,
    isSimulation,
    source: provider.source || (isSimulation ? 'simulation' : 'credential'),
    configured: !isSimulation,
    baseUrlHost: isSimulation ? null : provider.baseUrlHost || describeBaseUrl(provider.baseUrl) || null,
    timeoutMs: provider.timeoutMs || null,
    pricing: provider.pricing || (isSimulation ? SIMULATION_PRICING : null),
    warning: isSimulation ? '未配置模型 API Key，当前使用内置离线模拟 Provider；模拟输出不会调用任何外部模型。' : null,
  };
}

/**
 * Connectivity test. Never leaks the key; reports sanitised provider errors.
 * @returns {Promise<{ok:boolean, provider:string, model:string|null, latencyMs:number, sample:any, isSimulation:boolean, error?:{code:string,message:string}}>}
 */
export async function testProvider({ workspaceId } = {}) {
  const startedAt = Date.now();
  let provider;
  try {
    provider = resolveProvider(workspaceId);
  } catch (error) {
    return {
      ok: false,
      provider: 'unavailable',
      model: null,
      latencyMs: Date.now() - startedAt,
      sample: null,
      isSimulation: false,
      error: {
        code: error?.code || 'AGENT_PROVIDER_NOT_CONFIGURED',
        message: String(error?.message || '模型 Provider 未配置').slice(0, 300),
      },
    };
  }
  try {
    const result = await provider.test();
    return {
      ok: true,
      provider: provider.key,
      model: provider.model || null,
      latencyMs: Date.now() - startedAt,
      sample: result?.sample ?? null,
      isSimulation: provider.isSimulation === true,
    };
  } catch (error) {
    return {
      ok: false,
      provider: provider.key,
      model: provider.model || null,
      latencyMs: Date.now() - startedAt,
      sample: null,
      isSimulation: provider.isSimulation === true,
      error: {
        code: error?.code || 'AGENT_PROVIDER_ERROR',
        message: String(error?.message || '模型连通性测试失败').slice(0, 300),
      },
    };
  }
}

export default { resolveProvider, getProviderInfo, testProvider };
