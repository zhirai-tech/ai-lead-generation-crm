/** OWNER: lead. Assistant MCP-style tool registry (first tools). */
import { asArray, asBool, asEnum, asInt, asObject, asString } from '../core/validate.mjs';
import { validationError } from '../core/errors.mjs';
import * as icpsService from '../services/icps.mjs';
import * as productsService from '../services/products.mjs';
import * as companiesService from '../services/companies.mjs';
import * as contactsService from '../services/contacts.mjs';
import * as draftsService from '../services/drafts.mjs';
import * as discoveryService from '../services/discovery.mjs';
import { resolveProvider } from '../agents/providers/index.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = {
  auth: 'required',
  capability: 'data.write',
  rateLimit: { windowMs: 60_000, max: 15 },
};
const APPROVE = {
  auth: 'required',
  capability: 'drafts.approve',
  rateLimit: { windowMs: 60_000, max: 20 },
};
const SEND = {
  auth: 'required',
  capability: 'drafts.approve',
  rateLimit: { windowMs: 60_000, max: 10 },
};
const RUN = {
  auth: 'required',
  capability: 'discovery.run',
  rateLimit: { windowMs: 60_000, max: 8 },
};

const TOOLS = [
  {
    name: 'icp.create',
    description: '创建客户画像 ICP。必须由用户在页面上再次确认后执行。',
    input: ['name', 'description', 'targetCountries', 'targetCompanyTypes', 'targetSizes', 'targetRoles', 'includeKeywords', 'excludeKeywords', 'minScore'],
    risk: 'write',
  },
  {
    name: 'copy.optimize',
    description: '创作型文案优化：润色客户画像描述、开发信段落、产品卖点。',
    input: ['text', 'kind'],
    risk: 'read',
  },
  {
    name: 'product.create',
    description: '创建产品资料。必须由用户确认后执行。',
    input: ['name', 'category', 'description', 'moq', 'leadTime', 'certifications', 'applications', 'keywords', 'materials', 'capacity', 'pricingTerms', 'samples'],
    risk: 'write',
  },
  {
    name: 'draft.generate',
    description: '为指定企业/联系人生成一封个性化开发信草稿（不发送）。',
    input: ['companyId', 'companyName', 'contactId', 'language'],
    risk: 'write',
  },
  {
    name: 'draft.approve',
    description: '批准一封待审批的开发信草稿。',
    input: ['draftId'],
    risk: 'approve',
  },
  {
    name: 'draft.send',
    description: '将一封已批准的草稿加入发送队列；发送窗口、限额、抑制与接管检查仍然生效。',
    input: ['draftId'],
    risk: 'send',
  },
  {
    name: 'discovery.start',
    description: '用选定的真实数据源启动一次企业发现。',
    input: ['provider', 'keywords', 'countries', 'maxResults', 'industry'],
    risk: 'write',
  },
];

function context(ctx) {
  return { actorId: ctx.user?.id || null, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

function stringArray(value, label) {
  return asArray(value || [], { max: 100, label }).filter((item) => typeof item === 'string');
}

export function mount(router) {
  router.get('/api/v1/assistant/tools', async () => ({ items: TOOLS }), READ);

  router.post(
    '/api/v1/assistant/tools/icp.create',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        name: asString(body.name, { required: true, max: 200, label: 'ICP 名称' }),
        description: asString(body.description, { max: 4000 }) || null,
        productId: body.productId ? asString(body.productId, { max: 100 }) : null,
        targetCountries: stringArray(body.targetCountries, '目标国家'),
        targetRegions: stringArray(body.targetRegions, '目标区域'),
        targetCompanyTypes: stringArray(body.targetCompanyTypes, '目标企业类型'),
        targetSizes: stringArray(body.targetSizes, '目标规模'),
        targetRoles: stringArray(body.targetRoles, '目标角色'),
        includeKeywords: stringArray(body.includeKeywords, '包含关键词'),
        excludeKeywords: stringArray(body.excludeKeywords, '排除关键词'),
        minScore: body.minScore === undefined ? 60 : asInt(body.minScore, { min: 0, max: 100, label: '最低评分' }),
        isActive: body.isActive === undefined ? true : asBool(body.isActive),
      };
      const icp = icpsService.createIcp(ctx.workspace.id, input, context(ctx));
      return { icp, tool: 'icp.create' };
    },
    WRITE,
  );

  router.post(
    '/api/v1/assistant/tools/copy.optimize',
    async (ctx) => {
      const text = asString(ctx.body?.text, { required: true, max: 4000, label: '待优化文本' });
      const kind = asString(ctx.body?.kind, { max: 40 }) || '外贸文案';
      const provider = resolveProvider(ctx.workspace.id);
      if (provider.providerKey === 'simulation') {
        return { text, note: '当前为模拟模型，未进行真实优化' };
      }
      const result = await provider.complete({
        messages: [
          {
            role: 'system',
            content: '你是资深欧洲 B2B 外贸文案与客户画像专家。保留事实，不编造客户、认证、价格或交期；让表达更清晰、专业、简洁，适合欧洲买家阅读。只输出优化后的正文，不要解释。',
          },
          { role: 'user', content: `优化以下${kind}（保持原意，中文或英文跟原文一致）：\n\n${text}` },
        ],
        jsonMode: false,
        maxTokensOverride: 900,
      });
      return { text: String(result?.text || '').trim(), kind };
    },
    WRITE,
  );

  router.post(
    '/api/v1/assistant/tools/product.create',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        name: asString(body.name, { required: true, max: 200, label: '产品名称' }),
        category: asString(body.category, { max: 120 }) || null,
        sku: asString(body.sku, { max: 80 }) || null,
        description: asString(body.description, { max: 4000 }) || null,
        specs: asObject(body.specs, { label: '产品规格' }),
        applications: stringArray(body.applications, '应用领域'),
        materials: asString(body.materials, { max: 500 }) || null,
        certifications: stringArray(body.certifications, '认证'),
        capacity: asString(body.capacity, { max: 500 }) || null,
        moq: asString(body.moq, { max: 200 }) || null,
        pricingTerms: asString(body.pricingTerms, { max: 500 }) || null,
        samples: asString(body.samples, { max: 500 }) || null,
        leadTime: asString(body.leadTime, { max: 200 }) || null,
        status: 'active',
        keywords: stringArray(body.keywords, '关键词'),
      };
      const product = productsService.createProduct(ctx.workspace.id, input, context(ctx));
      return { product, tool: 'product.create' };
    },
    WRITE,
  );

  router.post(
    '/api/v1/assistant/tools/draft.generate',
    async (ctx) => {
      const body = ctx.body || {};
      let company = null;
      if (body.companyId) {
        company = companiesService.getCompanyOrThrow(ctx.workspace.id, asString(body.companyId, { max: 100, label: '企业' }));
      } else {
        const companyName = asString(body.companyName, { required: true, max: 200, label: '企业名称' });
        const listed = companiesService.listCompanies(ctx.workspace.id, { q: companyName, page: 1, pageSize: 5 }, { key: 'updatedAt', direction: 'DESC' });
        const items = Array.isArray(listed) ? listed : listed?.items || [];
        company = items[0] || null;
      }
      if (!company) throw validationError('没有找到该企业，请先在企业发现或潜在客户中确认企业名称');
      let contact = null;
      if (body.contactId) {
        contact = contactsService.getContactOrThrow(ctx.workspace.id, asString(body.contactId, { max: 100, label: '联系人' }));
        if (contact.companyId !== company.id) throw validationError('联系人不属于该企业');
      } else {
        const listed = contactsService.listContacts(ctx.workspace.id, {
          companyId: company.id,
          hasEmail: true,
          limit: 1,
          offset: 0,
        }, { key: 'updatedAt', direction: 'DESC' });
        const items = Array.isArray(listed) ? listed : listed?.items || [];
        contact = items[0] || null;
      }
      if (!contact) throw validationError('该企业还没有带邮箱的联系人，请先在联系人库补充联系人');
      const language = asString(body.language, { max: 20 }) || 'en';
      const draft = draftsService.create(ctx.workspace.id, {
        companyId: company.id,
        contactId: contact.id,
        language,
      }, context(ctx));
      const generated = await draftsService.generateDraft({
        workspaceId: ctx.workspace.id,
        draftId: draft.id,
        actorType: 'user',
        actorId: ctx.user?.id || null,
      });
      return {
        tool: 'draft.generate',
        company: { id: company.id, name: company.name },
        contact: { id: contact.id, name: contact.fullName, email: contact.email },
        draft: generated.draft,
      };
    },
    { ...WRITE, rateLimit: { windowMs: 60_000, max: 10 } },
  );

  router.post(
    '/api/v1/assistant/tools/draft.approve',
    async (ctx) => {
      const draftId = asString(ctx.body?.draftId, { required: true, max: 100, label: '草稿' });
      const draft = draftsService.approveDraft(ctx.workspace.id, draftId, context(ctx));
      return { tool: 'draft.approve', draft };
    },
    APPROVE,
  );

  router.post(
    '/api/v1/assistant/tools/draft.send',
    async (ctx) => {
      const draftId = asString(ctx.body?.draftId, { required: true, max: 100, label: '草稿' });
      const result = await draftsService.sendDraft(ctx.workspace.id, draftId, context(ctx));
      return { tool: 'draft.send', ...result };
    },
    SEND,
  );

  router.post(
    '/api/v1/assistant/tools/discovery.start',
    async (ctx) => {
      const body = ctx.body || {};
      const keywords = stringArray(body.keywords, '关键词').filter(Boolean);
      const countries = stringArray(body.countries, '目标国家').map((code) => String(code).toUpperCase().slice(0, 2));
      const run = await discoveryService.createDiscoveryRun(
        ctx.workspace.id,
        {
          provider: asString(body.provider, { max: 40 }) || 'tavily',
          keywords: keywords.length ? keywords : ['B2B distributor'],
          countries,
          maxResults: body.maxResults === undefined ? 20 : asInt(body.maxResults, { min: 1, max: 100, label: '最大结果数' }),
          industry: asString(body.industry, { max: 120 }) || 'General B2B',
        },
        context(ctx),
      );
      return { tool: 'discovery.start', run };
    },
    RUN,
  );
}

export default { mount };
