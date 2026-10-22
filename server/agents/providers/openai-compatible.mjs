/**
 * OpenAI-compatible chat-completions provider.
 *
 * Works with any endpoint that implements `POST {baseUrl}/chat/completions`
 * (DeepSeek, OpenAI, local vLLM/Ollama gateways, ...). The API key only ever
 * lives in this process: it is read from the encrypted credential store by the
 * resolver, sent in the Authorization header and never logged or stored.
 */
import { AppError } from '../../core/errors.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_PRICING = Object.freeze({ inputPer1k: 0.0005, outputPer1k: 0.0015 });

/** DeepSeek expects /chat/completions on the bare host; OpenAI expects /v1/chat/completions. */
export function normalizeChatEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

export function describeBaseUrl(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).host;
  } catch {
    return null;
  }
}

function redact(text, secret) {
  let output = String(text ?? '');
  if (secret) output = output.split(secret).join('[redacted]');
  return output.slice(0, 400);
}

function mapHttpError(status, payload, secret) {
  let detail = payload?.error?.message ?? payload?.message ?? payload?.error ?? '';
  if (typeof detail !== 'string') {
    try {
      detail = JSON.stringify(detail);
    } catch {
      detail = '';
    }
  }
  const safeDetail = redact(detail, secret);
  if (status === 401 || status === 403) {
    return new AppError('AGENT_PROVIDER_AUTH', `模型接口认证失败（HTTP ${status}），请检查 API Key 是否正确。`, { status: 502 });
  }
  if (status === 429) {
    return new AppError('AGENT_PROVIDER_RATE_LIMIT', '模型接口触发限流（HTTP 429），请稍后重试或降低调用频率。', { status: 502 });
  }
  if (status >= 500) {
    return new AppError('AGENT_PROVIDER_UNAVAILABLE', `模型接口暂时不可用（HTTP ${status}）。`, { status: 502 });
  }
  return new AppError('AGENT_PROVIDER_ERROR', `模型接口返回错误（HTTP ${status}）${safeDetail ? `：${safeDetail}` : ''}`, { status: 502 });
}

function mentionsResponseFormat(payload) {
  let text = '';
  try {
    text = JSON.stringify(payload ?? {}).toLowerCase();
  } catch {
    return false;
  }
  return text.includes('response_format') || text.includes('json_object') || text.includes('unsupported');
}

function readUsage(usage) {
  const promptTokens = Math.max(0, Math.trunc(Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0));
  const completionTokens = Math.max(0, Math.trunc(Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0));
  const totalTokens = Math.max(0, Math.trunc(Number(usage?.total_tokens ?? 0) || 0)) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @returns {object} provider with `complete({ messages, jsonMode, ... })`
 */
export function createOpenAICompatibleProvider({
  providerKey = 'openai_compatible',
  baseUrl,
  apiKey,
  model = 'deepseek-chat',
  temperature = 0.3,
  maxTokens = 4096,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pricing = null,
  source = 'credential',
} = {}) {
  if (!apiKey) throw new AppError('AGENT_PROVIDER_NOT_CONFIGURED', '未配置模型 API Key', { status: 503 });
  const endpoint = normalizeChatEndpoint(baseUrl);
  if (!endpoint) throw new AppError('AGENT_PROVIDER_NOT_CONFIGURED', '未配置模型接口地址', { status: 503 });
  const effectiveTimeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.trunc(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));

  async function complete({ messages, jsonMode = true, temperatureOverride, maxTokensOverride } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AppError('AGENT_PROVIDER_ERROR', '模型请求缺少消息内容', { status: 502 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'ZHIRAI-Outreach/1.0',
    };
    try {
      const body = {
        model,
        messages,
        temperature: temperatureOverride ?? temperature,
        max_tokens: maxTokensOverride ?? maxTokens,
        stream: false,
      };
      if (jsonMode) body.response_format = { type: 'json_object' };

      let response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      let payload = await readJson(response);

      // Some compatible gateways reject response_format; retry once with prompt-only JSON.
      if (!response.ok && jsonMode && response.status >= 400 && response.status < 500 && mentionsResponseFormat(payload)) {
        delete body.response_format;
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        payload = await readJson(response);
      }

      if (!response.ok) throw mapHttpError(response.status, payload, apiKey);

      const content = payload?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((part) => part?.text || '').join('') : content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new AppError('AGENT_PROVIDER_ERROR', '模型未返回内容', { status: 502 });
      }
      return { text, usage: readUsage(payload?.usage), model: payload?.model || model };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw new AppError('AGENT_PROVIDER_TIMEOUT', `模型请求超时（${effectiveTimeout}ms）。`, { status: 504 });
      }
      throw new AppError('AGENT_PROVIDER_ERROR', `模型请求失败：${redact(error?.message || '网络错误', apiKey)}`, {
        status: 502,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function test() {
    const result = await complete({
      messages: [
        { role: 'system', content: 'You are a connectivity test. Reply with a tiny JSON object only.' },
        { role: 'user', content: 'Return {"ok":true}.' },
      ],
      maxTokensOverride: 32,
      temperatureOverride: 0,
    });
    let sample = result.text.slice(0, 200);
    try {
      sample = JSON.parse(result.text);
    } catch {
      // keep the raw text snippet as the sample
    }
    return { sample };
  }

  return {
    key: providerKey,
    providerKey,
    model,
    isSimulation: false,
    source,
    baseUrlHost: describeBaseUrl(baseUrl),
    timeoutMs: effectiveTimeout,
    pricing: pricing || DEFAULT_PRICING,
    complete,
    test,
  };
}

export default { createOpenAICompatibleProvider, normalizeChatEndpoint, DEFAULT_PRICING };
