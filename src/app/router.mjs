/**
 * Hash router. Pages are loaded lazily so a slow/broken module never blocks the
 * shell. Page contract:
 *   export const meta = { title, help }
 *   export async function render(root, params, ctx)
 *   export function destroy()   (optional)
 */
import { clear, el } from '../utils/dom.mjs';
import { loadingBlock, notice, button, emptyState } from '../components/ui.mjs';
import { state } from './state.mjs';

const ROUTES = [
  { path: '/dashboard', loader: () => import('../pages/dashboard.js') },
  { path: '/discovery', loader: () => import('../pages/discovery.js') },
  { path: '/companies', loader: () => import('../pages/companies.js') },
  { path: '/companies/:id', loader: () => import('../pages/company-detail.js') },
  { path: '/contacts', loader: () => import('../pages/contacts.js') },
  { path: '/products', loader: () => import('../pages/products.js') },
  { path: '/icps', loader: () => import('../pages/icps.js') },
  { path: '/campaigns', loader: () => import('../pages/campaigns.js') },
  { path: '/drafts', loader: () => import('../pages/drafts.js'), context: { mode: 'drafts' } },
  { path: '/approvals', loader: () => import('../pages/drafts.js'), context: { mode: 'approvals' } },
  { path: '/inbox', loader: () => import('../pages/inbox.js') },
  { path: '/deals', loader: () => import('../pages/deals.js') },
  { path: '/automation', loader: () => import('../pages/automation.js') },
  { path: '/assistant', loader: () => import('../pages/assistant.js') },
  { path: '/agents', loader: () => import('../pages/agents.js') },
  { path: '/jobs', loader: () => import('../pages/jobs.js') },
  { path: '/settings', loader: () => import('../pages/settings.js') },
];

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${source}/?$`), keys };
}

const compiled = ROUTES.map((route) => ({ ...route, ...compile(route.path) }));

export function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/dashboard';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '/dashboard';
  return { path, query: new URLSearchParams(queryPart || ''), raw };
}

export function matchRoute(path) {
  for (const route of compiled) {
    const result = route.regex.exec(path);
    if (!result) continue;
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(result[index + 1] || '');
    });
    return { route, params };
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (replace) {
    window.location.replace(`${window.location.pathname}${window.location.search}${target}`);
  } else {
    window.location.hash = target;
  }
}

let currentModule = null;
let renderToken = 0;

export function createRouter({ view, onPage = null, onUnhandled = null } = {}) {
  async function renderCurrent() {
    const token = ++renderToken;
    const { path, query } = parseHash();
    const match = matchRoute(path);
    if (!match) {
      clear(view);
      view.appendChild(
        emptyState({
          iconName: 'compass',
          title: '页面不存在',
          description: '请从左侧导航进入功能模块。',
          action: button('回到总览', { variant: 'primary', onClick: () => navigate('/dashboard') }),
        }),
      );
      return;
    }
    const { route, params } = match;
    if (!state.session) return;

    try {
      if (currentModule && typeof currentModule.destroy === 'function') {
        try {
          currentModule.destroy();
        } catch {
          // page cleanup must never break navigation
        }
      }
      currentModule = null;
      clear(view);
      const loaderNode = el('div', '');
      loaderNode.appendChild(loadingBlock('正在加载…'));
      view.appendChild(loaderNode);

      const module = await route.loader();
      if (token !== renderToken) return;
      const page = module.default || module;
      currentModule = page;
      const meta = page.meta || module.meta || { title: '工作台' };
      if (onPage) onPage(meta, { path, query });
      clear(view);
      const ctx = {
        query,
        params,
        mode: route.context?.mode || null,
        navigate,
        refresh: () => renderCurrent(),
        routePath: route.path,
      };
      await page.render(view, params, ctx);
      if (token !== renderToken) return;
    } catch (error) {
      if (token !== renderToken) return;
      clear(view);
      const details = error instanceof Error ? error.message : String(error);
      const box = el('div', 'card');
      const body = el('div', 'card-body');
      body.appendChild(notice(`页面加载失败：${details}`, 'danger'));
      body.appendChild(
        el('div', 'row', [
          button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => renderCurrent() }),
          button('回到总览', { size: 'sm', onClick: () => navigate('/dashboard') }),
        ]),
      );
      box.appendChild(body);
      view.appendChild(box);
      if (onUnhandled) onUnhandled(error);
    }
  }

  function onHashChange() {
    renderCurrent();
  }

  window.addEventListener('hashchange', onHashChange);
  return {
    start: () => renderCurrent(),
    refresh: () => renderCurrent(),
    stop: () => window.removeEventListener('hashchange', onHashChange),
  };
}

export default { createRouter, navigate, parseHash, matchRoute };
