#!/usr/bin/env node
/**
 * Reset a user's password from the server console.
 * Usage: npm run reset-password -- user@example.com NewPassword123
 * The user must change the password again on next login.
 */
import '../server/core/silence-sqlite-warning.mjs';
import path from 'node:path';
import { config } from '../server/config.mjs';
import { closeDatabase, get, migrate, openDatabase, run } from '../server/core/db.mjs';
import { hashPassword } from '../server/core/crypto.mjs';
import { nowIso } from '../server/core/time.mjs';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('用法：npm run reset-password -- <邮箱> <新密码>');
  process.exit(1);
}
if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
  console.error('新密码至少 10 位，且必须同时包含字母和数字。');
  process.exit(1);
}

const db = openDatabase(config.dbFile);
try {
  migrate(db, path.join(config.rootDir, 'server', 'db', 'migrations'));
  const user = get('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE', [email]);
  if (!user) {
    console.error(`未找到用户：${email}`);
    process.exit(1);
  }
  run('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?', [hashPassword(password), nowIso(), user.id]);
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), user.id]);
  console.log(`已重置密码：${user.email}`);
  console.log('该用户下次登录后会被要求修改密码。');
} finally {
  closeDatabase();
}
