/**
 * Real browser contact extraction.
 *
 * HTTP crawling sees only the first HTML document. Many European B2B sites hide
 * contact details behind JS tabs, icon buttons, employee/team pages or
 * Impressum/Kontakt links. This module launches Playwright Chromium locally,
 * opens the site like a human, follows contact/team links, and extracts:
 *  - mailto / tel links (including icon buttons)
 *  - emails and phones rendered after JS
 *  - address and social profiles
 *
 * It is intentionally best-effort: failures return an empty result plus an
 * error string; the caller keeps the HTTP evidence and never invents contacts.
 */
import { extractEmailsFromHtml, extractPhonesFromHtml, parseHtmlPage } from './enrichment.mjs';

const CONTACT_PATH_WORDS = [
  'kontakt', 'contact', 'contatti', 'contacto', 'contactez', 'kontaktai',
  'impressum', 'imprint', 'about', 'ueber-uns', 'über-uns', 'team',
  'mitarbeiter', 'ansprechpartner', 'employee', 'staff', 'people',
  'company', 'firma', 'chi-siamo', 'quienes-somos', 'o-nas',
  'distributor', 'wholesale', 'grosshandel', 'großhandel',
];
const SOCIAL_HOSTS = [
  'linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'xing.com', 'tiktok.com', 'wa.me', 'whatsapp.com',
  'telegram.me', 't.me', 'pinterest.', 'vk.com',
];

let browserPromise = null;
let browserChannel = null;

async function getBrowser(channel = 'auto', launchTimeoutMs = 15000) {
  if (!browserPromise) {
    browserPromise = import('playwright').then(async ({ chromium }) => {
      const candidates = channel === 'auto' ? ['chrome', 'msedge', 'bundled'] : [channel];
      let lastError = null;
      for (const candidate of candidates) {
        try {
          const headed = process.env.BROWSER_HEADLESS !== '1';
          const launchOptions = { headless: headed, timeout: Math.max(1000, launchTimeoutMs), args: ['--no-sandbox', '--disable-dev-shm-usage'] };
          const browser = candidate === 'bundled'
            ? await chromium.launch(launchOptions)
            : await chromium.launch({ ...launchOptions, channel: candidate });
          browserChannel = candidate;
          return browser;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('没有可用的浏览器');
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}


function abortError() {
  const error = new Error('browser operation aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/**
 * Launch a browser owned by exactly one Agent search. Unlike getBrowser(),
 * this browser is never shared and can be closed by its owner after abort/
 * timeout without touching other tasks or the user's browser.
 * If launch resolves after an abort won the race, the late browser is closed
 * immediately so it cannot become an orphan.
 */
async function launchDedicatedBrowser(channel, launchTimeoutMs, signal) {
  if (signal?.aborted) throw abortError();
  const { chromium } = await import('playwright');
  const candidates = channel === 'auto' ? ['chrome', 'msedge', 'bundled'] : [channel];
  let lastError = null;
  for (const candidate of candidates) {
    if (signal?.aborted) throw abortError();
    const headed = process.env.BROWSER_HEADLESS !== '1';
    const launchOptions = { headless: headed, timeout: Math.max(1000, launchTimeoutMs), args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    const launchPromise = candidate === 'bundled'
      ? chromium.launch(launchOptions)
      : chromium.launch({ ...launchOptions, channel: candidate });
    let aborted = false;
    let lateCloseAttached = false;
    const closeLate = (browser) => {
      if (browser && !lateCloseAttached) {
        lateCloseAttached = true;
        browser.close().catch(() => {});
      }
    };
    const abortPromise = new Promise((_, reject) => {
      if (!signal) return;
      const onAbort = () => {
        aborted = true;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      launchPromise.then(() => {}, () => {});
      signal.addEventListener('abort', () => {
        launchPromise.then(closeLate).catch(() => {});
      }, { once: true });
    });
    try {
      const browser = await Promise.race([launchPromise, abortPromise]);
      if (signal?.aborted || aborted) {
        await browser.close().catch(() => {});
        throw abortError();
      }
      browserChannel = candidate;
      return browser;
    } catch (error) {
      if (aborted || signal?.aborted) {
        launchPromise.then(closeLate).catch(() => {});
        throw abortError();
      }
      lastError = error;
    }
  }
  throw lastError || new Error('没有可用的浏览器');
}

function sameSite(url, base) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') === new URL(base).hostname.replace(/^www\./i, '');
  } catch {
    return false;
  }
}

function usefulLinks(links, base) {
  const seen = new Set();
  const selected = [];
  for (const link of links) {
    if (!sameSite(link, base) || seen.has(link)) continue;
    const lower = link.toLowerCase();
    if (!CONTACT_PATH_WORDS.some((word) => lower.includes(word))) continue;
    seen.add(link);
    selected.push(link);
    if (selected.length >= 8) break;
  }
  return selected;
}

export async function browserExtractContacts(website, { timeoutMs = 30000, maxPages = 8, channel = 'auto' } = {}) {
  let page = null;
  let context = null;
  const result = {
    browser: true,
    channel: null,
    pages: [],
    emails: [],
    phones: [],
    socials: [],
    address: null,
    employees: [],
    error: null,
  };
  try {
    const browser = await getBrowser(channel);
    result.channel = browserChannel;
    context = await browser.newContext({
      locale: 'de-DE',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      viewport: { width: 1365, height: 900 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(website, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try { await page.bringToFront(); } catch {}
    await page.waitForTimeout(1200);

    const visited = new Set();
    const queue = [page.url()];
    const allEmails = new Set();
    const allPhones = new Set();
    const socials = new Set();

    while (queue.length && result.pages.length < maxPages) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      try {
        if (page.url() !== current) await page.goto(current, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForTimeout(800);
        const html = await page.content();
        const parsed = parseHtmlPage(html, page.url());
        for (const email of [...parsed.emails, ...extractEmailsFromHtml(html)]) allEmails.add(email);
        for (const phone of [...parsed.phones, ...extractPhonesFromHtml(html)]) allPhones.add(phone);
        for (const link of await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.href))) {
          if (SOCIAL_HOSTS.some((host) => String(link).toLowerCase().includes(host))) socials.add(link);
        }
        const employeeLinks = await page.locator('a[href]').evaluateAll((nodes, base) => nodes
          .map((node) => ({ href: node.href, text: (node.textContent || '').trim() }))
          .filter((item) => item.text && /ansprechpartner|mitarbeiter|team|employee|contact person|sales/i.test(item.text))
          .map((item) => item.href), page.url());
        for (const link of employeeLinks) {
          if (sameSite(link, page.url()) && result.employees.length < 12 && !result.employees.includes(link)) {
            result.employees.push(link);
          }
        }
        result.pages.push({
          url: page.url(),
          title: parsed.title || null,
          emails: parsed.emails || [],
          phones: parsed.phones || [],
          address: parsed.address || null,
        });
        const nextLinks = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.href));
        for (const link of usefulLinks([...nextLinks, ...employeeLinks], page.url())) {
          if (!visited.has(link)) queue.push(link);
        }
      } catch (caught) {
        result.error = result.error || String(caught.message || caught);
      }
    }

    result.emails = [...allEmails].slice(0, 30);
    result.phones = [...allPhones].slice(0, 20);
    result.socials = [...socials].slice(0, 20);
    result.address = result.pages.find((item) => item.address)?.address || null;
    return result;
  } catch (caught) {
    result.error = String(caught.message || caught);
    return result;
  } finally {
    try {
      await page?.close();
      await context?.close();
    } catch {
      // ignore cleanup
    }
  }
}

function decodeBingRedirect(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const encoded = url.searchParams.get('u');
    if (!encoded || !encoded.startsWith('a1')) return rawUrl;
    const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const base64WithPad = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(base64WithPad, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : rawUrl;
  } catch {
    return rawUrl;
  }
}

function decodeSearchRedirect(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.includes('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    if (url.hostname.includes('bing.com') && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u');
      if (encoded && encoded.startsWith('a1')) {
        const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const base64WithPad = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const decoded = Buffer.from(base64WithPad, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

export async function browserSearch(query, { channel = 'auto', timeoutMs = 30000, engine = 'duckduckgo', signal = null, launchTimeoutMs = 15000, dedicated = false, launchBrowserImpl = launchDedicatedBrowser } = {}) {
  let page = null;
  let context = null;
  let ownedBrowser = null;
  let aborted = false;
  const abortHandler = () => {
    aborted = true;
    try { page?.close(); } catch { /* best effort */ }
    try { context?.close(); } catch { /* best effort */ }
  };
  try {
    if (signal?.aborted) return { query: String(query || ''), engine, channel: browserChannel, results: [], error: 'aborted' };
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });
    const browser = dedicated
      ? await launchBrowserImpl(channel, launchTimeoutMs, signal)
      : await getBrowser(channel, launchTimeoutMs);
    if (dedicated) ownedBrowser = browser;
    if (signal?.aborted) return { query: String(query || ''), engine, channel: browserChannel, results: [], error: 'aborted' };
    context = await browser.newContext({
      locale: 'de-DE',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      viewport: { width: 1365, height: 900 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(Math.max(1000, timeoutMs));
    const term = String(query || '').trim();
    if (!term) return { query: term, engine, channel: browserChannel, results: [], error: 'empty query' };
    if (engine === 'duckduckgo') {
      await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      try { await page.bringToFront(); } catch {}
    } else {
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(term)}&count=20&setlang=de`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    }
    await page.waitForTimeout(1200);
    const rows = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('li.b_algo h2 a, .b_algo h2 a, a.result__a')];
      return anchors.map((anchor) => ({
        title: (anchor.textContent || '').trim(),
        url: anchor.href,
      })).filter((item) => /^https?:\/\//i.test(item.url)).slice(0, 20);
    });
    for (const row of rows) {
      row.url = decodeSearchRedirect(row.url);
    }
    const organic = rows.filter((row) => {
      const lower = row.url.toLowerCase();
      if (lower.includes('duckduckgo.com/y.js') || lower.includes('bing.com/aclick')) return false;
      if (lower.includes('duckduckgo.com/?') || lower.includes('bing.com/search')) return false;
      return /^https?:\/\//i.test(row.url);
    });
    return { query: term, engine, channel: browserChannel, results: organic, error: null };
  } catch (caught) {
    return { query: String(query || ''), engine, channel: browserChannel, results: [], error: aborted ? 'aborted' : String(caught.message || caught) };
  } finally {
    if (signal) signal.removeEventListener('abort', abortHandler);
    try {
      await page?.close();
      await context?.close();
      if (ownedBrowser) await ownedBrowser.close().catch(() => {});
    } catch {
      // ignore cleanup
    }
  }
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    // already closed
  } finally {
    browserPromise = null;
  }
}

export default { browserExtractContacts, browserSearch, closeBrowser };
