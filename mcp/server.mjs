#!/usr/bin/env node
/**
 * ZHIRAI MCP server (stdio, JSON-RPC 2.0).
 *
 * This is a real MCP server, not the browser tool registry. It is meant to be
 * launched by the desktop shell or an MCP client on the same machine, with the
 * workspace scoped by ZHIRAI_WORKSPACE_ID. It never exposes the HTTP session or
 * API key to the model; tool results are read from the local SQLite database.
 */
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.mjs';
import { all, closeDatabase, openDatabase } from '../server/core/db.mjs';
import { migrate } from '../server/core/db.mjs';
import * as companiesService from '../server/services/companies.mjs';
import * as enrichment from '../server/services/enrichment.mjs';
import { browserSearch, closeBrowser } from '../server/services/browser-contact.mjs';
import * as discoveryService from '../server/services/discovery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const PROTOCOL_VERSION = '2024-11-05';

const db = openDatabase(config.dbFile);
migrate(db, path.join(projectRoot, 'server', 'db', 'migrations'));

function workspaceId() {
  if (process.env.ZHIRAI_WORKSPACE_ID) return process.env.ZHIRAI_WORKSPACE_ID;
  const row = all('SELECT id FROM workspaces ORDER BY created_at LIMIT 1')[0];
  if (!row) throw new Error('没有可用的工作空间');
  return row.id;
}

const TOOLS = [
  {
    name: 'company.list',
    description: '列出本地客户库中的企业，可按国家、状态、关键词、是否有邮箱筛选。返回联系方式完整度和客户阶段。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        country: { type: 'string' },
        status: { type: 'string' },
        hasEmail: { type: 'boolean' },
        hasPhone: { type: 'boolean' },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'company.get',
    description: '读取一家企业的完整资料、联系人、来源与时间线。',
    inputSchema: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'company.evidence',
    description: '读取企业证据：来源 URL、抓取页面、邮箱/电话、验证记录。用于核对客户资料，不允许编造。',
    inputSchema: {
      type: 'object',
      properties: { companyId: { type: 'string' }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } },
      required: ['companyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.search',
    description: '当搜索 API 没有结果或需要更多结果时，使用本机 Chrome/Edge 真实打开搜索引擎并返回官网结果。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        engine: { type: 'string', enum: ['duckduckgo', 'bing'], default: 'duckduckgo' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'company.enrich',
    description: '打开企业官网/Kontakt/Impressum，抓取邮箱、电话、地址和社交链接，并写入本地联系人。',
    inputSchema: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'company.enrich_batch',
    description: '批量补全企业联系方式，失败会逐条返回原因，不会中断其他企业。',
    inputSchema: {
      type: 'object',
      properties: {
        companyIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      },
      required: ['companyIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'discovery.start',
    description: '用本地数据源执行一次真实企业发现。返回新建企业、联系方式和证据。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['tavily', 'osm', 'brave', 'serper', 'csv'] },
        keywords: { type: 'array', items: { type: 'string' }, minItems: 1 },
        countries: { type: 'array', items: { type: 'string' } },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        industry: { type: 'string' },
      },
      required: ['keywords'],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError: false,
  };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: String(message || 'MCP 工具执行失败') }],
    isError: true,
  };
}

async function callTool(name, args = {}) {
  const ws = workspaceId();
  if (name === 'company.list') {
    const result = companiesService.listCompanies(ws, {
      q: args.q || '',
      country: args.country || '',
      status: args.status || '',
      hasEmail: typeof args.hasEmail === 'boolean' ? args.hasEmail : null,
      hasPhone: typeof args.hasPhone === 'boolean' ? args.hasPhone : null,
      page: 1,
      pageSize: Math.min(100, Number(args.pageSize) || 20),
    });
    return {
      total: result.total,
      items: (result.items || []).map((company) => ({
        id: company.id,
        name: company.name,
        domain: company.domain,
        website: company.website,
        country: company.country,
        phone: company.phone,
        address: company.address,
        emailCount: company.emailCount,
        contactCompleteness: company.contactCompleteness,
        leadStage: company.leadStage,
      })),
    };
  }
  if (name === 'company.get') {
    return companiesService.getCompanyDetail(ws, String(args.companyId || ''));
  }
  if (name === 'company.evidence') {
    const detail = companiesService.getCompanyDetail(ws, String(args.companyId || ''));
    return {
      company: detail.company,
      sources: companiesService.getCompanySources(ws, String(args.companyId || ''), {
        page: 1,
        pageSize: Math.min(100, Number(args.pageSize) || 50),
      }),
      contacts: detail.contacts || [],
      verifications: detail.verifications || [],
      timeline: detail.timeline || [],
    };
  }
  if (name === 'browser.search') {
    const result = await browserSearch(String(args.query || ''), {
      engine: args.engine === 'bing' ? 'bing' : 'duckduckgo',
    });
    return { ...result, results: (result.results || []).slice(0, Number(args.maxResults) || 10) };
  }
  if (name === 'company.enrich') {
    return enrichment.enrichCompany({ workspaceId: ws, companyId: String(args.companyId || ''), actorId: null });
  }
  if (name === 'company.enrich_batch') {
    const ids = Array.isArray(args.companyIds) ? args.companyIds.slice(0, 20).map(String) : [];
    const results = [];
    for (const companyId of ids) {
      try {
        const value = await enrichment.enrichCompany({ workspaceId: ws, companyId, actorId: null });
        results.push({ companyId, ok: true, contactsCreated: value.contactsCreated, emailsFound: value.emailsFound, error: null });
      } catch (error) {
        results.push({ companyId, ok: false, contactsCreated: 0, emailsFound: 0, error: String(error?.message || error) });
      }
    }
    return { results, completed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
  }
  if (name === 'discovery.start') {
    const run = await discoveryService.createDiscoveryRun(ws, {
      provider: args.provider || 'tavily',
      keywords: Array.isArray(args.keywords) ? args.keywords : [],
      countries: Array.isArray(args.countries) ? args.countries : [],
      maxResults: Math.min(50, Number(args.maxResults) || 20),
      industry: args.industry || null,
    }, { actorId: null });
    const result = await discoveryService.executeDiscoveryRun(ws, run.id, { actorId: null });
    return { run, result };
  }
  throw new Error(`未知工具：${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'zhirai-outreach-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOLS.some((tool) => tool.name === name)) {
      send({ jsonrpc: '2.0', id, result: errorResult(`未知工具：${name}`) });
      return;
    }
    Promise.resolve()
      .then(() => callTool(name, args))
      .then((value) => send({ jsonrpc: '2.0', id, result: textResult(value) }))
      .catch((error) => send({ jsonrpc: '2.0', id, result: errorResult(error?.message || error) }));
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message || 'parse error') } });
  }
});
rl.on('close', () => {
  closeDatabase();
  process.exit(0);
});
