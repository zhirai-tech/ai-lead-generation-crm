import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScore,
  inferCompanyIdentity,
} from '../../server/services/scoring.mjs';
import { matchProductRules } from '../../server/services/products.mjs';

function baseCompany(overrides = {}) {
  return {
    id: 'cmp_identity',
    name: 'Rheinland Autoteile GmbH',
    domain: 'rheinland-autoteile.example',
    website: 'https://rheinland-autoteile.example',
    country: 'DE',
    region: 'Baden-Württemberg',
    city: 'Stuttgart',
    address: 'Industriestraße 12, 70173 Stuttgart',
    companyType: null,
    industry: 'Automotive Aftermarket',
    description: 'We are a distributor and importer of brake parts, filters and suspension for the European aftermarket.',
    phone: '+49 711 123456',
    status: 'new',
    confidence: 'medium',
    ...overrides,
  };
}

const product = {
  id: 'prd_identity',
  name: 'Brake Disc Rotor',
  category: 'Brake System',
  status: 'active',
  applications: ['brake', 'passenger car', 'aftermarket'],
  materials: 'grey cast iron',
  certifications: ['IATF 16949'],
};

const icp = {
  id: 'icp_identity',
  targetCountries: ['DE'],
  targetRegions: [],
  targetCompanyTypes: ['distributor', 'wholesaler', 'importer'],
  excludeKeywords: [],
};

const contacts = [{
  id: 'ctc_identity',
  fullName: 'Public Role',
  email: 'buyer@rheinland-autoteile.example',
  emailNormalized: 'buyer@rheinland-autoteile.example',
  emailStatus: 'valid',
  roleCategory: 'decision_maker',
}];

test('identity: a marketplace/aggregator platform is not scored as a direct buyer', () => {
  const platform = baseCompany({
    name: 'OPTIMAL 24 Germany B2B',
    domain: 'optimal24.de',
    website: 'https://www.optimal24.de',
    description: 'Durch unseren B2B online Großhandelsmarktplatz greifen Kunden auf Großhändler, Autoteile und Katalog-Angebote zu.',
  });
  const identity = inferCompanyIdentity(platform);
  assert.equal(identity.role, 'platform');
  const result = computeScore({ company: platform, product, icp, contacts, signals: {} });
  const typeFactor = result.factors.find((factor) => factor.key === 'company_type');
  const buyingFactor = result.factors.find((factor) => factor.key === 'buying_scenario');
  assert.ok(typeFactor.score <= 0.1, 'platform type must not receive direct-buyer credit');
  assert.ok(buyingFactor.score <= 0.1, 'platform catalogue keywords must not count as own buying');
  assert.ok(result.score < 65, 'platform must not retain a high-priority B grade');
});

test('identity: a documented wholesaler/distributor gets a direct-buyer role from evidence', () => {
  const wholesaler = baseCompany({
    name: 'AT KFZ-Teile GmbH',
    domain: 'at-kfzteile.de',
    companyType: null,
    description: 'AT KFZ-Teile GmbH ist ein führender internationaler Distributor für Automatikgetriebe-Ersatzteile und Großhandel mit Autoteilen.',
  });
  const identity = inferCompanyIdentity(wholesaler);
  assert.equal(identity.role, 'direct_buyer');
  assert.equal(identity.companyType, 'distributor');
  assert.equal(identity.confidence, 'inferred');
  const result = computeScore({ company: wholesaler, product, icp, contacts, signals: {} });
  const typeFactor = result.factors.find((factor) => factor.key === 'company_type');
  assert.equal(typeFactor.score, 1);
  assert.match(typeFactor.reason, /推断/);
  assert.ok(typeFactor.evidence.some((item) => String(item).includes('distributor')));
});

test('identity: an independent automotive wholesaler is not misclassified as a platform', () => {
  const independent = baseCompany({
    name: 'Müller Autoteile Großhandel GmbH',
    companyType: null,
    description: 'Unabhängiger Großhandel für Autoteile und Ersatzteile in Deutschland.',
  });
  const identity = inferCompanyIdentity(independent);
  assert.equal(identity.role, 'direct_buyer');
  assert.equal(identity.companyType, 'wholesaler');
  assert.notEqual(identity.role, 'platform');
});

test('identity: insufficient evidence remains unknown and does not invent a buyer type', () => {
  const unknown = baseCompany({
    name: 'Autoteile Beispiel',
    companyType: null,
    description: 'Autoteile für Werkstätten und Fahrzeuge.',
  });
  const identity = inferCompanyIdentity(unknown);
  assert.equal(identity.role, 'unknown');
  assert.equal(identity.companyType, null);
  const result = computeScore({ company: unknown, product, icp, contacts, signals: {} });
  const typeFactor = result.factors.find((factor) => factor.key === 'company_type');
  assert.equal(typeFactor.score, 0.35);
  assert.match(typeFactor.reason, /未知/);
});

test('product matching: platform catalogue content does not earn a buyer-profile bonus', () => {
  const platform = baseCompany({
    name: 'Marketplace Example',
    companyType: null,
    description: 'B2B online Großhandelsmarktplatz mit Autoteile-Katalog und Großhändlern.',
  });
  const identity = inferCompanyIdentity(platform);
  const result = matchProductRules(product, platform, { identity });
  assert.equal(result.evidence.some((item) => item.type === 'buyer_profile'), false);
  assert.ok(result.evidence.some((item) => item.type === 'platform_identity'));
});

test('scoring: repeated calculation is deterministic for the same identity', () => {
  const company = baseCompany({ companyType: null, description: 'Distributor für Autoteile und Großhandel.' });
  const first = computeScore({ company, product, icp, contacts, signals: {} });
  const second = computeScore({ company, product, icp, contacts, signals: {} });
  assert.deepEqual(first, second);
});
