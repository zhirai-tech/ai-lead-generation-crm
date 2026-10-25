/**
 * Phase 1 read-only tool registry.
 *
 * The model never receives a function name that can be executed directly.
 * Every call is validated against this allowlist and executed with a workspace
 * bound by the authenticated request/task, never by model-provided identity.
 *
 * No tool in this file may write customer data, send email, start discovery or
 * mutate the database. Adding a write tool requires a separate security review.
 */
import * as companiesService from '../services/companies.mjs';
import { browserSearch } from '../services/browser-contact.mjs';

export const READ_TOOL_NAMES = Object.freeze([
  'company.list',
  'company.get',
  'company.evidence',
  'browser.search',
]);

const TOOL_DEFINITIONS = Object.freeze({
  'company.list': {
    description: '列出当前工作空间中的企业。可按关键词、国家、状态、是否有邮箱/电话筛选。只读。',
    args: {
      q: '可选，搜索关键词，最多 200 字',
      country: '可选，ISO 2 位国家代码',
      status: '可选，企业状态，例如 new/qualified/contacted/replied/customer',
      hasEmail: '可选，布尔值',
      hasPhone: '可选，布尔值',
      pageSize: '可选，1-20，默认 10',
    },
  },
  'company.get': {
    description: '读取一家企业的完整资料和联系人。只读。',
    args: { companyId: '必填，当前工作空间中的企业 ID' },
  },
  'company.evidence': {
    description: '读取一家企业的来源、联系人、验证和时间线证据。只读。',
    args: { companyId: '必填，当前工作空间中的企业 ID' },
  },
  'browser.search': {
    description: '使用本机浏览器真实搜索公开网页，返回标题和 URL。只读，不写入客户库。',
    args: {
      query: '必填，搜索词，最多 500 字',
      engine: '可选，duckduckgo 或 bing',
      maxResults: '可选，1-10，默认 8',
    },
  },
});

const MAX_RESULT_BYTES = 14000;
const MAX_ARRAY = 20;
const MAX_STRING = 700;
const BROWSER_TIMEOUT_MS = 30000;
const BROWSER_CHANNEL = process.env.AGENT_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'auto');

export class ToolValidationError extends Error {
  constructor(message, { code = 'TOOL_INVALID_ARGUMENT' } = {}) {
    super(message);
    this.name = 'ToolValidationError';
    this.code = code;
  }
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolValidationError('工具参数必须是对象');
  }
  return value;
}

function assertAllowedKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ToolValidationError(`不允许的工具参数：${key}`);
  }
}

function optionalString(value, { label, max, required = false, pattern = null }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolValidationError(`${label}不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw new ToolValidationError(`${label}必须是字符串`);
  const text = value.trim();
  if (!text && required) throw new ToolValidationError(`${label}不能为空`);
  if (text.length > max) throw new ToolValidationError(`${label}过长`);
  if (pattern && !pattern.test(text)) throw new ToolValidationError(`${label}格式不正确`);
  return text;
}

function optionalBool(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'boolean') throw new ToolValidationError(`${label}必须是布尔值`);
  return value;
}

function optionalInt(value, { label, min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value)) throw new ToolValidationError(`${label}必须是整数`);
  if (value < min || value > max) throw new ToolValidationError(`${label}超出范围（${min}-${max}）`);
  return value;
}

function trimDeep(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => trimDeep(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) out[key] = trimDeep(item, depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  return value;
}

function capResult(value) {
  const safe = trimDeep(value);
  let text;
  try {
    text = JSON.stringify(safe);
  } catch {
    return { truncated: true, note: '结果无法序列化' };
  }
  if (text.length <= MAX_RESULT_BYTES) return safe;
  return {
    truncated: true,
    note: `结果超过 ${MAX_RESULT_BYTES} 字节，已截断`,
    preview: text.slice(0, MAX_RESULT_BYTES - 200),
  };
}

function mapCompany(company) {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    country: company.country,
    industry: company.industry,
    companyType: company.companyType,
    phone: company.phone,
    address: company.address,
    emailCount: company.emailCount,
    leadStage: company.leadStage,
    contactCompleteness: company.contactCompleteness,
    updatedAt: company.updatedAt,
  };
}

function mapContact(contact) {
  return {
    id: contact.id,
    fullName: contact.fullName,
    title: contact.title,
    email: contact.email,
    phone: contact.phone,
    roleCategory: contact.roleCategory,
    emailStatus: contact.emailStatus,
  };
}

function validateArgs(toolName, inputArgs) {
  const args = assertPlainObject(inputArgs || {});
  if (toolName === 'company.list') {
    assertAllowedKeys(args, ['q', 'country', 'status', 'hasEmail', 'hasPhone', 'pageSize']);
    return {
      q: optionalString(args.q, { label: '关键词', max: 200 }),
      country: optionalString(args.country, { label: '国家', max: 2, pattern: /^[A-Za-z]{2}$/ }),
      status: optionalString(args.status, { label: '状态', max: 40 }),
      hasEmail: optionalBool(args.hasEmail, 'hasEmail'),
      hasPhone: optionalBool(args.hasPhone, 'hasPhone'),
      pageSize: optionalInt(args.pageSize, { label: 'pageSize', min: 1, max: 20, fallback: 10 }),
    };
  }
  if (toolName === 'company.get' || toolName === 'company.evidence') {
    assertAllowedKeys(args, ['companyId']);
    return {
      companyId: optionalString(args.companyId, { label: 'companyId', max: 100, required: true }),
    };
  }
  if (toolName === 'browser.search') {
    assertAllowedKeys(args, ['query', 'engine', 'maxResults']);
    const engine = optionalString(args.engine, { label: 'engine', max: 20, pattern: /^(duckduckgo|bing)$/i }).toLowerCase();
    return {
      query: optionalString(args.query, { label: 'query', max: 500, required: true }),
      engine: engine || 'duckduckgo',
      maxResults: optionalInt(args.maxResults, { label: 'maxResults', min: 1, max: 10, fallback: 8 }),
    };
  }
  throw new ToolValidationError(`未注册的工具：${toolName}`, { code: 'TOOL_NOT_ALLOWED' });
}

let browserQueue = Promise.resolve();
const BROWSER_QUEUE_HARD_TIMEOUT_MS = 45000;

/**
 * Browser searches are serialized. Queue waiting and actual execution have
 * separate timeouts: a hard execution deadline starts only when the operation
 * leaves the queue. If an aborted search's underlying promise never settles,
 * abort its controller and quarantine that operation; the shared browser is not
 * closed and no user Chrome/Edge process is killed. This is a last-resort
 * isolation path, not the normal completion path.
 */
function runBrowserSearchExclusive(fn, { onHardTimeout = null, signal = null, hardTimeoutMs = BROWSER_QUEUE_HARD_TIMEOUT_MS } = {}) {
  const previous = browserQueue;
  const run = previous.then(() => {
    if (signal?.aborted) {
      return Promise.reject(new ToolValidationError('浏览器搜索在排队期间被取消', { code: 'TOOL_CANCELLED' }));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (settle, value) => {
        clearTimeout(timer);
        settle(value);
      };
      timer = setTimeout(() => {
        try { onHardTimeout?.(); } catch { /* best effort */ }
        reject(new ToolValidationError('浏览器队列操作超过硬性截止时间，已隔离旧操作', { code: 'TOOL_QUEUE_TIMEOUT' }));
      }, hardTimeoutMs);
      Promise.resolve()
        .then(fn)
        .then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  });
  browserQueue = run.catch(() => {});
  return run;
}

function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new ToolValidationError(`${label}超时（${timeoutMs}ms）`, { code: 'TOOL_TIMEOUT' }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function execute(toolName, args, workspaceId, signal = null, browserSearchImpl = browserSearch, browserHardTimeoutMs = BROWSER_QUEUE_HARD_TIMEOUT_MS) {
  if (toolName === 'company.list') {
    const filters = { page: 1, pageSize: args.pageSize };
    if (args.q) filters.q = args.q;
    if (args.country) filters.country = args.country.toUpperCase();
    if (args.status) filters.status = args.status;
    if (args.hasEmail !== null) filters.hasEmail = args.hasEmail;
    if (args.hasPhone !== null) filters.hasPhone = args.hasPhone;
    const result = companiesService.listCompanies(workspaceId, filters);
    const items = Array.isArray(result?.items) ? result.items : [];
    return {
      total: Number(result?.total || items.length),
      page: 1,
      pageSize: args.pageSize,
      items: items.slice(0, MAX_ARRAY).map(mapCompany),
    };
  }
  if (toolName === 'company.get') {
    const detail = companiesService.getCompanyDetail(workspaceId, args.companyId);
    return {
      company: mapCompany(detail.company || {}),
      contacts: (detail.contacts || []).slice(0, MAX_ARRAY).map(mapContact),
      timeline: (detail.timeline || []).slice(0, 10),
    };
  }
  if (toolName === 'company.evidence') {
    const detail = companiesService.getCompanyDetail(workspaceId, args.companyId);
    const sources = companiesService.getCompanySources(workspaceId, args.companyId, { page: 1, pageSize: 20 });
    const verifications = companiesService.getCompanyVerifications(workspaceId, args.companyId);
    return {
      company: mapCompany(detail.company || {}),
      sources: sources?.items || sources || [],
      contacts: (detail.contacts || []).slice(0, MAX_ARRAY).map(mapContact),
      verifications,
      timeline: (detail.timeline || []).slice(0, 20),
    };
  }
  if (toolName === 'browser.search') {
    const controller = new AbortController();
    const forwardAbort = () => {
      try { controller.abort(); } catch { /* best effort */ }
    };
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    return runBrowserSearchExclusive(async () => {
      try {
        const result = await withTimeout(
          browserSearchImpl(args.query, {
            channel: BROWSER_CHANNEL,
            engine: args.engine,
            timeoutMs: BROWSER_TIMEOUT_MS,
            launchTimeoutMs: 15000,
            dedicated: true,
            signal: controller.signal,
          }),
          BROWSER_TIMEOUT_MS + 5000,
          '浏览器搜索',
          forwardAbort,
        );
        if (result?.error === 'aborted') {
          throw new ToolValidationError('浏览器搜索已取消', { code: 'TOOL_CANCELLED' });
        }
        return {
          query: args.query,
          engine: args.engine,
          results: (result?.results || []).slice(0, args.maxResults).map((item) => ({
            title: String(item.title || '').slice(0, 300),
            url: String(item.url || '').slice(0, 500),
          })),
          error: result?.error || null,
        };
      } finally {
        if (signal) signal.removeEventListener('abort', forwardAbort);
        if (!controller.signal.aborted) {
          // No successful race should leave a browser operation running.
          try { controller.abort(); } catch { /* best effort */ }
        }
      }
    }, { onHardTimeout: forwardAbort, signal, hardTimeoutMs: browserHardTimeoutMs });
  }
  throw new ToolValidationError(`未注册的工具：${toolName}`, { code: 'TOOL_NOT_ALLOWED' });
}

export function listReadTools() {
  return READ_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DEFINITIONS[name].description,
    arguments: TOOL_DEFINITIONS[name].args,
  }));
}

/**
 * Validate and execute one tool call.
 * workspaceId is supplied by the server; model args cannot override it.
 */
export async function executeReadTool({ workspaceId, toolName, args, signal = null, browserSearchImpl = browserSearch, browserHardTimeoutMs = BROWSER_QUEUE_HARD_TIMEOUT_MS }) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new ToolValidationError('缺少服务端 workspace', { code: 'TOOL_WORKSPACE_MISSING' });
  }
  if (!READ_TOOL_NAMES.includes(toolName)) {
    throw new ToolValidationError(`未注册的工具：${toolName}`, { code: 'TOOL_NOT_ALLOWED' });
  }
  const validated = validateArgs(toolName, args);
  const result = await execute(toolName, validated, workspaceId, signal, browserSearchImpl, browserHardTimeoutMs);
  return {
    tool: toolName,
    arguments: validated,
    result: capResult(result),
  };
}

export default {
  READ_TOOL_NAMES,
  listReadTools,
  executeReadTool,
  ToolValidationError,
};
