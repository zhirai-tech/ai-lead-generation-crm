/**
 * SQLite access layer (node:sqlite).
 *
 * A single DatabaseSync connection is shared by the whole process. WAL mode,
 * foreign keys and a busy timeout are enabled. Every business table carries a
 * workspace_id and repositories must always scope queries by it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from './time.mjs';

let current = null;
let currentFile = null;
const statementCache = new Map();

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
  current = db;
  currentFile = file;
  statementCache.clear();
  return db;
}

export function setDatabase(db, file = null) {
  current = db;
  currentFile = file;
  statementCache.clear();
  return current;
}

export function getDb() {
  if (!current) throw new Error('database not initialised');
  return current;
}

export function getDatabaseFile() {
  return currentFile;
}

export function closeDatabase() {
  if (!current) return;
  try {
    current.close();
  } finally {
    current = null;
    currentFile = null;
    statementCache.clear();
  }
}

function prepare(sql) {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    if (statementCache.size > 400) statementCache.clear();
    statementCache.set(sql, stmt);
  }
  return stmt;
}

export function all(sql, params = []) {
  return prepare(sql).all(...params);
}

export function get(sql, params = []) {
  const row = prepare(sql).get(...params);
  return row === undefined ? null : row;
}

export function run(sql, params = []) {
  return prepare(sql).run(...params);
}

export function exec(sql) {
  return getDb().exec(sql);
}

/** Run a function inside an IMMEDIATE transaction. */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    if (result && typeof result.then === 'function') {
      throw new Error('tx() does not support async callbacks; compose sync transactions only');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  }
}

/** Migrations that the current application requires to be present. */
export const REQUIRED_SCHEMA_MIGRATIONS = Object.freeze([
  '001_init.sql',
  '002_product_media_attachments.sql',
  '003_product_email_templates.sql',
  '004_assistant_memory.sql',
  '005_agent_tasks.sql',
  '006_discovery_candidate_audit.sql',
]);

function isUncPath(value) {
  return /^\\\\[^\\]+\\/.test(String(value || '').trim()) || /^\/\/[^/]+\//.test(String(value || '').trim());
}

function comparablePath(value) {
  const raw = String(value || '').trim();
  if (isUncPath(raw)) throw new Error('migration_unc_path_not_supported');
  const absolute = path.resolve(raw);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    // A missing database file is allowed for first initialization, but an
    // existing path that cannot be canonicalized must fail closed.
    if (fs.existsSync(absolute)) throw new Error(`migration_path_normalization_failed:${error.message}`);
    return absolute;
  }
}

function pathsEqual(a, b) {
  const left = comparablePath(a);
  const right = comparablePath(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Verify the path SQLite actually opened is the approved database file. */
export function assertOpenedDatabasePath(db, expectedDbPath) {
  const rows = db.prepare('PRAGMA database_list').all();
  const main = rows.find((row) => row.name === 'main');
  if (!main || !main.file) throw new Error('opened_database_path_missing');
  if (!pathsEqual(main.file, expectedDbPath)) {
    throw new Error(`opened_database_path_mismatch:${main.file}`);
  }
  return main.file;
}

/** Validate the database path and migration allowlist before any migration SQL. */
export function validateMigrationPolicy({ allowlist, expectedDbPath, actualDbPath, dataDir = null, expectedDataDir = null } = {}) {
  if (!expectedDbPath || !String(expectedDbPath).trim()) {
    throw new Error('migration_expected_db_path_missing');
  }
  if (!path.isAbsolute(String(expectedDbPath).trim())) {
    throw new Error('migration_expected_db_path_not_absolute');
  }
  if (!actualDbPath || !String(actualDbPath).trim()) {
    throw new Error('migration_actual_db_path_missing');
  }
  if (!path.isAbsolute(String(actualDbPath).trim())) {
    throw new Error('migration_actual_db_path_not_absolute');
  }
  if (expectedDataDir !== null && dataDir !== null && !pathsEqual(dataDir, expectedDataDir)) {
    throw new Error('migration_data_dir_mismatch');
  }
  if (isUncPath(expectedDbPath) || isUncPath(actualDbPath)) {
    throw new Error('migration_unc_path_not_supported');
  }
  if (!pathsEqual(expectedDbPath, actualDbPath)) {
    throw new Error('migration_db_path_mismatch');
  }
  if (!Array.isArray(allowlist)) {
    throw new Error('migration_allowlist_missing');
  }
  const seen = new Set();
  for (const name of allowlist) {
    if (typeof name !== 'string' || !name.endsWith('.sql') || path.basename(name) !== name) {
      throw new Error(`migration_allowlist_invalid_name:${String(name)}`);
    }
    if (seen.has(name)) throw new Error(`migration_allowlist_duplicate:${name}`);
    seen.add(name);
  }
  return true;
}

/**
 * Run only explicitly approved migrations. This function is fail-closed:
 * callers must pass a complete policy; there is no implicit "apply everything"
 * fallback for application startup or operational scripts.
 */
export function migrate(db, migrationsDir, { allowlist = null, expectedDbPath = null, actualDbPath = null } = {}) {
  validateMigrationPolicy({ allowlist, expectedDbPath, actualDbPath });
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const known = new Set(files);
  for (const name of allowlist) {
    if (!known.has(name)) throw new Error(`migration_allowlist_unknown:${name}`);
  }

  const migrationTableExists = Boolean(
    get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"),
  );
  const applied = new Set(
    migrationTableExists ? all('SELECT name FROM schema_migrations').map((row) => row.name) : [],
  );
  const pending = files.filter((name) => !applied.has(name));
  const approvedPending = pending.filter((name) => allowlist.includes(name));
  const skipped = pending.filter((name) => !allowlist.includes(name));

  // Do not create schema_migrations (or run any migration SQL) when nothing is
  // approved. A subsequent schema-readiness check will fail startup if the
  // database lacks the tables/columns required by this application.
  if (!approvedPending.length) {
    return Object.assign([], { skipped });
  }
  if (!migrationTableExists) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
  }
  const appliedNow = [];
  for (const file of approvedPending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, nowIso());
      db.exec('COMMIT');
      appliedNow.push(file);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }
  return Object.assign(appliedNow, { skipped });
}

/** Fail closed when the database does not contain the current application schema. */
export function assertSchemaReady(db, { requiredMigrations = REQUIRED_SCHEMA_MIGRATIONS } = {}) {
  if (!get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")) {
    throw new Error(`schema_migrations_missing:${requiredMigrations.join(',')}`);
  }
  const applied = new Set(all('SELECT name FROM schema_migrations').map((row) => row.name));
  const missing = requiredMigrations.filter((name) => !applied.has(name));
  if (missing.length) {
    throw new Error(`schema_migrations_missing:${missing.join(',')}`);
  }
  const requiredTables = [
    'users', 'workspaces', 'memberships', 'settings', 'companies', 'contacts',
    'company_sources', 'lead_scores', 'discovery_runs', 'background_jobs',
    'agent_tasks', 'agent_events', 'discovery_candidates',
  ];
  for (const table of requiredTables) {
    if (!get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])) {
      throw new Error(`schema_table_missing:${table}`);
    }
  }
  const discoveryRunColumns = new Set(all('PRAGMA table_info(discovery_runs)').map((row) => row.name));
  for (const column of ['qualification_status', 'qualified_count', 'rejected_count', 'insufficient_count', 'unclassified_count', 'qualification_finalized_at', 'qualification_evaluation']) {
    if (!discoveryRunColumns.has(column)) throw new Error(`schema_column_missing:discovery_runs.${column}`);
  }
  const candidateIndexes = new Set(all('PRAGMA index_list(discovery_candidates)').map((row) => row.name));
  for (const index of ['idx_discovery_candidates_run', 'idx_discovery_candidates_outcome']) {
    if (!candidateIndexes.has(index)) throw new Error(`schema_index_missing:${index}`);
  }
  return true;
}

/** Compact helper for UPSERT-style writes on a simple key/value settings table. */
export function upsertSetting(workspaceId, key, value) {
  const now = nowIso();
  run(
    `INSERT INTO settings (workspace_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [workspaceId, key, JSON.stringify(value ?? null), now],
  );
}

/** JSON column helpers. */
export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function json(value, fallback = 'null') {
  if (value === undefined) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export default {
  openDatabase,
  setDatabase,
  getDb,
  getDatabaseFile,
  closeDatabase,
  all,
  get,
  run,
  exec,
  tx,
  migrate,
  upsertSetting,
  parseJson,
  json,
};
