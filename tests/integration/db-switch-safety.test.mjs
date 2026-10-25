import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, closeDatabase, migrate } from '../../server/core/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(ROOT, 'server', 'db', 'migrations');
const ALL = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const CORE_TABLES = ['companies', 'contacts', 'company_sources', 'lead_scores', 'discovery_runs', 'email_messages', 'message_drafts', 'follow_up_tasks'];

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-switch-safety-'));
  const dbFile = path.join(dir, 'outreach.sqlite');
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS, { allowlist: ALL.slice(0, 5), expectedDbPath: dbFile, actualDbPath: dbFile });
  closeDatabase();
  return { dir, dbFile };
}

function readOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function counts(db) {
  const out = {};
  for (const table of CORE_TABLES) out[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  return out;
}

function validateBackup(backupPath, expectedPath, expectedMigrations, expectedCounts) {
  assert.ok(fs.existsSync(backupPath), 'backup exists');
  assert.equal(path.dirname(path.dirname(backupPath)), path.dirname(expectedPath), 'backup belongs to instance');
  const db = readOnly(backupPath);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name), expectedMigrations);
    assert.deepEqual(counts(db), expectedCounts);
  } finally {
    db.close();
  }
}

function validatePost(dbFile, baseline) {
  const db = readOnly(dbFile);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(baseline.dbPath, dbFile);
    assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name), ALL.slice(0, 6));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_candidates'").get());
    const indexes = new Set(db.prepare('PRAGMA index_list(discovery_candidates)').all().map((r) => r.name));
    assert.ok(indexes.has('idx_discovery_candidates_run'));
    assert.ok(indexes.has('idx_discovery_candidates_outcome'));
    assert.deepEqual(counts(db), baseline.counts);
  } finally {
    db.close();
  }
}

test('valid backup has hard integrity, migration and count assertions', () => {
  const { dir, dbFile } = temp();
  const backup = path.join(dir, 'backups', 'outreach-test.sqlite');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const db = openDatabase(dbFile);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  closeDatabase();
  const expectedCounts = (() => { const x = readOnly(backup); const c = counts(x); x.close(); return c; })();
  validateBackup(backup, dbFile, ALL.slice(0, 5), expectedCounts);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt or missing backup fails hard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-switch-bad-backup-'));
  const bad = path.join(dir, 'bad.sqlite');
  fs.writeFileSync(bad, 'not a sqlite database', 'utf8');
  assert.throws(() => validateBackup(bad, path.join(dir, 'outreach.sqlite'), [], {}));
  assert.throws(() => validateBackup(path.join(dir, 'missing.sqlite'), path.join(dir, 'outreach.sqlite'), [], {}));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('post-migration validator fails when 006 migration is missing', () => {
  const { dir, dbFile } = temp();
  const db = readOnly(dbFile);
  const baseline = { dbPath: dbFile, counts: counts(db) };
  db.close();
  assert.throws(() => validatePost(dbFile, baseline), /006_discovery_candidate_audit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('post-migration validator fails when an index is missing', () => {
  const { dir, dbFile } = temp();
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS, { allowlist: ['006_discovery_candidate_audit.sql'], expectedDbPath: dbFile, actualDbPath: dbFile });
  db.exec('DROP INDEX idx_discovery_candidates_run');
  const baseline = { dbPath: dbFile, counts: counts(db) };
  closeDatabase();
  assert.throws(() => validatePost(dbFile, baseline), /idx_discovery_candidates_run/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('post-migration validator fails on count mismatch or baseline path mismatch', () => {
  const { dir, dbFile } = temp();
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS, { allowlist: ['006_discovery_candidate_audit.sql'], expectedDbPath: dbFile, actualDbPath: dbFile });
  const real = counts(db);
  closeDatabase();
  assert.throws(() => validatePost(dbFile, { dbPath: dbFile, counts: { ...real, companies: real.companies + 1 } }), /Expected values/);
  assert.throws(() => validatePost(dbFile, { dbPath: path.join(dir, 'other.sqlite'), counts: real }), /Expected values/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('module loading from an unrelated current directory uses an absolute file URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-switch-module-'));
  const script = path.join(dir, 'check.mjs');
  const dbFile = path.join(dir, 'outreach.sqlite');
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(ROOT)};
const config = (await import(pathToFileURL(path.join(root, 'server', 'config.mjs')).href)).config;
const db = await import(pathToFileURL(path.join(root, 'server', 'core', 'db.mjs')).href);
assert.equal(config.dbFile, ${JSON.stringify(dbFile)});
db.validateMigrationPolicy({ allowlist: [], expectedDbPath: ${JSON.stringify(dbFile)}, actualDbPath: config.dbFile });
console.log('module-ok');
`, 'utf8');
  const result = spawnSync(process.execPath, ['--no-warnings', script], {
    cwd: 'C:\\Windows',
    env: { ...process.env, DATA_DIR: dir, MIGRATION_EXPECTED_DB_PATH: dbFile, MIGRATION_ALLOWLIST: 'none' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /module-ok/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('baseline is captured before backup and a mismatch fails hard', () => {
  const { dir, dbFile } = temp();
  const db = readOnly(dbFile);
  const baseline = {
    dbPath: fs.realpathSync.native(dbFile),
    migrations: db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name),
    counts: counts(db),
    backupVerified: false,
  };
  db.close();
  assert.deepEqual(baseline.migrations, ALL.slice(0, 5));
  const backup = path.join(dir, 'backups', 'outreach-baseline.sqlite');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const write = openDatabase(dbFile);
  write.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  closeDatabase();
  validateBackup(backup, dbFile, baseline.migrations, baseline.counts);
  assert.throws(() => validateBackup(backup, dbFile, baseline.migrations, { ...baseline.counts, companies: baseline.counts.companies + 1 }), /Expected values/);
  fs.rmSync(dir, { recursive: true, force: true });
});
