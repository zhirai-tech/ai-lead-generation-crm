/**
 * Application bootstrap: status check, auth screen or workbench, hash routing.
 */
import { api, ApiError, setUnauthorizedHandler } from './api.mjs';
import { state, setSession, clearSession } from './state.mjs';
import { buildShell } from './shell.mjs';
import { createRouter } from './router.mjs';
import { renderSetup, renderLogin, renderUnsubscribe } from './auth.mjs';
import { append, clear, el } from '../utils/dom.mjs';
import { button, notice } from '../components/ui.mjs';

const app = document.getElementById('app');
let shell = null;
let router = null;
let unauthorizedHandled = false;

function showFatal(error) {
  clear(app);
  const screen = el('div', 'public-screen');
  const card = el('div', 'unsub-card');
  append(card, [
    el('h1', '', '无法连接后端服务'),
    el('p', '', error?.message || '请确认服务已启动（npm start），然后刷新页面。'),
    notice('默认地址：http://127.0.0.1:4173', 'info'),
    button('重新加载', { variant: 'primary', onClick: () => window.location.reload() }),
  ]);
  screen.appendChild(card);
  app.appendChild(screen);
}

function startWorkbench(session) {
  clear(app);
  unauthorizedHandled = false;
  setUnauthorizedHandler(() => {
    if (unauthorizedHandled) return;
    unauthorizedHandled = true;
    clearSession();
    window.location.reload();
  });
  shell = buildShell({ container: app, onLogout: () => window.location.reload() });
  router = createRouter({
    view: shell.view,
    onPage: (meta, { path }) => shell.setPage({ ...meta, path: path === '/approvals' ? '/approvals' : path }),
  });
  router.start();
  window.addEventListener('beforeunload', () => {
    shell?.destroy();
    router?.stop();
  });
  void session;
}

async function boot() {
  const hash = window.location.hash || '';
  const unsubMatch = /^#\/unsubscribe\/(.+)$/.exec(hash);
  if (unsubMatch) {
    try {
      await renderUnsubscribe(app, decodeURIComponent(unsubMatch[1]));
    } catch (error) {
      showFatal(error);
    }
    return;
  }

  document.addEventListener('click', () => {
    for (const open of document.querySelectorAll('.help.open')) open.classList.remove('open');
  });

  try {
    const status = await api.get('/api/v1/auth/status');
    if (!status.initialized) {
      renderSetup(app, { onDone: (data) => startWorkbench(data) });
      return;
    }
    if (!status.user) {
      renderLogin(app, { onDone: (data) => startWorkbench(data) });
      return;
    }
    setSession(status);
    startWorkbench(status);
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) showFatal(error);
    else showFatal(error);
  }
}

boot();
