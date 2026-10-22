/**
 * Schema validator, JSON extraction, retry logic, budget and error handling.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_INPUTS, createAgentTestEnv, createFakeProvider } from './agents-support.mjs';
import { getExecution, runAgent, validateOutput } from '../../server/agents/index.mjs';
import { OUTPUT_SCHEMAS } from '../../server/agents/schemas.mjs';
import { parseJsonOutput } from '../../server/agents/schema.mjs';
import { simulateRole } from '../../server/agents/simulation.mjs';
import { recordUsageRecord } from '../../server/agents/executions.mjs';
import { AppError } from '../../server/core/errors.mjs';
import { get } from '../../server/core/db.mjs';

const env = createAgentTestEnv();
after(() => env.cleanup());

function countExecutions() {
  return get('SELECT COUNT(*) AS c FROM agent_executions WHERE workspace_id = ?', [env.workspaceId])?.c ?? 0;
}

test('parseJsonOutput tolerates fences and surrounding prose, rejects garbage', () => {
  assert.deepEqual(parseJsonOutput('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonOutput('```json\n{"a":2}\n```'), { ok: true, value: { a: 2 } });
  assert.deepEqual(parseJsonOutput('Here you go:\n```\n{"a":3}\n```\nDone'), { ok: true, value: { a: 3 } });
  assert.deepEqual(parseJsonOutput('prefix {"a":4} suffix'), { ok: true, value: { a: 4 } });
  assert.equal(parseJsonOutput('').ok, false);
  assert.equal(parseJsonOutput('not json at all').ok, false);
  assert.equal(parseJsonOutput(null).ok, false);
});

test('schema validation rejects illegal enum values, missing fields and out-of-range numbers', () => {
  const replySchema = OUTPUT_SCHEMAS.reply_classification;
  const validReply = simulateRole('reply_classification', SAMPLE_INPUTS.reply_classification);
  assert.equal(validateOutput(validReply, replySchema).ok, true);

  const illegalLabel = { ...validReply, label: 'very_interested' };
  const labelResult = validateOutput(illegalLabel, replySchema);
  assert.equal(labelResult.ok, false);
  assert.ok(labelResult.errors.some((error) => error.includes('value must be one of')));

  const missingField = { ...validReply };
  delete missingField.rationale;
  const missingResult = validateOutput(missingField, replySchema);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((error) => error.includes('rationale') && error.includes('required')));

  const badIntent = { ...validReply, intentScore: 140 };
  assert.equal(validateOutput(badIntent, replySchema).ok, false);

  const qualificationSchema = OUTPUT_SCHEMAS.company_qualification;
  const validQualification = simulateRole('company_qualification', SAMPLE_INPUTS.company_qualification);
  const badGrade = { ...validQualification, grade: 'E' };
  assert.equal(validateOutput(badGrade, qualificationSchema).ok, false);
  const badScore = { ...validQualification, score: 101 };
  assert.equal(validateOutput(badScore, qualificationSchema).ok, false);
  const badConfidence = { ...validQualification, confidence: 1.5 };
  assert.equal(validateOutput(badConfidence, qualificationSchema).ok, false);
  const emptyFactors = { ...validQualification, factors: [] };
  assert.equal(validateOutput(emptyFactors, qualificationSchema).ok, false);

  const outreachSchema = OUTPUT_SCHEMAS.outreach_writer;
  const validOutreach = simulateRole('outreach_writer', SAMPLE_INPUTS.outreach_writer);
  const tooLongBody = { ...validOutreach, body: 'x'.repeat(7000) };
  const tooLongResult = validateOutput(tooLongBody, outreachSchema);
  assert.equal(tooLongResult.ok, false);
  assert.ok(tooLongResult.errors.some((error) => error.includes('longer than')));

  const unknownRoleSchema = validateOutput({ anything: true }, null);
  assert.equal(unknownRoleSchema.ok, false);
});

test('invalid output is retried once with a stricter instruction, then succeeds', async () => {
  const validOutput = simulateRole('reply_classification', SAMPLE_INPUTS.reply_classification);
  const fake = createFakeProvider([{ ...validOutput, label: 'not_a_label' }, validOutput]);

  const result = await runAgent({
    workspaceId: env.workspaceId,
    role: 'reply_classification',
    input: SAMPLE_INPUTS.reply_classification,
    provider: fake,
    actorType: 'agent',
    actorId: 'worker-test',
  });

  assert.equal(fake.calls.length, 2, 'expected exactly one retry');
  assert.equal(result.output.label, 'quote_request');
  assert.equal(result.usage.tokensIn, 20);
  assert.equal(result.usage.tokensOut, 40);
  assert.ok(result.usage.costEstimate > 0, 'fake provider is billed');
  assert.equal(result.usage.isSimulation, false);

  // The retry prompt must contain the stricter instruction and validation reasons.
  const second = fake.calls[1];
  const systemText = second.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  const userText = second.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
  assert.match(systemText, /Retry instruction/);
  assert.match(userText, /previous JSON was rejected/);

  const execution = getExecution(env.workspaceId, result.executionId);
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.provider, 'fake-provider');
  assert.equal(execution.tokensIn, 20);
  assert.equal(execution.tokensOut, 40);
});

test('output that stays invalid after the retry throws AGENT_INVALID_OUTPUT and logs a failed execution', async () => {
  const validOutput = simulateRole('reply_classification', SAMPLE_INPUTS.reply_classification);
  const fake = createFakeProvider([{ ...validOutput, label: 'nope' }, { ...validOutput, intentScore: 999 }]);

  const before = countExecutions();
  let thrown = null;
  try {
    await runAgent({
      workspaceId: env.workspaceId,
      role: 'reply_classification',
      input: SAMPLE_INPUTS.reply_classification,
      provider: fake,
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, 'AGENT_INVALID_OUTPUT');
  assert.equal(thrown.status, 502);
  assert.ok(thrown.details.errors.length > 0);
  assert.equal(fake.calls.length, 2);
  assert.equal(countExecutions(), before + 1);

  const failed = get(
    `SELECT * FROM agent_executions WHERE workspace_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`,
    [env.workspaceId],
  );
  assert.ok(failed);
  assert.match(failed.error, /AGENT_INVALID_OUTPUT/);
  const usageRows = get(
    `SELECT COUNT(*) AS c FROM usage_records WHERE workspace_id = ? AND agent_execution_id = ?`,
    [env.workspaceId, failed.id],
  );
  assert.equal(usageRows.c, 2);

  const apiError = JSON.parse(JSON.stringify(thrown));
  assert.equal(apiError.code, 'AGENT_INVALID_OUTPUT');
});

test('provider failures are recorded and not retried automatically', async () => {
  const fake = createFakeProvider([new AppError('AGENT_PROVIDER_TIMEOUT', '模型请求超时（60ms）。', { status: 504 })]);
  let thrown = null;
  try {
    await runAgent({
      workspaceId: env.workspaceId,
      role: 'reply_classification',
      input: SAMPLE_INPUTS.reply_classification,
      provider: fake,
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, 'AGENT_PROVIDER_TIMEOUT');
  assert.equal(fake.calls.length, 1, 'provider errors must not be retried');

  const failed = get(
    `SELECT * FROM agent_executions WHERE workspace_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`,
    [env.workspaceId],
  );
  assert.match(failed.error, /AGENT_PROVIDER_TIMEOUT/);
});

test('unknown role and oversized input are rejected before any execution row', async () => {
  const before = countExecutions();
  await assert.rejects(
    runAgent({ workspaceId: env.workspaceId, role: 'does_not_exist', input: {} }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    runAgent({ workspaceId: env.workspaceId, role: 'reply_classification', input: { blob: 'x'.repeat(70 * 1024) } }),
    (error) => error.code === 'AGENT_INPUT_TOO_LARGE' && error.status === 413,
  );
  await assert.rejects(
    runAgent({ workspaceId: env.workspaceId, role: 'reply_classification', input: [] }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(countExecutions(), before);
});

test('execution input is sanitised: secret-looking keys are redacted before storage', async () => {
  const validOutput = simulateRole('reply_classification', SAMPLE_INPUTS.reply_classification);
  const fake = createFakeProvider([validOutput]);
  const result = await runAgent({
    workspaceId: env.workspaceId,
    role: 'reply_classification',
    input: {
      ...SAMPLE_INPUTS.reply_classification,
      apiKey: 'sk-test-secret-value',
      nested: { password: 'hunter2', authorization: 'Bearer abc' },
    },
    provider: fake,
  });
  const execution = getExecution(env.workspaceId, result.executionId);
  assert.equal(execution.input.apiKey, '[redacted]');
  assert.equal(execution.input.nested.password, '[redacted]');
  assert.equal(execution.input.nested.authorization, '[redacted]');
  assert.equal(JSON.stringify(execution).includes('sk-test-secret-value'), false);
});

test('daily AI token budget exhaustion rejects the run before calling the provider', async () => {
  // Default workspace limit is 500000 tokens/day; push usage above it.
  recordUsageRecord({
    workspaceId: env.workspaceId,
    category: 'ai_tokens',
    agentRole: 'company_qualification',
    quantity: 600_000,
    unit: 'tokens',
  });
  const fake = createFakeProvider([simulateRole('reply_classification', SAMPLE_INPUTS.reply_classification)]);
  const before = countExecutions();
  await assert.rejects(
    runAgent({
      workspaceId: env.workspaceId,
      role: 'reply_classification',
      input: SAMPLE_INPUTS.reply_classification,
      provider: fake,
    }),
    (error) => error.code === 'AGENT_BUDGET_EXCEEDED' && error.status === 429 && error.details.limit === 500000,
  );
  assert.equal(fake.calls.length, 0, 'no model call when budget is exhausted');
  assert.equal(countExecutions(), before, 'no execution row when budget is exhausted');
});
