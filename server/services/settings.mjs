/**
 * Workspace settings: defaults, merge semantics and encrypted integration
 * credentials. Settings are always scoped to the active workspace and can only
 * be changed by admins/owners (enforced in the routes).
 */
import { all, get, run, upsertSetting, parseJson } from '../core/db.mjs';
import { encryptCredential, decryptCredential, maskSecret } from '../core/crypto.mjs';
import { getSecret } from '../core/secrets.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { badRequest, notFound } from '../core/errors.mjs';
import { recordAudit } from '../core/audit.mjs';

export const SETTING_GROUPS = ['outreach', 'limits', 'retention', 'ai', 'compliance', 'enrichment'];

export const DEFAULT_SETTINGS = Object.freeze({
  outreach: {
    requireApproval: true,
    autoSendEnabled: false,
    dailySendLimit: 50,
    sendWindow: { start: 9, end: 17, weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' },
    signature: '',
    defaultLanguage: 'en',
  },
  limits: {
    dailyEmailLimit: 50,
    dailyAiTokens: 500000,
    hourlyJobLimit: 300,
    maxCrawlPagesPerJob: 30,
    maxCompaniesPerDiscovery: 100,
  },
  retention: {
    messageDays: 730,
    contactDays: 1095,
    jobDays: 30,
    auditDays: 730,
    usageDays: 730,
  },
  ai: {
    provider: 'openai_compatible',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokensPerRun: 4096,
    allowAutoSend: false,
    language: 'en',
  },
  compliance: {
    legalBasis: 'legitimate_interest',
    includeUnsubscribe: true,
    senderCompanyName: '',
    senderAddress: '',
    privacyUrl: '',
    doNotContactNote: '',
  },
  enrichment: {
    maxEmailsPerDomain: 5,
    verifyMx: true,
    crawlUserAgent: 'ZHIRAI-Outreach/1.0 (+https://zhirai.cloud)',
    crawlTimeoutMs: 12000,
    maxPagesPerDomain: 4,
  },
});

export const PROVIDER_CATALOG = [
  {
    key: 'csv_import',
    name: 'CSV / 表格导入',
    category: 'search',
    adapter: 'csv',
    capabilities: ['import'],
    costModel: '免费',
    isEnabled: 1,
    config: {},
  },
  {
    key: 'company_enrichment',
    name: '可配置企业数据提供商',
    category: 'enrichment',
    adapter: 'http_enrichment',
    capabilities: ['enrichment'],
    costModel: '按所选服务商计费',
    isEnabled: 0,
    config: { baseUrl: '', provider: '' },
  },
  {
    key: 'mx_verification',
    name: '域名邮件交换记录校验',
    category: 'verification',
    adapter: 'dns_mx',
    capabilities: ['verification'],
    costModel: '免费',
    isEnabled: 1,
    config: {},
  },
  {
    key: 'openai_compatible',
    name: 'DeepSeek 语言模型（不负责搜索）',
    category: 'ai',
    adapter: 'openai_compatible',
    capabilities: ['chat', 'json'],
    costModel: '按所选服务商计费',
    isEnabled: 1,
    config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  },
];

export function ensureWorkspaceDefaults(workspaceId) {
  const now = nowIso();
  for (const key of SETTING_GROUPS) {
    const exists = get('SELECT 1 AS ok FROM settings WHERE workspace_id = ? AND key = ?', [workspaceId, key]);
    if (!exists) upsertSetting(workspaceId, key, DEFAULT_SETTINGS[key]);
  }
  for (const provider of PROVIDER_CATALOG) {
    const exists = get('SELECT 1 AS ok FROM external_providers WHERE workspace_id = ? AND key = ?', [workspaceId, provider.key]);
    if (!exists) {
      run(
        `INSERT INTO external_providers (id, workspace_id, key, name, category, adapter, capabilities_json, cost_model, config_json, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('prv'), workspaceId, provider.key, provider.name, provider.category, provider.adapter, JSON.stringify(provider.capabilities), provider.costModel, JSON.stringify(provider.config), provider.isEnabled, now, now],
      );
    }
  }
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (base && typeof base === 'object' && patch && typeof patch === 'object') {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = deepMerge(base[key], value);
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

export function getSettings(workspaceId) {
  ensureWorkspaceDefaults(workspaceId);
  const rows = all('SELECT key, value_json FROM settings WHERE workspace_id = ?', [workspaceId]);
  const stored = Object.fromEntries(rows.map((row) => [row.key, parseJson(row.value_json, {})]));
  const merged = {};
  for (const key of SETTING_GROUPS) {
    merged[key] = deepMerge(DEFAULT_SETTINGS[key], stored[key] || {});
  }
  return merged;
}

export function getSetting(workspaceId, key) {
  const row = get('SELECT value_json FROM settings WHERE workspace_id = ? AND key = ?', [workspaceId, key]);
  return deepMerge(DEFAULT_SETTINGS[key] || {}, parseJson(row?.value_json, {}));
}

export function updateSettings(workspaceId, patch, { actorId = null, ip = null, userAgent = null, requestId = null } = {}) {
  const before = getSettings(workspaceId);
  const cleanPatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!SETTING_GROUPS.includes(key)) throw badRequest(`未知设置分组：${key}`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`设置分组 ${key} 必须是对象`);
    cleanPatch[key] = value;
  }
  const after = {};
  for (const [key, value] of Object.entries(cleanPatch)) {
    const merged = deepMerge(before[key], value);
    upsertSetting(workspaceId, key, merged);
    after[key] = merged;
  }
  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'settings.update',
    entityType: 'workspace',
    entityId: workspaceId,
    before,
    after,
    ip,
    userAgent,
    requestId,
  });
  return getSettings(workspaceId);
}

// ------------------------------------------------------------------ providers
export function listProviders(workspaceId) {
  ensureWorkspaceDefaults(workspaceId);
  return all('SELECT * FROM external_providers WHERE workspace_id = ? ORDER BY category, name', [workspaceId]).map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    category: row.category,
    adapter: row.adapter,
    capabilities: parseJson(row.capabilities_json, []),
    costModel: row.cost_model,
    config: parseJson(row.config_json, {}),
    isEnabled: Boolean(row.is_enabled),
    updatedAt: row.updated_at,
  }));
}

export function updateProvider(workspaceId, key, { isEnabled, config } = {}, { actorId = null } = {}) {
  const row = get('SELECT * FROM external_providers WHERE workspace_id = ? AND key = ?', [workspaceId, key]);
  if (!row) throw notFound('数据源不存在');
  const nextConfig = config !== undefined ? { ...parseJson(row.config_json, {}), ...config } : parseJson(row.config_json, {});
  const nextEnabled = isEnabled === undefined ? row.is_enabled : isEnabled ? 1 : 0;
  run('UPDATE external_providers SET is_enabled = ?, config_json = ?, updated_at = ? WHERE id = ?', [
    nextEnabled,
    JSON.stringify(nextConfig),
    nowIso(),
    row.id,
  ]);
  recordAudit({
    workspaceId,
    actorType: actorId ? 'user' : 'system',
    actorId,
    action: 'provider.update',
    entityType: 'external_provider',
    entityId: row.id,
    before: { isEnabled: Boolean(row.is_enabled), config: parseJson(row.config_json, {}) },
    after: { isEnabled: Boolean(nextEnabled), config: nextConfig },
  });
  return listProviders(workspaceId);
}

// ---------------------------------------------------------------- credentials
export function credentialContext(workspaceId, kind, providerKey) {
  return `${workspaceId}:${kind}:${providerKey}`;
}

export function saveCredential(workspaceId, kind, providerKey, { label = '', secret = {}, config = {} } = {}, { actorId = null } = {}) {
  if (!providerKey || !/^[a-z0-9_\-]{2,60}$/i.test(providerKey)) throw badRequest('providerKey 不合法');
  const sealed = encryptCredential(getSecret(), credentialContext(workspaceId, kind, providerKey), secret);
  const existing = get('SELECT * FROM integration_credentials WHERE workspace_id = ? AND kind = ? AND provider_key = ?', [workspaceId, kind, providerKey]);
  const now = nowIso();
  if (existing) {
    run(
      'UPDATE integration_credentials SET label = ?, credential_enc = ?, config_json = ?, status = ?, updated_at = ? WHERE id = ?',
      [label || existing.label, sealed, JSON.stringify(config), 'active', now, existing.id],
    );
    recordAudit({ workspaceId, actorType: 'user', actorId, action: 'credential.update', entityType: 'integration_credential', entityId: existing.id, after: { kind, providerKey, label } });
    return { id: existing.id, kind, providerKey, label: label || existing.label };
  }
  const credentialId = id('crd');
  run(
    `INSERT INTO integration_credentials (id, workspace_id, kind, provider_key, label, credential_enc, config_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [credentialId, workspaceId, kind, providerKey, label || providerKey, sealed, JSON.stringify(config), actorId, now, now],
  );
  recordAudit({ workspaceId, actorType: 'user', actorId, action: 'credential.create', entityType: 'integration_credential', entityId: credentialId, after: { kind, providerKey, label } });
  return { id: credentialId, kind, providerKey, label: label || providerKey };
}

export function listCredentials(workspaceId) {
  return all('SELECT * FROM integration_credentials WHERE workspace_id = ? ORDER BY kind, provider_key', [workspaceId]).map((row) => ({
    id: row.id,
    kind: row.kind,
    providerKey: row.provider_key,
    label: row.label,
    status: row.status,
    config: parseJson(row.config_json, {}),
    hasSecret: Boolean(row.credential_enc),
    secretPreview: row.credential_enc ? maskSecret(decryptCredentialSafe(workspaceId, row)) : null,
    updatedAt: row.updated_at,
  }));
}

function decryptCredentialSafe(workspaceId, row) {
  try {
    const payload = decryptCredential(getSecret(), credentialContext(workspaceId, row.kind, row.provider_key), row.credential_enc);
    return payload?.apiKey || payload?.token || payload?.secret || '';
  } catch {
    return '';
  }
}

export function getCredential(workspaceId, kind, providerKey) {
  const row = get('SELECT * FROM integration_credentials WHERE workspace_id = ? AND kind = ? AND provider_key = ?', [workspaceId, kind, providerKey]);
  if (!row || row.status !== 'active') return null;
  try {
    return {
      record: row,
      secret: decryptCredential(getSecret(), credentialContext(workspaceId, kind, providerKey), row.credential_enc),
      config: parseJson(row.config_json, {}),
    };
  } catch {
    return null;
  }
}

export function deleteCredential(workspaceId, credentialId, { actorId = null } = {}) {
  const row = get('SELECT * FROM integration_credentials WHERE workspace_id = ? AND id = ?', [workspaceId, credentialId]);
  if (!row) throw notFound('凭据不存在');
  run('DELETE FROM integration_credentials WHERE id = ?', [credentialId]);
  recordAudit({ workspaceId, actorType: 'user', actorId, action: 'credential.delete', entityType: 'integration_credential', entityId: credentialId, before: { kind: row.kind, providerKey: row.provider_key } });
  return true;
}
