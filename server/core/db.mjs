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

/** Run migrations from a directory of numbered .sql files. */
export function migrate(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name));
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const appliedNow = [];
  for (const file of files) {
    if (applied.has(file)) continue;
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
        // ignore
      }
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }
  return appliedNow;
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
