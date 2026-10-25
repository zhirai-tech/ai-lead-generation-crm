/**
 * OWNER: t-worker. t-data handlers (discovery / crawl / enrichment /
 * verification / scoring). All cross-module calls go through the documented
 * contracts (CONTRACTS.md 7.1) via lazy dynamic import so a missing upstream
 * module fails the job with a retryable, explicit error instead of crashing.
 */
import { callUpstream } from '../contracts.mjs';
import { recordJobAudit, recordJobUsage } from '../job-log.mjs';
import { requirePayloadField } from './index.mjs';

async function discoverySearch({ job, workspaceId, payload }) {
  const discoveryRunId = requirePayloadField(payload, 'discoveryRunId');
  const result = await callUpstream('discovery', 'executeDiscoveryRun', workspaceId, discoveryRunId, { actorId: job.createdBy || null });
  recordJobUsage({ workspaceId, category: 'data_lookup', quantity: 1, jobId: job.id, provider: 'discovery' });
  recordJobAudit({
    workspaceId,
    action: 'discovery.run.completed',
    entityType: 'discovery_run',
    entityId: discoveryRunId,
    after: { companiesCreated: result?.companiesCreated ?? 0, resultCount: result?.resultCount ?? 0, jobId: job.id },
  });
  return { discoveryRunId, ...result };
}

async function companyCrawl({ job, workspaceId, payload }) {
  const companyId = requirePayloadField(payload, 'companyId');
  const result = await callUpstream('enrichment', 'enrichCompany', { workspaceId, companyId, actorId: job.createdBy || null });
  recordJobUsage({ workspaceId, category: 'crawl', quantity: 1, jobId: job.id, provider: 'public_web' });
  recordJobAudit({
    workspaceId,
    action: 'company.crawl.completed',
    entityType: 'company',
    entityId: companyId,
    after: { updated: result?.updated ?? null, contactsCreated: result?.contactsCreated ?? 0, jobId: job.id },
  });
  return { companyId, ...result };
}

async function companyEnrich({ job, workspaceId, payload }) {
  const companyId = requirePayloadField(payload, 'companyId');
  const result = await callUpstream('enrichment', 'enrichCompany', { workspaceId, companyId, actorId: job.createdBy || null });
  if (payload.discoveryRunId) {
    try {
      const { recordEnrichmentProgress } = await import('../../services/discovery.mjs');
      recordEnrichmentProgress(workspaceId, payload.discoveryRunId, {
        companyName: payload.companyName || '',
        emails: result?.emailsFound || 0,
        phones: result?.browser?.phones?.length || 0,
        foundEmails: Array.isArray(result?.emails) ? result.emails : [],
        foundPhones: Array.isArray(result?.browser?.phones) ? result.browser.phones : [],
        address: result?.browser?.address || null,
        socials: Array.isArray(result?.browser?.socials) ? result.browser.socials : [],
      });
    } catch {
      // progress display is best-effort and must never fail enrichment
    }
  }
  recordJobUsage({ workspaceId, category: 'data_lookup', quantity: 1, jobId: job.id, provider: 'enrichment' });
  recordJobAudit({
    workspaceId,
    action: 'company.enrich.completed',
    entityType: 'company',
    entityId: companyId,
    after: { updated: result?.updated ?? null, contactsCreated: result?.contactsCreated ?? 0, emailsFound: result?.emailsFound ?? 0, jobId: job.id },
  });
  return { companyId, ...result };
}

async function contactVerify({ job, workspaceId, payload }) {
  const contactId = requirePayloadField(payload, 'contactId');
  const result = await callUpstream('verification', 'verifyContactEmail', { workspaceId, contactId, actorId: job.createdBy || null });
  recordJobUsage({ workspaceId, category: 'data_lookup', quantity: 1, jobId: job.id, provider: 'mx_verification' });
  recordJobAudit({
    workspaceId,
    action: 'contact.verify.completed',
    entityType: 'contact',
    entityId: contactId,
    after: { emailStatus: result?.emailStatus ?? null, mx: result?.mx ?? null, jobId: job.id },
  });
  return { contactId, ...result };
}

async function leadScore({ job, workspaceId, payload }) {
  const companyId = requirePayloadField(payload, 'companyId');
  const productId = payload.productId || null;
  const result = await callUpstream('scoring', 'scoreCompany', { workspaceId, companyId, productId, actorId: job.createdBy || null });
  recordJobUsage({ workspaceId, category: 'data_lookup', quantity: 1, jobId: job.id, provider: 'rules' });
  recordJobAudit({
    workspaceId,
    action: 'lead.score.completed',
    entityType: 'company',
    entityId: companyId,
    after: { score: result?.score ?? null, grade: result?.grade ?? null, productId, jobId: job.id },
  });
  return { companyId, productId, ...result };
}

export const handlers = {
  'discovery.search': discoverySearch,
  'company.crawl': companyCrawl,
  'company.enrich': companyEnrich,
  'contact.verify': contactVerify,
  'lead.score': leadScore,
};

export default handlers;
