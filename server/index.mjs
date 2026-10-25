#!/usr/bin/env node
/**
 * ZHIRAI AI Lead Generation & Outreach CRM - server entry point.
 *
 * Keeps the process single-node and dependency-free: HTTP API + static
 * frontend + background worker all run here. See DEPLOY.md.
 */
import './core/silence-sqlite-warning.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureRuntimeDirs } from './config.mjs';
import { assertOpenedDatabasePath, assertSchemaReady, closeDatabase, migrate, openDatabase, validateMigrationPolicy } from './core/db.mjs';
import { createLogger } from './core/logger.mjs';
import { initSecret } from './core/secrets.mjs';
import { hasUsers } from './core/auth.mjs';
import { createServerApp } from './app.mjs';
import { startWorker, stopWorker } from './jobs/worker.mjs';

const logger = createLogger({
  level: config.logLevel,
  file: path.join(config.logsDir, 'app.log'),
  name: 'server',
});

async function main() {
  ensureRuntimeDirs();
  initSecret(config);

  logger.info('startup safety flags', {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    dataDir: config.dataDir,
    dbFile: config.dbFile,
    workerEnabled: config.worker.enabled,
    agentLoopEnabled: config.features.agentLoop,
    globalSendPaused: config.globalSendPaused,
    migrationExpectedDbPath: config.migrations.expectedDbPath,
    migrationAllowlist: config.migrations.allowlist,
  });

  validateMigrationPolicy({
    allowlist: config.migrations.allowlist,
    expectedDbPath: config.migrations.expectedDbPath,
    actualDbPath: config.dbFile,
    dataDir: config.dataDir,
    expectedDataDir: process.env.DATA_DIR || config.dataDir,
  });
  const db = openDatabase(config.dbFile);
  assertOpenedDatabasePath(db, config.migrations.expectedDbPath);
  const applied = migrate(db, path.join(config.rootDir, 'server', 'db', 'migrations'), {
    allowlist: config.migrations.allowlist,
    expectedDbPath: config.migrations.expectedDbPath,
    actualDbPath: config.dbFile,
  });
  assertSchemaReady(db);
  if (applied.length) logger.info('database migrated', { applied, skipped: applied.skipped || [] });
  logger.info('database ready', { file: config.dbFile });

  const server = createServerApp({ config, logger, db });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const url = `${config.publicBaseUrl}`;
  const initialized = hasUsers();
  console.log('');
  console.log('  ZHIRAI AI Lead Generation & Outreach CRM');
  console.log(`  AI 智能获客与销售外联系统  v${config.version}`);
  console.log('  ─────────────────────────────────────────────');
  console.log(`  访问地址   ${url}`);
  console.log(`  监听地址   ${config.host}:${config.port}`);
  console.log(`  数据目录   ${config.dataDir}`);
  console.log(`  系统状态   ${initialized ? '已初始化' : '待初始化（首次打开会引导创建管理员）'}`);
  console.log(`  后台任务   ${config.worker.enabled ? '已启动' : '未启动（WORKER_ENABLED=0）'}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  Powered by 智睿 · https://zhirai.cloud');
  console.log('');

  if (config.worker.enabled) {
    startWorker({ config, logger }).catch((error) => logger.error('worker crashed', { error }));
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // A hung client/worker must not leave an orphaned local server behind.
    setTimeout(() => process.exit(0), 5000).unref();
    try {
      await stopWorker();
    } catch (error) {
      logger.warn('worker stop failed', { error });
    }
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // If the desktop shell is force-killed, do not leave an orphaned local server
  // (and its SQLite handle) running in the background.
  const parentPid = Number.parseInt(process.env.ZHIRAI_PARENT_PID || '', 10);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const parentWatch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(parentWatch);
        shutdown('parent-exited');
      }
    }, 1500);
    parentWatch.unref?.();
  }
  process.on('unhandledRejection', (error) => {
    logger.error('unhandled rejection', { error });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    logger.error('startup failed', { error });
    console.error('启动失败：', error.message);
    process.exit(1);
  });
}
