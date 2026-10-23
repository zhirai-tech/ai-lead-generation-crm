/**
 * v1.1 keyword_research role: schema, deterministic simulation expansion,
 * convenience helper and tenancy.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_INPUTS, createAgentTestEnv } from './agents-support.mjs';
import {
  AGENT_CATALOG,
  generateProductKeywords,
  getExecution,
  getOutputSchema,
  listExecutions,
  runAgent,
  validateOutput,
} from '../../server/agents/index.mjs';
import { OUTPUT_SCHEMAS } from '../../server/agents/schemas.mjs';
import { simulateRole } from '../../server/agents/simulation.mjs';
import { all, get } from '../../server/core/db.mjs';

const env = createAgentTestEnv();
after(() => env.cleanup());

test('keyword_research is registered in the catalogue with schema and prompt version', () => {
  const entry = AGENT_CATALOG.find((item) => item.role === 'keyword_research');
  assert.ok(entry, 'catalogue must include keyword_research');
  assert.match(entry.promptVersion, /^keyword_research@\d+$/);
  assert.equal(entry.nameZh, '关键词研究');
  assert.ok(entry.inputFields.includes('product'));
  assert.ok(entry.capabilities.includes('keywords'));
  assert.ok(getOutputSchema('keyword_research'));

  // Browser-facing catalogue still must not expose prompt/schema bodies.
  assert.equal(entry.system, undefined);
  assert.equal(entry.outputSchema, undefined);
});

test('simulation expands deduplicated English B2B keywords from product fields', () => {
  const output = simulateRole('keyword_research', SAMPLE_INPUTS.keyword_research);
  const validation = validateOutput(output, OUTPUT_SCHEMAS.keyword_research);
  assert.equal(validation.ok, true, validation.errors.join('; '));

  assert.ok(output.keywords.length > 0, 'keywords must not be empty');
  assert.ok(output.keywords.length <= 30);
  assert.ok(output.keywords.every((keyword) => keyword.length <= 80));
  const normalized = output.keywords.map((keyword) => keyword.toLowerCase());
  assert.equal(new Set(normalized).size, normalized.length, 'keywords must be unique (case-insensitive)');

  const joined = output.keywords.join(' ').toLowerCase();
  for (const word of ['supplier', 'manufacturer', 'distributor']) {
    assert.ok(joined.includes(word), `expected generic B2B word "${word}"`);
  }
  assert.ok(normalized.some((keyword) => keyword.includes('ev battery brackets') || keyword.includes('ev battery')));
  assert.ok(output.keywords.includes('EV 电池包支架 C 型'), 'Chinese product name is kept verbatim');
  // No fabricated certifications / customers / prices in keyword expansion.
  assert.equal(/iso\s?\d{4,5}|iata|case study|customer|price|€|\$/.test(joined), false);

  assert.ok(output.negativeKeywords.length > 0 && output.negativeKeywords.length <= 15);
  assert.ok(output.negativeKeywords.every((keyword) => keyword.length <= 80));
  const negativeNormalized = output.negativeKeywords.map((keyword) => keyword.toLowerCase());
  assert.equal(new Set(negativeNormalized).size, negativeNormalized.length);
  assert.ok(negativeNormalized.includes('consumer retail'), 'ICP exclusions are kept');

  assert.ok(output.searchQueries.length > 0 && output.searchQueries.length <= 10);
  assert.ok(output.searchQueries.every((query) => query.length <= 200));
  const queryNormalized = output.searchQueries.map((query) => query.toLowerCase());
  assert.equal(new Set(queryNormalized).size, queryNormalized.length);

  assert.match(output.notes, /模拟 Provider/);
  assert.match(output.notes, /未做搜索量/);

  // Deterministic for the same input.
  assert.deepEqual(simulateRole('keyword_research', SAMPLE_INPUTS.keyword_research), output);
});

test('keyword_research still returns generic B2B keywords for an empty product', () => {
  const output = simulateRole('keyword_research', { product: {} });
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.keyword_research).ok, true);
  assert.ok(output.keywords.length > 0);
  assert.match(output.notes, /缺少字段/);
});

test('generateProductKeywords writes execution + usage with simulation provider', async () => {
  const before = listExecutions(env.workspaceId, { role: 'keyword_research', page: 1, pageSize: 100 }).total;
  const output = await generateProductKeywords({
    workspaceId: env.workspaceId,
    product: SAMPLE_INPUTS.keyword_research.product,
    actorType: 'agent',
    actorId: 't-data',
  });
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.keyword_research).ok, true);

  const list = listExecutions(env.workspaceId, { role: 'keyword_research', page: 1, pageSize: 100 });
  assert.equal(list.total, before + 1);
  const latest = list.items[0];
  assert.equal(latest.status, 'succeeded');
  assert.equal(latest.provider, 'simulation');
  assert.match(latest.promptVersion, /^keyword_research@\d+$/);
  assert.equal(latest.costEstimate, 0);

  const execution = getExecution(env.workspaceId, latest.id);
  assert.equal(execution.input.product.name, SAMPLE_INPUTS.keyword_research.product.name);
  assert.deepEqual(execution.output.keywords, output.keywords);

  const usageRows = all(
    'SELECT * FROM usage_records WHERE workspace_id = ? AND agent_execution_id = ? ORDER BY category',
    [env.workspaceId, latest.id],
  );
  assert.equal(usageRows.length, 2);
  const runRow = usageRows.find((row) => row.category === 'agent_run');
  const tokenRow = usageRows.find((row) => row.category === 'ai_tokens');
  assert.equal(runRow.quantity, 1);
  assert.equal(runRow.unit, 'run');
  assert.equal(tokenRow.quantity, 0);
  assert.equal(tokenRow.unit, 'tokens');

  const audit = get(
    `SELECT * FROM audit_events WHERE workspace_id = ? AND action = 'agent.run' AND entity_id = ?`,
    [env.workspaceId, latest.id],
  );
  assert.ok(audit);
});

test('keyword executions and usage are isolated per workspace', async () => {
  const other = env.createWorkspace('关键词隔离空间');
  const result = await runAgent({
    workspaceId: env.workspaceId,
    role: 'keyword_research',
    input: SAMPLE_INPUTS.keyword_research,
  });
  assert.equal(validateOutput(result.output, OUTPUT_SCHEMAS.keyword_research).ok, true);

  assert.equal(getExecution(other.workspaceId, result.executionId), null);
  assert.equal(listExecutions(other.workspaceId, { role: 'keyword_research', page: 1, pageSize: 50 }).total, 0);
  const leakedUsage = get(
    'SELECT COUNT(*) AS c FROM usage_records WHERE workspace_id = ? AND agent_execution_id = ?',
    [other.workspaceId, result.executionId],
  );
  assert.equal(leakedUsage.c, 0);

  const otherRun = await runAgent({
    workspaceId: other.workspaceId,
    role: 'keyword_research',
    input: { product: { name: 'Industrial Valve', category: 'valves' } },
  });
  assert.equal(validateOutput(otherRun.output, OUTPUT_SCHEMAS.keyword_research).ok, true);
  const ownList = listExecutions(env.workspaceId, { role: 'keyword_research', page: 1, pageSize: 100 });
  assert.equal(ownList.items.some((item) => item.id === otherRun.executionId), false);
});
