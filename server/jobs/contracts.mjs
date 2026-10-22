/**
 * OWNER: t-worker. Dynamic adapters for the cross-module service contracts
 * documented in docs/CONTRACTS.md section 7.
 *
 * t-data / t-crm are developed in parallel. A background handler must never
 * crash the process when an upstream module is not ready yet: it fails the job
 * with a clear, retryable error instead. We therefore import lazily and wrap
 * failures in `UPSTREAM_NOT_READY`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/errors.mjs';

const SERVER_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cache = new Map();

export const UPSTREAM_CONTRACTS = Object.freeze({
  discovery: { file: 'services/discovery.mjs', owner: 't-data', functions: ['executeDiscoveryRun'] },
  enrichment: { file: 'services/enrichment.mjs', owner: 't-data', functions: ['enrichCompany', 'inferEmails'] },
  verification: { file: 'services/verification.mjs', owner: 't-data', functions: ['verifyContactEmail'] },
  scoring: { file: 'services/scoring.mjs', owner: 't-data', functions: ['scoreCompany'] },
  drafts: { file: 'services/drafts.mjs', owner: 't-crm', functions: ['generateDraft'] },
  replies: { file: 'services/replies.mjs', owner: 't-crm', functions: ['classifyInboundMessage'] },
  followups: { file: 'services/followups.mjs', owner: 't-crm', functions: ['planFollowUpForThread'] },
  campaigns: { file: 'services/campaigns.mjs', owner: 't-crm', functions: ['advanceAfterSend', 'getCampaignSendContext'] },
  emailAccounts: { file: 'services/email-accounts.mjs', owner: 't-crm', functions: ['loadSendAccount', 'loadEmailAccount', 'markAccountSynced'] },
});

function upstreamPath(key) {
  const contract = UPSTREAM_CONTRACTS[key];
  if (!contract) throw new Error(`unknown upstream contract: ${key}`);
  return path.join(SERVER_DIR, contract.file);
}

function notReady(key, reason) {
  const contract = UPSTREAM_CONTRACTS[key];
  return new AppError('UPSTREAM_NOT_READY', `上游模块 ${contract.file}（${contract.owner}）尚未就绪：${reason}`, {
    status: 503,
    details: { upstream: key, file: contract.file, owner: contract.owner },
  });
}

export function isUpstreamAvailable(key) {
  try {
    return fs.existsSync(upstreamPath(key));
  } catch {
    return false;
  }
}

/**
 * Load an upstream service module lazily.
 * @returns {Promise<object>} module namespace
 */
export async function loadUpstream(key) {
  if (cache.has(key)) return cache.get(key);
  const file = upstreamPath(key);
  if (!fs.existsSync(file)) {
    throw notReady(key, '文件不存在');
  }
  try {
    const module = await import(new URL(`file://${file.replace(/\\/g, '/')}`).href);
    cache.set(key, module);
    return module;
  } catch (error) {
    // The file may exist while its own dependencies are still being written by
    // another teammate; that is a transient condition, not a crash.
    throw notReady(key, String(error && error.message ? error.message : error).slice(0, 300));
  }
}

/**
 * Call one contract function. Throws `UPSTREAM_NOT_READY` when the module or
 * the function has not been implemented yet.
 */
export async function callUpstream(key, functionName, ...args) {
  const module = await loadUpstream(key);
  const fn = module[functionName];
  if (typeof fn !== 'function') {
    const contract = UPSTREAM_CONTRACTS[key];
    throw notReady(key, `导出函数 ${functionName} 不存在（需要 ${contract.owner} 实现）`);
  }
  return fn(...args);
}

/**
 * Same as `callUpstream` but returns `{ ok:false, skipped:true }` instead of
 * throwing. Used for post-send side effects that must not undo a delivery.
 */
export async function tryCallUpstream(key, functionName, ...args) {
  try {
    const value = await callUpstream(key, functionName, ...args);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, skipped: true, error };
  }
}

/** Test helper: clear the module cache (modules may land while tests run). */
export function resetUpstreamCache() {
  cache.clear();
}

export default { UPSTREAM_CONTRACTS, loadUpstream, callUpstream, tryCallUpstream, isUpstreamAvailable, resetUpstreamCache };
