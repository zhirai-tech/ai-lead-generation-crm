/**
 * Provider resolution behaviour: credential priority, simulation fallback and
 * key hygiene. No real network request is made in this file.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTestEnv } from './agents-support.mjs';
import { getProviderInfo, resolveProvider } from '../../server/agents/index.mjs';
import { normalizeChatEndpoint } from '../../server/agents/providers/openai-compatible.mjs';
import { saveCredential } from '../../server/services/settings.mjs';

const env = createAgentTestEnv();
after(() => env.cleanup());

test('default resolution falls back to the offline simulation provider', () => {
  const provider = resolveProvider(env.workspaceId);
  assert.equal(provider.key, 'simulation');
  assert.equal(provider.isSimulation, true);
  assert.deepEqual(provider.pricing, { inputPer1k: 0, outputPer1k: 0 });
  const info = getProviderInfo(env.workspaceId);
  assert.equal(info.configured, false);
  assert.equal(info.baseUrlHost, null);
});

test('an active ai_provider credential overrides the simulation fallback', () => {
  saveCredential(
    env.workspaceId,
    'ai_provider',
    'openai_compatible',
    {
      label: '单元测试 DeepSeek',
      secret: { apiKey: 'sk-unit-test-secret-value' },
      config: {
        baseUrl: 'https://example.invalid/v1',
        model: 'deepseek-chat',
        timeoutMs: 5000,
        pricing: { inputPer1k: 0.001, outputPer1k: 0.002 },
      },
    },
    { actorId: env.userId },
  );

  const provider = resolveProvider(env.workspaceId);
  assert.equal(provider.key, 'openai_compatible');
  assert.equal(provider.isSimulation, false);
  assert.equal(provider.source, 'credential');
  assert.equal(provider.model, 'deepseek-chat');
  assert.equal(provider.baseUrlHost, 'example.invalid');
  assert.equal(provider.timeoutMs, 5000);
  assert.deepEqual(provider.pricing, { inputPer1k: 0.001, outputPer1k: 0.002 });
  // The key is held in a closure only; provider metadata never serialises it.
  assert.equal(JSON.stringify(provider).includes('sk-unit-test-secret-value'), false);
  assert.equal(JSON.stringify(provider.baseUrlHost).includes('sk-'), false);

  const info = getProviderInfo(env.workspaceId);
  assert.equal(info.configured, true);
  assert.equal(info.isSimulation, false);
  assert.equal(info.provider, 'openai_compatible');
  assert.equal(info.baseUrlHost, 'example.invalid');
  assert.equal(info.warning, null);
  assert.equal(JSON.stringify(info).includes('sk-unit-test-secret-value'), false);
  assert.equal(Object.keys(info).includes('apiKey'), false);
});

test('chat endpoint normalisation supports bare hosts and versioned gateways', () => {
  assert.equal(normalizeChatEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(normalizeChatEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(normalizeChatEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(normalizeChatEndpoint('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
  assert.equal(normalizeChatEndpoint(''), '');
});
