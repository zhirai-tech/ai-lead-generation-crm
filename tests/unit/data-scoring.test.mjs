import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, gradeForScore, FACTOR_DEFINITIONS, SCORE_MODEL_VERSION } from '../../server/services/scoring.mjs';
import { matchProductRules } from '../../server/services/products.mjs';

function makeCompany(overrides = {}) {
  return {
    id: 'cmp_1',
    name: 'Rheinland Autoteile GmbH',
    domain: 'rheinland-autoteile.example',
    website: 'https://rheinland-autoteile.example',
    country: 'DE',
    region: 'Baden-Württemberg',
    city: 'Stuttgart',
    address: 'Industriestraße 12, 70173 Stuttgart',
    companyType: 'distributor',
    industry: 'Automotive Aftermarket',
    description: 'Distributor and importer of brake parts, filters and suspension for the European aftermarket.',
    employeeRange: '51-200',
    revenueRange: '10-50M',
    linkedinUrl: 'https://linkedin.com/company/rheinland-autoteile',
    phone: '+49 711 123456',
    status: 'new',
    confidence: 'medium',
    tags: [],
    icpId: 'icp_1',
    ...overrides,
  };
}

function makeProduct(overrides = {}) {
  return {
    id: 'prd_1',
    name: 'Brake Disc Rotor',
    category: 'Brake System',
    status: 'active',
    applications: ['brake', 'passenger car', 'aftermarket'],
    materials: 'grey cast iron',
    certifications: ['IATF 16949', 'ECE R90'],
    ...overrides,
  };
}

function makeIcp(overrides = {}) {
  return {
    id: 'icp_1',
    name: 'European automotive distributors',
    targetCountries: ['DE', 'FR', 'IT'],
    targetRegions: [],
    targetCompanyTypes: ['distributor', 'wholesaler', 'importer'],
    excludeKeywords: [],
    minScore: 60,
    isActive: true,
    ...overrides,
  };
}

function makeContacts() {
  return [
    {
      id: 'ctc_1',
      fullName: 'Anna Schmidt',
      email: 'anna.schmidt@rheinland-autoteile.example',
      emailNormalized: 'anna.schmidt@rheinland-autoteile.example',
      emailStatus: 'valid',
      roleCategory: 'decision_maker',
    },
  ];
}

test('weights of all factors sum to 1', () => {
  const total = FACTOR_DEFINITIONS.reduce((sum, factor) => sum + factor.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('computeScore returns an explainable weighted score with 7 factors', () => {
  const result = computeScore({
    company: makeCompany(),
    product: makeProduct(),
    icp: makeIcp(),
    contacts: makeContacts(),
    signals: { repliedThreadAt: new Date().toISOString() },
  });
  assert.equal(result.factors.length, FACTOR_DEFINITIONS.length);
  for (const factor of result.factors) {
    assert.equal(typeof factor.key, 'string');
    assert.equal(typeof factor.label, 'string');
    assert.ok(factor.weight > 0);
    assert.ok(factor.score >= 0 && factor.score <= 1, `factor ${factor.key} score out of range`);
    assert.ok(factor.reason.length > 0);
  }
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.exclusions.length, 0);
  assert.equal(result.grade, gradeForScore(result.score));
  assert.ok(result.explanation.includes('综合评分'));
  assert.match(result.explanation, /主要加分项/);
});

test('grade thresholds are monotonic', () => {
  assert.equal(gradeForScore(80), 'A');
  assert.equal(gradeForScore(79), 'B');
  assert.equal(gradeForScore(65), 'B');
  assert.equal(gradeForScore(64), 'C');
  assert.equal(gradeForScore(45), 'C');
  assert.equal(gradeForScore(44), 'D');
  assert.equal(gradeForScore(0), 'D');
});

test('a strong ICP match scores higher than a mismatched company', () => {
  const strong = computeScore({ company: makeCompany(), product: makeProduct(), icp: makeIcp(), contacts: makeContacts(), signals: {} });
  const weak = computeScore({
    company: makeCompany({
      country: 'US',
      companyType: 'manufacturer',
      industry: 'Furniture',
      description: 'Furniture manufacturer for offices, no imports.',
      confidence: 'unverified',
    }),
    product: makeProduct(),
    icp: makeIcp(),
    contacts: [],
    signals: {},
  });
  assert.ok(strong.score > weak.score, `expected ${strong.score} > ${weak.score}`);
});

test('archived product triggers an exclusion and forces score 0 / grade D', () => {
  const result = computeScore({
    company: makeCompany(),
    product: makeProduct({ status: 'archived' }),
    icp: makeIcp(),
    contacts: makeContacts(),
    signals: {},
  });
  assert.equal(result.exclusions.length, 1);
  assert.equal(result.exclusions[0].code, 'product_inactive');
  assert.equal(result.score, 0);
  assert.equal(result.grade, 'D');
  assert.match(result.explanation, /排除规则/);
});

test('suppression hit and do-not-contact are both exclusions', () => {
  const result = computeScore({
    company: makeCompany(),
    product: makeProduct(),
    icp: makeIcp(),
    contacts: makeContacts(),
    signals: { suppressed: true, automationState: 'DO_NOT_CONTACT' },
  });
  const codes = result.exclusions.map((item) => item.code).sort();
  assert.deepEqual(codes, ['do_not_contact', 'suppressed']);
  assert.equal(result.score, 0);
  assert.equal(result.grade, 'D');
});

test('ICP exclude keyword excludes the company', () => {
  const result = computeScore({
    company: makeCompany({ description: 'We are a broker and never buy stock.' }),
    product: makeProduct(),
    icp: makeIcp({ excludeKeywords: ['broker'] }),
    contacts: makeContacts(),
    signals: {},
  });
  assert.equal(result.exclusions[0].code, 'icp_exclude_keyword');
});

test('disqualified company status is excluded', () => {
  const result = computeScore({
    company: makeCompany({ status: 'disqualified' }),
    product: makeProduct(),
    icp: makeIcp(),
    contacts: makeContacts(),
    signals: {},
  });
  assert.equal(result.exclusions[0].code, 'company_status');
});

test('matchProductRules is deterministic and bounded', () => {
  const first = matchProductRules(makeProduct(), makeCompany());
  const second = matchProductRules(makeProduct(), makeCompany());
  assert.deepEqual(first, second);
  assert.ok(first.score >= 0 && first.score <= 1);
  assert.ok(first.reasons.length > 0);
  assert.ok(Array.isArray(first.evidence));
});

test('score model version is exposed for traceability', () => {
  assert.equal(SCORE_MODEL_VERSION, 'rules-v1');
});
