/**
 * HTTP-level tests for /api/v1/agents.
 *
 * Import order matters: `../unit/agents-support.mjs` is imported first so the
 * operator AI_* env vars are cleared before `server/config.mjs` is loaded by the
 * test helpers. All runs therefore use the offline simulation provider — no
 * real network request is ever made.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import '../unit/agents-support.mjs';
import { createTestContext } from '../helpers.mjs';
import { validateOutput } from '../../server/agents/index.mjs';
import { OUTPUT_SCHEMAS } from '../../server/agents/schemas.mjs';
import { get } from '../../server/core/db.mjs';

const ctx = await createTestContext();
after(() => ctx.close());

test('GET /api/v1/agents returns catalogue + safe provider status without prompts or keys', async () => {
  const response = await ctx.request('GET', '/api/v1/agents');
  assert.equal(response.status, 200);
  const data = response.body.data;
  assert.equal(data.items.length, 10);
  assert.equal(data.roles.length, 10);
  assert.equal(data.provider.provider, 'simulation');
  assert.equal(data.provider.isSimulation, true);
  assert.equal(data.provider.configured, false);
  assert.equal(data.provider.apiKey, undefined);
  assert.equal(data.provider.secret, undefined);
  assert.ok(data.provider.warning);

  for (const item of data.items) {
    assert.ok(item.role);
    assert.ok(item.promptVersion);
    assert.ok(item.nameZh);
    assert.equal(item.system, undefined);
    assert.equal(item.outputSchema, undefined);
  }

  const raw = JSON.stringify(response.body);
  assert.equal(raw.includes('Absolute prohibitions'), false, 'prompt body must not be exposed');
  assert.equal(raw.includes('Structured output contract'), false, 'schema instruction must not be exposed');
  assert.equal(raw.includes('sk-'), false);
});

test('POST /api/v1/agents/run executes via simulation, persists execution and audit', async () => {
  const response = await ctx.request('POST', '/api/v1/agents/run', {
    body: {
      role: 'outreach_writer',
      input: {
        company: { name: 'Beispiel Valves GmbH', industry: 'industrial equipment distribution' },
        contact: { fullName: 'Anna Schmidt' },
        product: { name: 'Industrial Valve X1' },
        language: 'de',
      },
    },
  });
  assert.equal(response.status, 200, response.text);
  const data = response.body.data;
  assert.ok(data.executionId.startsWith('agx_'));
  assert.equal(data.usage.provider, 'simulation');
  assert.equal(data.usage.isSimulation, true);
  assert.equal(data.usage.costEstimate, 0);
  const validation = validateOutput(data.output, OUTPUT_SCHEMAS.outreach_writer);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(data.output.language, 'de');

  const detail = await ctx.request('GET', `/api/v1/agents/executions/${data.executionId}`);
  assert.equal(detail.status, 200);
  const execution = detail.body.data.execution;
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.role, 'outreach_writer');
  assert.equal(execution.provider, 'simulation');
  assert.equal(execution.output.language, 'de');
  assert.equal(execution.input.contact.fullName, 'Anna Schmidt');
  assert.ok(execution.promptVersion.startsWith('outreach_writer@'));

  const audit = get(
    `SELECT * FROM audit_events WHERE workspace_id = ? AND action = 'agent.run' AND entity_id = ?`,
    [ctx.owner.workspaceId, data.executionId],
  );
  assert.ok(audit, 'agent.run audit event must exist');

  const list = await ctx.request('GET', '/api/v1/agents/executions?role=outreach_writer&page=1&pageSize=5');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.total >= 1);
  assert.equal(list.body.data.page, 1);
  assert.equal(list.body.data.pageSize, 5);
  assert.ok(list.body.data.items.every((item) => item.role === 'outreach_writer'));
  assert.equal(list.body.data.items[0].input, undefined, 'list must not include heavy payloads');
});

test('POST /api/v1/agents/test-provider reports simulation mode offline', async () => {
  const response = await ctx.request('POST', '/api/v1/agents/test-provider');
  assert.equal(response.status, 200);
  const data = response.body.data;
  assert.equal(data.ok, true);
  assert.equal(data.provider, 'simulation');
  assert.equal(data.isSimulation, true);
  assert.ok(data.latencyMs >= 0);
  assert.ok(data.sample);
  assert.equal(JSON.stringify(data).includes('sk-'), false);
});

test('POST /api/v1/agents/run validates role whitelist and input size', async () => {
  const badRole = await ctx.request('POST', '/api/v1/agents/run', { body: { role: 'evil_role', input: {} } });
  assert.equal(badRole.status, 422);
  assert.equal(badRole.body.error.code, 'VALIDATION_ERROR');

  const missingRole = await ctx.request('POST', '/api/v1/agents/run', { body: { input: {} } });
  assert.equal(missingRole.status, 422);

  const oversized = await ctx.request('POST', '/api/v1/agents/run', {
    body: { role: 'outreach_writer', input: { blob: 'x'.repeat(70 * 1024) } },
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, 'AGENT_INPUT_TOO_LARGE');

  const badInput = await ctx.request('POST', '/api/v1/agents/run', {
    body: { role: 'outreach_writer', input: 'not-an-object' },
  });
  assert.equal(badInput.status, 422);
});

test('viewer can read catalogue but cannot run agents', async () => {
  const viewer = ctx.createMember({ email: 'agents-viewer@test.local', role: 'viewer' });
  ctx.as(viewer);

  const catalogue = await ctx.request('GET', '/api/v1/agents');
  assert.equal(catalogue.status, 200);

  const run = await ctx.request('POST', '/api/v1/agents/run', {
    body: { role: 'reply_classification', input: { message: { body: 'Please send a quotation.' } } },
  });
  assert.equal(run.status, 403);
  assert.equal(run.body.error.code, 'FORBIDDEN');

  const providerTest = await ctx.request('POST', '/api/v1/agents/test-provider');
  assert.equal(providerTest.status, 200);

  ctx.as(ctx.owner);
  const ownerCatalogue = await ctx.request('GET', '/api/v1/agents');
  assert.equal(ownerCatalogue.status, 200);
});

test('executions are isolated per workspace over HTTP', async () => {
  const other = ctx.createWorkspace({ name: 'HTTP 隔离空间' });

  const ownerRun = await ctx.request('POST', '/api/v1/agents/run', {
    body: { role: 'reply_classification', input: { message: { body: 'We need a quotation.' } } },
  });
  assert.equal(ownerRun.status, 200);
  const ownerExecutionId = ownerRun.body.data.executionId;

  ctx.as(other);
  const list = await ctx.request('GET', '/api/v1/agents/executions');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 0);

  const detail = await ctx.request('GET', `/api/v1/agents/executions/${ownerExecutionId}`);
  assert.equal(detail.status, 404);
  assert.equal(detail.body.error.code, 'NOT_FOUND');

  const otherRun = await ctx.request('POST', '/api/v1/agents/run', {
    body: { role: 'follow_up_planning', input: { classification: { label: 'price_inquiry' } } },
  });
  assert.equal(otherRun.status, 200);
  const otherExecutionId = otherRun.body.data.executionId;

  const otherList = await ctx.request('GET', '/api/v1/agents/executions?pageSize=50');
  assert.equal(otherList.body.data.total, 1);
  assert.equal(otherList.body.data.items[0].id, otherExecutionId);

  ctx.as(ctx.owner);
  const ownerList = await ctx.request('GET', '/api/v1/agents/executions?pageSize=100');
  assert.equal(
    ownerList.body.data.items.some((item) => item.id === otherExecutionId),
    false,
  );
  assert.ok(ownerList.body.data.items.some((item) => item.id === ownerExecutionId));
});

test('agent execution list validates filter values', async () => {
  const badRole = await ctx.request('GET', '/api/v1/agents/executions?role=not_a_role');
  assert.equal(badRole.status, 422);
  const badStatus = await ctx.request('GET', '/api/v1/agents/executions?status=exploded');
  assert.equal(badStatus.status, 422);
  const empty = await ctx.request('GET', '/api/v1/agents/executions?role=quality_review&status=failed');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.total, 0);
});
