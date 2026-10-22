/**
 * Discovery layer: create discovery runs, enqueue `discovery.search` jobs and
 * execute them from the worker via executeDiscoveryRun().
 *
 * Providers:
 *  - simulation  offline, deterministic demo companies for the European
 *                automotive parts industry (clearly marked as demo data);
 *  - search_api  generic HTTP JSON provider configured by the user (base URL,
 *                result path, field mapping) using stored credentials;
 *  - csv         discovery from uploaded/pasted CSV text.
 *
 * Search engine result pages are never scraped (ToS). Only provider APIs and
 * the company's own website (enrichment module) are used.
 */
import { get, tx } from '../core/db.mjs';
import { badRequest, conflict, notFound } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import { normalizeDomain, normalizeName } from '../core/validate.mjs';
import * as discoveryRepo from '../repositories/discovery.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import * as icpsRepo from '../repositories/icps.mjs';
import { createCompanyRecord, normalizeCompanyName, addCompanySource } from './companies.mjs';
import { getSetting, getCredential, listProviders } from './settings.mjs';

export const DISCOVERY_PROVIDERS = ['simulation', 'search_api', 'csv'];
export const DISCOVERY_IMPLEMENTED_ADAPTERS = ['simulation', 'search_api', 'csv'];

const SIMULATION_BRANDS = [
  'Rheinland', 'Nordkap', 'Alpen', 'Lyon', 'Milano', 'Iberia', 'Vistula', 'Bavaria', 'Hansa', 'Seine', 'Toscana',
  'Baltic', 'Danube', 'Carpathia', 'Flandria', 'Adria',
];
const SIMULATION_COUNTRIES = [
  { code: 'DE', cities: ['Stuttgart', 'Hamburg', 'München', 'Köln', 'Hannover'], region: 'Baden-Württemberg' },
  { code: 'FR', cities: ['Lyon', 'Lille', 'Bordeaux', 'Toulouse', 'Strasbourg'], region: 'Auvergne-Rhône-Alpes' },
  { code: 'IT', cities: ['Milano', 'Torino', 'Bologna', 'Verona', 'Napoli'], region: 'Lombardia' },
  { code: 'ES', cities: ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Bilbao'], region: 'Comunidad de Madrid' },
  { code: 'PL', cities: ['Poznań', 'Wrocław', 'Kraków', 'Gdańsk', 'Łódź'], region: 'Wielkopolska' },
  { code: 'NL', cities: ['Rotterdam', 'Amsterdam', 'Eindhoven', 'Utrecht', 'Breda'], region: 'Zuid-Holland' },
  { code: 'BE', cities: ['Antwerpen', 'Gent', 'Liège', 'Brussel', 'Brugge'], region: 'Vlaanderen' },
  { code: 'AT', cities: ['Wien', 'Graz', 'Linz', 'Salzburg', 'Innsbruck'], region: 'Wien' },
  { code: 'CZ', cities: ['Praha', 'Brno', 'Ostrava', 'Plzeň', 'Olomouc'], region: 'Praha' },
  { code: 'SE', cities: ['Göteborg', 'Malmö', 'Stockholm', 'Jönköping', 'Örebro'], region: 'Västra Götaland' },
  { code: 'PT', cities: ['Porto', 'Lisboa', 'Braga', 'Aveiro', 'Valencia'], region: 'Norte' },
  { code: 'DK', cities: ['København', 'Aarhus', 'Odense', 'Aalborg', 'Esbjerg'], region: 'Hovedstaden' },
];
const SIMULATION_TYPES = ['distributor', 'wholesaler', 'importer', 'retailer', 'manufacturer'];

function slugifyName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function asStringList(value, { max = 30 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, max);
}

export function normalizeDiscoveryQuery(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const queryText = typeof source.query === 'string' && source.query.trim() ? source.query.trim().slice(0, 500) : null;
  const nested = source.query && typeof source.query === 'object' ? source.query : {};
  const merged = { ...nested, ...source };
  delete merged.query;
  const countries = asStringList(merged.countries ?? merged.country).map((value) => value.toUpperCase().slice(0, 2));
  const companyTypes = asStringList(merged.companyTypes ?? merged.companyType);
  const keywords = asStringList(merged.keywords ?? merged.q ?? merged.queryText ?? queryText, { max: 20 });
  const limitValue = Number(merged.limit ?? merged.maxResults);
  return {
    keywords,
    countries,
    companyTypes,
    industry: merged.industry ? String(merged.industry).slice(0, 120) : 'Automotive Aftermarket',
    region: merged.region ? String(merged.region).slice(0, 120) : null,
    icpId: merged.icpId ? String(merged.icpId).slice(0, 100) : null,
    productId: merged.productId ? String(merged.productId).slice(0, 100) : null,
    limit: Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.round(limitValue))) : 25,
    csvText: typeof merged.csvText === 'string' ? merged.csvText.slice(0, 2_000_000) : typeof merged.csv === 'string' ? merged.csv.slice(0, 2_000_000) : null,
    rows: Array.isArray(merged.rows) ? merged.rows.slice(0, 500) : null,
    raw: Object.fromEntries(
      Object.entries(merged).filter(([key]) => !['csvText', 'csv', 'rows'].includes(key)).slice(0, 30),
    ),
  };
}

async function tryEnqueueDiscoveryJob(workspaceId, runId, actorId) {
  try {
    const { enqueueJob } = await import('../jobs/queue.mjs');
    const result = enqueueJob({
      workspaceId,
      type: 'discovery.search',
      payload: { discoveryRunId: runId },
      dedupeKey: `discovery.search:${workspaceId}:${runId}`,
      createdBy: actorId || null,
    });
    return { queued: true, jobId: result?.id || null, deduped: Boolean(result?.deduped) };
  } catch (error) {
    return { queued: false, jobId: null, error: error.message };
  }
}

export async function createDiscoveryRun(workspaceId, input, context = {}) {
  const provider = input.provider ? String(input.provider) : 'simulation';
  if (!DISCOVERY_PROVIDERS.includes(provider)) throw badRequest('不支持的发现数据源');
  if (provider === 'search_api') {
    const providerRow = get(
      "SELECT * FROM external_providers WHERE workspace_id = ? AND key = 'search_api'",
      [workspaceId],
    );
    if (!providerRow || !providerRow.is_enabled) throw badRequest('请先在设置中启用「可配置搜索 API」数据源');
  }
  if (discoveryRepo.countActiveRuns(workspaceId) >= 10) throw conflict('同时运行的发现任务过多，请稍后再试');
  const query = normalizeDiscoveryQuery(input);
  if (provider === 'csv' && !query.csvText && !query.rows) throw badRequest('CSV 发现需要提供 csvText 或 rows');
  const runId = id('dr');
  const run = discoveryRepo.insertDiscoveryRun({
    id: runId,
    workspace_id: workspaceId,
    query,
    provider,
    status: 'queued',
    created_by: context.actorId || null,
    created_at: nowIso(),
  });
  const job = await tryEnqueueDiscoveryJob(workspaceId, runId, context.actorId);
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'discovery.run_create',
    entityType: 'discovery_run',
    entityId: runId,
    after: { provider, query, job },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { ...run, job };
}

export function listDiscoveryRuns(workspaceId, filters, sort) {
  return discoveryRepo.listDiscoveryRuns(workspaceId, { ...filters, sortDirection: sort?.direction });
}

export function getDiscoveryRunDetail(workspaceId, runId) {
  const run = discoveryRepo.findDiscoveryRun(workspaceId, runId);
  if (!run) throw notFound('发现任务不存在');
  const companyIds = companiesRepo.findCompaniesByDiscoveryRun(workspaceId, runId, { limit: 100 });
  const companies = companyIds.map((companyId) => companiesRepo.findCompany(workspaceId, companyId)).filter(Boolean);
  return { ...run, companies, results: companies };
}

export function cancelDiscoveryRun(workspaceId, runId, context = {}) {
  const run = discoveryRepo.findDiscoveryRun(workspaceId, runId);
  if (!run) throw notFound('发现任务不存在');
  if (run.status === 'cancelled') return run;
  if (!['queued', 'running'].includes(run.status)) throw conflict('该发现任务已结束，无法取消');
  const updated = discoveryRepo.updateDiscoveryRun(workspaceId, runId, {
    status: 'cancelled',
    finished_at: nowIso(),
    error: '已由用户取消',
  });
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'discovery.run_cancel',
    entityType: 'discovery_run',
    entityId: runId,
    after: { status: 'cancelled' },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return updated;
}

export function listDiscoveryProviders(workspaceId) {
  const rows = listProviders(workspaceId).filter((provider) => provider.category === 'search');
  return rows.map((provider) => {
    const implemented = DISCOVERY_IMPLEMENTED_ADAPTERS.includes(provider.adapter);
    const item = {
      key: provider.key,
      name: provider.name,
      adapter: provider.adapter,
      capabilities: provider.capabilities,
      costModel: provider.costModel,
      config: provider.config,
      isEnabled: provider.isEnabled,
      implemented,
      offline: provider.adapter === 'simulation',
    };
    if (provider.key === 'search_api') {
      const credential = getCredential(workspaceId, 'data_provider', 'search_api');
      item.hasCredential = Boolean(credential && credential.secret);
      item.config = { ...provider.config, ...(credential?.config || {}) };
    }
    return item;
  });
}

// ----------------------------------------------------------------- adapters
async function runSimulationAdapter({ run, maxCompanies }) {
  const query = run.query || {};
  const countriesSelected = (query.countries || [])
    .map((code) => SIMULATION_COUNTRIES.find((country) => country.code === code))
    .filter(Boolean);
  const countries = countriesSelected.length ? countriesSelected : SIMULATION_COUNTRIES;
  const typeFilter = (query.companyTypes || []).filter((type) => SIMULATION_TYPES.includes(type));
  const types = typeFilter.length ? typeFilter : SIMULATION_TYPES;
  const limit = Math.min(maxCompanies, query.limit || 25);
  const results = [];
  const usedNames = new Set();
  for (let index = 0; index < limit; index += 1) {
    const country = countries[index % countries.length];
    const brand = SIMULATION_BRANDS[(index + Math.floor(index / countries.length)) % SIMULATION_BRANDS.length];
    const city = country.cities[index % country.cities.length];
    const type = types[index % types.length];
    const suffix = type === 'manufacturer' ? 'GmbH' : index % 3 === 0 ? 'GmbH' : index % 3 === 1 ? 'S.A.R.L.' : 'B.V.';
    let name = `${city} ${brand} Autoteile ${suffix}`;
    if (usedNames.has(name)) name = `${name} ${index + 1}`;
    usedNames.add(name);
    let domain = `${slugifyName(`${brand} ${city}`)}-autoteile.example`;
    if (results.some((item) => item.domain === domain)) domain = `${slugifyName(`${brand} ${city}`)}-${type}.example`;
    results.push({
      name,
      domain,
      website: `https://${domain}`,
      country: country.code,
      region: country.region,
      city,
      companyType: type,
      industry: query.industry || 'Automotive Aftermarket',
      description: `演示数据：欧洲汽车零部件${type === 'distributor' ? '分销商' : type === 'wholesaler' ? '批发商' : type === 'importer' ? '进口商' : type === 'retailer' ? '零售商' : '制造商'}，主营售后市场配件采购。关键词：${(query.keywords || []).join('、') || '汽车零部件'}。该企业由内置模拟数据源生成，仅用于功能演示。`,
      tags: ['simulation', 'demo'],
      sourceConfidence: 55,
    });
  }
  return results;
}

function pickArrayRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['results', 'items', 'data', 'companies', 'organizations']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = pickArrayRows(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function readPath(object, path) {
  if (!path) return object;
  let current = object;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

async function runSearchApiAdapter({ workspaceId, run, maxCompanies }) {
  const providerRow = get("SELECT * FROM external_providers WHERE workspace_id = ? AND key = 'search_api'", [workspaceId]);
  if (!providerRow) throw badRequest('未配置搜索 API 数据源');
  let providerConfig = {};
  try {
    providerConfig = JSON.parse(providerRow.config_json || '{}');
  } catch {
    providerConfig = {};
  }
  const credential = getCredential(workspaceId, 'data_provider', 'search_api');
  const config = { ...providerConfig, ...(credential?.config || {}) };
  const baseUrl = config.baseUrl || config.searchUrl;
  if (!baseUrl) throw badRequest('搜索 API 缺少 baseUrl 配置，请先在设置中填写');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw badRequest('搜索 API 的 baseUrl 配置无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('搜索 API 仅支持 http/https');
  const query = run.query || {};
  const queryParam = config.queryParam || 'q';
  const keywords = (query.keywords || []).join(' ');
  if (keywords) url.searchParams.set(queryParam, keywords);
  for (const [key, value] of Object.entries(config.extraParams || {})) {
    if (typeof value === 'string' || typeof value === 'number') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json', 'User-Agent': 'ZHIRAI-Outreach/1.0' };
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (typeof value === 'string') headers[key] = value;
  }
  if (credential?.secret) {
    const secret = credential.secret;
    const apiKey = secret.apiKey || secret.token || secret.secret || '';
    if (apiKey) {
      headers[config.apiKeyHeader || 'Authorization'] = `${config.apiKeyPrefix ?? 'Bearer '}${apiKey}`;
    }
    for (const [header, field] of Object.entries(config.secretHeaders || {})) {
      if (secret[field]) headers[header] = String(secret[field]);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2000, Number(config.timeoutMs) || 15000));
  let response;
  try {
    response = await fetch(url.toString(), { method: config.method || 'GET', headers, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw badRequest('搜索 API 请求超时');
    throw badRequest(`搜索 API 请求失败：${error?.message || '网络错误'}`);
  }
  clearTimeout(timer);
  if (!response.ok) throw badRequest(`搜索 API 返回 HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw badRequest('搜索 API 返回内容不是合法 JSON');
  }
  const rows = readPath(payload, config.resultsPath) ?? payload;
  const list = pickArrayRows(rows);
  const fields = {
    name: 'name',
    domain: 'domain',
    website: 'website',
    country: 'country',
    region: 'region',
    city: 'city',
    companyType: 'companyType',
    industry: 'industry',
    description: 'description',
    linkedinUrl: 'linkedinUrl',
    phone: 'phone',
    ...(config.fields || {}),
  };
  const results = [];
  for (const item of list.slice(0, maxCompanies)) {
    if (!item || typeof item !== 'object') continue;
    const name = String(readPath(item, fields.name) || '').trim();
    if (!name) continue;
    const domain = normalizeDomain(String(readPath(item, fields.domain) || readPath(item, fields.website) || ''));
    results.push({
      name,
      domain,
      website: readPath(item, fields.website) ? String(readPath(item, fields.website)) : domain ? `https://${domain}` : null,
      country: String(readPath(item, fields.country) || '').toUpperCase().slice(0, 2),
      region: readPath(item, fields.region) ? String(readPath(item, fields.region)).slice(0, 120) : null,
      city: readPath(item, fields.city) ? String(readPath(item, fields.city)).slice(0, 120) : null,
      companyType: readPath(item, fields.companyType) ? String(readPath(item, fields.companyType)).slice(0, 80) : null,
      industry: readPath(item, fields.industry) ? String(readPath(item, fields.industry)).slice(0, 120) : null,
      description: readPath(item, fields.description) ? String(readPath(item, fields.description)).slice(0, 4000) : null,
      linkedinUrl: readPath(item, fields.linkedinUrl) ? String(readPath(item, fields.linkedinUrl)).slice(0, 2000) : null,
      phone: readPath(item, fields.phone) ? String(readPath(item, fields.phone)).slice(0, 60) : null,
      tags: ['search_api'],
      sourceConfidence: 65,
    });
  }
  return results;
}

async function runCsvAdapter({ run, maxCompanies }) {
  const query = run.query || {};
  let rows = query.rows;
  if (!rows && query.csvText) {
    const { parseCsvTable } = await import('./imports.mjs');
    const table = parseCsvTable(query.csvText);
    rows = table.rows.map((entry) => entry.row);
  }
  if (!Array.isArray(rows)) return [];
  const pick = (row, names) => {
    for (const name of names) {
      const found = Object.keys(row).find((key) => key.trim().toLowerCase() === name);
      if (found && String(row[found] || '').trim()) return String(row[found]).trim();
    }
    return '';
  };
  const results = [];
  for (const row of rows.slice(0, maxCompanies)) {
    if (!row || typeof row !== 'object') continue;
    const name = pick(row, ['name', 'company_name', 'company', '企业名称', '公司名称', '名称']);
    if (!name) continue;
    const websiteRaw = pick(row, ['website', 'url', '官网', '网站']);
    const domain = normalizeDomain(pick(row, ['domain', '域名']) || websiteRaw);
    results.push({
      name,
      domain,
      website: websiteRaw || (domain ? `https://${domain}` : null),
      country: pick(row, ['country', '国家']).toUpperCase().slice(0, 2),
      region: pick(row, ['region', '地区', '区域']) || null,
      city: pick(row, ['city', '城市']) || null,
      companyType: pick(row, ['company_type', 'type', '企业类型', '类型']) || null,
      industry: pick(row, ['industry', '行业']) || null,
      description: pick(row, ['description', '描述', '简介']) || null,
      linkedinUrl: pick(row, ['linkedin', 'linkedin_url']) || null,
      phone: pick(row, ['phone', '电话']) || null,
      tags: ['csv'],
      sourceConfidence: 80,
    });
  }
  return results;
}

async function runAdapter({ workspaceId, run, maxCompanies }) {
  switch (run.provider) {
    case 'simulation':
      return runSimulationAdapter({ run, maxCompanies });
    case 'search_api':
      return runSearchApiAdapter({ workspaceId, run, maxCompanies });
    case 'csv':
      return runCsvAdapter({ run, maxCompanies });
    default:
      throw badRequest(`不支持的发现数据源：${run.provider}`);
  }
}

// ---------------------------------------------------------------- execution
/**
 * Execute (or resume) a discovery run. Called by the worker for the
 * `discovery.search` job. Idempotent: a finished run returns its stored summary.
 *
 * @returns {Promise<{companiesCreated:number, resultCount:number, skippedExisting:number, cancelled:boolean}>}
 */
export async function executeDiscoveryRun(workspaceId, discoveryRunId, { actorId = null } = {}) {
  const run = discoveryRepo.findDiscoveryRun(workspaceId, discoveryRunId);
  if (!run) throw notFound('发现任务不存在');
  if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
    return {
      companiesCreated: run.companiesCreated,
      resultCount: run.resultCount,
      skippedExisting: 0,
      cancelled: run.status === 'cancelled',
      status: run.status,
      skipped: true,
    };
  }
  discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, { status: 'running', started_at: nowIso(), error: null });
  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'discovery.run_start',
    entityType: 'discovery_run',
    entityId: discoveryRunId,
  });

  const limits = getSetting(workspaceId, 'limits');
  const maxCompanies = Math.max(1, Math.min(500, Number(limits.maxCompaniesPerDiscovery) || 100));
  let candidates;
  try {
    candidates = await runAdapter({ workspaceId, run, maxCompanies });
  } catch (error) {
    discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
      status: 'failed',
      error: String(error.message || '发现任务失败').slice(0, 1000),
      finished_at: nowIso(),
    });
    recordAudit({
      workspaceId,
      actorType: actorId ? 'user' : 'system',
      actorId,
      action: 'discovery.run_failed',
      entityType: 'discovery_run',
      entityId: discoveryRunId,
      after: { error: String(error.message || '').slice(0, 500) },
    });
    throw error;
  }

  const current = discoveryRepo.findDiscoveryRun(workspaceId, discoveryRunId);
  if (current?.status === 'cancelled') {
    return { companiesCreated: 0, resultCount: 0, skippedExisting: 0, cancelled: true, status: 'cancelled' };
  }

  const query = run.query || {};
  const discoveredIcp = query.icpId ? icpsRepo.findIcp(workspaceId, query.icpId) : null;
  const seenDomains = new Set();
  const seenNames = new Set();
  let companiesCreated = 0;
  let skippedExisting = 0;
  let skippedDuplicates = 0;
  let resultCount = 0;

  tx(() => {
    for (const candidate of candidates) {
      const name = normalizeName(candidate.name || '');
      if (!name) continue;
      const domain = candidate.domain ? normalizeDomain(candidate.domain) : '';
      const normalizedName = normalizeCompanyName(name);
      if (domain && seenDomains.has(domain)) {
        skippedDuplicates += 1;
        continue;
      }
      if (!domain && seenNames.has(normalizedName)) {
        skippedDuplicates += 1;
        continue;
      }
      resultCount += 1;
      const existing = domain
        ? companiesRepo.findCompanyByDomain(workspaceId, domain)
        : companiesRepo.findCompanyByNormalizedName(workspaceId, normalizedName);
      if (existing) {
        addCompanySource(workspaceId, existing.id, {
          type: 'discovery',
          name: run.provider,
          url: candidate.website || null,
          confidence: candidate.sourceConfidence || 50,
          payload: {
            discoveryRunId,
            provider: run.provider,
            adapter: run.provider,
            query,
            matchedByName: !domain,
          },
        });
        skippedExisting += 1;
        continue;
      }
      createCompanyRecord(
        workspaceId,
        {
          name,
          domain,
          website: candidate.website || (domain ? `https://${domain}` : null),
          country: candidate.country || null,
          region: candidate.region || null,
          city: candidate.city || null,
          companyType: candidate.companyType || null,
          industry: candidate.industry || query.industry || null,
          description: candidate.description || null,
          linkedinUrl: candidate.linkedinUrl || null,
          phone: candidate.phone || null,
          status: 'new',
          confidence: 'low',
          tags: candidate.tags || [],
          icpId: discoveredIcp ? discoveredIcp.id : null,
          source: {
            type: 'discovery',
            name: run.provider,
            url: candidate.website || null,
            confidence: candidate.sourceConfidence || 50,
            payload: {
              discoveryRunId,
              provider: run.provider,
              adapter: run.provider,
              query,
            },
          },
        },
        { actorId, audit: false },
      );
      companiesCreated += 1;
      if (domain) seenDomains.add(domain);
      seenNames.add(normalizedName);
    }
  });

  const finishedAt = nowIso();
  const finalRun = discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
    status: 'completed',
    result_count: resultCount,
    companies_created: companiesCreated,
    finished_at: finishedAt,
    error: null,
  });
  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'discovery.run_completed',
    entityType: 'discovery_run',
    entityId: discoveryRunId,
    after: { resultCount, companiesCreated, skippedExisting, skippedDuplicates, provider: run.provider },
  });
  return {
    companiesCreated,
    resultCount,
    skippedExisting,
    skippedDuplicates,
    cancelled: finalRun?.status === 'cancelled',
    status: 'completed',
  };
}
