/**
 * Application configuration.
 *
 * Configuration is read once at boot from environment variables, with an
 * optional local `.env` file. Secrets are never exposed to the browser:
 * only this process reads them. Runtime data lives under DATA_DIR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function intEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? '1' : '0').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

loadDotEnv(path.join(ROOT_DIR, '.env'));

const dataDir = path.resolve(ROOT_DIR, env('DATA_DIR', 'server/data'));
const publicBaseUrl = env('PUBLIC_BASE_URL', `http://127.0.0.1:${intEnv('PORT', 4173)}`).replace(/\/+$/, '');

// Migration gate: an unset allowlist is not the same as an explicit empty list.
// Unset means the operator did not state which migrations are approved, so the
// process must fail before applying any migration. An explicitly empty list
// means "approve no pending migrations".
const rawMigrationAllowlist = process.env.MIGRATION_ALLOWLIST;
const normalizedMigrationAllowlist = rawMigrationAllowlist === undefined ? null : rawMigrationAllowlist.trim();
const migrationAllowlist = normalizedMigrationAllowlist === null
  ? null
  : normalizedMigrationAllowlist === '' || normalizedMigrationAllowlist.toLowerCase() === 'none'
    ? []
    : normalizedMigrationAllowlist.split(',').map((item) => item.trim()).filter(Boolean);

export const config = Object.freeze({
  env: env('NODE_ENV', 'development'),
  isProduction: env('NODE_ENV', 'development') === 'production',
  rootDir: ROOT_DIR,
  version: readVersion(),
  appName: env('APP_NAME', 'ZHIRAI Outreach'),
  host: env('HOST', '127.0.0.1'),
  port: intEnv('PORT', 4173, { min: 1, max: 65535 }),
  publicBaseUrl,
  trustProxy: boolEnv('TRUST_PROXY', false),
  logLevel: env('LOG_LEVEL', 'info'),
  dataDir,
  dbFile: path.join(dataDir, 'outreach.sqlite'),
  uploadsDir: path.join(dataDir, 'uploads'),
  logsDir: path.join(dataDir, 'logs'),
  secretFile: path.join(dataDir, 'secret.key'),
  sessionTtlHours: intEnv('SESSION_TTL_HOURS', 168, { min: 1, max: 24 * 365 }),
  worker: {
    enabled: boolEnv('WORKER_ENABLED', true),
    pollMs: intEnv('WORKER_POLL_MS', 1000, { min: 100, max: 60000 }),
  },
  globalSendPaused: boolEnv('GLOBAL_SEND_PAUSED', false),
  migrations: Object.freeze({
    allowlist: migrationAllowlist,
    expectedDbPath: process.env.MIGRATION_EXPECTED_DB_PATH?.trim() || null,
  }),
  features: Object.freeze({
    agentLoop: boolEnv('AGENT_LOOP_ENABLED', false),
  }),
  aiFallback: {
    provider: env('AI_PROVIDER', ''),
    baseUrl: env('AI_BASE_URL', ''),
    apiKey: env('AI_API_KEY', ''),
    model: env('AI_MODEL', ''),
  },
  cookies: {
    session: 'zr_session',
    csrf: 'zr_csrf',
  },
});

export function ensureRuntimeDirs(cfg = config) {
  for (const dir of [cfg.dataDir, cfg.uploadsDir, cfg.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export default config;
