/**
 * Simulation provider + runner happy paths.
 *
 * Runs fully offline: the support module clears AI_* env vars before the agent
 * modules load and no credentials are configured, so the resolver always picks
 * the deterministic simulation provider.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { CONVENIENCE_CONTEXTS, SAMPLE_INPUTS, createAgentTestEnv } from './agents-support.mjs';
import {
  AGENT_CATALOG,
  AGENT_ROLES,
  classifyReply,
  companyResearch,
  complianceCheck,
  generateOutreachDraft,
  getExecution,
  getProviderInfo,
  listExecutions,
  matchProduct,
  planFollowUp,
  qualifyCompany,
  reviewQuality,
  runAgent,
  testProvider,
  validateOutput,
} from '../../server/agents/index.mjs';
import { OUTPUT_SCHEMAS } from '../../server/agents/schemas.mjs';
import { simulateRole } from '../../server/agents/simulation.mjs';
import { all } from '../../server/core/db.mjs';

const env = createAgentTestEnv();
after(() => env.cleanup());

test('catalogue exposes the ten contracted roles without prompt bodies', () => {
  assert.equal(AGENT_CATALOG.length, 10);
  assert.deepEqual(
    AGENT_CATALOG.map((entry) => entry.role),
    [...AGENT_ROLES],
  );
  for (const entry of AGENT_CATALOG) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.nameZh, 'string');
    assert.equal(typeof entry.description, 'string');
    assert.match(entry.promptVersion, new RegExp(`^${entry.role}@\\d+$`));
    assert.ok(Array.isArray(entry.capabilities) && entry.capabilities.length > 0);
    assert.ok(Array.isArray(entry.inputFields) && entry.inputFields.length > 0);
    // Prompt/system text must never be part of the browser-facing catalogue.
    assert.equal(entry.system, undefined);
    assert.equal(entry.prompt, undefined);
    assert.equal(entry.outputSchema, undefined);
  }
});

test('simulation provider produces schema-valid output for every role and records execution + usage', async () => {
  for (const role of AGENT_ROLES) {
    const result = await runAgent({
      workspaceId: env.workspaceId,
      role,
      input: SAMPLE_INPUTS[role],
      actorType: 'user',
      actorId: env.userId,
    });

    assert.ok(result.executionId.startsWith('agx_'), `${role}: execution id prefix`);
    const validation = validateOutput(result.output, OUTPUT_SCHEMAS[role]);
    assert.equal(validation.ok, true, `${role}: ${validation.errors.join('; ')}`);

    assert.equal(result.usage.provider, 'simulation');
    assert.equal(result.usage.isSimulation, true);
    assert.equal(result.usage.costEstimate, 0, `${role}: simulation cost must be 0`);
    assert.equal(result.usage.promptVersion, `${role}@1`);

    const execution = getExecution(env.workspaceId, result.executionId);
    assert.equal(execution.status, 'succeeded');
    assert.equal(execution.role, role);
    assert.equal(execution.provider, 'simulation');
    assert.equal(execution.promptVersion, `${role}@1`);
    assert.equal(execution.costEstimate, 0);
    assert.equal(execution.error, null);
    assert.ok(execution.finishedAt);

    const usageRows = all(
      'SELECT * FROM usage_records WHERE workspace_id = ? AND agent_execution_id = ? ORDER BY category',
      [env.workspaceId, result.executionId],
    );
    assert.equal(usageRows.length, 2, `${role}: expected agent_run + ai_tokens usage rows`);
    const runRow = usageRows.find((row) => row.category === 'agent_run');
    const tokenRow = usageRows.find((row) => row.category === 'ai_tokens');
    assert.equal(runRow.quantity, 1);
    assert.equal(runRow.unit, 'run');
    assert.equal(tokenRow.unit, 'tokens');
    assert.equal(tokenRow.quantity, 0, `${role}: simulation consumes no real tokens`);
  }
});

test('simulation output is deterministic for the same input', async () => {
  const first = simulateRole('company_qualification', SAMPLE_INPUTS.company_qualification);
  const second = simulateRole('company_qualification', SAMPLE_INPUTS.company_qualification);
  assert.deepEqual(first, second);

  const runA = await runAgent({ workspaceId: env.workspaceId, role: 'company_qualification', input: SAMPLE_INPUTS.company_qualification });
  const runB = await runAgent({ workspaceId: env.workspaceId, role: 'company_qualification', input: SAMPLE_INPUTS.company_qualification });
  assert.notEqual(runA.executionId, runB.executionId);
  assert.deepEqual(runA.output, runB.output);
});

test('provider status and testProvider clearly label simulation mode', async () => {
  const info = getProviderInfo(env.workspaceId);
  assert.equal(info.isSimulation, true);
  assert.equal(info.provider, 'simulation');
  assert.equal(info.configured, false);
  assert.ok(info.warning.includes('模拟'));
  assert.equal(info.apiKey, undefined);
  assert.equal(info.secret, undefined);

  const result = await testProvider({ workspaceId: env.workspaceId });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'simulation');
  assert.equal(result.isSimulation, true);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.sample.provider, 'simulation');
  assert.equal(JSON.stringify(result).includes('sk-'), false);
});

test('convenience functions prune context and return schema-valid output', async () => {
  const cases = [
    ['generateOutreachDraft', generateOutreachDraft, 'outreach_writer'],
    ['qualifyCompany', qualifyCompany, 'company_qualification'],
    ['classifyReply', classifyReply, 'reply_classification'],
    ['planFollowUp', planFollowUp, 'follow_up_planning'],
    ['companyResearch', companyResearch, 'market_research'],
    ['matchProduct', matchProduct, 'product_matching'],
    ['complianceCheck', complianceCheck, 'compliance_guard'],
    ['reviewQuality', reviewQuality, 'quality_review'],
  ];
  for (const [name, fn, role] of cases) {
    const output = await fn({
      workspaceId: env.workspaceId,
      context: CONVENIENCE_CONTEXTS[name],
      language: 'de',
      actorType: 'agent',
      actorId: 'worker-test',
    });
    const validation = validateOutput(output, OUTPUT_SCHEMAS[role]);
    assert.equal(validation.ok, true, `${name}: ${validation.errors.join('; ')}`);
  }
});

test('outreach simulation honours campaignStep templates, product facts and sender signature', () => {
  const output = simulateRole('outreach_writer', {
    company: { name: 'Flanders EV Solutions NV', industry: 'EV manufacturing', country: 'BE' },
    contact: { fullName: 'Jan Peeters', firstName: 'Jan' },
    product: {
      name: 'EV battery bracket C',
      certifications: ['ISO 9001', 'IATF 16949'],
      moq: '500 pcs',
      leadTime: '6 weeks',
    },
    language: 'en',
    campaignStep: {
      subjectTemplate: 'EV battery brackets for {{companyName}}',
      bodyTemplate:
        'Hi {{firstName}},\n\nWe saw that {{companyName}} works in {{industry}}. Our {{productName}} may fit your programme.\n\nBest regards',
      language: 'en',
    },
    sender: { name: 'Thomas Chen', title: 'Sales Manager', companyName: 'ZHIRAI', address: 'Berlin, Germany' },
    settings: { includeUnsubscribe: true },
  });

  assert.equal(output.subject, 'EV battery brackets for Flanders EV Solutions NV');
  assert.equal(output.language, 'en');
  assert.match(output.body, /Hi Jan,/);
  assert.match(output.body, /Flanders EV Solutions NV/);
  assert.match(output.body, /EV battery bracket C/);
  assert.match(output.body, /ISO 9001/);
  assert.match(output.body, /500 pcs/);
  assert.match(output.body, /6 weeks/);
  assert.match(output.body, /Thomas Chen/);
  assert.match(output.body, /unsubscribe/i);
  assert.equal(output.body.includes('{{'), false);
  assert.ok(output.claims.some((claim) => claim.source === 'company.name'));
  assert.ok(output.claims.some((claim) => claim.source === 'product.name'));
  assert.ok(output.claims.some((claim) => claim.source === 'product.certifications'));
  assert.ok(output.claims.some((claim) => claim.source === 'product.moq'));
  assert.ok(output.claims.some((claim) => claim.source === 'product.leadTime'));
  assert.ok(output.riskNotes.length >= 1);
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach simulation accepts the t-crm draft generation context shape (step + preferences)', () => {
  const output = simulateRole('outreach_writer', {
    company: {
      name: 'Flanders EV Solutions NV',
      domain: 'flanders-ev.be',
      country: 'BE',
      industry: 'EV battery systems',
      description: 'EV battery pack integrator.',
      certifications: [],
    },
    contact: { fullName: 'Jan Peeters', firstName: 'Jan', lastName: 'Peeters', title: 'Procurement Manager', language: 'en' },
    product: {
      name: 'EV 电池包支架 C 型',
      certifications: ['ISO 9001'],
      moq: '500 pcs',
      leadTime: '6 weeks',
    },
    icp: { name: 'EV OEM' },
    score: null,
    campaign: { id: 'cmp_1', name: 'EV Q1', goal: 'book calls', requireApproval: 1 },
    step: {
      stepNo: 1,
      name: '首封开发信',
      subjectTemplate: 'EV battery brackets for {{companyName}}',
      bodyTemplate:
        'Hi {{firstName}},\n\nWe saw that {{companyName}} works on {{industry}}. Our {{productName}} may support your programme.',
      language: 'en',
    },
    history: { messages: [], previousDrafts: [] },
    preferences: {
      includeUnsubscribe: true,
      senderCompanyName: 'ZHIRAI',
      senderAddress: 'Berlin, Germany',
      privacyUrl: 'https://zhirai.cloud/privacy',
      legalBasis: 'legitimate_interest',
    },
    language: 'en',
  });

  assert.equal(output.subject, 'EV battery brackets for Flanders EV Solutions NV');
  assert.equal(output.language, 'en');
  assert.match(output.body, /Hi Jan,/);
  assert.match(output.body, /Our product may support your programme/);
  assert.match(output.body, /ISO 9001/);
  assert.match(output.body, /ZHIRAI/);
  assert.match(output.body, /unsubscribe/i);
  assert.equal(/[\u4e00-\u9fff]/.test(output.body), false, 'no Chinese text in an English draft');
  assert.ok(output.riskNotes.some((note) => note.includes('中文')));
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach template replaces contactFirstName aliases and derives it from fullName', () => {
  const base = {
    company: { name: 'Flanders EV Solutions NV', industry: 'EV battery systems' },
    product: { name: 'EV battery brackets', certifications: ['ISO 9001'] },
    language: 'en',
    sender: { name: 'Thomas Chen', companyName: 'ZHIRAI' },
    settings: { includeUnsubscribe: true },
  };
  const templates = [
    'Hello {{contactFirstName}},\n\nOur product may fit your programme.',
    'Hello {{contact.firstName}},\n\nOur product may fit your programme.',
    'Hello {{firstName}},\n\nOur product may fit your programme.',
  ];
  for (const bodyTemplate of templates) {
    const output = simulateRole('outreach_writer', {
      ...base,
      contact: { fullName: 'Jan Peeters' },
      step: { subjectTemplate: 'EV brackets for {{companyName}}', bodyTemplate, language: 'en' },
    });
    assert.match(output.body, /Hello Jan,/, bodyTemplate);
    assert.doesNotMatch(output.body, /Hello ,/);
    assert.equal(output.body.includes('{{'), false);
    assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
  }

  const explicit = simulateRole('outreach_writer', {
    ...base,
    contact: { firstName: 'Johannes', fullName: 'Jan Peeters' },
    step: { subjectTemplate: 'X {{companyName}}', bodyTemplate: 'Hello {{contactFirstName}},', language: 'en' },
  });
  assert.match(explicit.body, /Hello Johannes,/);
});

test('outreach localizes known Chinese units and keeps English certification names', () => {
  const output = simulateRole('outreach_writer', {
    company: { name: 'Flanders EV Solutions NV', industry: 'EV battery systems' },
    contact: { fullName: 'Jan Peeters' },
    product: {
      name: 'EV battery bracket',
      certifications: ['ISO 9001（质量体系认证）', 'IATF 16949'],
      moq: '200 件',
      leadTime: '25-35 天',
    },
    language: 'en',
    step: {
      subjectTemplate: 'EV battery brackets for {{companyName}}',
      bodyTemplate: 'Hi {{contactFirstName}},\n\nMOQ: {{moq}}, lead time: {{leadTime}}. Our {{productName}} may fit.',
      language: 'en',
    },
    sender: { name: 'Thomas Chen', companyName: 'ZHIRAI' },
    settings: { includeUnsubscribe: true },
  });
  assert.match(output.body, /MOQ: 200 pcs/);
  assert.match(output.body, /lead time: 25-35 days/);
  assert.match(output.body, /ISO 9001, IATF 16949/);
  assert.equal(output.body.includes('件'), false);
  assert.equal(output.body.includes('天'), false);
  assert.equal(output.body.includes('（'), false);
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach does not append a duplicate fact line when the template already covers the facts', () => {
  const output = simulateRole('outreach_writer', {
    company: { name: 'Flanders EV Solutions NV', industry: 'EV battery systems' },
    contact: { fullName: 'Jan Peeters' },
    product: {
      name: 'EV battery bracket',
      certifications: ['ISO 9001', 'IATF 16949'],
      moq: '200 pcs',
      leadTime: '25-35 days',
    },
    language: 'en',
    step: {
      subjectTemplate: 'EV battery brackets for {{companyName}}',
      bodyTemplate: 'Hi {{contactFirstName}},\n\nCertifications: ISO 9001, IATF 16949. MOQ 200 pcs. Lead time 25-35 days.',
      language: 'en',
    },
  });
  assert.equal((output.body.match(/Certifications/gi) || []).length, 1);
  assert.equal((output.body.match(/MOQ/g) || []).length, 1);
  assert.equal((output.body.match(/Lead time/gi) || []).length, 1);
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach omits untranslatable Chinese facts from the English body and reports them', () => {
  const output = simulateRole('outreach_writer', {
    company: { name: 'Beispiel GmbH', industry: 'industrial equipment' },
    contact: { fullName: 'Jan Peeters' },
    product: { name: 'Valve', moq: '两百件', leadTime: '三个月' },
    language: 'en',
    step: { subjectTemplate: 'Valves for {{companyName}}', bodyTemplate: 'Hello {{contactFirstName}}, our valve may fit.' },
  });
  assert.equal(/[\u4e00-\u9fff]/.test(output.body), false);
  assert.ok(output.riskNotes.some((note) => note.includes('无法本地化')));
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach localizes hardcoded Chinese units inside campaign templates without duplicate facts', () => {
  const output = simulateRole('outreach_writer', {
    company: { name: 'Flanders EV Solutions NV', industry: 'EV battery systems' },
    contact: { fullName: 'Jan Peeters' },
    product: {
      name: 'EV battery bracket',
      certifications: ['ISO 9001（质量体系认证）'],
      moq: '200 件',
      leadTime: '25-35 天',
    },
    language: 'en',
    step: {
      subjectTemplate: 'EV battery brackets for {{companyName}}',
      bodyTemplate:
        'Hi {{contactFirstName}},\n\nMOQ 200 件, lead time 25-35 天, certification ISO 9001（质量体系认证）.',
      language: 'en',
    },
  });
  assert.match(output.body, /MOQ 200 pcs/);
  assert.match(output.body, /lead time 25-35 days/);
  assert.match(output.body, /ISO 9001\./);
  assert.equal(/[件天（]/.test(output.body), false);
  assert.equal((output.body.match(/Certifications from our product data/gi) || []).length, 0);
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach flags unlocalizable Chinese template text instead of silently mixing languages', () => {
  const output = simulateRole('outreach_writer', {
    company: { name: 'Beispiel GmbH', industry: 'industrial equipment' },
    contact: { fullName: 'Jan Peeters' },
    product: { name: 'Valve' },
    language: 'en',
    step: { subjectTemplate: 'Valves for {{companyName}}', bodyTemplate: '您好，我们提供工业阀门，期待合作。' },
  });
  assert.ok(output.riskNotes.some((note) => note.includes('无法本地化')));
  assert.equal(validateOutput(output, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('outreach simulation keeps the requested language and never invents a translated product name', () => {
  const german = simulateRole('outreach_writer', SAMPLE_INPUTS.outreach_writer);
  assert.equal(german.language, 'de');
  assert.match(german.body, /Guten Tag,/);
  assert.match(german.body, /Zertifizierungen/);
  assert.equal(/[\u4e00-\u9fff]/.test(german.body), false);
  assert.equal(validateOutput(german, OUTPUT_SCHEMAS.outreach_writer).ok, true);

  const latinWithChineseProduct = simulateRole('outreach_writer', {
    company: { name: 'Flanders EV Solutions NV', industry: 'EV manufacturing' },
    product: { name: 'EV 电池包支架 C 型', certifications: ['ISO 9001'] },
    language: 'en',
    settings: { includeUnsubscribe: true },
  });
  assert.equal(latinWithChineseProduct.language, 'en');
  assert.equal(/[\u4e00-\u9fff]/.test(latinWithChineseProduct.subject), false);
  assert.equal(/[\u4e00-\u9fff]/.test(latinWithChineseProduct.body), false);
  assert.ok(latinWithChineseProduct.riskNotes.some((note) => note.includes('中文')));
  assert.equal(validateOutput(latinWithChineseProduct, OUTPUT_SCHEMAS.outreach_writer).ok, true);
});

test('quality_review returns structured issues for language mismatch and unresolved template variables', () => {
  const mismatch = simulateRole('quality_review', {
    draft: { subject: 'Quick question', body: '您好，我们提供工业阀门。', language: 'en' },
    language: 'en',
    claims: [],
  });
  assert.equal(validateOutput(mismatch, OUTPUT_SCHEMAS.quality_review).ok, true);
  assert.ok(mismatch.issues.some((issue) => issue.category === 'language' && issue.severity === 'high'));
  assert.notEqual(mismatch.verdict, 'pass');
  assert.ok(Array.isArray(mismatch.issues) && mismatch.issues.length > 0);
  for (const issue of mismatch.issues) {
    assert.ok(['low', 'medium', 'high'].includes(issue.severity));
    assert.ok(issue.category);
    assert.ok(issue.message);
    assert.ok(issue.suggestion);
  }

  const placeholder = simulateRole('quality_review', {
    draft: { subject: 'Hello {{companyName}}', body: 'Our product may fit your programme.', language: 'en' },
    language: 'en',
    claims: [],
  });
  assert.ok(placeholder.issues.some((issue) => issue.severity === 'high' && issue.message.includes('模板变量')));
  assert.notEqual(placeholder.verdict, 'pass');
});

test('execution list filters by role and status', async () => {
  const filtered = listExecutions(env.workspaceId, { role: 'outreach_writer', page: 1, pageSize: 50 });
  assert.ok(filtered.total >= 1);
  for (const item of filtered.items) {
    assert.equal(item.role, 'outreach_writer');
  }
  const succeeded = listExecutions(env.workspaceId, { status: 'succeeded', page: 1, pageSize: 50 });
  assert.ok(succeeded.total >= 1);
  for (const item of succeeded.items) assert.equal(item.status, 'succeeded');
  const failed = listExecutions(env.workspaceId, { status: 'failed', page: 1, pageSize: 50 });
  assert.equal(failed.total, 0);
});
