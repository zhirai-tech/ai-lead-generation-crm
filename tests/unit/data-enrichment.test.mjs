import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';
import { upsertSetting } from '../../server/core/db.mjs';
import {
  isPrivateIp,
  assertPublicHttpUrl,
  decodeEntities,
  stripHtml,
  parseHtmlPage,
  enrichCompany,
  crawlCompanyWebsite,
} from '../../server/services/enrichment.mjs';

let ctx;
let workspaceId;

before(async () => {
  ctx = await createTestContext();
  workspaceId = ctx.owner.workspaceId;
  upsertSetting(workspaceId, 'enrichment', {
    verifyMx: false,
    maxEmailsPerDomain: 3,
    maxPagesPerDomain: 3,
    crawlTimeoutMs: 3000,
    crawlUserAgent: 'ZHIRAI-Test/1.0',
  });
});

after(async () => {
  await ctx.close();
});

test('private, loopback and link-local addresses are rejected', () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.3', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isPrivateIp(address), true, `${address} should be private`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(address), false, `${address} should be public`);
  }
});

test('assertPublicHttpUrl blocks non-http protocols, credentials and private hosts', async () => {
  await assert.rejects(() => assertPublicHttpUrl('ftp://example.com/file'), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(() => assertPublicHttpUrl('http://user:pass@example.com/'), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1:8080/'), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/'), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(() => assertPublicHttpUrl('http://intranet.local/'), (error) => error.code === 'BAD_REQUEST');
  const url = await assertPublicHttpUrl('https://93.184.216.34/');
  assert.equal(url.hostname, '93.184.216.34');
});

test('assertPublicHttpUrl rejects hostnames resolving to private addresses (SSRF)', async () => {
  const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];
  await assert.rejects(
    () => assertPublicHttpUrl('https://evil.example.com/', { lookup: privateLookup }),
    (error) => error.code === 'BAD_REQUEST',
  );
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const url = await assertPublicHttpUrl('https://good.example.com/', { lookup: publicLookup });
  assert.equal(url.hostname, 'good.example.com');
});

test('assertPublicHttpUrl rejects an unresolvable domain', async () => {
  const failingLookup = async () => {
    throw new Error('ENOTFOUND');
  };
  await assert.rejects(
    () => assertPublicHttpUrl('https://does-not-exist.example/', { lookup: failingLookup }),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('HTML entity decoding and tag stripping', () => {
  assert.equal(decodeEntities('A &amp; B &#65; &#x42; &nbsp;'), 'A & B A B  ');
  assert.equal(stripHtml('<div>Hello <b>world</b></div><script>evil()</script>'), 'Hello world');
});

test('parseHtmlPage extracts metadata, contacts, JSON-LD address and about links', () => {
  const html = `<!doctype html><html><head>
    <title>Nordkap Autoteile GmbH</title>
    <meta property="og:title" content="Nordkap Autoteile" />
    <meta name="description" content="European distributor of brake parts and filters." />
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Nordkap Autoteile","email":"sales@nordkap-autoteile.example","telephone":"+49 40 123456","address":{"@type":"PostalAddress","streetAddress":"Hafenstraße 5","postalCode":"20457","addressLocality":"Hamburg","addressCountry":"DE"}}</script>
  </head><body>
    <a href="mailto:info@nordkap-autoteile.example">info</a>
    <a href="tel:+4940123456">call</a>
    <a href="https://www.linkedin.com/company/nordkap-autoteile">LinkedIn</a>
    <a href="/kontakt">Kontakt</a>
    <p>Write to anna.schmidt@nordkap-autoteile.example for details.</p>
  </body></html>`;
  const page = parseHtmlPage(html, 'https://nordkap-autoteile.example/');
  assert.equal(page.title, 'Nordkap Autoteile');
  assert.match(page.description, /European distributor/);
  assert.ok(page.emails.includes('info@nordkap-autoteile.example'));
  assert.ok(page.emails.includes('sales@nordkap-autoteile.example'));
  assert.ok(page.emails.includes('anna.schmidt@nordkap-autoteile.example'));
  assert.equal(page.phone, '+4940123456');
  assert.equal(page.address, 'Hafenstraße 5, 20457, Hamburg, DE');
  assert.equal(page.city, 'Hamburg');
  assert.equal(page.country, 'DE');
  assert.match(page.linkedinUrl, /linkedin\.com\/company\/nordkap-autoteile/);
  assert.deepEqual(page.aboutLinks, ['https://nordkap-autoteile.example/kontakt']);
  assert.equal(page.jsonLdCount, 1);
});

test('parseHtmlPage ignores image-like and disposable addresses', () => {
  const html = `<a href="mailto:logo@2x.png">x</a><a href="mailto:test@mailinator.com">y</a><a href="mailto:real@company.example">z</a>`;
  const page = parseHtmlPage(html, 'https://company.example/');
  assert.deepEqual(page.emails, ['real@company.example']);
});

test('crawlCompanyWebsite fills empty company fields and stores sources', async () => {
  const created = await ctx.request('POST', '/api/v1/companies', {
    body: { name: 'Crawl Test Handler GmbH', website: 'https://crawl-test.example', country: 'DE' },
  });
  assert.equal(created.status, 200, created.text);
  const companyId = created.body.data.id;
  const pages = {
    'https://crawl-test.example/': `<html><head><title>Crawl Test</title><meta name="description" content="Independent aftermarket parts distributor in Hamburg." /></head>
      <body><a href="/kontakt">Kontakt</a><a href="mailto:info@crawl-test.example">mail</a></body></html>`,
    'https://crawl-test.example/kontakt': `<html><head><title>Kontakt</title></head>
      <body><a href="tel:+4940333444">call</a><a href="mailto:sales@crawl-test.example">sales</a>
      <script type="application/ld+json">{"@type":"Organization","address":{"streetAddress":"Hafenweg 9","postalCode":"20457","addressLocality":"Hamburg","addressCountry":"DE"}}</script></body></html>`,
  };
  const fetcher = async (url) => {
    const html = pages[url];
    if (!html) throw new Error(`unexpected fetch ${url}`);
    return { url, html, status: 200 };
  };
  const result = await crawlCompanyWebsite(workspaceId, companyId, { actorId: ctx.owner.userId, fetcher });
  assert.equal(result.fetched, 2);
  assert.ok(result.updatedFields.includes('description'));
  assert.ok(result.updatedFields.includes('phone'));
  assert.ok(result.updatedFields.includes('address'));
  assert.equal(result.contactsCreated, 2);
  assert.ok(result.emailsFound >= 2);

  const detail = await ctx.request('GET', `/api/v1/companies/${companyId}`);
  assert.equal(detail.status, 200);
  assert.match(detail.body.data.company.description, /Independent aftermarket/);
  assert.equal(detail.body.data.company.phone, '+4940333444');
  assert.equal(detail.body.data.company.city, 'Hamburg');
  assert.equal(detail.body.data.company.country, 'DE');
  assert.ok(detail.body.data.sources.length >= 2);
  assert.equal(detail.body.data.sources[0].sourceType, 'crawl');
  const crawledEmails = detail.body.data.contacts.filter((contact) => contact.email).map((contact) => contact.email);
  assert.ok(crawledEmails.includes('info@crawl-test.example'));
  assert.ok(crawledEmails.includes('sales@crawl-test.example'));
  for (const contact of detail.body.data.contacts) {
    assert.equal(contact.emailStatus, 'unverified');
    assert.equal(contact.sources[0].method, 'crawl');
  }
});

test('enrichCompany without a website returns a no-op summary', async () => {
  const created = await ctx.request('POST', '/api/v1/companies', { body: { name: 'No Website Handler' } });
  const result = await enrichCompany({ workspaceId, companyId: created.body.data.id, actorId: ctx.owner.userId });
  assert.equal(result.updated, false);
  assert.equal(result.contactsCreated, 0);
  assert.equal(result.pagesFetched, 0);
  assert.equal(result.error, null);
});

test('enrichCompany infers emails for existing contacts without email', async () => {
  const created = await ctx.request('POST', '/api/v1/companies', {
    body: { name: 'Infer Test GmbH', domain: 'infer-test.example' },
  });
  const companyId = created.body.data.id;
  const contact = await ctx.request('POST', `/api/v1/companies/${companyId}/contacts`, {
    body: { firstName: 'Anna', lastName: 'Schmidt' },
  });
  assert.equal(contact.status, 200, contact.text);
  const fetcher = async (url) => ({
    url,
    status: 200,
    html: '<html><head><title>Infer Test</title></head><body>No emails published.</body></html>',
  });
  const result = await enrichCompany({ workspaceId, companyId, actorId: ctx.owner.userId, fetcher });
  assert.ok(result.inferredEmails >= 1);
  const detail = await ctx.request('GET', `/api/v1/companies/${companyId}`);
  const refreshed = detail.body.data.contacts.find((item) => item.id === contact.body.data.id);
  assert.equal(refreshed.emailStatus, 'inferred');
  assert.match(refreshed.email, /@infer-test\.example$/);
  assert.ok(refreshed.sources.some((source) => source.method === 'inference'));
});
