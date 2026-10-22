/**
 * Maintenance console. Uses the same session cookie as the workbench and the
 * owner/admin-only /api/v1/ops endpoints. No secrets are rendered here.
 */
const $ = (id) => document.getElementById(id);
const toastSlot = $('toast-slot');

function toast(message, tone = 'ok') {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.textContent = message;
  toastSlot.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

function csrfToken() {
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === 'zr_csrf') return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrfToken();
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { ...headers, ...(options.headers || {}) },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(payload?.error?.message || '需要管理员权限');
    error.forbidden = true;
    throw error;
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
  }
  return payload.data;
}

function card(label, value, sub = '') {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = label;
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = value === null || value === undefined ? '—' : String(value);
  wrap.append(k, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    wrap.append(s);
  }
  return wrap;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatUptime(seconds) {
  const total = Number(seconds) || 0;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function renderSystem(system) {
  $('sys-time').textContent = `刷新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  const cards = $('system-cards');
  cards.replaceChildren(
    card('应用版本', `${system.app.name} v${system.app.version}`, `环境：${system.app.env}`),
    card('运行时长', formatUptime(system.process.uptimeSeconds), `Node ${system.process.node} · PID ${system.process.pid}`),
    card('内存占用', `${system.process.memoryMb} MB`, 'RSS'),
    card('数据库大小', formatBytes(system.storage.dbSize), system.storage.dbFile),
    card('后台 Worker', system.worker?.running ? '运行中' : '未运行', system.worker?.currentJob?.type || `已处理 ${system.worker?.processed ?? 0} 个任务`),
    card('企业 / 联系人', `${system.counts.companies} / ${system.counts.contacts}`, `邮件 ${system.counts.messages} · 审计 ${system.counts.auditEvents}`),
  );

  const backups = $('backups');
  backups.replaceChildren();
  if (!system.backups?.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无备份。建议在重大变更前创建一次备份。';
    backups.append(empty);
  } else {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['文件', '大小', '创建时间', '操作']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const item of system.backups) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      const nameText = document.createElement('b');
      nameText.textContent = item.name;
      name.append(nameText);
      const size = document.createElement('td');
      size.textContent = formatBytes(item.size);
      const created = document.createElement('td');
      created.textContent = new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false });
      const action = document.createElement('td');
      const link = document.createElement('a');
      link.href = `/api/v1/ops/backup/${encodeURIComponent(item.name)}`;
      link.textContent = '下载';
      action.append(link);
      tr.append(name, size, created, action);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    backups.append(table);
  }
}

function renderLicense(info) {
  const root = $('license');
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'license-grid';
  const product = document.createElement('div');
  product.className = 'license-block';
  const title = document.createElement('b');
  title.textContent = `${info.product.nameZh}（${info.product.name}）`;
  product.append(title);
  for (const [label, value] of [
    ['版本', info.product.version],
    ['作者', info.product.author],
    ['版权', info.product.copyright],
    ['授权', info.product.license],
    ['网站', info.product.website],
    ['支持', info.product.support],
  ]) {
    const p = document.createElement('p');
    p.textContent = `${label}：${value}`;
    product.append(p);
  }
  grid.append(product);

  const runtime = document.createElement('div');
  runtime.className = 'license-block';
  const runtimeTitle = document.createElement('b');
  runtimeTitle.textContent = '运行时依赖';
  runtime.append(runtimeTitle);
  for (const [label, value] of Object.entries(info.runtime || {})) {
    const p = document.createElement('p');
    p.textContent = `${label}：${value}`;
    runtime.append(p);
  }
  const deps = document.createElement('p');
  deps.textContent = `npm 运行时依赖：${info.runtimeDependencies?.length ? info.runtimeDependencies.join(', ') : '无'}；开发依赖：${info.devDependencies?.length ? info.devDependencies.join(', ') : '无'}`;
  runtime.append(deps);
  grid.append(runtime);

  const research = document.createElement('div');
  research.className = 'license-block';
  const researchTitle = document.createElement('b');
  researchTitle.textContent = '研究参考（不包含其代码）';
  research.append(researchTitle);
  for (const item of info.researchReferences || []) {
    const p = document.createElement('p');
    p.textContent = `${item.name} · ${item.license} · ${item.usage}`;
    research.append(p);
  }
  grid.append(research);

  for (const note of info.notes || []) {
    const block = document.createElement('div');
    block.className = 'license-block';
    const p = document.createElement('p');
    p.textContent = note;
    block.append(p);
    grid.append(block);
  }
  root.append(grid);
}

async function loadLogs() {
  const pre = $('logs');
  try {
    const data = await api('/api/v1/ops/logs?lines=200');
    pre.textContent = (data.lines || []).join('\n') || '暂无日志。';
    pre.scrollTop = pre.scrollHeight;
  } catch (error) {
    pre.textContent = error.forbidden ? '需要 owner / admin 权限才能查看日志。' : `日志加载失败：${error.message}`;
  }
}

async function loadAll() {
  try {
    const [system, license] = await Promise.all([api('/api/v1/ops/system'), api('/api/v1/ops/license')]);
    $('login-hint').classList.add('hidden');
    renderSystem(system);
    renderLicense(license);
    loadLogs();
  } catch (error) {
    if (error.forbidden) {
      $('login-hint').classList.remove('hidden');
      $('system-cards').replaceChildren();
      $('logs').textContent = '需要登录后查看。';
    } else {
      toast(error.message, 'err');
    }
  }
}

$('btn-refresh').addEventListener('click', () => loadAll());
$('btn-backup').addEventListener('click', async () => {
  const btn = $('btn-backup');
  btn.disabled = true;
  btn.textContent = '正在备份…';
  try {
    const data = await api('/api/v1/ops/backup', { method: 'POST' });
    toast(`备份完成：${data.backup.name}`, 'ok');
    await loadAll();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '创建备份';
  }
});

loadAll();
