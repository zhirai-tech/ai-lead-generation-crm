/**
 * ZHIRAI desktop shell (first pass).
 *
 * Starts the existing local Node server as an Electron child process, waits for
 * the health endpoint, then opens the platform in a normal desktop window.
 * Kept intentionally small: packaging, signing and auto-update come later.
 */
import { app, BrowserWindow, dialog, shell, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.ZHIRAI_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.ZHIRAI_DESKTOP_USER_DATA));
const projectRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(projectRoot, 'server', 'index.mjs');
const preferredPorts = [Number(process.env.ZHIRAI_DESKTOP_PORT || 4173)];

let serverProcess = null;
let mainWindow = null;

function findFreePort(ports) {
  return new Promise((resolve, reject) => {
    const tryPort = (index) => {
      if (index >= ports.length) {
        reject(new Error('没有可用端口'));
        return;
      }
      const port = ports[index];
      const tester = net.createServer();
      tester.once('error', () => tryPort(index + 1));
      tester.once('listening', () => tester.close(() => resolve(port)));
      tester.listen(port, '127.0.0.1');
    };
    tryPort(0);
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      // server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function startServer() {
  if (!existsSync(serverEntry)) throw new Error('找不到 server/index.mjs');
  const port = await findFreePort(preferredPorts);
  const dataDir = path.join(app.getPath('userData'), 'data');
  const dbFile = path.join(dataDir, 'outreach.sqlite');
  const migrationAllowlist = [
    '001_init.sql',
    '002_product_media_attachments.sql',
    '003_product_email_templates.sql',
    '004_assistant_memory.sql',
    '005_agent_tasks.sql',
    '006_discovery_candidate_audit.sql',
  ];
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      WORKER_ENABLED: process.env.WORKER_ENABLED ?? '1',
      DRAFT_TEMPLATE_FALLBACK: '1',
      BROWSER_HEADLESS: '0',
      AGENT_LOOP_ENABLED: process.env.AGENT_LOOP_ENABLED ?? '0',
      ZHIRAI_PARENT_PID: String(process.pid),
      GLOBAL_SEND_PAUSED: process.env.GLOBAL_SEND_PAUSED ?? '1',
      MIGRATION_EXPECTED_DB_PATH: dbFile,
      MIGRATION_ALLOWLIST: migrationAllowlist.join(','),
    },
    stdio: 'ignore',
  });
  serverProcess.on('exit', (code) => {
    if (code && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('ZHIRAI 服务已退出', `本地服务退出码：${code}`);
    }
  });
  const ready = await waitForHealth(port);
  if (!ready) throw new Error('本地服务启动超时');
  return port;
}

async function createWindow() {
  const port = await startServer();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: 'ZHIRAI · 智睿科技',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/?desktop=1#/discovery`);
}

app.commandLine.appendSwitch('disable-http-cache');

app.whenReady().then(async () => {
  try {
    await session.defaultSession.clearCache();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox('ZHIRAI 启动失败', String(error?.message || error));
    app.quit();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
