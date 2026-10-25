import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCompanyQualification,
  readQualificationFromTags,
  summarizeQualification,
  withQualificationTags,
} from '../../server/services/scoring.mjs';
import { mapCompany } from '../../server/repositories/companies.mjs';

const icp = { targetCountries: ['DE', 'AT', 'CH'] };

function company(overrides = {}) {
  return {
    id: 'cmp_q',
    name: 'Rheinland Autoteile GmbH',
    country: 'DE',
    companyType: null,
    industry: 'Automotive Aftermarket',
    description: 'Kfz-Ersatzteile Großhandel für Händler und regionale Distributoren.',
    tags: [],
    ...overrides,
  };
}

const crawl = [{ source_type: 'crawl', source_name: '官网抓取', source_url: 'https://rheinland.example/ueber-uns', payload_json: '{"title":"Autoteile Großhandel"}' }];
const discoveryOnly = [{ source_type: 'discovery', source_name: 'browser', payload_json: '{}' }];

test('a verified B2B wholesaler is qualified from official evidence', () => {
  const result = classifyCompanyQualification({ company: company(), sources: crawl, icp });
  assert.equal(result.qualification, 'qualified');
  assert.equal(result.reason, 'verified_direct_buyer');
});

test('a marketplace is rejected even when it contains wholesale keywords', () => {
  const result = classifyCompanyQualification({
    company: company({ name: 'B2B Autoteile Marktplatz', description: 'B2B Marktplatz und Großhandel Plattform für Händler' }),
    sources: crawl,
    icp,
  });
  assert.equal(result.qualification, 'rejected');
  assert.equal(result.reason, 'platform_or_directory');
});

test('a retail-only onlineshop is rejected even with a direct-buyer type', () => {
  const explicitRetail = classifyCompanyQualification({
    company: company({ companyType: 'retailer', name: 'Teile Shop', description: 'B2C Onlineshop für Endkunden' }),
    sources: crawl,
    icp,
  });
  assert.equal(explicitRetail.qualification, 'rejected');
  assert.equal(explicitRetail.reason, 'retail_only');
});

test('a retail-only onlineshop is rejected', () => {
  const result = classifyCompanyQualification({
    company: company({ name: 'Autoteile Direkt Shop', description: 'B2C Onlineshop für Endkunden und Einzelhandel' }),
    sources: crawl,
    icp,
  });
  assert.equal(result.qualification, 'rejected');
  assert.equal(result.reason, 'retail_only');
});

test('a manufacturer or own brand is not automatically a target buyer', () => {
  const result = classifyCompanyQualification({
    company: company({ name: 'Parts Brand GmbH', description: 'Hersteller und eigene Marke für Bremsen' }),
    sources: crawl,
    icp,
  });
  assert.equal(result.qualification, 'rejected');
  assert.equal(result.reason, 'manufacturer_or_brand');
});

test('a company outside the ICP target countries is rejected', () => {
  const result = classifyCompanyQualification({
    company: company({ country: 'TR', description: 'Automotive spare parts wholesaler and distributor' }),
    sources: crawl,
    icp,
  });
  assert.equal(result.qualification, 'rejected');
  assert.equal(result.reason, 'country_mismatch');
});

test('a homepage-only or shallow search result is insufficient, not qualified', () => {
  const homepageOnly = classifyCompanyQualification({
    company: company(),
    sources: [{ source_type: 'crawl', source_name: '官网抓取', source_url: 'https://rheinland.example/', payload_json: '{"title":"Autoteile Großhandel"}' }],
    icp,
  });
  assert.equal(homepageOnly.qualification, 'insufficient_evidence');
  assert.equal(homepageOnly.reason, 'official_business_page_missing');
});

test('thin search-result evidence is insufficient, not qualified', () => {
  const result = classifyCompanyQualification({
    company: company({ description: 'Autoteile -', companyType: null }),
    sources: discoveryOnly,
    icp,
  });
  assert.equal(result.qualification, 'insufficient_evidence');
  assert.equal(result.reason, 'official_business_page_missing');
});

test('qualification tags round-trip and replace prior qualification', () => {
  const first = withQualificationTags(['crm:new'], { qualification: 'insufficient_evidence', reason: 'official_business_evidence_missing' });
  assert.equal(readQualificationFromTags(first), 'insufficient_evidence');
  const second = withQualificationTags(first, { qualification: 'qualified', reason: 'verified_direct_buyer' });
  assert.equal(readQualificationFromTags(second), 'qualified');
  assert.ok(second.includes('crm:new'));
  assert.equal(second.filter((tag) => tag.startsWith('qualification:')).length, 1);
});

test('company API mapper exposes persisted qualification and reason', () => {
  const mapped = mapCompany({
    id: 'cmp_q',
    workspace_id: 'ws_1',
    name: 'Rheinland Autoteile GmbH',
    normalized_name: 'rheinland autoteile',
    status: 'new',
    tags_json: JSON.stringify(['qualification:qualified', 'qualification_reason:verified_direct_buyer']),
    data_quality_score: 0,
    confidence: 'low',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(mapped.qualification, 'qualified');
  assert.equal(mapped.qualificationReason, 'verified_direct_buyer');
});

test('quota counting counts only qualified companies and never rejected or insufficient ones', () => {
  const summary = summarizeQualification([
    { qualification: 'qualified' },
    { qualification: 'rejected' },
    { qualification: 'insufficient_evidence' },
    { qualification: null },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.qualified, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.insufficientEvidence, 1);
  assert.equal(summary.unclassified, 1);
  assert.equal(summary.verified, 3);
  assert.equal(summary.qualifiedRate, 33.3);
});
