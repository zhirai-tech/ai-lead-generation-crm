import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companyGroupKey,
  companyIdentityKeys,
  isPlatformSearchResult,
  searchQueries,
  shouldRejectSearchResult,
} from '../../server/services/discovery.mjs';

test('discovery filter rejects a known B2B marketplace landing page', () => {
  assert.equal(
    isPlatformSearchResult({
      url: 'https://www.wlw.com/',
      title: 'wer liefert was (wlw) - Best B2B marketplace For Suppliers',
    }),
    true,
  );
  assert.equal(
    shouldRejectSearchResult({
      url: 'https://www.wlw.com/',
      title: 'Wholesale vehicle parts Germany',
    }),
    true,
  );
});

test('discovery filter rejects known platform profile pages as company candidates', () => {
  assert.equal(
    isPlatformSearchResult({
      url: 'https://www.europages.com/company/acme-parts-gmbh',
      title: 'Acme Parts GmbH - supplier profile',
    }),
    true,
  );
  assert.equal(
    isPlatformSearchResult({
      url: 'https://www.wlw.de/de/unternehmen/acme-parts',
      title: 'Acme Parts GmbH',
    }),
    true,
  );
});

test('discovery filter keeps an independent company website', () => {
  assert.equal(
    isPlatformSearchResult({
      url: 'https://www.at-kfzteile.de/',
      title: 'Auto Parts Wholesale Germany | AT KFZ-Teile GmbH',
    }),
    false,
  );
  assert.equal(
    shouldRejectSearchResult({
      url: 'https://www.at-kfzteile.de/',
      title: 'Auto Parts Wholesale Germany | AT KFZ-Teile GmbH',
    }),
    false,
  );
});

test('discovery filter does not reject an ordinary company with a generic title', () => {
  assert.equal(
    isPlatformSearchResult({
      url: 'https://acme-parts.example/',
      title: 'ACME Parts - B2B marketplace supplier',
    }),
    false,
  );
});

test('discovery filter identifies unknown platform-like hosts only with aggregator evidence', () => {
  assert.equal(
    isPlatformSearchResult({
      url: 'https://www.some-b2b-marketplace.example/',
      title: 'Some B2B Marketplace - supplier directory',
    }),
    true,
  );
  assert.equal(
    isPlatformSearchResult({
      url: 'https://www.some-b2b-marketplace.example/company/acme',
      title: 'Acme company profile',
    }),
    true,
  );
});

test('discovery filter rejects malformed URLs safely', () => {
  assert.equal(shouldRejectSearchResult({ url: 'not a url', title: 'Nope' }), true);
  assert.equal(isPlatformSearchResult({ url: 'not a url', title: 'Nope' }), false);
});

test('discovery filter rejects marketplace and report titles even on unknown hosts', () => {
  const cases = [
    ['https://www.tyre100.de/', 'Autoteile B2B Marktplatz | Autoteilebörse'],
    ['https://kfzeuropa.com/', 'KFZ Europa - Der Marktplatz für KFZ-Ersatzteile'],
    ['https://merkandi.de/', 'Großhandel Plattform für gewerbetreibende - B2B Merkandi.de'],
    ['https://towobo.com/', 'Find Manufacturers & Wholesalers | Global B2B Marketplace'],
    ['https://wolk-aftersales.com/en/report', 'Car parts webshops in Germany'],
  ];
  for (const [url, title] of cases) {
    assert.equal(shouldRejectSearchResult({ url, title }), true, `${url} must be rejected`);
  }
});

test('discovery filter does not reject a normal independent company with wholesale title', () => {
  assert.equal(
    shouldRejectSearchResult({
      url: 'https://www.neimcke.de/',
      title: 'KFZ-Ersatzteile - Neimcke - Großhandel für Kfz-Ersatzteile',
    }),
    false,
  );
  assert.equal(
    shouldRejectSearchResult({
      url: 'https://shop.k2-kfzteile.de/',
      title: 'K2 Kfz-Ersatzteile-Grosshandel GmbH',
    }),
    false,
  );
});

test('discovery group key dedupes country and language subdomains of the same company', () => {
  assert.equal(companyGroupKey('de.speautoparts.com'), companyGroupKey('speautoparts.com'));
  assert.notEqual(companyGroupKey('at.intercars.com'), companyGroupKey('intercars.de'));
  assert.ok(companyIdentityKeys('at.intercars.com', 'Inter Cars: Leading European Auto Parts Distributor').some((key) => companyIdentityKeys('intercars.de', 'Inter Cars: Europas führender Ersatzteil-Großhändler').includes(key)));
  assert.notEqual(companyGroupKey('neimcke.de'), companyGroupKey('bema-materials.com'));
});

test('discovery query plan varies by country and customer role', () => {
  const de = searchQueries({ keywords: ['Autoteile'] }, 'DE');
  const at = searchQueries({ keywords: ['Autoteile'] }, 'AT');
  assert.ok(de.length >= 6);
  assert.ok(de.some((query) => /distributor/i.test(query)));
  assert.ok(de.some((query) => /importer/i.test(query)));
  assert.ok(de.some((query) => /wholesaler/i.test(query)));
  assert.ok(de.every((query) => query.includes('Germany')));
  assert.ok(at.every((query) => query.includes('Austria')));
  assert.notDeepEqual(de, at);
});

test('discovery group key does not collapse different public suffix tenants', () => {
  assert.notEqual(companyGroupKey('alpha.co.uk'), companyGroupKey('beta.co.uk'));
  assert.notEqual(companyGroupKey('acme.wixsite.com'), companyGroupKey('beta.wixsite.com'));
  assert.notEqual(companyGroupKey('foo.example.com'), companyGroupKey('bar.example.org'));
});

test('identity keys do not merge generic spare-parts names', () => {
  const left = companyIdentityKeys('oe-germany.com', 'Spare parts automotive');
  const right = companyIdentityKeys('myauto.it', 'Spare parts');
  assert.equal(left.some((key) => right.includes(key)), false);
});

test('alpha.co.uk is not collapsed to alpha.uk', () => {
  assert.equal(companyGroupKey('alpha.co.uk'), 'alpha.co.uk');
  assert.notEqual(companyGroupKey('alpha.co.uk'), companyGroupKey('alpha.uk'));
  const left = companyIdentityKeys('alpha.co.uk', 'Alpha');
  const right = companyIdentityKeys('alpha.uk', 'Alpha');
  assert.equal(left.some((key) => right.includes(key)), false);
});

test('same name on different strong domains is not a duplicate by name alone', () => {
  const left = companyIdentityKeys('strong-domain-one.com', 'Spare parts');
  const right = companyIdentityKeys('strong-domain-two.com', 'Spare parts');
  assert.equal(left.some((key) => right.includes(key)), false);
});
