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
import { all, get, tx } from '../core/db.mjs';
import { badRequest, conflict, notFound } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import { normalizeDomain, normalizeName } from '../core/validate.mjs';
import * as discoveryRepo from '../repositories/discovery.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import * as discoveryCandidatesRepo from '../repositories/discovery-candidates.mjs';
import * as icpsRepo from '../repositories/icps.mjs';
import { createCompanyRecord, normalizeCompanyName, addCompanySource } from './companies.mjs';
import { getSetting, getCredential, listProviders } from './settings.mjs';

export const DISCOVERY_PROVIDERS = ['brave', 'serper', 'tavily', 'browser', 'osm', 'simulation', 'search_api', 'csv'];
export const DISCOVERY_IMPLEMENTED_ADAPTERS = ['brave', 'serper', 'tavily', 'browser', 'osm', 'simulation', 'search_api', 'csv'];

const RUN_PROGRESS = new Map();
const PROGRESS_TTL_MS = 30 * 60 * 1000;

function setProgress(workspaceId, runId, patch) {
  const key = `${workspaceId}:${runId}`;
  const previous = RUN_PROGRESS.get(key) || {};
  RUN_PROGRESS.set(key, { ...previous, ...patch, updatedAt: nowIso(), expiresAt: Date.now() + PROGRESS_TTL_MS });
  for (const [entryKey, value] of RUN_PROGRESS) {
    if (value.expiresAt < Date.now()) RUN_PROGRESS.delete(entryKey);
  }
}

export function listDiscoveryCandidates(workspaceId, runId, options = {}) {
  const run = discoveryRepo.findDiscoveryRun(workspaceId, runId);
  if (!run) throw notFound('发现任务不存在');
  return discoveryCandidatesRepo.listCandidates(workspaceId, runId, options);
}

export function getDiscoveryProgress(workspaceId, runId) {
  return RUN_PROGRESS.get(`${workspaceId}:${runId}`) || null;
}

export function recordEnrichmentProgress(workspaceId, runId, { companyName = '', emails = 0, phones = 0, foundEmails = [], foundPhones = [], address = null, socials = [] } = {}) {
  const key = `${workspaceId}:${runId}`;
  const previous = RUN_PROGRESS.get(key);
  if (!previous) return null;
  const enrichChecked = Number(previous.enrichChecked || 0) + 1;
  const enrichTotal = Number(previous.enrichTotal || 0);
  const emailTotal = Number(previous.emails || 0) + Number(emails || 0);
  const phoneTotal = Number(previous.phones || 0) + Number(phones || 0);
  const done = enrichTotal > 0 && enrichChecked >= enrichTotal;
  const detail = [
    companyName ? `企业：${companyName.slice(0, 70)}` : null,
    `邮箱 ${Number(emails || 0)} 个${foundEmails.length ? `（${foundEmails.slice(0, 3).join('、')}）` : ''}`,
    `电话 ${Number(phones || 0)} 个${foundPhones.length ? `（${foundPhones.slice(0, 3).join('、')}）` : ''}`,
    address ? `地址：${String(address).slice(0, 80)}` : null,
    Array.isArray(socials) && socials.length ? `社交 ${socials.length} 个（${socials.slice(0, 2).join('、')}）` : null,
  ].filter(Boolean).join('；');
  setProgress(workspaceId, runId, {
    stage: done ? 'completed' : 'enriching',
    message: done
      ? `补全完成：检查 ${enrichChecked} 家，累计邮箱 ${emailTotal} 个，电话 ${phoneTotal} 个`
      : `正在读取第 ${enrichChecked}/${enrichTotal} 家企业资料；${detail}`,
    enrichChecked,
    enrichTotal,
    emails: emailTotal,
    phones: phoneTotal,
    ...(done ? { finishedAt: nowIso() } : {}),
  });
  return getDiscoveryProgress(workspaceId, runId);
}

const SEARCH_COUNTRY_NAMES = {
  DE: 'Germany', AT: 'Austria', CH: 'Switzerland', FR: 'France', IT: 'Italy',
  ES: 'Spain', NL: 'Netherlands', PL: 'Poland', GB: 'United Kingdom', BE: 'Belgium',
  SE: 'Sweden', DK: 'Denmark', CZ: 'Czech Republic', HU: 'Hungary', PT: 'Portugal',
  RO: 'Romania', FI: 'Finland', IE: 'Ireland', NO: 'Norway', GR: 'Greece',
};

const SEARCH_RESULT_BLOCKLIST = [
  '11880.com', 'lieferanten.de', 'bundes-telefonbuch.de', 'fobshanghai.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'xing.com',
  'wikipedia.org', 'gelbeseiten.de', 'yellowpages', 'indeed.com', 'stepstone.de',
  'amazon.', 'ebay.', 'kleinanzeigen.de', 'mobile.de', 'autoscout24.',
  'wlw.de', 'europages.', 'revenuebase.', 'rocketreach.', 'tracxn.', 'zoominfo.',
  'mapquest.', 'yelp.', 'reddit.', 'quora.', 'dhl.', 'advantageaustria.',
  'partstrader.', 'brightmotive.', 'ensun.', 'researchgermany.', 'autorecyclingworld.',
  'glassdoor.', 'crunchbase.', 'bloomberg.', 'pitchbook.', 'dnb.com', 'kompass.',
];

function searchKeyFor(workspaceId, providerKey) {
  const envNames = providerKey === 'brave'
    ? ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY']
    : providerKey === 'tavily'
      ? ['TAVILY_API_KEY', 'TAVILY_SEARCH_API_KEY']
      : ['SERPER_API_KEY', 'SERPER_SEARCH_API_KEY'];
  for (const name of envNames) {
    const value = String(process.env[name] || '').trim();
    if (value) return { key: value, source: 'env' };
  }
  const credential = getCredential(workspaceId, 'data_provider', providerKey);
  const secret = credential?.secret || {};
  const key = String(secret.apiKey || secret.key || secret.token || '').trim();
  return key ? { key, source: 'credential' } : null;
}

function searchProviderEnabled(workspaceId, providerKey) {
  return Boolean(searchKeyFor(workspaceId, providerKey));
}

function countryNameForSearch(code) {
  return SEARCH_COUNTRY_NAMES[String(code || '').toUpperCase()] || code || 'Europe';
}

function officialWebsite(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return rawUrl;
    return `${url.protocol}//${url.hostname}/`;
  } catch {
    return rawUrl;
  }
}
function isBlockedSearchDomain(domain) {
  const host = String(domain || '').toLowerCase();
  return SEARCH_RESULT_BLOCKLIST.some((blocked) => host.includes(blocked));
}

const PLATFORM_HOST_PATTERNS = [  /(^|\.)wlw\.(?:de|com|at|ch)$/,
  /(^|\.)europages\./,
  /(^|\.)kompass\./,
  /(^|\.)industrystock\./,
  /(^|\.)directindustry\./,
  /(^|\.)globalsources\./,
  /(^|\.)alibaba\./,
  /(^|\.)made-in-china\./,
  /(^|\.)thomasnet\./,
  /(^|\.)gelbeseiten\.de$/,
  /(^|\.)11880\.com$/,
  /(^|\.)lieferanten\.de$/,
  /(^|\.)tyre100\./,
  /(^|\.)kfzeuropa\./,
  /(^|\.)merkandi\./,
  /(^|\.)towobo\./,
  /(^|\.)wolk-aftersales\./,
];

/**
 * Classify search results that are aggregator/marketplace pages rather than a
 * company's own site. A platform profile can describe a real company, but the
 * browser adapter cannot verify its independent official domain, so it must not
 * be persisted as if the platform itself were the company. The independent
 * domain result, when present, is still accepted normally.
 *
 * This is deliberately host/path/title based instead of adding every platform
 * domain to the old blanket blocklist. Unknown ordinary company sites are not
 * rejected merely because they contain a generic word in their title.
 */
export function isPlatformSearchResult({ url = '', title = '' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (!host) return false;
  if (PLATFORM_HOST_PATTERNS.some((pattern) => pattern.test(host))) return true;

  // Generic fallback only for obvious directory landing/listing URLs whose host
  // itself looks like an aggregator. A normal independent company homepage is
  // not rejected merely because its title contains a generic word.
  const platformishHost = /(marketplace|directory|yellowpages|yellow-pages|suppliers?|lieferanten|firmenverzeichnis)/i.test(host);
  // A hostname that explicitly describes a marketplace/directory is a platform
  // regardless of whether the URL is its landing page or a company profile.
  return platformishHost;
}

/**
 * Registrable root domain, used only as one identity signal.
 * Country/language/shop subdomains collapse to the same root; multi-label
 * suffixes and shared hosting tenants are kept distinct.
 */
export function companyGroupKey(domainOrUrl) {
  const raw = String(domainOrUrl || '').trim();
  if (!raw) return '';
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    host = raw.replace(/^https?:\/\//i, '').split('/')[0];
  }
  host = host.replace(/^www\./i, '').toLowerCase();
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return host;

  const multiSuffixes = new Set(['co.uk', 'com.au', 'co.nz', 'com.tr', 'co.jp', 'com.br', 'co.za', 'com.mx', 'co.at', 'com.sg']);
  const suffix = labels.slice(-2).join('.');
  const baseIndex = multiSuffixes.has(suffix) ? labels.length - 3 : labels.length - 2;
  const base = labels[baseIndex] || labels[labels.length - 2];
  if (!base) return host;

  const sharedSuffixes = new Set(['wixsite.com', 'business.site', 'webnode.page', 'github.io', 'blogspot.com', 'myshopify.com', 'shopify.com', 'amazonaws.com', 'herokuapp.com', 'pages.dev', 'netlify.app', 'vercel.app']);
  if (sharedSuffixes.has(suffix)) return host.toLowerCase();

  // Keep the full registrable root: alpha.co.uk is not alpha.uk.
  if (multiSuffixes.has(suffix)) return `${base}.${suffix}`;
  return `${base}.${labels[labels.length - 1]}`;
}

const GENERIC_NAME_TOKENS = new Set([
  'auto', 'autoteile', 'autoteil', 'cars', 'car', 'parts', 'part', 'spare', 'automotive', 'aftermarket',
  'ersatzteile', 'ersatzteil', 'kfz', 'kfz-teile', 'wholesale', 'wholesaler', 'distributor',
  'import', 'importer', 'leading', 'european', 'europas', 'führender', 'führende', 'grosshändler',
  'großhändler', 'handel', 'handels', 'gmbh', 'ag', 'europe', 'supplier', 'suppliers', 'service',
  'services', 'the', 'and', 'und', 'für', 'fur', 'im', 'in', 'der', 'die', 'das',
]);

function normalizedNameKey(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !GENERIC_NAME_TOKENS.has(token));
  if (tokens.length === 0) return '';
  // A single generic-ish short token is not enough for identity.
  if (tokens.length === 1 && tokens[0].length < 5) return '';
  return tokens.slice(0, 3).join(' ').trim();
}

/**
 * Identity signals for dedupe. Strong signals:
 *  - the exact registrable root domain;
 *  - a brand label derived from a sufficiently long domain root, which keeps
 *    Inter Cars' country domains together.
 * The normalized name is used only when there is no domain, so two distinct
 * site owners with the same generic name are not merged by name alone.
 */
export function companyIdentityKeys(domainOrUrl, name = '') {
  const keys = [];
  const domainKey = companyGroupKey(domainOrUrl);
  if (domainKey) {
    keys.push(`domain:${domainKey}`);
    const brand = domainKey.split('.')[0] || '';
    if (brand.length >= 6 && !GENERIC_NAME_TOKENS.has(brand)) keys.push(`brand:${brand}`);
    return keys;
  }
  const nameKey = normalizedNameKey(name);
  if (nameKey) keys.push(`name:${nameKey}`);
  return keys;
}

/** True when a search result must not become a new company record. */
export function shouldRejectSearchResult({ url = '', title = '' } = {}) {
  const domain = domainFromUrl(url);
  return !domain || isBlockedSearchDomain(domain) || isPlatformSearchResult({ url, title });
}

const SEARCH_ROLES = [
  'distributor',
  'wholesaler',
  'importer',
  'regional distributor',
  'B2B wholesale supplier',
  'aftermarket distributor',
];

function addDiscoverySource(workspaceId, companyId, source) {
  const url = source?.url || null;
  if (url) {
    const duplicate = get(
      'SELECT 1 AS ok FROM company_sources WHERE workspace_id = ? AND company_id = ? AND source_url = ? LIMIT 1',
      [workspaceId, companyId, url],
    );
    if (duplicate) return false;
  }
  addCompanySource(workspaceId, companyId, source);
  return true;
}

export function searchQueries(query, countryCode) {
  const explicit = Array.isArray(query.searchTerms) ? query.searchTerms : [];
  const base = explicit.length
    ? explicit
    : (query.keywords || []).length
      ? query.keywords
      : [query.industry || 'automotive aftermarket parts'];
  const country = countryNameForSearch(countryCode);
  const terms = [];
  const seen = new Set();
  for (const raw of base.slice(0, 3)) {
    for (const role of SEARCH_ROLES) {
      const term = `${raw} ${country} ${role}`.replace(/\s+/g, ' ').trim();
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
    }
  }
  return terms.slice(0, 12);
}

/**
 * Pure quota-driven search loop. The caller supplies the actual search engine,
 * duplicate check and evidence assessor; this keeps the quota decision testable
 * without writing to the production database.
 *
 * Only a qualified, non-duplicate, newly assessed candidate fills the quota.
 * Rejected/insufficient candidates are counted but never counted as success.
 */
export async function runSearchWithQualificationQuota({
  queries = [],
  search,
  assess,
  isDuplicate = () => false,
  onResult = null,
  target = 10,
  queryBudget = 8,
  resultsPerQuery = 10,
} = {}) {
  const stats = {
    rawResults: 0,
    preFilteredCandidates: 0,
    filteredCandidates: 0,
    duplicateCandidates: 0,
    independentNew: 0,
    qualified: 0,
    rejected: 0,
    insufficientEvidence: 0,
    queriesUsed: [],
    errors: [],
    stopReason: null,
  };
  const qualifiedCandidates = [];
  const used = queries.slice(0, Math.max(1, queryBudget));
  for (const query of used) {
    if (stats.qualified >= target) {
      stats.stopReason = 'target_reached';
      break;
    }
    stats.queriesUsed.push(query);
    let results;
    try {
      results = await search(query);
    } catch (error) {
      stats.errors.push({ query, error: String(error.message || error).slice(0, 300) });
      continue;
    }
    for (const result of (Array.isArray(results) ? results : []).slice(0, resultsPerQuery)) {
      stats.rawResults += 1;
      const candidate = result;
      if (!candidate || candidate.rejected === true) {
        stats.preFilteredCandidates += 1;
        continue;
      }
      if (isDuplicate(candidate)) {
        stats.duplicateCandidates += 1;
        continue;
      }
      stats.filteredCandidates += 1;
      let assessment;
      try {
        assessment = await assess(candidate);
      } catch (error) {
        assessment = { qualification: 'insufficient_evidence', reason: 'evidence_check_failed', error: String(error.message || error) };
      }
      if (typeof onResult === 'function') {
        try { onResult(candidate, assessment); } catch { /* audit callback must not change the classification */ }
      }
      const qualification = assessment?.qualification;
      if (qualification === 'qualified') {
        stats.qualified += 1;
        stats.independentNew += 1;
        qualifiedCandidates.push({
          ...candidate,
          qualification,
          qualificationReason: assessment.reason || null,
          evidenceSources: Array.isArray(assessment.evidenceSources) ? assessment.evidenceSources : [],
          officialDescription: assessment.companyDescription || null,
        });
        if (stats.qualified >= target) {
          stats.stopReason = 'target_reached';
          break;
        }
      } else if (qualification === 'rejected') {
        stats.rejected += 1;
      } else {
        stats.insufficientEvidence += 1;
      }
    }
    if (stats.stopReason === 'target_reached') break;
  }
  if (!stats.stopReason) {
    stats.stopReason = stats.errors.length && stats.errors.length >= used.length ? 'search_error' : 'query_budget_exhausted';
  }
  return { candidates: qualifiedCandidates, stats };
}

function domainFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function titleToCompanyName(title) {
  return String(title || '')
    .replace(/\s*[|–—]\s*.*$/, '')
    .replace(/\s*-\s*(Home|Startseite|Kontakt|Impressum).*$/i, '')
    .trim()
    .slice(0, 200) || '未命名企业';
}

/** Real OpenStreetMap/Photon search anchors (country centroid/bias). */
const OSM_COUNTRY_POINTS = {
  DE: { lat: 51.1657, lon: 10.4515 },
  FR: { lat: 46.2276, lon: 2.2137 },
  IT: { lat: 41.8719, lon: 12.5674 },
  ES: { lat: 40.4637, lon: -3.7492 },
  NL: { lat: 52.1326, lon: 5.2913 },
  PL: { lat: 51.9194, lon: 19.1451 },
  GB: { lat: 55.3781, lon: -3.4360 },
  BE: { lat: 50.5039, lon: 4.4699 },
  AT: { lat: 47.5162, lon: 14.5501 },
  SE: { lat: 60.1282, lon: 18.6435 },
  DK: { lat: 56.2639, lon: 9.5018 },
  CZ: { lat: 49.8175, lon: 15.4730 },
  HU: { lat: 47.1625, lon: 19.5033 },
  PT: { lat: 39.3999, lon: -8.2245 },
  RO: { lat: 45.9432, lon: 24.9668 },
  FI: { lat: 61.9241, lon: 25.7482 },
  IE: { lat: 53.1424, lon: -7.6921 },
  CH: { lat: 46.8182, lon: 8.2275 },
  NO: { lat: 60.4720, lon: 8.4689 },
  GR: { lat: 39.0742, lon: 21.8243 },
};

const OSM_TYPE_MAP = {
  car_parts: 'distributor',
  car_repair: 'aftermarket',
  wholesale: 'wholesaler',
  company: 'trader',
  doityourself: 'retailer',
  hardware: 'distributor',
};

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
  const searchTerms = asStringList(merged.searchTerms ?? merged.queries, { max: 8 });
  const limitValue = Number(merged.limit ?? merged.maxResults);
  return {
    keywords,
    searchTerms,
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
  const provider = input.provider ? String(input.provider) : 'osm';
  if (!DISCOVERY_PROVIDERS.includes(provider)) throw badRequest('不支持的发现数据源');
  if (provider === 'search_api') {
    const providerRow = get(
      "SELECT * FROM external_providers WHERE workspace_id = ? AND key = 'search_api'",
      [workspaceId],
    );
    if (!providerRow || !providerRow.is_enabled) throw badRequest('请先在设置中启用「可配置搜索 API」数据源');
  }
  if (provider === 'brave' && !searchProviderEnabled(workspaceId, 'brave')) {
    throw badRequest('Brave Search API Key 未配置。请在系统设置/环境变量中配置 BRAVE_SEARCH_API_KEY 后再运行。');
  }
  if (provider === 'serper' && !searchProviderEnabled(workspaceId, 'serper')) {
    throw badRequest('Serper API Key 未配置。请在系统设置/环境变量中配置 SERPER_API_KEY 后再运行。');
  }
  if (provider === 'tavily') {
    // Keyless mode is supported by Tavily; a key is optional, not required.
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
  const osm = {
    key: 'osm',
    name: 'OpenStreetMap 真实企业（免费）',
    adapter: 'osm',
    capabilities: ['company'],
    costModel: 'free',
    config: {},
    isEnabled: true,
    implemented: true,
    offline: false,
    hasCredential: true,
  };
  const braveKey = searchKeyFor(workspaceId, 'brave');
  const serperKey = searchKeyFor(workspaceId, 'serper');
  const tavilyKey = searchKeyFor(workspaceId, 'tavily');
  const brave = {
    key: 'brave',
    name: 'Brave Search API（全网企业官网）',
    adapter: 'brave',
    capabilities: ['search', 'company'],
    costModel: '免费额度 / 按月',
    config: {},
    isEnabled: Boolean(braveKey),
    implemented: true,
    offline: false,
    hasCredential: Boolean(braveKey),
    credentialSource: braveKey?.source || null,
  };
  const serper = {
    key: 'serper',
    name: 'Serper（Google 搜索结果）',
    adapter: 'serper',
    capabilities: ['search', 'company'],
    costModel: '免费额度 / 按量',
    config: {},
    isEnabled: Boolean(serperKey),
    implemented: true,
    offline: false,
    hasCredential: Boolean(serperKey),
    credentialSource: serperKey?.source || null,
  };
  const tavily = {
    key: 'tavily',
    name: tavilyKey ? 'Tavily（已配置 Key）' : 'Tavily（免注册 / 免 Key）',
    adapter: 'tavily',
    capabilities: ['search', 'company'],
    costModel: tavilyKey ? '免费额度 / 按量' : '免费 keyless（限额）',
    config: {},
    isEnabled: true,
    implemented: true,
    offline: false,
    hasCredential: true,
    keyless: !tavilyKey,
    credentialSource: tavilyKey?.source || 'keyless',
  };
  const browser = {
    key: 'browser',
    name: '浏览器搜索（本机 Edge / Chrome）',
    adapter: 'browser',
    capabilities: ['search', 'company'],
    costModel: '免费',
    config: {},
    isEnabled: true,
    implemented: true,
    offline: false,
    hasCredential: true,
    keyless: true,
    credentialSource: 'browser',
  };
  const items = rows.map((provider) => {
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
  return [brave, serper, tavily, browser, osm, ...items.filter((item) => item.adapter !== 'simulation')];
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

async function runOsmAdapter({ run, maxCompanies }) {
  const query = run.query || {};
  const selected = Array.isArray(query.countries) && query.countries.length
    ? query.countries.map((code) => String(code).toUpperCase().slice(0, 2)).filter((code) => OSM_COUNTRY_POINTS[code])
    : ['DE', 'FR', 'IT', 'ES', 'NL', 'PL'];
  const keywords = (query.keywords || []).join(' ').trim() || query.industry || 'auto parts';
  const autoRelated = /auto|car|kfz|automotive|aftermarket|汽配|汽车|刹车|battery|brake/i.test(`${keywords} ${query.industry || ''}`);
  const tags = autoRelated ? ['shop:car_parts', 'shop:car_repair'] : ['office:company', 'shop:wholesale'];
  const results = [];
  const seen = new Set();
  const limit = Math.max(1, Math.min(maxCompanies, Number(query.limit) || maxCompanies));
  for (const country of selected) {
    if (results.length >= limit) break;
    const point = OSM_COUNTRY_POINTS[country];
    for (const osmTag of tags) {
      if (results.length >= limit) break;
      const params = new URLSearchParams({
        q: autoRelated ? 'auto' : (keywords.split(/\s+/)[0] || 'company'),
        lat: String(point.lat),
        lon: String(point.lon),
        limit: '50',
        lang: 'en',
        osm_tag: osmTag,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let payload;
      try {
        const response = await fetch(`https://photon.komoot.io/api/?${params}`, {
          headers: { 'User-Agent': 'ZHIRAI-Outreach/1.0 (contact: zhirai@zhirai.cloud)', Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) continue;
        payload = await response.json();
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
      for (const feature of payload?.features || []) {
        const props = feature.properties || {};
        if (props.countrycode !== country || !props.name) continue;
        const key = `${props.osm_type || ''}:${props.osm_id || props.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const osmValue = props.osm_value || 'company';
        const address = [props.street, props.housenumber, props.postcode, props.city].filter(Boolean).join(' ');
        results.push({
          name: String(props.name).slice(0, 200),
          domain: null,
          website: null,
          country,
          region: props.state || null,
          city: props.city || null,
          companyType: OSM_TYPE_MAP[osmValue] || 'trader',
          industry: query.industry || (autoRelated ? 'Automotive Aftermarket' : null),
          description: `OpenStreetMap 真实企业记录：${osmValue}${address ? `，${address}` : ''}。来源：openstreetmap.org。`,
          tags: ['real', 'openstreetmap', osmValue],
          sourceConfidence: 70,
        });
        if (results.length >= limit) break;
      }
    }
  }
  if (!results.length) {
    throw badRequest('OpenStreetMap 没有找到匹配的真实企业，请调整关键词或目标国家后重试');
  }
  return results;
}

async function fetchSearchJson(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function braveSearch({ key, query, country }) {
  const params = new URLSearchParams({
    q: query,
    count: '20',
    country: String(country || 'DE').toUpperCase(),
    search_lang: ['DE', 'AT', 'CH'].includes(String(country || '').toUpperCase()) ? 'de' : 'en',
  });
  const payload = await fetchSearchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key,
    },
  });
  return (payload?.web?.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.description,
  }));
}

async function serperSearch({ key, query, country }) {
  const payload = await fetchSearchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify({
      q: query,
      gl: String(country || 'DE').toLowerCase(),
      hl: ['DE', 'AT', 'CH'].includes(String(country || '').toUpperCase()) ? 'de' : 'en',
      num: 20,
    }),
  });
  return (payload?.organic || []).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
  }));
}

async function tavilySearch({ key, query }) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  else headers['X-Tavily-Access-Mode'] = 'keyless';
  const payload = await fetchSearchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: 20,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  return (payload?.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content,
  }));
}

async function runWebSearchAdapter({ workspaceId, run, maxCompanies, providerKey }) {
  const keyInfo = searchKeyFor(workspaceId, providerKey);
  if (!keyInfo && providerKey !== 'tavily') {
    throw badRequest(`${providerKey === 'brave' ? 'Brave Search API' : 'Serper'} Key 未配置`);
  }
  const query = run.query || {};
  const countries = (query.countries || []).length ? query.countries : ['DE'];
  const candidates = [];
  const seen = new Set();
  const errors = [];
  const requests = [];
  // Cover the whole requested market, not just the first three countries.
  // One query per country keeps cost bounded; larger markets get a second term.
  const primaryMarkets = new Set(['DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'GB', 'AT', 'CH']);
  for (const country of countries.slice(0, 24)) {
    const terms = searchQueries(query, country);
    if (!terms.length) continue;
    requests.push({ country, term: terms[0] });
    if (primaryMarkets.has(country) && terms[1] && requests.length < 24) {
      requests.push({ country, term: terms[1] });
    }
  }
  for (const request of requests.slice(0, 24)) {
    if (candidates.length >= maxCompanies) break;
    try {
      const results = providerKey === 'brave'
        ? await braveSearch({ key: keyInfo.key, query: request.term, country: request.country })
        : providerKey === 'tavily'
          ? await tavilySearch({ key: keyInfo?.key || null, query: request.term })
          : await serperSearch({ key: keyInfo.key, query: request.term, country: request.country });
      for (const result of results) {
        if (candidates.length >= maxCompanies) break;
        const domain = domainFromUrl(result.url);
        const name = titleToCompanyName(result.title);
        if (!domain || !name || name.length < 2 || isBlockedSearchDomain(domain) || shouldRejectSearchResult({ url: result.url, title: result.title })) continue;
        const identityKeys = companyIdentityKeys(result.url, name);
        if (identityKeys.some((key) => seen.has(key))) continue;
        for (const key of identityKeys) seen.add(key);
        candidates.push({
          name,
          domain,
          website: officialWebsite(result.url),
          country: request.country,
          region: null,
          city: null,
          companyType: null,
          industry: query.industry || 'General B2B',
          description: String(result.snippet || '').slice(0, 1000) || `搜索结果：${result.title || result.url}`,
          tags: ['web', 'search', providerKey, 'unverified'],
          sourceConfidence: 80,
          sourceUrl: result.url,
          sourceTitle: result.title || null,
        });
      }
    } catch (error) {
      errors.push(`${providerKey} ${request.country}: ${error.message}`);
    }
  }
  if (!candidates.length) {
    try {
      const fallback = await runBrowserSearchAdapter({ run, maxCompanies });
      if (fallback.length) return fallback;
    } catch {
      // fall through to the original provider error
    }
    throw badRequest(`${providerKey === 'brave' ? 'Brave' : providerKey === 'tavily' ? 'Tavily' : 'Serper'} 搜索没有返回可用企业官网${errors.length ? `：${errors.slice(0, 3).join('；')}` : ''}`);
  }
  return candidates;
}

/**
 * Last-resort free discovery: use the user's installed Chrome/Edge to search
 * DuckDuckGo and return the same candidate shape as API discovery.
 */
async function assessBrowserCandidate(candidate, icp) {
  const { fetchPage, parseHtmlPage, findAboutLinks } = await import('./enrichment.mjs');
  const { classifyCompanyQualification } = await import('./scoring.mjs');
  const website = candidate.website || (candidate.domain ? `https://${candidate.domain}` : null);
  if (!website) {
    return { qualification: 'insufficient_evidence', reason: 'website_missing', evidenceSources: [] };
  }
  const pages = [];
  const errors = [];
  let home;
  try {
    home = await fetchPage(website, { timeoutMs: 12000 });
  } catch (error) {
    return { qualification: 'insufficient_evidence', reason: 'official_site_unreachable', evidenceSources: [], error: String(error.message || error).slice(0, 200) };
  }
  const homeParsed = parseHtmlPage(home.html || '', home.url || website);
  pages.push({
    url: home.url || website,
    title: homeParsed.title || '',
    description: homeParsed.description || '',
  });
  const aboutLinks = findAboutLinks(home.html || '', home.url || website).slice(0, 2);
  for (const link of aboutLinks) {
    try {
      const page = await fetchPage(link, { timeoutMs: 10000 });
      const parsed = parseHtmlPage(page.html || '', page.url || link);
      pages.push({
        url: page.url || link,
        title: parsed.title || '',
        description: parsed.description || '',
      });
    } catch (error) {
      errors.push({ url: link, error: String(error.message || error).slice(0, 160) });
    }
  }
  const businessPages = pages.filter((page) => {
    try {
      return new URL(page.url).pathname.replace(/\/+$/, '') !== '';
    } catch {
      return false;
    }
  });
  const evidenceSources = businessPages.map((page) => ({
    sourceType: 'crawl',
    sourceName: '官网业务页核验',
    sourceUrl: page.url,
    confidence: 70,
    payload: { title: page.title, description: page.description },
  }));
  const companyDescription = pages
    .map((page) => [page.title, page.description].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
    .slice(0, 3000);
  const result = classifyCompanyQualification({
    company: {
      name: candidate.name,
      description: companyDescription,
      country: candidate.country,
      industry: candidate.industry,
      companyType: candidate.companyType,
    },
    sources: evidenceSources.map((source) => ({
      source_type: source.sourceType,
      source_name: source.sourceName,
      source_url: source.sourceUrl,
      payload_json: JSON.stringify(source.payload),
    })),
    icp,
  });
  return { ...result, evidenceSources, companyDescription, errors };
}

function candidateFilterReason(url, title) {
  const domain = domainFromUrl(url);
  if (!domain) return 'invalid_url';
  const name = titleToCompanyName(title);
  if (!name || name.length < 2) return 'missing_name';
  if (isBlockedSearchDomain(domain)) return 'blocked_domain';
  if (isPlatformSearchResult({ url, title })) return 'platform_host';
  return null;
}

export async function runBrowserSearchAdapter({ run, maxCompanies, assessCandidate = null, inspectDuplicateCandidate = null, recordCandidate = null, searchImpl = null }) {
  const { browserSearch } = await import('./browser-contact.mjs');
  const searchEngine = searchImpl || browserSearch;
  const query = run.query || {};
  const countries = (query.countries || []).length ? query.countries : ['DE'];
  const audit = (data) => {
    if (typeof recordCandidate === 'function') recordCandidate(data);
  };

  if (!assessCandidate) {
    const candidates = [];
    const seen = new Set();
    for (const country of countries.slice(0, 10)) {
      if (candidates.length >= maxCompanies) break;
      const terms = searchQueries(query, country).slice(0, 4);
      for (const term of (terms.length ? terms : [`${query.industry || 'B2B'} distributor ${country}`])) {
        if (candidates.length >= maxCompanies) break;
        const result = await searchEngine(term, { engine: 'duckduckgo', timeoutMs: 30000 });
        for (const item of result.results || []) {
          if (candidates.length >= maxCompanies) break;
          const domain = domainFromUrl(item.url);
          const name = titleToCompanyName(item.title);
          if (!domain || !name || name.length < 2 || isBlockedSearchDomain(domain) || shouldRejectSearchResult({ url: item.url, title: item.title })) continue;
          const identityKeys = companyIdentityKeys(item.url, name);
          if (identityKeys.some((key) => seen.has(key))) continue;
          for (const key of identityKeys) seen.add(key);
          candidates.push({
            name, domain, website: officialWebsite(item.url), country, region: null, city: null,
            companyType: null, industry: query.industry || 'General B2B', description: item.title || '',
            tags: ['web', 'browser', 'unverified'], sourceConfidence: 60,
            sourceUrl: item.url, sourceTitle: item.title || null,
          });
        }
      }
    }
    return candidates;
  }

  const queries = [];
  for (const country of countries.slice(0, 10)) {
    for (const term of searchQueries(query, country).slice(0, 4)) queries.push({ country, term });
  }
  const seenInBatch = new Set();
  const search = async ({ country, term }) => {
    const result = await searchEngine(term, { engine: 'duckduckgo', timeoutMs: 30000 });
    return (result.results || []).map((item) => {
      const candidateAuditId = id('dsc');
      const domain = domainFromUrl(item.url);
      const name = titleToCompanyName(item.title);
      const baseAudit = {
        id: candidateAuditId, query: term, rawUrl: item.url || null,
        normalizedUrl: domain ? `https://${domain}/` : null, title: item.title || null,
      };
      audit({ ...baseAudit, stage: 'pre_filter', outcome: 'pre_filtered', reasonCode: null });
      const filterReason = candidateFilterReason(item.url, item.title);
      if (filterReason) {
        audit({ ...baseAudit, stage: 'pre_filter', outcome: 'pre_filtered', reasonCode: filterReason });
        return { rejected: true, auditReason: filterReason, candidateAuditId };
      }
      const identityKeys = companyIdentityKeys(item.url, name);
      return {
        candidateAuditId, query: term, name, domain, website: officialWebsite(item.url), country,
        region: null, city: null, companyType: null, industry: query.industry || 'General B2B',
        description: item.title || '', tags: ['web', 'browser', 'unverified'], sourceConfidence: 60,
        sourceUrl: item.url, sourceTitle: item.title || null, identityKeys,
      };
    });
  };
  const quota = await runSearchWithQualificationQuota({
    queries,
    search,
    assess: assessCandidate,
    isDuplicate: (candidate) => {
      if (candidate.rejected) return false;
      const info = inspectDuplicateCandidate ? inspectDuplicateCandidate(candidate) : { duplicate: false };
      if (info?.duplicate) {
        audit({
          id: candidate.candidateAuditId, query: candidate.query, rawUrl: candidate.sourceUrl,
          normalizedUrl: candidate.domain ? `https://${candidate.domain}/` : null, title: candidate.sourceTitle,
          stage: 'identity', outcome: info.kind === 'history_match' ? 'history_match' : 'batch_duplicate',
          reasonCode: info.kind || 'batch_duplicate', identityKeys: candidate.identityKeys,
          matchedCompanyId: info.matchedCompanyId || null,
          duplicateOfCandidateId: info.duplicateOfCandidateId || null,
        });
        return true;
      }
      if (!inspectDuplicateCandidate) {
        const keys = candidate.identityKeys || companyIdentityKeys(candidate.domain, candidate.name);
        if (keys.some((key) => seenInBatch.has(key))) return true;
        for (const key of keys) seenInBatch.add(key);
      }
      return false;
    },
    onResult: (candidate, assessment) => {
      audit({
        id: candidate.candidateAuditId, query: candidate.query, rawUrl: candidate.sourceUrl,
        normalizedUrl: candidate.domain ? `https://${candidate.domain}/` : null, title: candidate.sourceTitle,
        stage: 'assessment', outcome: assessment?.qualification || 'insufficient_evidence',
        reasonCode: assessment?.reason || 'assessment_missing', identityKeys: candidate.identityKeys,
        websiteCheckStatus: assessment?.qualification === 'insufficient_evidence' ? 'insufficient' : 'available',
        qualification: assessment?.qualification || 'insufficient_evidence',
        qualificationReason: assessment?.reason || null,
        evidenceUrls: (assessment?.evidenceSources || []).map((source) => source.sourceUrl).filter(Boolean),
        evidenceExcerpt: String(assessment?.companyDescription || '').slice(0, 1000) || null,
      });
    },
    target: maxCompanies,
    queryBudget: Math.max(1, Math.min(queries.length, 12)),
    resultsPerQuery: 10,
  });
  return { candidates: quota.candidates, searchStats: quota.stats };
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

async function runAdapter({ workspaceId, run, maxCompanies, options = {} }) {
  switch (run.provider) {
    case 'brave':
      return runWebSearchAdapter({ workspaceId, run, maxCompanies, providerKey: 'brave' });
    case 'serper':
      return runWebSearchAdapter({ workspaceId, run, maxCompanies, providerKey: 'serper' });
    case 'tavily':
      return runWebSearchAdapter({ workspaceId, run, maxCompanies, providerKey: 'tavily' });
    case 'browser':
      return runBrowserSearchAdapter({ run, maxCompanies, ...options });
    case 'osm':
      return runOsmAdapter({ run, maxCompanies });
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

/**
 * Finalize qualification after all run-linked enrichment/score jobs settle.
 * Idempotent: recalculates counts from persisted company tags and overwrites
 * the run's final counters; repeated calls cannot double-count.
 */
export function finalizeDiscoveryQualification(workspaceId, discoveryRunId) {
  const run = discoveryRepo.findDiscoveryRun(workspaceId, discoveryRunId);
  if (!run) throw notFound('发现任务不存在');
  if (run.qualificationStatus === 'finalized') return run;

  const linkedCompanies = discoveryCandidatesRepo.listCandidates(workspaceId, discoveryRunId, { limit: 1000 }).items
    .map((candidate) => candidate.savedCompanyId)
    .filter(Boolean);
  const companyIds = [...new Set(linkedCompanies)];
  if (!companyIds.length) {
    const finalizedAt = nowIso();
    const updated = discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
      qualification_status: 'finalized',
      qualified_count: 0,
      rejected_count: 0,
      insufficient_count: 0,
      unclassified_count: 0,
      qualification_finalized_at: finalizedAt,
      qualification_evaluation: 'no_saved_qualified_candidates',
    });
    recordAudit({
      workspaceId,
      actorType: 'system',
      action: 'discovery.qualification_finalized',
      entityType: 'discovery_run',
      entityId: discoveryRunId,
      after: { qualified: 0, rejected: 0, insufficient: 0, unclassified: 0, companyCount: 0 },
    });
    return updated;
  }

  const jobs = all(
    `SELECT id, type, status FROM background_jobs
      WHERE workspace_id = ? AND payload_json LIKE ?
        AND type IN ('company.enrich', 'lead.score')`,
    [workspaceId, `%${discoveryRunId}%`],
  );
  const pending = jobs.filter((job) => !['succeeded', 'failed', 'cancelled', 'dead'].includes(job.status));
  if (pending.length) {
    const updated = discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
      qualification_status: 'pending',
      qualification_evaluation: 'awaiting_enrichment_and_score',
    });
    recordAudit({
      workspaceId,
      actorType: 'system',
      action: 'discovery.qualification_pending',
      entityType: 'discovery_run',
      entityId: discoveryRunId,
      after: { pendingJobs: pending.map((job) => ({ id: job.id, type: job.type })) },
    });
    return updated;
  }

  const failedJobs = jobs.filter((job) => ['failed', 'dead'].includes(job.status));
  const counts = { qualified: 0, rejected: 0, insufficient: 0, unclassified: 0 };
  for (const companyId of companyIds) {
    const company = companiesRepo.findCompany(workspaceId, companyId);
    const tag = (company?.tags || []).find((item) => String(item).startsWith('qualification:'));
    const value = tag ? String(tag).slice('qualification:'.length) : null;
    if (value === 'qualified') counts.qualified += 1;
    else if (value === 'rejected') counts.rejected += 1;
    else if (value === 'insufficient_evidence') counts.insufficient += 1;
    else counts.unclassified += 1;
  }
  const finalizedAt = nowIso();
  const failed = failedJobs.length > 0;
  const updated = discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
    qualification_status: failed ? 'failed' : 'finalized',
    qualified_count: counts.qualified,
    rejected_count: counts.rejected,
    insufficient_count: counts.insufficient,
    unclassified_count: counts.unclassified,
    qualification_finalized_at: finalizedAt,
    qualification_evaluation: failed ? 'async_job_failed' : 'final_after_async_jobs',
    error: failed ? `资格核验任务失败：${failedJobs.map((job) => job.id).join(',')}` : run.error,
  });
  recordAudit({
    workspaceId,
    actorType: 'system',
    action: failed ? 'discovery.qualification_failed' : 'discovery.qualification_finalized',
    entityType: 'discovery_run',
    entityId: discoveryRunId,
    after: { ...counts, companyCount: companyIds.length, failedJobs: failedJobs.map((job) => job.id) },
  });
  return updated;
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
  setProgress(workspaceId, discoveryRunId, {
    stage: 'searching',
    message: run.provider === 'browser' ? '正在启动本机浏览器（Edge/Chrome），打开搜索页并搜索企业…' : `正在调用数据源：${run.provider}`,
    checked: 0,
    total: 0,
    created: 0,
    emails: 0,
  });
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
  const query = run.query || {};
  const discoveredIcp = query.icpId ? icpsRepo.findIcp(workspaceId, query.icpId) : null;
  const existingGroupIds = new Map();
  for (const row of all('SELECT id, name, domain FROM companies WHERE workspace_id = ? AND deleted_at IS NULL', [workspaceId])) {
    for (const key of companyIdentityKeys(row.domain, row.name)) {
      if (!existingGroupIds.has(key)) existingGroupIds.set(key, row.id);
    }
  }
  const processedIdentityKeys = new Set();
  const processedCandidateByKey = new Map();
  const candidateAuditIds = new Set();
  let historyDuplicateCount = 0;
  let batchDuplicateCount = 0;
  const inspectDuplicateCandidate = (candidate) => {
    const keys = companyIdentityKeys(candidate.domain, candidate.name);
    const historyKey = keys.find((key) => existingGroupIds.has(key));
    const batchKey = keys.find((key) => processedIdentityKeys.has(key));
    if (historyKey) {
      historyDuplicateCount += 1;
      return { duplicate: true, kind: 'history_match', key: historyKey, matchedCompanyId: existingGroupIds.get(historyKey) };
    }
    if (batchKey) {
      batchDuplicateCount += 1;
      return { duplicate: true, kind: 'batch_duplicate', key: batchKey, duplicateOfCandidateId: processedCandidateByKey.get(batchKey) || null };
    }
    for (const key of keys) {
      processedIdentityKeys.add(key);
      if (candidate.candidateAuditId) processedCandidateByKey.set(key, candidate.candidateAuditId);
    }
    return { duplicate: false };
  };
  const recordCandidate = (data) => {
    const now = nowIso();
    const payload = {
      workspaceId,
      runId: discoveryRunId,
      query: data.query || null,
      rawUrl: data.rawUrl || null,
      normalizedUrl: data.normalizedUrl || null,
      title: data.title || null,
      stage: data.stage || 'pre_filter',
      outcome: data.outcome || 'pre_filtered',
      reasonCode: data.reasonCode || null,
      identityKeys: Array.isArray(data.identityKeys) ? data.identityKeys : [],
      matchedCompanyId: data.matchedCompanyId || null,
      duplicateOfCandidateId: data.duplicateOfCandidateId || null,
      websiteCheckStatus: data.websiteCheckStatus || null,
      qualification: data.qualification || null,
      qualificationReason: data.qualificationReason || null,
      evidenceUrls: Array.isArray(data.evidenceUrls) ? data.evidenceUrls : [],
      evidenceExcerpt: data.evidenceExcerpt || null,
      savedCompanyId: data.savedCompanyId || null,
      createdAt: now,
      updatedAt: now,
    };
    if (!data.id) return false;
    if (candidateAuditIds.has(data.id)) {
      const patch = {
        stage: payload.stage,
        outcome: payload.outcome,
        reason_code: payload.reasonCode,
        identity_keys_json: JSON.stringify(payload.identityKeys),
        matched_company_id: payload.matchedCompanyId,
        duplicate_of_candidate_id: payload.duplicateOfCandidateId,
        website_check_status: payload.websiteCheckStatus,
        qualification: payload.qualification,
        qualification_reason: payload.qualificationReason,
        evidence_urls_json: JSON.stringify(payload.evidenceUrls),
        evidence_excerpt: payload.evidenceExcerpt,
        saved_company_id: payload.savedCompanyId,
        updated_at: now,
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      discoveryCandidatesRepo.updateCandidate(workspaceId, data.id, Object.fromEntries(entries));
    } else {
      discoveryCandidatesRepo.insertCandidate({ ...payload, id: data.id });
      candidateAuditIds.add(data.id);
    }
    return true;
  };
  const assessCandidate = run.provider === 'browser'
    ? (candidate) => assessBrowserCandidate(candidate, discoveredIcp)
    : null;
  let candidates;
  let searchStats = null;
  try {
    const adapterResult = await runAdapter({
      workspaceId,
      run,
      maxCompanies,
      options: assessCandidate ? { assessCandidate, inspectDuplicateCandidate, recordCandidate } : {},
    });
    if (Array.isArray(adapterResult)) {
      candidates = adapterResult;
    } else {
      candidates = Array.isArray(adapterResult?.candidates) ? adapterResult.candidates : [];
      searchStats = adapterResult?.searchStats || null;
    }
  } catch (error) {
    setProgress(workspaceId, discoveryRunId, { stage: 'failed', message: String(error.message || '发现任务失败') });
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
  if (searchStats?.stopReason === 'search_error') {
    const message = '所有搜索查询均失败，未将本轮记录为正常完成';
    setProgress(workspaceId, discoveryRunId, { stage: 'failed', message });
    discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
      status: 'failed',
      error: message,
      finished_at: nowIso(),
    });
    recordAudit({
      workspaceId,
      actorType: actorId ? 'user' : 'system',
      actorId,
      action: 'discovery.run_failed',
      entityType: 'discovery_run',
      entityId: discoveryRunId,
      after: { error: message, searchErrors: searchStats.errors?.slice(0, 5) || [] },
    });
    throw badRequest(message);
  }
  if (current?.status === 'cancelled') {
    return { companiesCreated: 0, resultCount: 0, skippedExisting: 0, cancelled: true, status: 'cancelled' };
  }
  setProgress(workspaceId, discoveryRunId, {
    stage: 'creating',
    message: `已获取 ${searchStats?.rawResults ?? candidates.length} 条搜索结果，准备核验 ${candidates.length} 家合格候选`,
    checked: 0,
    total: candidates.length,
    created: 0,
    emails: 0,
  });

  const seenDomains = new Set();
  const seenIdentityKeys = new Set();
  const seenNames = new Set();
  let companiesCreated = 0;
  let restoredExisting = 0;
  let skippedExisting = 0;
  let skippedDuplicates = 0;
  let resultCount = searchStats?.rawResults ?? candidates.length;
  let checkedCount = 0;
  const newCompanyIds = [];
  const enrichTargets = [];
  const scoreTargets = [];
  const rememberEnrichTarget = (companyId, website, companyName = '') => {
    if (companyId && website && !enrichTargets.some((item) => item.companyId === companyId)) {
      enrichTargets.push({ companyId, companyName });
    }
  };
  const rememberScoreTarget = (companyId) => {
    if (companyId && !scoreTargets.includes(companyId)) scoreTargets.push(companyId);
  };

  tx(() => {
    for (const candidate of candidates) {
      const name = normalizeName(candidate.name || '');
      if (!name) continue;
      if (assessCandidate && candidate.qualification !== 'qualified') continue;
      const domain = candidate.domain ? normalizeDomain(candidate.domain) : '';
      const identityKeys = companyIdentityKeys(domain, name);
      const normalizedName = normalizeCompanyName(name);
      if (domain && (seenDomains.has(domain) || identityKeys.some((key) => seenIdentityKeys.has(key)))) {
        skippedDuplicates += 1;
        continue;
      }
      if (!domain && seenNames.has(normalizedName)) {
        skippedDuplicates += 1;
        continue;
      }
      checkedCount += 1;
      setProgress(workspaceId, discoveryRunId, {
        stage: 'creating',
        message: `正在处理第 ${checkedCount} 家合格候选：${name.slice(0, 80)}`,
        checked: checkedCount,
        total: candidates.length,
        created: companiesCreated,
      });
      let existing = domain
        ? companiesRepo.findCompanyByDomain(workspaceId, domain)
        : companiesRepo.findCompanyByNormalizedName(workspaceId, normalizedName);
      if (!existing && identityKeys.some((key) => existingGroupIds.has(key))) {
        const matchedId = identityKeys.map((key) => existingGroupIds.get(key)).find(Boolean);
        existing = matchedId ? companiesRepo.findCompany(workspaceId, matchedId) : null;
      }
      if (domain) {
        seenDomains.add(domain);
        for (const key of identityKeys) seenIdentityKeys.add(key);
      }
      if (existing) {
        for (const key of identityKeys) existingGroupIds.set(key, existing.id);
        addDiscoverySource(workspaceId, existing.id, {
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
        if (existing.deletedAt) {
          // The user removed this company earlier (often because it had no
          // contact details). Rediscovery should bring it back, not silently
          // count it as an existing/hidden record.
          if (companiesRepo.restoreCompany(workspaceId, existing.id)) {
            companiesCreated += 1;
            restoredExisting += 1;
            rememberEnrichTarget(existing.id, existing.website || candidate.website, existing.name || name);
            rememberScoreTarget(existing.id);
          } else {
            skippedExisting += 1;
          }
        } else {
          skippedExisting += 1;
        }
        continue;
      }
      const created = createCompanyRecord(
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
          description: candidate.officialDescription || candidate.description || null,
          linkedinUrl: candidate.linkedinUrl || null,
          phone: candidate.phone || null,
          status: 'new',
          confidence: 'low',
          tags: [
            ...(candidate.tags || []),
            `qualification:${candidate.qualification || 'insufficient_evidence'}`,
            `qualification_reason:${String(candidate.qualificationReason || 'not_yet_verified').replace(/[^a-z0-9_]/gi, '').slice(0, 30)}`,
          ],
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
      if (candidate.candidateAuditId) {
        recordCandidate({
          id: candidate.candidateAuditId,
          stage: 'saved',
          outcome: 'qualified',
          savedCompanyId: created?.id || null,
        });
      }
      if (created?.id) newCompanyIds.push(created.id);
      for (const evidence of candidate.evidenceSources || []) {
        if (!created?.id || !evidence?.sourceUrl) continue;
        addDiscoverySource(workspaceId, created.id, {
          type: evidence.sourceType || 'crawl',
          name: evidence.sourceName || '官网业务页核验',
          url: evidence.sourceUrl,
          confidence: evidence.confidence || 70,
          payload: evidence.payload || {},
        });
      }
      rememberEnrichTarget(created?.id, candidate.website || created?.website, name);
      rememberScoreTarget(created?.id);
      if (domain) {
        seenDomains.add(domain);
        for (const key of identityKeys) {
          seenIdentityKeys.add(key);
          existingGroupIds.set(key, created?.id || null);
        }
      }
      seenNames.add(normalizedName);
    }
  });

  // Search results often have a website but no contact in the snippet. Queue
  // enrichment instead of crawling inline: the worker retries transient
  // failures and records them, so a slow/blocked site no longer loses contacts
  // silently during the discovery run.
  let enrichQueued = 0;
  let scoreQueued = 0;
  let scoreProductId = query.productId || null;
  if (!scoreProductId) {
    try {
      const productsRepo = await import('../repositories/products.mjs');
      scoreProductId = productsRepo.listActiveProducts(workspaceId, { limit: 1 })[0]?.id || null;
    } catch {
      scoreProductId = null;
    }
  }
  const { enqueueJob } = await import('../jobs/queue.mjs');
  for (const target of enrichTargets.slice(0, 10)) {
    try {
      enqueueJob({
        workspaceId,
        type: 'company.enrich',
        payload: { companyId: target.companyId, companyName: target.companyName, discoveryRunId },
        dedupeKey: `company.enrich:${workspaceId}:${target.companyId}`,
        createdBy: actorId || null,
        maxAttempts: 3,
        priority: 80,
      });
      enrichQueued += 1;
    } catch {
      // discovery must not fail because one enrichment was not queued
    }
  }
  for (const companyId of scoreTargets) {
    try {
      enqueueJob({
        workspaceId,
        type: 'lead.score',
        payload: { companyId, productId: scoreProductId, discoveryRunId },
        dedupeKey: `lead.score:${workspaceId}:${companyId}`,
        createdBy: actorId || null,
        maxAttempts: 3,
        priority: 60,
      });
      scoreQueued += 1;
    } catch {
      // scoring is best-effort; discovery data is already saved
    }
  }

  const finishedAt = nowIso();
  const newIndependentCount = Math.max(0, companiesCreated - restoredExisting);
  const qualificationCounts = {
    qualified: searchStats?.qualified ?? 0,
    rejected: searchStats?.rejected ?? 0,
    insufficientEvidence: searchStats?.insufficientEvidence ?? 0,
    unclassified: Math.max(0, (searchStats?.independentNew ?? 0) - (searchStats?.qualified ?? 0)),
  };
  const plannedQueries = [];
  for (const country of (query.countries || []).length ? query.countries : ['DE']) {
    for (const term of searchQueries(query, country).slice(0, 4)) plannedQueries.push({ country, term });
  }
  const auditStats = {
    rawResultCount: searchStats?.rawResults ?? candidates.length,
    preFilteredCandidateCount: searchStats?.preFilteredCandidates ?? 0,
    filteredCandidateCount: searchStats?.filteredCandidates ?? candidates.length,
    duplicateCandidateCount: batchDuplicateCount + skippedDuplicates,
    existingCandidateCount: historyDuplicateCount + skippedExisting,
    independentNewCount: newIndependentCount,
    qualificationCounts,
    qualificationEvaluation: 'search_time_official_business_page',
    queriesUsed: searchStats?.queriesUsed ?? plannedQueries.slice(0, 24),
    stopReason: searchStats?.stopReason ?? (candidates.length === 0 ? 'no_search_results' : 'completed'),
  };
  setProgress(workspaceId, discoveryRunId, {
    stage: enrichQueued > 0 ? 'enriching' : 'completed',
    message: enrichQueued > 0
      ? `搜索完成：检查 ${resultCount} 条，新建/恢复 ${companiesCreated} 家；正在补全第 0/${enrichQueued} 家企业资料`
      : `检查完成：${resultCount} 条结果，新建/恢复 ${companiesCreated} 家`,
    checked: resultCount,
    total: candidates.length,
    created: companiesCreated,
    emails: 0,
    phones: 0,
    enrichChecked: 0,
    enrichTotal: enrichQueued,
    ...(enrichQueued === 0 ? { finishedAt } : {}),
  });
  const finalRun = discoveryRepo.updateDiscoveryRun(workspaceId, discoveryRunId, {
    status: 'completed',
    result_count: resultCount,
    companies_created: companiesCreated,
    qualification_status: (enrichQueued + scoreQueued) > 0 ? 'pending' : 'pending',
    qualification_evaluation: 'search_completed_pending_async_qualification',
    finished_at: finishedAt,
    error: null,
  });
  finalizeDiscoveryQualification(workspaceId, discoveryRunId);
  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'discovery.run_completed',
    entityType: 'discovery_run',
    entityId: discoveryRunId,
    after: { resultCount, companiesCreated, skippedExisting, skippedDuplicates, restoredExisting, enrichQueued, scoreQueued, provider: run.provider, ...auditStats },
  });
  return {
    companiesCreated,
    resultCount,
    skippedExisting,
    skippedDuplicates,
    restoredExisting,
    enrichQueued,
    scoreQueued,
    ...auditStats,
    cancelled: finalRun?.status === 'cancelled',
    status: 'completed',
  };
}
