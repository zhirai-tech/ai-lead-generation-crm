import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertOpenedDatabasePath,
  assertSchemaReady,
  closeDatabase,
  migrate,
  openDatabase,
  validateMigrationPolicy,
} from '../../server/core/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(ROOT, 'server', 'db', 'migrations');
const ALL_MIGRATIONS = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zhirai-migration-gate-'));
}

function openTempDb(dir) {
  const dbFile = path.join(dir, 'outreach.sqlite');
  const db = openDatabase(dbFile);
  return { dbFile, db };
}

function apply(db, dbFile, names, migrationsDir = MIGRATIONS_DIR) {
  return migrate(db, migrationsDir, {
    allowlist: names,
    expectedDbPath: dbFile,
    actualDbPath: dbFile,
  });
}

function closeAndRemove(dir) {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('A: 4173-like 001-004 cannot apply 005/006 with an empty allowlist and fails schema readiness', () => {
  const dir = tempDir();
  const { db, dbFile } = openTempDb(dir);
  apply(db, dbFile, ALL_MIGRATIONS.slice(0, 4));
  assert.deepEqual(
    db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((row) => row.name),
    ALL_MIGRATIONS.slice(0, 4),
  );

  const applied = apply(db, dbFile, []);
  assert.deepEqual([...applied], []);
  assert.deepEqual(
    db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((row) => row.name),
    ALL_MIGRATIONS.slice(0, 4),
  );
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_candidates'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'").get(), undefined);
  assert.throws(() => assertSchemaReady(db), /schema_migrations_missing/);
  closeAndRemove(dir);
});

test('B: 4174-like 001-005 only applies approved 006 and keeps data intact', () => {
  const dir = tempDir();
  const { db, dbFile } = openTempDb(dir);
  apply(db, dbFile, ALL_MIGRATIONS.slice(0, 5));
  const before = {
    companies: db.prepare('SELECT COUNT(*) AS c FROM companies').get().c,
    contacts: db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c,
    sources: db.prepare('SELECT COUNT(*) AS c FROM company_sources').get().c,
    scores: db.prepare('SELECT COUNT(*) AS c FROM lead_scores').get().c,
  };
  const applied = apply(db, dbFile, ['006_discovery_candidate_audit.sql']);
  assert.deepEqual([...applied], ['006_discovery_candidate_audit.sql']);
  assertSchemaReady(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_candidates'").get());
  const columns = new Set(db.prepare('PRAGMA table_info(discovery_runs)').all().map((row) => row.name));
  for (const column of ['qualification_status', 'qualified_count', 'rejected_count', 'insufficient_count', 'unclassified_count', 'qualification_finalized_at', 'qualification_evaluation']) {
    assert.ok(columns.has(column), column);
  }
  const indexes = new Set(db.prepare('PRAGMA index_list(discovery_candidates)').all().map((row) => row.name));
  assert.ok(indexes.has('idx_discovery_candidates_run'));
  assert.ok(indexes.has('idx_discovery_candidates_outcome'));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const after = {
    companies: db.prepare('SELECT COUNT(*) AS c FROM companies').get().c,
    contacts: db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c,
    sources: db.prepare('SELECT COUNT(*) AS c FROM company_sources').get().c,
    scores: db.prepare('SELECT COUNT(*) AS c FROM lead_scores').get().c,
  };
  assert.deepEqual(after, before);
  const repeat = apply(db, dbFile, ['006_discovery_candidate_audit.sql']);
  assert.deepEqual([...repeat], []);
  closeAndRemove(dir);
});

test('C: gate rejects missing, mismatched, unknown, duplicate and missing-allowlist configurations before SQL', () => {
  const dir = tempDir();
  const { db, dbFile } = openTempDb(dir);
  apply(db, dbFile, ALL_MIGRATIONS.slice(0, 4));
  const before = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
  if (process.platform === 'win32') {
    assert.doesNotThrow(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: dbFile.toUpperCase(), actualDbPath: dbFile }));
  }
  assert.throws(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: 'relative/outreach.sqlite', actualDbPath: dbFile }), /migration_expected_db_path_not_absolute/);
  assert.throws(() => migrate(db, MIGRATIONS_DIR, { allowlist: ALL_MIGRATIONS, expectedDbPath: null, actualDbPath: dbFile }), /migration_expected_db_path_missing/);
  assert.throws(() => migrate(db, MIGRATIONS_DIR, { allowlist: ALL_MIGRATIONS, expectedDbPath: path.join(dir, 'wrong.sqlite'), actualDbPath: dbFile }), /migration_db_path_mismatch/);
  assert.throws(() => migrate(db, MIGRATIONS_DIR, { allowlist: null, expectedDbPath: dbFile, actualDbPath: dbFile }), /migration_allowlist_missing/);
  assert.throws(() => migrate(db, MIGRATIONS_DIR, { allowlist: ['999_missing.sql'], expectedDbPath: dbFile, actualDbPath: dbFile }), /migration_allowlist_unknown/);
  assert.throws(() => migrate(db, MIGRATIONS_DIR, { allowlist: ['006_discovery_candidate_audit.sql', '006_discovery_candidate_audit.sql'], expectedDbPath: dbFile, actualDbPath: dbFile }), /migration_allowlist_duplicate/);
  assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all(), before);
  closeAndRemove(dir);
});

test('C1b: path normalization, missing files, UNC and symlink handling', (t) => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'outreach.sqlite');
  const db = openDatabase(dbFile);
  closeDatabase();
  assert.doesNotThrow(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: path.join(dir, 'sub', '..', 'outreach.sqlite'), actualDbPath: dbFile }));
  assert.doesNotThrow(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: dbFile, actualDbPath: dbFile }));
  const missing = path.join(dir, 'missing.sqlite');
  assert.doesNotThrow(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: missing, actualDbPath: missing }));
  assert.throws(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: '\\\\server\\share\\outreach.sqlite', actualDbPath: dbFile }), /migration_unc_path_not_supported/);
  const link = path.join(dir, 'outreach-link.sqlite');
  try {
    fs.symlinkSync(dbFile, link, 'file');
  } catch (error) {
    t.skip(`symlink unavailable on this Windows session: ${error.code || error.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    assert.doesNotThrow(() => validateMigrationPolicy({ allowlist: [], expectedDbPath: link, actualDbPath: dbFile }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: a failing migration rolls back its own SQL and does not record success', () => {
  const dir = tempDir();
  const migrationDir = path.join(dir, 'migrations');
  fs.mkdirSync(migrationDir);
  fs.writeFileSync(path.join(migrationDir, '001_ok.sql'), 'CREATE TABLE gate_ok (id TEXT PRIMARY KEY);', 'utf8');
  fs.writeFileSync(path.join(migrationDir, '002_fail.sql'), 'CREATE TABLE gate_fail (id TEXT PRIMARY KEY); THIS IS NOT SQL;', 'utf8');
  const dbFile = path.join(dir, 'test.sqlite');
  const db = openDatabase(dbFile);
  assert.throws(() => migrate(db, migrationDir, {
    allowlist: ['001_ok.sql', '002_fail.sql'], expectedDbPath: dbFile, actualDbPath: dbFile,
  }), /migration 002_fail\.sql failed/);
  assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((row) => row.name), ['001_ok.sql']);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_ok'").get());
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_fail'").get(), undefined);
  closeAndRemove(dir);
});

test('C3: init-db cannot bypass the gate', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'outreach.sqlite');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'init-db.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      MIGRATION_EXPECTED_DB_PATH: dbFile,
      MIGRATION_ALLOWLIST: '',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.notEqual(result.status, 0);
  const db = openDatabase(dbFile);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_candidates'").get(), undefined);
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C4: application startup fails closed when required schema is missing', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'outreach.sqlite');
  // Create an empty DB; startup has an explicit empty allowlist and must fail.
  const db = openDatabase(dbFile);
  closeDatabase();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      MIGRATION_EXPECTED_DB_PATH: dbFile,
      MIGRATION_ALLOWLIST: '',
      PORT: '65431',
      WORKER_ENABLED: '0',
      AGENT_LOOP_ENABLED: '0',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.notEqual(result.status, 0);
  const check = openDatabase(dbFile);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_candidates'").get(), undefined);
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C5: application startup fails closed for a 001-004 database with an explicit empty allowlist', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'outreach.sqlite');
  const db = openDatabase(dbFile);
  apply(db, dbFile, ALL_MIGRATIONS.slice(0, 4));
  closeDatabase();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      MIGRATION_EXPECTED_DB_PATH: dbFile,
      MIGRATION_ALLOWLIST: '',
      PORT: '65432',
      WORKER_ENABLED: '0',
      AGENT_LOOP_ENABLED: '0',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.notEqual(result.status, 0);
  const check = openDatabase(dbFile);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_candidates'").get(), undefined);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'").get(), undefined);
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C6: application startup reaches normal initialization when only approved 006 is applied', async () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'outreach.sqlite');
  const db = openDatabase(dbFile);
  apply(db, dbFile, ALL_MIGRATIONS.slice(0, 5));
  apply(db, dbFile, ['006_discovery_candidate_audit.sql']);
  assertSchemaReady(db);
  closeDatabase();
  const port = 65434;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      MIGRATION_EXPECTED_DB_PATH: dbFile,
      MIGRATION_ALLOWLIST: '006_discovery_candidate_audit.sql',
      PORT: String(port),
      WORKER_ENABLED: '0',
      AGENT_LOOP_ENABLED: '0',
      GLOBAL_SEND_PAUSED: '1',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        if (child.exitCode !== null) {
          clearInterval(timer);
          reject(new Error(`startup exited: ${child.exitCode}\n${output}`));
          return;
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
          if (response.ok) {
            clearInterval(timer);
            resolve();
          }
        } catch {
          // not listening yet
        }
        if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(new Error(`startup timeout\n${output}`));
        }
      }, 100);
    });
    const logFile = path.join(dir, 'logs', 'app.log');
    const startupLines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const safetyLine = startupLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((entry) => entry?.msg === 'startup safety flags');
    assert.ok(safetyLine, 'startup safety flags missing');
    assert.equal(safetyLine.pid, child.pid);
    assert.equal(safetyLine.workerEnabled, false);
    assert.equal(safetyLine.agentLoopEnabled, false);
    assert.equal(safetyLine.globalSendPaused, true);
    assert.deepEqual(safetyLine.migrationAllowlist, ['006_discovery_candidate_audit.sql']);
    assert.ok(startupLines.every((line) => !line.includes('"msg":"worker started"')));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    child.stdout?.destroy();
    child.stderr?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C0: migration allowlist config distinguishes unset, empty, none and explicit values', () => {
  const code = "import('./server/config.mjs').then(m=>console.log(JSON.stringify(m.config.migrations)))";
  const baseEnv = { ...process.env, MIGRATION_EXPECTED_DB_PATH: 'C:\\\\temp\\\\unused.sqlite' };
  const run = (value) => {
    const env = { ...baseEnv };
    delete env.MIGRATION_ALLOWLIST;
    if (value !== undefined) env.MIGRATION_ALLOWLIST = value;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()).allowlist;
  };
  assert.equal(run(undefined), null);
  assert.deepEqual(run('none'), []);
  assert.deepEqual(run(''), []);
  assert.deepEqual(run('006_discovery_candidate_audit.sql'), ['006_discovery_candidate_audit.sql']);
});

test('C7: actual SQLite opened path and DATA_DIR are asserted, not inferred from config strings', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'outreach.sqlite');
  const other = path.join(dir, 'other.sqlite');
  const db = openDatabase(dbFile);
  try {
    assert.doesNotThrow(() => assertOpenedDatabasePath(db, dbFile));
    assert.throws(() => assertOpenedDatabasePath(db, other), /opened_database_path_mismatch/);
    assert.throws(() => validateMigrationPolicy({
      allowlist: [], expectedDbPath: dbFile, actualDbPath: dbFile,
      dataDir: dir, expectedDataDir: path.join(dir, 'wrong-data-dir')
    }), /migration_data_dir_mismatch/);
  } finally {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
