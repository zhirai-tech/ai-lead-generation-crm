/**
 * Agent catalogue.
 *
 * `AGENT_CATALOG` is the public contract (docs/CONTRACTS.md 7.3). The prompt
 * bodies and output schemas stay server-side and are only reachable through
 * `getAgent()` / `loadPrompt()` inside the runner.
 */
import { AGENT_ROLES } from './roles.mjs';
import { OUTPUT_SCHEMAS } from './schemas.mjs';
import { loadPrompt } from './prompts.mjs';

const META = [
  {
    role: 'orchestrator',
    name: 'Orchestrator',
    nameZh: '任务编排',
    description: '理解用户目标，拆解为可执行的子任务并指定负责角色；只做规划，不直接改写业务数据。',
    capabilities: ['planning', 'decomposition', 'routing'],
    inputFields: ['goal', 'context'],
  },
  {
    role: 'market_research',
    name: 'Market Research',
    nameZh: '市场调研',
    description: '根据 ICP 与国家/关键词产出可验证的企业发现搜索策略，不虚构任何企业名称或联系方式。',
    capabilities: ['research', 'search_strategy'],
    inputFields: ['objective', 'icp', 'countries', 'keywords', 'existingCompanies'],
  },
  {
    role: 'company_qualification',
    name: 'Company Qualification',
    nameZh: '企业资质评分',
    description: '按 ICP 对企业打分（0-100），给出等级、可追溯因素、排除项与事实/推断区分。',
    capabilities: ['qualification', 'scoring', 'evidence'],
    inputFields: ['company', 'icp', 'product', 'signals'],
  },
  {
    role: 'contact_research',
    name: 'Contact Research',
    nameZh: '联系人研究',
    description: '规划决策链角色、部门与检索方式；不编造姓名、邮箱或电话。',
    capabilities: ['contact_research', 'role_prioritization'],
    inputFields: ['company', 'icp', 'existingContacts'],
  },
  {
    role: 'product_matching',
    name: 'Product Matching',
    nameZh: '产品匹配',
    description: '基于产品资料与采购场景给出匹配理由与证据，区分已知事实与推断。',
    capabilities: ['matching', 'evidence'],
    inputFields: ['company', 'product', 'icp'],
  },
  {
    role: 'outreach_writer',
    name: 'Outreach Writer',
    nameZh: '开发信撰写',
    description: '生成个性化开发信，只引用输入中的事实，并列出 claims 与风险提示。',
    capabilities: ['writing', 'personalization'],
    inputFields: ['company', 'contact', 'product', 'campaignStep', 'sender', 'settings', 'language', 'facts'],
  },
  {
    role: 'reply_classification',
    name: 'Reply Classification',
    nameZh: '回复分类',
    description: '识别客户回复的意图标签、置信度与意向分数，输出证据与建议回复。',
    capabilities: ['classification', 'intent'],
    inputFields: ['message', 'thread', 'company', 'contact'],
  },
  {
    role: 'follow_up_planning',
    name: 'Follow-up Planning',
    nameZh: '跟进规划',
    description: '根据沟通状态给出下一步动作、到期天数、任务标题与草稿提示。',
    capabilities: ['planning', 'follow_up'],
    inputFields: ['thread', 'classification', 'company', 'contact'],
  },
  {
    role: 'compliance_guard',
    name: 'Compliance Guard',
    nameZh: '合规检查',
    description: '检查退订、拒绝联系、自动化状态与不当承诺，给出 allowed / blockers / warnings。',
    capabilities: ['compliance', 'guard'],
    inputFields: ['draft', 'contact', 'company', 'settings', 'suppression', 'automationState'],
  },
  {
    role: 'quality_review',
    name: 'Quality Review',
    nameZh: '质量复核',
    description: '复核事实依据、语言质量与不当承诺，返回 verdict / score / issues。',
    capabilities: ['review', 'quality'],
    inputFields: ['draft', 'claims', 'campaignStep', 'product', 'company', 'language'],
  },
  {
    role: 'keyword_research',
    name: 'Keyword Research',
    nameZh: '关键词研究',
    description: '基于产品名称/分类/规格/应用/材料扩展英文 B2B 关键词、否定词与搜索式，不编造认证或客户。',
    capabilities: ['research', 'keywords', 'seo'],
    inputFields: ['product', 'icp'],
  },
  {
    role: 'tool_agent',
    name: 'Tool Agent',
    nameZh: '只读工具决策',
    description: '内部角色：根据目标和真实工具结果决定下一步只读工具调用或结束任务。',
    capabilities: ['planning', 'tool_selection', 'evidence'],
    inputFields: ['goal', 'toolCatalog', 'history', 'lastToolResult'],
    internal: true,
  },
];

for (const entry of META) {
  const prompt = loadPrompt(entry.role);
  if (!OUTPUT_SCHEMAS[entry.role]) throw new Error(`no output schema registered for role ${entry.role}`);
  if (prompt.role !== entry.role) throw new Error(`prompt front matter role mismatch for ${entry.role}`);
}

const DEFINITIONS = META.map((entry) => {
  const prompt = loadPrompt(entry.role);
  return Object.freeze({
    ...entry,
    promptVersion: prompt.promptVersion,
    promptVersionNumber: prompt.version,
    outputSchema: OUTPUT_SCHEMAS[entry.role],
  });
});

const DEFINITION_MAP = new Map(DEFINITIONS.map((definition) => [definition.role, definition]));

/** Public, browser-safe catalogue entries (no prompt text, no schema bodies). */
export const AGENT_CATALOG = Object.freeze(
  DEFINITIONS.filter((definition) => definition.internal !== true).map((definition) =>
    Object.freeze({
      role: definition.role,
      name: definition.name,
      nameZh: definition.nameZh,
      description: definition.description,
      promptVersion: definition.promptVersion,
      capabilities: definition.capabilities,
      inputFields: definition.inputFields,
    }),
  ),
);

export function getAgent(role) {
  return DEFINITION_MAP.get(role) || null;
}

export function listAgentRoles() {
  return [...AGENT_ROLES];
}

export default { AGENT_CATALOG, getAgent, listAgentRoles };
