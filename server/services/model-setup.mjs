/**
 * Local model setup for the desktop build.
 *
 * The browser/server never installs software silently. This service only:
 *  - probes a local Ollama instance,
 *  - reports RAM/GPU-free requirements,
 *  - pulls the small default model when the user explicitly asks,
 *  - saves the resulting OpenAI-compatible endpoint as the AI credential.
 */
import os from 'node:os';
import net from 'node:net';
import { badRequest } from '../core/errors.mjs';
import { getSettings, saveCredential, updateProvider, updateSettings } from './settings.mjs';

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_LOCAL_MODEL = 'qwen2.5:3b';
const MIN_RAM_GB = 8;

function baseUrl() {
  return String(process.env.OLLAMA_BASE_URL || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, '');
}

async function ollamaJson(path, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 3000),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`);
  return response.json();
}

export function memoryGb() {
  return Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
}

export async function status() {
  const ram = memoryGb();
  const minimum = { ramGb: MIN_RAM_GB, met: ram >= MIN_RAM_GB };
  let installed = false;
  let models = [];
  let error = null;
  try {
    const payload = await ollamaJson('/api/tags');
    installed = true;
    models = (payload.models || []).map((item) => ({
      name: item.name,
      size: item.size,
      modifiedAt: item.modified_at,
    }));
  } catch (caught) {
    error = caught.message;
  }
  const hasDefault = models.some((item) => item.name === DEFAULT_LOCAL_MODEL || item.name.startsWith(`${DEFAULT_LOCAL_MODEL}:`));
  return {
    platform: process.platform,
    memoryGb: ram,
    minimum,
    installed,
    endpoint: baseUrl(),
    models,
    defaultModel: DEFAULT_LOCAL_MODEL,
    hasDefault,
    ready: installed && hasDefault && minimum.met,
    installUrl: 'https://ollama.com/download',
    error,
  };
}

function privateIpv4(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function probePort(host, port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Scan only private /24 networks of this machine for an Ollama listener.
 * This is deliberately bounded and never touches public addresses.
 */
export async function scanLan({ timeoutMs = 350 } = {}) {
  const subnets = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && privateIpv4(address.address)) {
        subnets.add(address.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  const extra = String(process.env.OLLAMA_LAN_HOSTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => privateIpv4(value));
  for (const host of extra) subnets.add(host.split('.').slice(0, 3).join('.'));

  const hosts = [];
  for (const subnet of subnets) {
    let next = 1;
    async function worker() {
      while (next <= 254) {
        const last = next++;
        const host = `${subnet}.${last}`;
        if (await probePort(host, 11434, timeoutMs)) hosts.push(host);
      }
    }
    await Promise.all(Array.from({ length: 64 }, worker));
  }

  const results = [];
  for (const host of [...new Set([...extra, ...hosts])]) {
    try {
      const response = await fetch(`http://${host}:11434/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) continue;
      const payload = await response.json();
      results.push({
        host,
        endpoint: `http://${host}:11434`,
        models: (payload.models || []).map((item) => ({ name: item.name, size: item.size })),
      });
    } catch {
      // listener exists but not an Ollama API
    }
  }
  return { scannedSubnets: [...subnets], hosts: results };
}

export async function useModel({ workspaceId, model, baseUrl: requestedBaseUrl, actorId = null }) {
  const chosenModel = String(model || DEFAULT_LOCAL_MODEL).trim();
  if (!/^[a-z0-9._:/-]{2,120}$/i.test(chosenModel)) throw badRequest('模型名称不合法');
  const endpoint = String(requestedBaseUrl || baseUrl()).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(endpoint)) throw badRequest('模型地址必须以 http:// 或 https:// 开头');
  const openaiBase = endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`;
  saveCredential(
    workspaceId,
    'ai_provider',
    'openai_compatible',
    {
      label: `本地模型 ${chosenModel}`,
      secret: { apiKey: 'ollama' },
      config: { baseUrl: openaiBase, model: chosenModel, provider: 'ollama', local: true },
    },
    { actorId },
  );
  updateProvider(workspaceId, 'openai_compatible', {
    isEnabled: true,
    config: { baseUrl: openaiBase, model: chosenModel, provider: 'ollama' },
  }, { actorId });
  updateSettings(workspaceId, { ai: { provider: 'openai_compatible', baseUrl: openaiBase, model: chosenModel } }, { actorId });
  return { baseUrl: openaiBase, model: chosenModel };
}

export async function pullModel({ workspaceId, model, actorId = null }) {
  const chosenModel = String(model || DEFAULT_LOCAL_MODEL).trim();
  if (chosenModel !== DEFAULT_LOCAL_MODEL) throw badRequest(`第一版只允许自动下载默认模型 ${DEFAULT_LOCAL_MODEL}`);
  if (memoryGb() < MIN_RAM_GB) throw badRequest(`本机内存 ${memoryGb()}GB，低于本地运行最低要求 ${MIN_RAM_GB}GB`);
  const response = await fetch(`${baseUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: chosenModel, stream: true }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`下载模型失败：HTTP ${response.status}`);
  if (!response.body) throw new Error('下载模型失败：没有响应流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        last = event;
      } catch (caught) {
        if (caught.message && !caught.message.includes('JSON')) throw caught;
      }
    }
  }
  return { model: chosenModel, status: last?.status || 'success', ...(await useModel({ workspaceId, model: chosenModel, actorId })) };
}

export default { status, scanLan, pullModel, useModel, memoryGb, DEFAULT_LOCAL_MODEL };
