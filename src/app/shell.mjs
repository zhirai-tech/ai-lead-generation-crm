/**
 * Application shell: sidebar navigation, topbar, notifications and account menu.
 * Built once per session; the router renders page content into `view`.
 */
import { append, clear, el, on } from '../utils/dom.mjs';
import { relativeTime, formatDate } from '../utils/format.mjs';
import { api } from './api.mjs';
import { state, clearSession, setNavBadges, events } from './state.mjs';
import { icon } from '../components/ui.mjs';
import { mountAssistant } from '../components/assistant.mjs';

const DESKTOP_NAV = [
  {
    label: '获客',
    items: [
      { path: '/discovery', label: '企业发现', icon: 'compass' },
      { path: '/companies', label: '潜在客户', icon: 'building' },
    ],
  },
  {
    label: '营销',
    items: [
      { path: '/icps', label: '客户画像', icon: 'target' },
      { path: '/products', label: '产品资料', icon: 'box' },
      { path: '/drafts', label: '邮件草稿', icon: 'mail' },
      { path: '/approvals', label: '发送审批', icon: 'checkSquare', badge: 'approvals' },
    ],
  },
  {
    label: '系统',
    items: [
      { path: '/assistant', label: 'AI 助理', icon: 'sparkles' },
      { path: '/settings', label: '系统设置', icon: 'settings' },
    ],
  },
];

const NAV = [
  {
    label: '工作台',
    items: [
      { path: '/dashboard', label: '全局总览', icon: 'dashboard' },
      { path: '/discovery', label: '企业发现', icon: 'compass' },
      { path: '/companies', label: '潜在客户', icon: 'building' },
      { path: '/contacts', label: '联系人库', icon: 'users' },
    ],
  },
  {
    label: '获客营销',
    items: [
      { path: '/products', label: '产品资料', icon: 'box' },
      { path: '/icps', label: '客户画像', icon: 'target' },
      { path: '/drafts', label: '邮件草稿', icon: 'mail' },
      { path: '/approvals', label: '发送审批', icon: 'checkSquare', badge: 'approvals' },
      { path: '/inbox', label: '统一收件', icon: 'inbox', badge: 'inbox' },
    ],
  },
  {
    label: '客户经营',
    items: [
      { path: '/deals', label: '销售管道', icon: 'pipeline' },
      { path: '/automation', label: '自动化流', icon: 'zap' },
    ],
  },
  {
    label: '智能中枢',
    items: [
      { path: '/assistant', label: 'AI 助理', icon: 'sparkles' },
      { path: '/agents', label: '智能代理', icon: 'brain' },
      { path: '/jobs', label: '任务队列', icon: 'activity' },
    ],
  },
  {
    label: '系统',
    items: [{ path: '/settings', label: '系统设置', icon: 'settings' }],
  },
];

const DESKTOP = Boolean(window.zhiraiDesktop) || new URLSearchParams(window.location.search).get('desktop') === '1';
const ACTIVE_NAV = DESKTOP ? DESKTOP_NAV : NAV;

export function buildShell({ container, onLogout }) {
  clear(container);
  const shell = el('div', 'app-shell');
  const session = state.session;

  // ---------------------------------------------------------------- sidebar
  const sidebar = el('aside', 'sidebar');
  const brand = el('a', 'brand');
  brand.href = DESKTOP ? '#/discovery' : '#/dashboard';
  const logo = el('img', 'brand-logo');
  logo.src = '/assets/brand/app-icons/128x128.png';
  logo.alt = 'ZHIRAI';
  logo.width = 34;
  logo.height = 34;
  const brandText = el('span', 'brand-text');
  append(brandText, [el('span', 'brand-name', 'ZHIRAI'), el('span', 'brand-sub', 'AI 智能获客与销售管理')]);
  append(brand, [logo, brandText]);

  const nav = el('nav', 'nav');
  nav.setAttribute('aria-label', '主导航');
  const links = new Map();
  for (const group of ACTIVE_NAV) {
    nav.appendChild(el('div', 'nav-group', group.label));
    for (const item of group.items) {
      const link = el('a', 'nav-link');
      link.href = `#${item.path}`;
      link.appendChild(icon(item.icon, 17, 'nav-icon'));
      link.appendChild(el('span', 'nav-label', item.label));
      if (item.badge) {
        const badge = el('span', 'nav-badge hidden');
        link.appendChild(badge);
        link._badge = { key: item.badge, node: badge };
      }
      links.set(item.path, link);
      nav.appendChild(link);
    }
  }

  const footer = el('div', 'sidebar-footer');
  const personalSite = el('a', 'personal-site', '个人网站 · zhinian-ai.com');
  personalSite.href = 'https://zhinian-ai.com';
  personalSite.target = '_blank';
  personalSite.rel = 'noopener noreferrer';
  personalSite.title = '智睿个人网站';
  personalSite.style.color = 'inherit';
  personalSite.style.textDecoration = 'none';
  personalSite.style.opacity = '0.9';
  append(footer, [
    el('div', 'powered', 'Powered by 智睿'),
    personalSite,
    el('div', '', 'Build Ideas Into Reality'),
    el('div', 'copyright', '© 2026 智睿科技 保留所有权利。'),
  ]);
  append(sidebar, [brand, nav, footer]);

  // ----------------------------------------------------------------- topbar
  const main = el('div', 'main');
  const topbar = el('header', 'topbar');
  const menuToggle = el('button', 'icon-btn menu-toggle');
  menuToggle.type = 'button';
  menuToggle.setAttribute('aria-label', '打开导航');
  menuToggle.appendChild(icon('menu', 18));
  const titleWrap = el('div', 'topbar-title');
  const pageTitle = el('h1', '', '全局总览');
  const helpSlot = el('span', '');
  append(titleWrap, [pageTitle, helpSlot]);
  const spacer = el('div', 'topbar-spacer');
  const searchWrap = el('div', 'global-search');
  searchWrap.appendChild(icon('search', 15, 'search-icon'));
  const searchInput = el('input', '');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索企业 / 联系人或域名';
  searchInput.setAttribute('aria-label', '全局搜索');
  searchWrap.appendChild(searchInput);
  const refreshBtn = el('button', 'icon-btn');
  refreshBtn.type = 'button';
  refreshBtn.title = '刷新';
  refreshBtn.setAttribute('aria-label', '刷新');
  refreshBtn.appendChild(icon('refresh', 17));
  const notifBtn = el('button', 'icon-btn');
  notifBtn.type = 'button';
  notifBtn.title = '通知';
  notifBtn.setAttribute('aria-label', '通知');
  notifBtn.appendChild(icon('bell', 17));
  const assistantBtn = el('button', 'icon-btn assistant-entry');
  assistantBtn.type = 'button';
  assistantBtn.title = '打开 ZHIRAI 助理';
  assistantBtn.setAttribute('aria-label', '打开 ZHIRAI 助理');
  assistantBtn.appendChild(icon('sparkles', 17));
  const notifDot = el('span', 'dot hidden');
  notifBtn.appendChild(notifDot);
  const userChip = el('button', 'user-chip');
  userChip.type = 'button';
  const userMeta = el('span', 'meta');
  const userName = el('b', '', session?.user?.name || session?.user?.email || '用户');
  const userRole = el('span', '', `${session?.workspace?.name || ''} · ${session?.membership?.roleLabel || ''}`);
  append(userMeta, [userName, userRole]);
  userChip.appendChild(el('span', 'detail-avatar soft', (session?.user?.name || 'Z').slice(0, 1)));
  userChip.appendChild(userMeta);
  userChip.appendChild(icon('chevronDown', 14));
  append(topbar, [menuToggle, titleWrap, spacer, searchWrap, refreshBtn, assistantBtn, notifBtn, userChip]);

  const view = el('section', 'view');
  append(main, [topbar, view]);
  append(shell, [sidebar, main]);
  container.appendChild(shell);
  const assistant = mountAssistant();
  if (assistantBtn) {
    assistantBtn.hidden = false;
    assistantBtn.addEventListener('click', () => assistant?.open());
  }

  // Compact text fallback when microphone/voice is unavailable. This stays
  // independent from the assistant page and shows one short line at a time.
  const quick = el('div', 'assistant-quick');
  const quickLine = el('div', 'assistant-quick-line', '助手待命');
  const quickInput = el('input', 'assistant-quick-input');
  quickInput.type = 'text';
  quickInput.placeholder = '给助理发一句话…';
  const quickSend = el('button', 'assistant-quick-send', '发送');
  quickSend.type = 'button';
  const quickRow = el('div', 'assistant-quick-row');
  append(quickRow, [quickInput, quickSend]);
  append(quick, [quickLine, quickRow]);
  document.body.appendChild(quick);
  const submitQuick = async () => {
    const text = quickInput.value.trim();
    if (!text) return;
    quickInput.value = '';
    quickLine.textContent = '正在思考…';
    quick.classList.add('busy');
    try {
      const result = await api.post('/api/v1/assistant/chat', { messages: [{ role: 'user', content: text }] });
      quickLine.textContent = String(result?.reply || '已处理').replace(/\s+/g, ' ').slice(0, 160);
    } catch (error) {
      quickLine.textContent = `失败：${error?.message || '请求失败'}`.slice(0, 160);
    } finally {
      quick.classList.remove('busy');
    }
  };
  quickSend.addEventListener('click', submitQuick);
  quickInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitQuick();
    }
  });

  // ------------------------------------------------------------- behaviours
  const scrim = el('button', 'sidebar-scrim hidden');
  scrim.type = 'button';
  scrim.setAttribute('aria-label', '关闭导航');
  document.body.appendChild(scrim);

  const closeMobile = () => {
    sidebar.classList.remove('open');
    scrim.classList.add('hidden');
  };
  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    scrim.classList.toggle('hidden', !sidebar.classList.contains('open'));
  });
  scrim.addEventListener('click', closeMobile);
  on(nav, 'click', (event) => {
    if (event.target.closest('a')) closeMobile();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const value = searchInput.value.trim();
    if (!value) return;
    window.location.hash = `#/companies?q=${encodeURIComponent(value)}`;
  });

  refreshBtn.addEventListener('click', () => {
    events.dispatchEvent(new CustomEvent('global-refresh'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

  const setPage = (meta = {}) => {
    pageTitle.textContent = meta.title || '工作台';
    clear(helpSlot);
    if (meta.help) {
      const help = docHelp(meta.help);
      helpSlot.appendChild(help);
    }
    document.title = `${meta.title || '工作台'} · ZHIRAI AI 智能获客`;
    for (const [path, link] of links) {
      const active = meta.path ? meta.path === path : window.location.hash.replace(/^#/, '').split('?')[0] === path;
      link.classList.toggle('active', active);
    }
  };

  function docHelp(text) {
    const wrap = el('span', 'help');
    const btn = el('button', 'help-btn', '?');
    btn.type = 'button';
    btn.setAttribute('aria-label', '说明');
    const tip = el('span', 'help-tip', text);
    append(wrap, [btn, tip]);
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      for (const other of document.querySelectorAll('.help.open')) if (other !== wrap) other.classList.remove('open');
      wrap.classList.toggle('open');
    });
    return wrap;
  }

  // --------------------------------------------------------------- user menu
  const menu = el('div', 'menu hidden');
  const passwordItem = el('button', 'menu-item');
  passwordItem.type = 'button';
  append(passwordItem, [icon('lock', 15), '修改密码']);
  const apiKeyItem = el('button', 'menu-item');
  apiKeyItem.type = 'button';
  append(apiKeyItem, [icon('key', 15), 'API 密钥']);
  const logoutItem = el('button', 'menu-item danger');
  logoutItem.type = 'button';
  append(logoutItem, [icon('logout', 15), '退出登录']);
  append(menu, [passwordItem, apiKeyItem, el('div', 'menu-sep'), logoutItem]);
  const chipWrap = el('div', 'relative');
  userChip.remove();
  chipWrap.appendChild(userChip);
  chipWrap.appendChild(menu);
  topbar.insertBefore(chipWrap, topbar.lastChild.nextSibling);

  userChip.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));

  // ----------------------------------------------------------- notifications
  let notifyTimer = null;
  async function loadBadges() {
    const results = await Promise.allSettled([
      api.get('/api/v1/notifications?unread=1&limit=1'),
      api.get('/api/v1/approvals/pending'),
      api.get('/api/v1/inbox/threads?unread=1&pageSize=1'),
    ]);
    const unread = results[0].status === 'fulfilled' ? results[0].value.unread || 0 : 0;
    const approvals = results[1].status === 'fulfilled' ? results[1].value.count ?? results[1].value.total ?? 0 : 0;
    const inbox = results[2].status === 'fulfilled' ? results[2].value.unread ?? results[2].value.total ?? 0 : 0;
    notifDot.classList.toggle('hidden', unread <= 0);
    setNavBadges({ notifications: unread, approvals, inbox });
    for (const link of links.values()) {
      if (!link._badge) continue;
      const value = link._badge.key === 'approvals' ? approvals : inbox;
      link._badge.node.textContent = value > 99 ? '99+' : String(value);
      link._badge.node.classList.toggle('hidden', value <= 0);
    }
  }

  function renderNotificationList(items, drawerBody) {
    clear(drawerBody);
    if (!items.length) {
      drawerBody.appendChild(el('div', 'empty', [el('b', '', '暂无新通知')]));
      return;
    }
    for (const item of items) {
      const row = el('div', 'alert-item');
      const iconWrap = el('span', `alert-icon ${item.severity === 'critical' ? 'critical' : item.severity === 'warning' ? 'warning' : ''}`);
      iconWrap.appendChild(icon(item.severity === 'critical' ? 'alert' : 'bell', 14));
      const main = el('div', 'alert-main');
      append(main, [el('b', '', item.title), el('span', '', item.body || '')]);
      const time = el('span', 'alert-time', relativeTime(item.createdAt));
      append(row, [iconWrap, main, time]);
      row.addEventListener('click', async () => {
        try {
          await api.post(`/api/v1/notifications/${item.id}/read`);
        } catch {
          // ignore
        }
        row.style.opacity = '0.5';
      });
      drawerBody.appendChild(row);
    }
  }

  notifBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    menu.classList.add('hidden');
    const drawerBody = el('div', '');
    drawerBody.appendChild(el('div', 'empty', [el('span', 'spinner')]));
    const drawer = openDrawerLite('通知中心', drawerBody);
    try {
      const data = await api.get('/api/v1/notifications?limit=30');
      renderNotificationList(data.items || [], drawerBody);
      if ((data.unread || 0) > 0) {
        await api.post('/api/v1/notifications/read-all');
        notifDot.classList.add('hidden');
        loadBadges();
      }
    } catch (error) {
      clear(drawerBody);
      drawerBody.appendChild(el('div', 'empty', [el('b', '', '通知加载失败'), el('p', '', error.message)]));
    }
    void drawer;
  });

  function openDrawerLite(title, body) {
    const overlay = el('div', 'drawer-overlay');
    const drawer = el('div', 'drawer');
    const head = el('div', 'drawer-head');
    const closeBtn = el('button', 'icon-btn');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.appendChild(icon('close', 17));
    append(head, [el('h2', '', title), closeBtn]);
    const bodyWrap = el('div', 'drawer-body');
    bodyWrap.appendChild(body);
    append(drawer, [head, bodyWrap]);
    overlay.appendChild(drawer);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (clickEvent) => {
      if (clickEvent.target === overlay) close();
    });
    return { close };
  }

  // ------------------------------------------------------------ change password
  async function showChangePassword(force = false) {
    const current = textField('当前密码', { type: 'password', autocomplete: 'current-password' });
    const next = textField('新密码', { type: 'password', autocomplete: 'new-password', help: '至少 10 位，必须同时包含字母和数字' });
    const confirm = textField('确认新密码', { type: 'password', autocomplete: 'new-password' });
    const errorBox = el('div', 'field-error hidden');
    const body = el('div', 'stack');
    append(body, [current.wrap, next.wrap, confirm.wrap, errorBox]);
    const { close } = openModalSafe({
      title: force ? '首次登录请修改密码' : '修改密码',
      body,
      actions: [
        ...(force ? [] : [{ label: '取消', onClick: (done) => done() }]),
        {
          label: '保存',
          variant: 'primary',
          onClick: async (done) => {
            errorBox.classList.add('hidden');
            if (next.input.value !== confirm.input.value) {
              errorBox.textContent = '两次输入的新密码不一致';
              errorBox.classList.remove('hidden');
              return;
            }
            try {
              await api.post('/api/v1/auth/password', { currentPassword: current.input.value, newPassword: next.input.value });
              done();
              clearSession();
              window.location.hash = '#/login';
              window.location.reload();
            } catch (error) {
              errorBox.textContent = error.message;
              errorBox.classList.remove('hidden');
            }
          },
        },
      ],
    });
    void close;
  }

  function textField(label, { type = 'text', autocomplete = 'off', help = null } = {}) {
    const wrap = el('div', 'field');
    const labelNode = el('label', 'field-label', label);
    if (help) {
      const helpWrap = el('span', 'help');
      const btn = el('button', 'help-btn', '?');
      btn.type = 'button';
      btn.setAttribute('aria-label', '说明');
      const tip = el('span', 'help-tip', help);
      append(helpWrap, [btn, tip]);
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        helpWrap.classList.toggle('open');
      });
      labelNode.appendChild(helpWrap);
    }
    const input = el('input', 'input');
    input.type = type;
    input.setAttribute('autocomplete', autocomplete);
    append(wrap, [labelNode, input]);
    return { wrap, input };
  }

  function openModalSafe({ title, body, actions }) {
    const overlay = el('div', 'overlay');
    const modal = el('div', 'modal sm');
    const head = el('div', 'modal-head');
    append(head, [el('h2', '', title)]);
    const bodyNode = el('div', 'modal-body');
    bodyNode.appendChild(body);
    const foot = el('div', 'modal-foot');
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    for (const action of actions) {
      const btn = el('button', 'btn');
      if (action.variant === 'primary') btn.classList.add('btn-primary');
      btn.textContent = action.label;
      btn.type = 'button';
      btn.addEventListener('click', () => action.onClick(close));
      foot.appendChild(btn);
    }
    append(modal, [head, bodyNode, foot]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return { close };
  }

  passwordItem.addEventListener('click', () => {
    menu.classList.add('hidden');
    showChangePassword(false);
  });
  apiKeyItem.addEventListener('click', () => {
    menu.classList.add('hidden');
    window.location.hash = '#/settings?tab=security';
  });
  logoutItem.addEventListener('click', async () => {
    menu.classList.add('hidden');
    try {
      await api.post('/api/v1/auth/logout');
    } catch {
      // still clear locally
    }
    clearSession();
    if (onLogout) onLogout();
    else window.location.reload();
  });

  if (session?.user?.mustChangePassword) showChangePassword(true);

  loadBadges();
  notifyTimer = setInterval(loadBadges, 60_000);

  function destroy() {
    if (notifyTimer) clearInterval(notifyTimer);
    scrim.remove();
    document.removeEventListener('click', () => {});
  }

  return {
    view,
    setPage,
    refreshBadges: loadBadges,
    showChangePassword,
    closeMobile,
    destroy,
  };
}

export default { buildShell };
