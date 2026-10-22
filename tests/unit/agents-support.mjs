/**
 * Shared support for the agent unit/integration tests.
 *
 * Not a `*.test.mjs` file, so `node --test tests/unit/agents-*.test.mjs` does not
 * execute it directly.
 *
 * IMPORTANT: this module is imported *before* the agent modules in every test
 * file (import order matters). It clears operator AI_* environment variables so
 * a developer machine with a real key configured can never trigger a network
 * call during the test run; tests only exercise the deterministic simulation
 * provider or explicit fake providers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

for (const key of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) delete process.env[key];

import { closeDatabase, migrate, openDatabase, run } from '../../server/core/db.mjs';
import { setSecretForTests } from '../../server/core/secrets.mjs';
import { bootstrapWorkspace } from '../../server/core/auth.mjs';
import { hashPassword } from '../../server/core/crypto.mjs';
import { ensureWorkspaceDefaults, updateSettings } from '../../server/services/settings.mjs';
import { id } from '../../server/core/ids.mjs';
import { nowIso } from '../../server/core/time.mjs';

export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const TEST_PASSWORD = 'Testpass12345';

function createExtraWorkspace(name = '隔离工作空间') {
  const workspaceId = id('wsp');
  const userId = id('usr');
  const email = `iso-${randomBytes(4).toString('hex')}@test.local`;
  const now = nowIso();
  run(
    `INSERT INTO users (id, email, password_hash, name, locale, is_active, created_at, updated_at)
     VALUES (?, ?, ?, '隔离用户', 'zh-CN', 1, ?, ?)`,
    [userId, email, hashPassword(TEST_PASSWORD), now, now],
  );
  run(
    `INSERT INTO workspaces (id, name, slug, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
    [workspaceId, name, `ws-${workspaceId.slice(-8).toLowerCase()}`, now, now],
  );
  run(
    `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    [id('mem'), workspaceId, userId, now, now],
  );
  ensureWorkspaceDefaults(workspaceId);
  return { workspaceId, userId, email };
}

/**
 * Create an isolated temp SQLite database with migrations + bootstrap owner.
 * @returns {{workspaceId:string, userId:string, dir:string, cleanup:Function, createWorkspace:Function}}
 */
export function createAgentTestEnv({ settingsPatch = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-agents-'));
  const dbFile = path.join(dir, 'agents-test.sqlite');
  const db = openDatabase(dbFile);
  migrate(db, path.join(ROOT_DIR, 'server', 'db', 'migrations'));
  setSecretForTests(randomBytes(48));
  const bootstrap = bootstrapWorkspace({
    workspaceName: 'Agent 单元测试空间',
    email: `agents-${randomBytes(4).toString('hex')}@test.local`,
    password: TEST_PASSWORD,
    name: 'Agent 管理员',
  });
  ensureWorkspaceDefaults(bootstrap.workspace.id);
  if (settingsPatch) updateSettings(bootstrap.workspace.id, settingsPatch, {});
  return {
    workspaceId: bootstrap.workspace.id,
    userId: bootstrap.user.id,
    dir,
    db,
    createWorkspace(name) {
      return createExtraWorkspace(name);
    },
    cleanup() {
      closeDatabase();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp cleanup may fail on Windows while handles are closing
      }
    },
  };
}

/** Representative, fact-only input per role used by simulation tests. */
export const SAMPLE_INPUTS = {
  orchestrator: {
    goal: '在德国寻找工业阀门采购商，完成评估并生成首封开发信',
    context: { targetCountries: ['DE'], language: 'de' },
  },
  market_research: {
    objective: '寻找德国工业阀门采购商',
    icp: {
      name: '德国工业阀门采购商',
      targetCountries: ['DE'],
      includeKeywords: ['industrial valves', 'valve distributor'],
      excludeKeywords: ['retail only'],
    },
    countries: ['DE'],
    keywords: ['industrial valves'],
  },
  company_qualification: {
    company: {
      name: 'Beispiel Valves GmbH',
      country: 'DE',
      industry: 'industrial equipment distribution',
      companyType: 'distributor',
      domain: 'beispiel-valves.de',
      description: 'Distributor of industrial valves and fittings for water treatment plants.',
    },
    icp: { targetCountries: ['DE'], includeKeywords: ['industrial valves'], excludeKeywords: ['retail only'] },
  },
  contact_research: {
    company: { name: 'Beispiel Valves GmbH', country: 'DE', industry: 'industrial equipment' },
    icp: { targetRoles: ['采购经理', '技术负责人'] },
  },
  product_matching: {
    company: { name: 'Beispiel Valves GmbH', industry: 'water treatment' },
    product: {
      name: 'Industrial Valve X1',
      category: 'valves',
      applications: ['water treatment', 'industrial piping'],
      certifications: ['ISO 9001'],
      description: 'Stainless steel industrial valve for water treatment lines.',
    },
    icp: { targetCountries: ['DE'] },
  },
  outreach_writer: {
    company: { name: 'Beispiel Valves GmbH', industry: 'industrial equipment distribution', country: 'DE' },
    contact: { fullName: 'Anna Schmidt', title: 'Head of Procurement', firstName: 'Anna' },
    product: {
      name: 'Industrial Valve X1',
      certifications: ['ISO 9001'],
      moq: '500 pcs',
      leadTime: '6 weeks',
    },
    language: 'de',
    includeUnsubscribe: true,
    sender: { name: 'Thomas Chen', title: 'Sales Manager', companyName: 'ZHIRAI', address: 'Berlin, Germany' },
    settings: { compliance: { senderCompanyName: 'ZHIRAI', senderAddress: 'Berlin, Germany' } },
  },
  reply_classification: {
    message: {
      subject: 'Re: Industrial Valve X1',
      body: 'Thank you. Please send us a quotation for 500 units, including delivery time.',
      language: 'en',
    },
    language: 'en',
  },
  follow_up_planning: {
    classification: { label: 'quote_request', confidence: 0.8 },
    thread: { subject: 'Re: Industrial Valve X1', messageCount: 2 },
    company: { name: 'Beispiel Valves GmbH' },
  },
  compliance_guard: {
    draft: {
      subject: 'Industrial Valve X1 for Beispiel Valves GmbH',
      body: 'Hello, our ISO 9001 listed product may fit your procurement needs. If you prefer not to receive further emails, reply "unsubscribe".',
    },
    contact: { emailStatus: 'valid', email: 'anna.schmidt@beispiel-valves.de' },
    automationState: 'AUTOMATION_ACTIVE',
    settings: { includeUnsubscribe: true, legalBasis: 'legitimate_interest' },
    suppression: { hit: false },
  },
  quality_review: {
    draft: {
      subject: 'Industrial Valve X1 for Beispiel Valves GmbH',
      body: 'Hello, our ISO 9001 listed product may fit your procurement needs in water treatment. Would a short call next week be useful?',
    },
    claims: [{ text: '产品名称：Industrial Valve X1', source: 'product.name' }],
    product: { name: 'Industrial Valve X1', certifications: ['ISO 9001'] },
    language: 'en',
  },
};

/** Context per convenience function (minimal-context assembly tests). */
export const CONVENIENCE_CONTEXTS = {
  generateOutreachDraft: {
    company: { name: 'Beispiel Valves GmbH', industry: 'industrial equipment distribution' },
    contact: { fullName: 'Anna Schmidt', firstName: 'Anna' },
    product: { name: 'Industrial Valve X1', certifications: ['ISO 9001'], moq: '500 pcs', leadTime: '6 weeks' },
    campaignStep: { subjectTemplate: 'Industrial valves for {{companyName}}', bodyTemplate: 'Hello {{firstName}}, our {{productName}} may fit your programme.' },
    sender: { name: 'Thomas Chen', companyName: 'ZHIRAI' },
    language: 'de',
  },
  qualifyCompany: SAMPLE_INPUTS.company_qualification,
  classifyReply: SAMPLE_INPUTS.reply_classification,
  planFollowUp: SAMPLE_INPUTS.follow_up_planning,
  companyResearch: SAMPLE_INPUTS.market_research,
  matchProduct: SAMPLE_INPUTS.product_matching,
  complianceCheck: SAMPLE_INPUTS.compliance_guard,
  reviewQuality: SAMPLE_INPUTS.quality_review,
};

/** Fake provider for retry/error tests. Responses are consumed in order. */
export function createFakeProvider(responses, { pricing = { inputPer1k: 0.001, outputPer1k: 0.002 }, isSimulation = false } = {}) {
  const calls = [];
  return {
    key: 'fake-provider',
    model: 'fake-model-1',
    isSimulation,
    pricing,
    calls,
    async complete(request) {
      calls.push(request);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return {
        text: typeof next === 'string' ? next : JSON.stringify(next),
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: 'fake-model-1',
      };
    },
    async test() {
      return { sample: { ok: true } };
    },
  };
}
