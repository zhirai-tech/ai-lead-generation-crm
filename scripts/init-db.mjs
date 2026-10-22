#!/usr/bin/env node
/**
 * Initialise the database: create runtime directories, apply migrations and
 * report the schema version. Safe to run repeatedly.
 */
import '../server/core/silence-sqlite-warning.mjs';
import { config, ensureRuntimeDirs } from '../server/config.mjs';
import { closeDatabase, migrate, openDatabase, all } from '../server/core/db.mjs';
import path from 'node:path';

ensureRuntimeDirs();
const db = openDatabase(config.dbFile);
try {
  const applied = migrate(db, path.join(config.rootDir, 'server', 'db', 'migrations'));
  console.log(`[ZHIRAI] 数据库已初始化：${config.dbFile}`);
  console.log(`[ZHIRAI] 本次应用迁移：${applied.length ? applied.join(', ') : '无（已是最新）'}`);
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
  console.log(`[ZHIRAI] 数据表数量：${tables.length}`);
} finally {
  closeDatabase();
}
