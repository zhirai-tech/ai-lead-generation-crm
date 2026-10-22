/**
 * Company enrichment: crawl the company's own public website and extract
 * description, contact details, social links and published email addresses.
 *
 * Safety rules:
 *  - only http/https URLs;
 *  - loopback, private, link-local and metadata addresses are rejected, including
 *    after DNS resolution and on every redirect hop (SSRF protection);
 *  - per-request timeout, response body size limit, configurable user agent;
 *  - search engine result pages are never fetched: only the company's own site.
 *
 * Contract: enrichCompany({ workspaceId, companyId, actorId })
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { badRequest, notFound } from '../core/errors.mjs';
import { isEmail, normalizeDomain, normalizePhone } from '../core/validate.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import * as companiesRepo from '../repositories/companies.mjs';
import * as contactsRepo from '../repositories/contacts.mjs';
import { createContact, attachInferredEmail, deriveEmailType } from './contacts.mjs';
import { inferEmails, DISPOSABLE_DOMAINS } from './verification.mjs';
import { getSetting } from './settings.mjs';
import { addCompanySource, computeCompanyDataQuality } from './companies.mjs';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 12000;
const ABOUT_LINK_KEYWORDS = [
  '/about', '/about-us', '/company', '/who-we-are', '/kontakt', '/contact', '/impressum', '/ueber-uns', '/über-uns',
  '/qui-sommes-nous', '/chi-siamo', '/quienes-somos', '/o-nas', '/onas', '/team', '/legal', '/privacy',
];

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  ndash: '–', mdash: '—', laquo: '«', raquo: '»', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', eacute: 'é',
  egrave: 'è', agrave: 'à', ccedil: 'ç', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ', ograve: 'ò',
  aacute: 'á', euro: '€', pound: '£',
};

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

export function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<template[\s\S]*?<\/template>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttributes(tag) {
  const attributes = {};
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match = regex.exec(tag);
  while (match) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    match = regex.exec(tag);
  }
  return attributes;
}

function metaContent(html, key) {
  const wanted = key.toLowerCase();
  const regex = /<meta\b[^>]*>/gi;
  let match = regex.exec(html);
  while (match) {
    const attributes = parseAttributes(match[0]);
    const name = (attributes.property || attributes.name || '').toLowerCase();
    if (name === wanted && attributes.content) return attributes.content;
    match = regex.exec(html);
  }
  return '';
}

export function extractMeta(html) {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeEntities(stripHtml(metaContent(html, 'og:title') || (titleTag ? titleTag[1] : ''))).slice(0, 300);
  const description = decodeEntities(
    stripHtml(metaContent(html, 'og:description') || metaContent(html, 'description') || metaContent(html, 'twitter:description')),
  ).slice(0, 2000);
  const siteName = decodeEntities(stripHtml(metaContent(html, 'og:site_name'))).slice(0, 200);
  return { title, description, siteName };
}

export function extractJsonLd(html) {
  const blocks = [];
  const regex = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = regex.exec(html);
  while (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // ignore malformed JSON-LD
    }
    match = regex.exec(html);
  }
  return blocks;
}

function collectOrganizations(jsonLd) {
  const found = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((item) => /organization|localbusiness|corporation|store|autopartsstore|company/i.test(String(item)))) {
      found.push(node);
    }
    for (const key of ['@graph', 'mainEntity', 'publisher', 'parentOrganization']) {
      if (node[key]) visit(node[key], depth + 1);
    }
  };
  visit(jsonLd);
  return found;
}

export function extractEmailsFromHtml(html) {
  const emails = new Set();
  const collect = (raw) => {
    const decoded = decodeEntities(String(raw || '').trim());
    if (!decoded || decoded.length > 320) return;
    const normalized = decoded.toLowerCase();
    if (!isEmail(normalized)) return;
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(normalized)) return;
    if (normalized.includes('@2x') || normalized.includes('@3x')) return;
    const domain = normalized.split('@')[1];
    if (DISPOSABLE_DOMAINS.has(domain)) return;
    emails.add(normalized);
  };
  const mailtoRegex = /href\s*=\s*["']mailto:([^"'?]+)(?:\?[^"']*)?["']/gi;
  let match = mailtoRegex.exec(html);
  while (match) {
    collect(match[1]);
    match = mailtoRegex.exec(html);
  }
  const text = stripHtml(html);
  const emailRegex = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
  match = emailRegex.exec(text);
  while (match) {
    collect(match[0]);
    match = emailRegex.exec(text);
  }
  return [...emails].slice(0, 30);
}

export function extractPhonesFromHtml(html) {
  const phones = new Set();
  const telRegex = /href\s*=\s*["']tel:([^"']+)["']/gi;
  let match = telRegex.exec(html);
  while (match) {
    const phone = normalizePhone(decodeEntities(match[1]));
    if (phone.replace(/\D/g, '').length >= 6) phones.add(phone);
    match = telRegex.exec(html);
  }
  return [...phones].slice(0, 10);
}

export function extractLinks(html, pageUrl) {
  const links = new Set();
  const regex = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let match = regex.exec(html);
  while (match) {
    try {
      const url = new URL(decodeEntities(match[1]), pageUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') links.add(url.toString());
    } catch {
      // ignore malformed links
    }
    match = regex.exec(html);
  }
  return [...links];
}

export function findAboutLinks(html, pageUrl) {
  const base = new URL(pageUrl);
  const candidates = [];
  for (const link of extractLinks(html, pageUrl)) {
    let url;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname) continue;
    const pathname = `${url.pathname}${url.search}`.toLowerCase();
    if (ABOUT_LINK_KEYWORDS.some((keyword) => pathname.includes(keyword))) {
      if (!candidates.includes(url.toString()) && url.toString() !== pageUrl) candidates.push(url.toString());
    }
    if (candidates.length >= 3) break;
  }
  return candidates;
}

export function findLinkedinUrl(html) {
  const regex = /href\s*=\s*["'](https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[^"'?]+)["']/gi;
  const match = regex.exec(html);
  return match ? decodeEntities(match[1]) : null;
}

function formatJsonLdAddress(address) {
  if (!address) return { address: null, city: null, country: null };
  if (typeof address === 'string') return { address: address.slice(0, 500), city: null, country: null };
  if (typeof address !== 'object') return { address: null, city: null, country: null };
  const parts = [address.streetAddress, address.postalCode, address.addressLocality, address.addressRegion, address.addressCountry]
    .filter((part) => part && typeof part === 'string')
    .map((part) => part.trim());
  const countryRaw = typeof address.addressCountry === 'string' ? address.addressCountry : address.addressCountry?.name;
  const country = typeof countryRaw === 'string' && /^[a-z]{2}$/i.test(countryRaw) ? countryRaw.toUpperCase() : null;
  return {
    address: parts.length ? parts.join(', ').slice(0, 500) : null,
    city: typeof address.addressLocality === 'string' ? address.addressLocality.slice(0, 120) : null,
    country,
  };
}

/** Parse one fetched HTML page into the fields the enrichment flow needs. */
export function parseHtmlPage(html, pageUrl) {
  const meta = extractMeta(html);
  const organizations = collectOrganizations(extractJsonLd(html));
  let address = null;
  let city = null;
  let country = null;
  let phone = null;
  let description = meta.description;
  let linkedinUrl = findLinkedinUrl(html);
  const jsonLdEmails = [];
  const jsonLdPhones = [];
  for (const organization of organizations) {
    if (!description && typeof organization.description === 'string') description = decodeEntities(organization.description).slice(0, 2000);
    const formatted = formatJsonLdAddress(organization.address);
    if (!address && formatted.address) address = formatted.address;
    if (!city && formatted.city) city = formatted.city;
    if (!country && formatted.country) country = formatted.country;
    if (typeof organization.telephone === 'string') jsonLdPhones.push(normalizePhone(organization.telephone));
    if (typeof organization.email === 'string') jsonLdEmails.push(String(organization.email).replace(/^mailto:/i, ''));
    const sameAs = Array.isArray(organization.sameAs) ? organization.sameAs : [organization.sameAs];
    if (!linkedinUrl) {
      const hit = sameAs.find((value) => typeof value === 'string' && value.includes('linkedin.com/'));
      if (hit) linkedinUrl = hit;
    }
  }
  const emails = new Set([...extractEmailsFromHtml(html), ...jsonLdEmails.filter((email) => isEmail(email))]);
  const phones = new Set([...extractPhonesFromHtml(html), ...jsonLdPhones.filter((phoneValue) => phoneValue.replace(/\D/g, '').length >= 6)]);
  phone = [...phones][0] || null;
  return {
    url: pageUrl,
    title: meta.title || null,
    siteName: meta.siteName || null,
    description: description ? description.slice(0, 2000) : null,
    emails: [...emails].slice(0, 30),
    phones: [...phones],
    phone,
    address,
    city,
    country,
    linkedinUrl,
    aboutLinks: findAboutLinks(html, pageUrl),
    jsonLdCount: organizations.length,
  };
}

// ------------------------------------------------------------------- SSRF
export function isPrivateIp(address) {
  if (!address || typeof address !== 'string') return true;
  const value = address.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const parts = value.split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (family === 6) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice('::ffff:'.length);
      return net.isIP(mapped) === 4 ? isPrivateIp(mapped) : true;
    }
    if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff')) return true;
    if (value.startsWith('2001:db8')) return true;
    return false;
  }
  return true;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'instance-data']);

/**
 * Validate that a URL is a public http(s) URL. The DNS lookup is injectable so
 * unit tests can prove that hostnames resolving to private ranges are rejected.
 */
export async function assertPublicHttpUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    throw badRequest('网址格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('仅支持 http/https 协议的网址');
  if (url.username || url.password) throw badRequest('抓取网址不能包含用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw badRequest('网址缺少主机名');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw badRequest('不允许抓取内网或本地地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw badRequest('不允许抓取内网或本地地址');
    return url;
  }
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw badRequest(`域名无法解析：${host}`);
  }
  const list = Array.isArray(records) ? records : records ? [records] : [];
  if (!list.length) throw badRequest(`域名无法解析：${host}`);
  for (const record of list) {
    if (isPrivateIp(record.address)) throw badRequest('不允许抓取内网或本地地址');
  }
  return url;
}

async function readBodyLimited(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch a single HTML page with manual redirect handling. Every hop re-runs the
 * SSRF checks, so a public URL cannot redirect to an internal address.
 */
export async function fetchPage(rawUrl, { userAgent, timeoutMs = DEFAULT_TIMEOUT_MS, lookup = dns.lookup, maxBytes = MAX_BODY_BYTES } = {}) {
  let current = await assertPublicHttpUrl(rawUrl, { lookup });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    let response;
    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent || 'ZHIRAI-Outreach/1.0',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en;q=0.8,de;q=0.6,fr;q=0.4',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw badRequest('抓取超时，请稍后重试');
      throw badRequest(`抓取失败：${error?.message || '网络错误'}`);
    }
    clearTimeout(timer);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw badRequest(`重定向缺少目标地址（HTTP ${response.status}）`);
      const next = new URL(location, current).toString();
      if (hop === MAX_REDIRECTS) throw badRequest('重定向次数过多');
      current = await assertPublicHttpUrl(next, { lookup });
      continue;
    }
    if (!response.ok) throw badRequest(`抓取失败：HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml') && !contentType.includes('text/plain')) {
      throw badRequest('目标页面不是 HTML 内容');
    }
    const text = await readBodyLimited(response);
    return { url: current.toString(), status: response.status, html: text.slice(0, maxBytes), contentType };
  }
  throw badRequest('重定向次数过多');
}

// ------------------------------------------------------------------ crawl
function resolveHomeUrl(company) {
  if (company.website) {
    try {
      const url = new URL(company.website);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      // fall through to domain
    }
  }
  if (company.domain) return `https://${normalizeDomain(company.domain) || company.domain}`;
  return '';
}


/**
 * Crawl the company website (homepage + up to N about/contact pages) and apply
 * the extracted facts, sources and contact emails.
 */
export async function crawlCompanyWebsite(
  workspaceId,
  companyId,
  { actorId = null, urls = null, fetcher = null, ip = null, userAgent = null, requestId = null } = {},
) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  const settings = getSetting(workspaceId, 'enrichment');
  const crawlUa = settings.crawlUserAgent;
  const timeoutMs = Number(settings.crawlTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const maxPages = Math.max(1, Math.min(10, Number(settings.maxPagesPerDomain) || 4));
  const fetchImpl = fetcher || ((url, options) => fetchPage(url, { ...options, lookup: dns.lookup }));
  const explicitUrls = Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && url.trim()).slice(0, maxPages) : [];
  const homeUrl = explicitUrls[0] || resolveHomeUrl(company);
  if (!homeUrl) {
    return { fetched: 0, pages: [], updated: false, reason: 'no_website', contactsCreated: 0, emailsFound: 0, updatedFields: [] };
  }

  const pages = [];
  const errors = [];
  const visited = new Set();
  let homepageHtml = '';
  let homepageUrl = homeUrl;

  // The homepage must load, otherwise the whole crawl fails loudly for the job.
  try {
    const first = await fetchImpl(homeUrl, { userAgent: crawlUa, timeoutMs });
    homepageUrl = first.url || homeUrl;
    homepageHtml = first.html || '';
    visited.add(homeUrl);
    visited.add(homepageUrl);
    pages.push({ url: homepageUrl, html: homepageHtml });
  } catch (error) {
    throw badRequest(`官网抓取失败：${error.message}`);
  }

  const queue = [];
  if (explicitUrls.length > 1) {
    queue.push(...explicitUrls.slice(1));
  } else if (!explicitUrls.length && homepageHtml) {
    queue.push(...findAboutLinks(homepageHtml, homepageUrl).slice(0, maxPages - 1));
  }
  while (queue.length && pages.length < maxPages) {
    const nextUrl = queue.shift();
    if (!nextUrl || visited.has(nextUrl)) continue;
    visited.add(nextUrl);
    try {
      const page = await fetchImpl(nextUrl, { userAgent: crawlUa, timeoutMs });
      pages.push({ url: page.url || nextUrl, html: page.html || '' });
    } catch (error) {
      errors.push({ url: nextUrl, error: error.message });
    }
  }

  const parsedPages = [];
  const emailsFound = new Set();
  const phonesFound = new Set();
  let description = null;
  let phone = null;
  let address = null;
  let city = null;
  let country = null;
  let linkedinUrl = null;
  let bestTitle = null;
  for (const page of pages) {
    const parsed = parseHtmlPage(page.html, page.url);
    parsedPages.push(parsed);
    if (!description && parsed.description) description = parsed.description;
    if (parsed.description && (!description || parsed.description.length > description.length) && parsed.url === pages[0].url) {
      description = parsed.description;
    }
    if (!phone && parsed.phone) phone = parsed.phone;
    for (const value of parsed.phones) phonesFound.add(value);
    if (!address && parsed.address) address = parsed.address;
    if (!city && parsed.city) city = parsed.city;
    if (!country && parsed.country) country = parsed.country;
    if (!linkedinUrl && parsed.linkedinUrl) linkedinUrl = parsed.linkedinUrl;
    if (!bestTitle && parsed.title) bestTitle = parsed.title;
    for (const email of parsed.emails) emailsFound.add(email);
  }

  const patch = {};
  if (description && !company.description) patch.description = description;
  if (phone && !company.phone) patch.phone = phone;
  if (address && !company.address) patch.address = address;
  if (city && !company.city) patch.city = city;
  if (country && !company.country) patch.country = country;
  if (linkedinUrl && !company.linkedinUrl) patch.linkedinUrl = linkedinUrl;
  if (!company.website) patch.website = pages[0].url;
  patch.confidence = company.confidence === 'unverified' || company.confidence === 'low' ? 'medium' : company.confidence;
  patch.lastVerifiedAt = nowIso();
  const currentContacts = contactsRepo.listContactsForCompany(workspaceId, companyId);
  const merged = { ...company, ...patch };
  patch.dataQualityScore = computeCompanyDataQuality(merged, {
    contactsCount: currentContacts.length,
    hasEmail: [...emailsFound].length > 0 || currentContacts.some((contact) => Boolean(contact.emailNormalized)),
  });
  const updatedCompany = companiesRepo.updateCompany(workspaceId, companyId, {
    description: patch.description !== undefined ? patch.description : company.description,
    phone: patch.phone !== undefined ? patch.phone : company.phone,
    address: patch.address !== undefined ? patch.address : company.address,
    city: patch.city !== undefined ? patch.city : company.city,
    country: patch.country !== undefined ? patch.country : company.country,
    linkedin_url: patch.linkedinUrl !== undefined ? patch.linkedinUrl : company.linkedinUrl,
    website: patch.website !== undefined ? patch.website : company.website,
    confidence: patch.confidence,
    last_verified_at: patch.lastVerifiedAt,
    data_quality_score: patch.dataQualityScore,
    updated_at: patch.lastVerifiedAt,
  });

  for (const parsed of parsedPages) {
    addCompanySource(workspaceId, companyId, {
      type: 'crawl',
      name: '官网抓取',
      url: parsed.url,
      confidence: 70,
      payload: {
        title: parsed.title,
        description: parsed.description,
        emails: parsed.emails,
        phones: parsed.phones,
        address: parsed.address,
        linkedinUrl: parsed.linkedinUrl,
        jsonLdCount: parsed.jsonLdCount,
      },
    });
  }

  // Create contacts for published addresses (unverified by definition).
  const maxEmails = Math.max(1, Math.min(20, Number(settings.maxEmailsPerDomain) || 5));
  let contactsCreated = 0;
  let emailsStored = 0;
  for (const email of [...emailsFound].slice(0, maxEmails)) {
    const existing = contactsRepo.findContactByEmail(workspaceId, email);
    if (existing) {
      contactsRepo.addContactSource(workspaceId, existing.id, {
        id: id('csrc'),
        sourceType: 'crawl',
        sourceUrl: pages[0].url,
        method: 'crawl',
        retrievedAt: nowIso(),
        confidence: 60,
        payload: { note: 'email re-confirmed on company website' },
      });
      emailsStored += 1;
      continue;
    }
    const emailType = deriveEmailType(email);
    try {
      createContact(
        workspaceId,
        {
          companyId,
          email,
          emailType,
          emailStatus: 'unverified',
          roleCategory: emailType === 'role' ? 'gatekeeper' : 'unknown',
          confidence: 'low',
          source: {
            type: 'crawl',
            url: pages[0].url,
            method: 'crawl',
            confidence: 60,
            payload: { extractedFrom: 'company website', unverified: true },
          },
        },
        { actorId, sourceMethod: 'crawl' },
      );
      contactsCreated += 1;
      emailsStored += 1;
    } catch {
      // Duplicate or invalid row: skip, the crawl must not fail because of one email.
    }
  }

  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'company.crawl',
    entityType: 'company',
    entityId: companyId,
    after: {
      pages: parsedPages.map((page) => page.url),
      updatedFields: Object.keys(patch).filter((key) => key !== 'dataQualityScore' && key !== 'lastVerifiedAt' && key !== 'confidence'),
      contactsCreated,
      emailsFound: emailsFound.size,
    },
    ip,
    userAgent,
    requestId,
  });

  return {
    fetched: parsedPages.length,
    pages: parsedPages.map((page) => ({
      url: page.url,
      title: page.title,
      description: page.description,
      emails: page.emails,
      phones: page.phones,
      address: page.address,
      linkedinUrl: page.linkedinUrl,
    })),
    updated: patchedFieldCount(patch) > 0,
    updatedFields: Object.keys(patch).filter((key) => !['dataQualityScore', 'lastVerifiedAt', 'confidence'].includes(key)),
    company: updatedCompany,
    contactsCreated: contactsCreated,
    emailsFound: emailsFound.size,
    emailsStored,
    phonesFound: [...phonesFound],
    errors,
  };
}

function patchedFieldCount(patch) {
  return Object.keys(patch).filter((key) => !['dataQualityScore', 'lastVerifiedAt', 'confidence'].includes(key)).length;
}

/**
 * Fixed contract signature used by the `company.enrich` / `company.crawl` jobs.
 * Crawls the company site, then fills gaps with name+domain email inference for
 * existing contacts that have no email yet.
 */
export async function enrichCompany({
  workspaceId,
  companyId,
  actorId = null,
  fetcher = null,
  ip = null,
  userAgent = null,
  requestId = null,
} = {}) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  let crawlResult = null;
  let crawlError = null;
  if (company.website || company.domain) {
    try {
      crawlResult = await crawlCompanyWebsite(workspaceId, companyId, { actorId, fetcher, ip, userAgent, requestId: null });
    } catch (error) {
      crawlError = error.message;
    }
  }

  let inferred = 0;
  let inferenceError = null;
  if (company.domain) {
    const candidates = contactsRepo.listContactsWithoutEmail(workspaceId, companyId, { limit: 3 });
    for (const contact of candidates) {
      try {
        const emails = await inferEmails(workspaceId, companyId, contact.firstName, contact.lastName);
        const pick = emails.find((candidate) => !candidate.exists) || emails[0];
        if (pick) {
          attachInferredEmail(workspaceId, contact.id, { email: pick.email, confidence: pick.confidence });
          inferred += 1;
        }
      } catch (error) {
        inferenceError = error.message;
      }
    }
  }

  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'company.enrich',
    entityType: 'company',
    entityId: companyId,
    after: {
      crawlPages: crawlResult?.fetched || 0,
      contactsCreated: crawlResult?.contactsCreated || 0,
      emailsFound: crawlResult?.emailsFound || 0,
      inferred,
      crawlError,
    },
    ip,
    userAgent,
    requestId,
  });

  return {
    updated: Boolean(crawlResult?.updated),
    contactsCreated: crawlResult?.contactsCreated || 0,
    emailsFound: (crawlResult?.emailsFound || 0) + inferred,
    inferredEmails: inferred,
    pagesFetched: crawlResult?.fetched || 0,
    updatedFields: crawlResult?.updatedFields || [],
    emails: crawlResult?.pages?.flatMap((page) => page.emails).slice(0, 20) || [],
    error: crawlError,
    inferenceError,
  };
}

/**
 * Queue an asynchronous `company.crawl` job (frontend semantics: the crawl runs
 * in the background). Falls back to crawling inline when the job queue is not
 * available so the feature still works in minimal deployments/tests.
 */
export async function requestCompanyCrawl({ workspaceId, companyId, actorId = null, urls = null, ip = null, userAgent = null, requestId = null } = {}) {
  const company = companiesRepo.findCompany(workspaceId, companyId);
  if (!company) throw notFound('企业不存在');
  try {
    const { enqueueJob } = await import('../jobs/queue.mjs');
    const job = enqueueJob({
      workspaceId,
      type: 'company.crawl',
      payload: { companyId, urls: urls && urls.length ? urls : undefined },
      createdBy: actorId || null,
    });
    recordAudit({
      workspaceId,
      actorType: actorId ? 'user' : 'system',
      actorId,
      action: 'company.crawl_queued',
      entityType: 'company',
      entityId: companyId,
      after: { jobId: job?.id || null, deduped: Boolean(job?.deduped), urls: urls || null },
      ip,
      userAgent,
      requestId,
    });
    return { queued: true, jobId: job?.id || null, deduped: Boolean(job?.deduped), companyId };
  } catch (error) {
    const result = await crawlCompanyWebsite(workspaceId, companyId, { actorId, urls, ip, userAgent, requestId });
    return { queued: false, enqueueError: error.message, ...result };
  }
}

// The worker's upstream contract maps name+domain inference under the
// enrichment module even though the implementation lives in verification.mjs.
export { inferEmails };
