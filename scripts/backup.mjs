#!/usr/bin/env node
/**
 * Create a consistent SQLite backup using VACUUM INTO.
 * Usage: npm run backup
 * Files are written to server/data/backups/.
 */
import '../server/core/silence-sqlite-warning.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureRuntimeDirs } from '../server/config.mjs';
import { closeDatabase, get, openDatabase } from '../server/core/db.mjs';

ensureRuntimeDirs();
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.join(dir, `outreach-${stamp}.sqlite`);

const db = openDatabase(config.dbFile);
try {
  get('SELECT 1 AS ok');
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const stat = fs.statSync(target);
  console.log(`备份完成：${target}`);
  console.log(`文件大小：${(stat.size / 1024 / 1024).toFixed(2)} MB`);
} finally {
  closeDatabase();
}
