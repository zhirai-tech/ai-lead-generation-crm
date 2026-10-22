/** Operational endpoints for the admin console: health detail, backups, logs, license info. */
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from '../core/db.mjs';
import { badRequest, notFound } from '../core/errors.mjs';
import { asInt, asString } from '../core/validate.mjs';
import { recordAudit } from '../core/audit.mjs';
import { getWorkerStatus } from '../jobs/worker.mjs';
import { LICENSE_INFO } from '../core/license-info.mjs';

function backupsDir(ctx) {
  const dir = path.join(ctx.config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups(ctx) {
  const dir = backupsDir(ctx);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function mount(router) {
  router.get(
    '/api/v1/ops/system',
    async (ctx) => {
      ctx.requireCapability('audit.read');
      const dbPath = ctx.config.dbFile;
      let dbSize = 0;
      try {
        dbSize = fs.statSync(dbPath).size;
      } catch {
        dbSize = 0;
      }
      const counts = {
        companies: get('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ? AND deleted_at IS NULL', [ctx.workspace.id])?.c ?? 0,
        contacts: get('SELECT COUNT(*) AS c FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL', [ctx.workspace.id])?.c ?? 0,
        messages: get('SELECT COUNT(*) AS c FROM email_messages WHERE workspace_id = ?', [ctx.workspace.id])?.c ?? 0,
        jobs: get('SELECT COUNT(*) AS c FROM background_jobs WHERE workspace_id = ?', [ctx.workspace.id])?.c ?? 0,
        auditEvents: get('SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = ?', [ctx.workspace.id])?.c ?? 0,
      };
      return {
        app: { name: ctx.config.appName, version: ctx.config.version, env: ctx.config.env },
        process: {
          uptimeSeconds: Math.round(process.uptime()),
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          node: process.version,
          pid: process.pid,
        },
        storage: { dbFile: path.basename(dbPath), dbSize, dataDir: ctx.config.dataDir },
        counts,
        worker: getWorkerStatus(),
        backups: listBackups(ctx),
      };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/ops/license',
    async (ctx) => {
      ctx.requireCapability('settings.read');
      return LICENSE_INFO;
    },
    { auth: 'required' },
  );

  router.post(
    '/api/v1/ops/backup',
    async (ctx) => {
      ctx.requireCapability('backup.run');
      const dir = backupsDir(ctx);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
      const name = `outreach-${stamp}.sqlite`;
      const target = path.join(dir, name);
      const escaped = target.replace(/'/g, "''");
      get('SELECT 1 AS ok');
      ctx.db.exec(`VACUUM INTO '${escaped}'`);
      const stat = fs.statSync(target);
      recordAudit({ workspaceId: ctx.workspace.id, actorType: 'user', actorId: ctx.user.id, action: 'backup.create', entityType: 'backup', entityId: name, after: { size: stat.size }, ip: ctx.ip, requestId: ctx.requestId });
      return { backup: { name, size: stat.size, createdAt: stat.mtime.toISOString() } };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/ops/backup/:name',
    async (ctx) => {
      ctx.requireCapability('backup.run');
      const name = asString(ctx.params.name, { required: true, max: 120 });
      if (!/^[A-Za-z0-9._-]+\.sqlite$/.test(name)) throw badRequest('备份文件名不合法');
      const filePath = path.join(backupsDir(ctx), name);
      if (!fs.existsSync(filePath)) throw notFound('备份不存在');
      return ctx.sendFile(filePath, { downloadName: name, contentType: 'application/octet-stream' });
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/ops/logs',
    async (ctx) => {
      ctx.requireCapability('audit.read');
      const lines = asInt(ctx.query.get('lines'), { fallback: 200, min: 10, max: 2000 });
      const logFile = path.join(ctx.config.logsDir, 'app.log');
      if (!fs.existsSync(logFile)) return { lines: [], file: 'app.log' };
      const content = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
      return { file: 'app.log', lines: content.slice(-lines) };
    },
    { auth: 'required' },
  );
}
