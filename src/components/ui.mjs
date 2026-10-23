/**
 * Shared UI kit (vanilla DOM). Pages must use these primitives so spacing,
 * states and interactions stay consistent across the workbench.
 *
 * Rules:
 *  - never set innerHTML with user data (use el/text)
 *  - explanatory copy belongs in helpTip(), not as visible paragraphs
 *  - no inline style attributes; use classes or CSS custom properties
 */
import { append, attr, clear, cssVar, el, on, svg, text } from '../utils/dom.mjs';
import { iconMarkup } from '../app/icons.mjs';
import { formatDate, formatDateTime, initials, relativeTime } from '../utils/format.mjs';

export function icon(name, size = 16, className = '') {
  return svg(iconMarkup(name), { size, className });
}

export function helpTip(content) {
  const wrap = el('span', 'help');
  const btn = el('button', 'help-btn', '?');
  btn.type = 'button';
  btn.setAttribute('aria-label', '说明');
  const tip = el('span', 'help-tip', content);
  append(wrap, [btn, tip]);
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    for (const other of document.querySelectorAll('.help.open')) {
      if (other !== wrap) other.classList.remove('open');
    }
    wrap.classList.toggle('open');
  });
  return wrap;
}

export function button(label, { variant = 'default', size = '', iconName = null, onClick = null, disabled = false, type = 'button', title = '', block = false } = {}) {
  const classes = ['btn'];
  if (variant === 'primary') classes.push('btn-primary');
  else if (variant === 'ghost') classes.push('btn-ghost');
  else if (variant === 'danger') classes.push('btn-danger');
  else if (variant === 'outline') classes.push('btn-outline');
  if (size === 'sm') classes.push('btn-sm');
  if (size === 'lg') classes.push('btn-lg');
  if (block) classes.push('btn-block');
  const node = el('button', classes.join(' '));
  node.type = type;
  if (title) node.title = title;
  if (iconName) append(node, [icon(iconName, size === 'sm' ? 13 : 15, 'btn-icon')]);
  if (label !== null && label !== undefined && label !== '') append(node, [label]);
  node.disabled = Boolean(disabled);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function iconButton(iconName, { title = '', onClick = null, disabled = false, badge = 0 } = {}) {
  const node = el('button', 'icon-btn');
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title || iconName);
  node.appendChild(icon(iconName, 17));
  node.disabled = Boolean(disabled);
  if (badge > 0) append(node, [el('span', 'dot')]);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function badge(label, tone = 'gray', { dot = false, large = false } = {}) {
  const classes = ['badge', tone];
  if (large) classes.push('lg');
  const node = el('span', classes.join(' '));
  if (dot) node.appendChild(el('span', 'badge-dot'));
  node.appendChild(text(label));
  return node;
}

const COMPANY_STATUS = {
  new: ['新线索', 'gray'],
  qualified: ['已合格', 'cyan'],
  contacted: ['已触达', 'blue'],
  replied: ['已回复', 'green'],
  customer: ['已成交', 'purple'],
  disqualified: ['不合格', 'red'],
  archived: ['已归档', 'gray'],
};
const DRAFT_STATUS = {
  draft: ['草稿', 'gray'],
  pending_approval: ['待审批', 'yellow'],
  approved: ['已批准', 'cyan'],
  rejected: ['已驳回', 'red'],
  scheduled: ['已排期', 'blue'],
  sent: ['已发送', 'green'],
  failed: ['发送失败', 'red'],
  discarded: ['已丢弃', 'gray'],
};
const AUTOMATION_STATUS = {
  AUTOMATION_ACTIVE: ['自动运行', 'green'],
  NEEDS_HUMAN_REVIEW: ['需人工复核', 'yellow'],
  HUMAN_TAKEOVER: ['人工接管', 'purple'],
  PAUSED: ['已暂停', 'gray'],
  DO_NOT_CONTACT: ['禁止联系', 'red'],
  CLOSED: ['已关闭', 'gray'],
};
const JOB_STATUS = {
  queued: ['排队中', 'gray'],
  running: ['执行中', 'cyan'],
  succeeded: ['成功', 'green'],
  failed: ['失败', 'red'],
  cancelled: ['已取消', 'gray'],
  dead: ['已终止', 'red'],
};
const DEAL_STAGE = {
  lead: ['线索', 'gray'],
  qualified: ['已合格', 'cyan'],
  proposal: ['已报价', 'blue'],
  negotiation: ['谈判中', 'yellow'],
  won: ['赢单', 'green'],
  lost: ['输单', 'red'],
};
const INTENT_LABELS = {
  positive_interest: ['正面意向', 'green'],
  price_inquiry: ['询价', 'cyan'],
  quote_request: ['报价请求', 'cyan'],
  sample_request: ['样品需求', 'purple'],
  technical_question: ['技术问题', 'blue'],
  follow_up_needed: ['需进一步联系', 'blue'],
  no_need_now: ['暂无需求', 'gray'],
  rejection: ['明确拒绝', 'red'],
  unsubscribe: ['退订', 'red'],
  auto_reply: ['自动回复', 'gray'],
  unknown: ['无法判断', 'gray'],
};
const EMAIL_STATUS = {
  unverified: ['未验证', 'gray'],
  valid: ['有效', 'green'],
  risky: ['有风险', 'yellow'],
  invalid: ['无效', 'red'],
  inferred: ['推测', 'blue'],
};
const EMAIL_TYPE = {
  business: ['企业邮箱', 'cyan'],
  personal: ['个人邮箱', 'blue'],
  role: ['角色邮箱', 'purple'],
  inferred: ['推测邮箱', 'gray'],
  unknown: ['未知类型', 'gray'],
};
const SUPPLIER_REASON = {
  unsubscribe: ['主动退订', 'red'],
  hard_bounce: ['硬退信', 'red'],
  complaint: ['投诉', 'red'],
  manual: ['手动添加', 'gray'],
  do_not_contact: ['拒绝联系', 'red'],
  gdpr_request: ['GDPR 请求', 'yellow'],
};

export function statusBadge(status, kind = 'company') {
  const maps = {
    company: COMPANY_STATUS,
    draft: DRAFT_STATUS,
    automation: AUTOMATION_STATUS,
    job: JOB_STATUS,
    deal: DEAL_STAGE,
    intent: INTENT_LABELS,
    email: EMAIL_STATUS,
    emailType: EMAIL_TYPE,
    suppression: SUPPLIER_REASON,
  };
  const map = maps[kind] || COMPANY_STATUS;
  const [label, tone] = map[status] || [status || '未知', 'gray'];
  return badge(label, tone, { dot: true });
}

export function scoreBadge(score) {
  const value = Number(score) || 0;
  const tone = value >= 80 ? 'green' : value >= 60 ? 'cyan' : value >= 40 ? 'yellow' : 'red';
  return badge(`评分 ${Math.round(value)}`, tone);
}

export function scoreMeter(score, { showNumber = true } = {}) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  const wrap = el('span', 'score');
  const track = el('span', 'score-track');
  const fill = el('span', 'score-fill');
  cssVar(fill, '--score', `${value}%`);
  if (value < 40) fill.classList.add('bad');
  else if (value < 60) fill.classList.add('warn');
  else if (value >= 80) fill.classList.add('good');
  append(track, [fill]);
  append(wrap, [track]);
  if (showNumber) append(wrap, [el('span', 'score-num', String(Math.round(value)))]);
  return wrap;
}

export function avatar(name, { size = 32 } = {}) {
  const node = el('span', 'detail-avatar soft', initials(name));
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.style.fontSize = `${Math.round(size * 0.36)}px`;
  return node;
}

export function pageHeader({ title, help = null, subtitle = null, actions = [] } = {}) {
  const head = el('div', 'page-head');
  const textBlock = el('div', 'page-head-text');
  const heading = el('h1', '', title);
  if (help) append(heading, [helpTip(help)]);
  append(textBlock, [heading]);
  if (subtitle) append(textBlock, [el('div', 'page-head-sub', subtitle)]);
  const actionWrap = el('div', 'page-actions');
  append(actionWrap, actions);
  append(head, [textBlock, actionWrap]);
  return head;
}

export function card({ title = null, help = null, actions = [], body = null, foot = null, className = '', flush = false } = {}) {
  const node = el('section', `card ${className}`.trim());
  if (title || actions.length) {
    const head = el('div', 'card-head');
    const heading = el('h2', '', title || '');
    if (help) append(heading, [helpTip(help)]);
    append(head, [heading]);
    const actionWrap = el('div', 'row');
    append(actionWrap, actions);
    append(head, [actionWrap]);
    node.appendChild(head);
  }
  if (body) {
    const bodyNode = el('div', `card-body${flush ? ' flush' : ''}`);
    append(bodyNode, [body]);
    node.appendChild(bodyNode);
  }
  if (foot) {
    const footNode = el('div', 'card-foot');
    append(footNode, [foot]);
    node.appendChild(footNode);
  }
  return node;
}

export function statCard({ label, value, hint = null, iconName = 'chart', tone = 'cyan', delta = null, help = null } = {}) {
  const node = el('div', 'stat');
  const top = el('div', 'stat-top');
  const labelWrap = el('span', 'stat-label', label);
  if (help) append(labelWrap, [helpTip(help)]);
  const iconWrap = el('span', 'stat-icon', '');
  iconWrap.appendChild(icon(iconName, 14));
  if (tone === 'green') iconWrap.classList.add('green');
  append(top, [labelWrap, iconWrap]);
  const valueNode = el('div', 'stat-value', value === null || value === undefined ? '—' : String(value));
  append(node, [top, valueNode]);
  if (hint || delta !== null) {
    const foot = el('div', 'stat-foot');
    if (delta !== null) {
      const up = Number(delta) >= 0;
      append(foot, [el('span', `delta ${up ? 'up' : 'down'}`, `${up ? '↑' : '↓'} ${Math.abs(Number(delta))}%`)]);
    }
    if (hint) append(foot, [el('span', '', hint)]);
    append(node, [foot]);
  }
  return node;
}

export function toolbar(...children) {
  const node = el('div', 'toolbar');
  append(node, children);
  return node;
}

export function searchInput({ placeholder = '搜索…', value = '', onInput = null } = {}) {
  const wrap = el('div', 'search-input');
  wrap.appendChild(icon('search', 15));
  const input = el('input', 'input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.value = value || '';
  input.setAttribute('aria-label', placeholder);
  if (onInput) {
    input.addEventListener('input', (event) => onInput(event.target.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onInput(event.target.value, { submit: true });
    });
  }
  wrap.appendChild(input);
  return wrap;
}

export function input({ value = '', placeholder = '', type = 'text', name = '', autocomplete = 'off', disabled = false, onInput = null, onEnter = null, className = 'input' } = {}) {
  const node = el('input', className);
  node.type = type;
  node.value = value ?? '';
  if (placeholder) node.placeholder = placeholder;
  if (name) node.name = name;
  if (autocomplete) node.setAttribute('autocomplete', autocomplete);
  node.disabled = Boolean(disabled);
  if (onInput) node.addEventListener('input', (event) => onInput(event.target.value));
  if (onEnter) node.addEventListener('keydown', (event) => { if (event.key === 'Enter') onEnter(event.target.value); });
  return node;
}

export function textarea({ value = '', placeholder = '', rows = 5, onInput = null, className = 'textarea' } = {}) {
  const node = el('textarea', className);
  node.rows = rows;
  node.value = value ?? '';
  if (placeholder) node.placeholder = placeholder;
  if (onInput) node.addEventListener('input', (event) => onInput(event.target.value));
  return node;
}

export function select({ value = '', options = [], onChange = null, className = 'select', placeholder = null, disabled = false } = {}) {
  const node = el('select', className);
  node.disabled = Boolean(disabled);
  if (placeholder !== null) {
    const option = el('option', '', placeholder);
    option.value = '';
    node.appendChild(option);
  }
  for (const item of options) {
    const option = el('option', '', typeof item === 'string' ? item : item.label);
    option.value = typeof item === 'string' ? item : item.value;
    node.appendChild(option);
  }
  node.value = value ?? '';
  if (onChange) node.addEventListener('change', (event) => onChange(event.target.value));
  return node;
}

export function checkbox({ checked = false, label = '', onChange = null } = {}) {
  const wrap = el('label', 'checkbox');
  const box = el('input', '');
  box.type = 'checkbox';
  box.checked = Boolean(checked);
  if (onChange) box.addEventListener('change', (event) => onChange(event.target.checked));
  append(wrap, [box, label]);
  return wrap;
}

export function field(label, control, { help = null, required = false, hint = null, error = null } = {}) {
  const wrap = el('div', 'field');
  const labelNode = el('label', 'field-label');
  append(labelNode, [label]);
  if (required) append(labelNode, [el('span', 'req', '*')]);
  if (help) append(labelNode, [helpTip(help)]);
  wrap.appendChild(labelNode);
  wrap.appendChild(control);
  if (hint) append(wrap, [el('div', 'field-hint', hint)]);
  if (error) append(wrap, [el('div', 'field-error', error)]);
  return wrap;
}

export function emptyState({ iconName = 'folder', title = '暂无数据', description = '', action = null } = {}) {
  const node = el('div', 'empty');
  const iconWrap = el('span', 'empty-icon');
  iconWrap.appendChild(icon(iconName, 20));
  append(node, [iconWrap, el('b', '', title)]);
  if (description) append(node, [el('p', '', description)]);
  if (action) append(node, [action]);
  return node;
}

export function loadingBlock(label = '加载中…') {
  const wrap = el('div', 'empty');
  append(wrap, [el('span', 'spinner'), el('span', 'muted', label)]);
  return wrap;
}

export function notice(content, tone = 'info', iconName = null) {
  const node = el('div', `notice ${tone}`);
  const iconNameResolved = iconName || (tone === 'danger' || tone === 'warn' ? 'alert' : 'info');
  append(node, [icon(iconNameResolved, 14), el('span', '', content)]);
  return node;
}

export function dataTable({ columns = [], rows = [], rowKey = 'id', onRowClick = null, loading = false, empty = null } = {}) {
  const wrap = el('div', 'table-wrap');
  if (loading) {
    const lines = el('div', '');
    for (let i = 0; i < 6; i += 1) {
      const row = el('div', 'skeleton-row');
      for (const col of columns.length ? columns.slice(0, 4) : [{}, {}, {}, {}]) {
        append(row, [el('div', 'skeleton skeleton-line')]);
        void col;
      }
      lines.appendChild(row);
    }
    wrap.appendChild(lines);
    return wrap;
  }
  if (!rows.length) {
    const emptyWrap = el('div', 'table-empty');
    append(emptyWrap, [empty || emptyState({ title: '暂无数据' })]);
    wrap.appendChild(emptyWrap);
    return wrap;
  }
  const table = el('table', 'data-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const column of columns) {
    const th = el('th', `${column.align === 'right' ? 'num' : ''}`.trim(), column.label || '');
    if (column.width) th.style.width = `${column.width}px`;
    append(headRow, [th]);
  }
  append(thead, [headRow]);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', onRowClick ? 'clickable' : '');
    for (const column of columns) {
      const td = el('td', `${column.align === 'right' ? 'num' : ''} ${column.className || ''}`.trim());
      let value;
      if (typeof column.render === 'function') value = column.render(row);
      else value = row[column.key];
      if (value === null || value === undefined || value === '') value = '—';
      if (value instanceof Node) td.appendChild(value);
      else append(td, [String(value)]);
      tr.appendChild(td);
    }
    if (onRowClick) {
      tr.addEventListener('click', (event) => {
        if (event.target.closest('button, a, input, select, textarea, label')) return;
        onRowClick(row);
      });
    }
    tbody.appendChild(tr);
  }
  append(table, [thead, tbody]);
  wrap.appendChild(table);
  return wrap;
}

export function pagination({ page = 1, pageSize = 25, total = 0, onChange = null, label = '条记录' } = {}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const wrap = el('div', 'row-between');
  append(wrap, [el('span', 'muted', `共 ${total} ${label} · 第 ${page}/${pages} 页`)]);
  const nav = el('div', 'pagination');
  const prev = el('button', '', '‹');
  prev.disabled = page <= 1;
  prev.setAttribute('aria-label', '上一页');
  prev.addEventListener('click', () => onChange?.(page - 1));
  nav.appendChild(prev);
  const candidates = new Set([1, pages, page - 1, page, page + 1]);
  const sorted = [...candidates].filter((value) => value >= 1 && value <= pages).sort((a, b) => a - b);
  let last = 0;
  for (const item of sorted) {
    if (item - last > 1) append(nav, [el('span', 'muted', '…')]);
    const btn = el('button', item === page ? 'active' : '', String(item));
    btn.addEventListener('click', () => onChange?.(item));
    nav.appendChild(btn);
    last = item;
  }
  const next = el('button', '', '›');
  next.disabled = page >= pages;
  next.setAttribute('aria-label', '下一页');
  next.addEventListener('click', () => onChange?.(page + 1));
  nav.appendChild(next);
  append(wrap, [nav]);
  return wrap;
}

export function tabs({ items = [], active = '', onChange = null } = {}) {
  const wrap = el('div', 'tabs');
  for (const item of items) {
    const btn = el('button', item.key === active ? 'active' : '');
    append(btn, [item.label]);
    if (item.count !== undefined) append(btn, [el('span', 'count', String(item.count))]);
    btn.addEventListener('click', () => onChange?.(item.key));
    wrap.appendChild(btn);
  }
  return wrap;
}

export function segmented({ items = [], value = '', onChange = null } = {}) {
  const wrap = el('div', 'segmented');
  for (const item of items) {
    const btn = el('button', item.value === value ? 'active' : '', item.label);
    btn.type = 'button';
    btn.addEventListener('click', () => onChange?.(item.value));
    wrap.appendChild(btn);
  }
  return wrap;
}

function overlayBase(onClose) {
  const overlay = el('div', 'overlay');
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    onClose?.();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') close();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);
  return { overlay, close };
}

export function openModal({ title = '', body = null, actions = [], size = '', onClose = null } = {}) {
  const { overlay, close } = overlayBase(onClose);
  const modal = el('div', `modal ${size}`.trim());
  const head = el('div', 'modal-head');
  append(head, [el('h2', '', title), iconButton('close', { title: '关闭', onClick: close })]);
  const bodyNode = el('div', 'modal-body');
  append(bodyNode, [body]);
  const foot = el('div', 'modal-foot');
  for (const action of actions) {
    const btn = button(action.label, {
      variant: action.variant || (action.primary ? 'primary' : 'default'),
      onClick: () => action.onClick ? action.onClick(close) : close(),
    });
    foot.appendChild(btn);
  }
  append(modal, [head, bodyNode, foot]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const firstInput = modal.querySelector('input, textarea, select');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  return { close, modal };
}

export function openDrawer({ title = '', body = null, actions = [], onClose = null } = {}) {
  const overlay = el('div', 'drawer-overlay');
  const close = () => {
    overlay.remove();
    onClose?.();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  const drawer = el('div', 'drawer');
  const head = el('div', 'drawer-head');
  append(head, [el('h2', '', title), iconButton('close', { title: '关闭', onClick: close })]);
  const bodyNode = el('div', 'drawer-body');
  append(bodyNode, [body]);
  drawer.appendChild(head);
  drawer.appendChild(bodyNode);
  if (actions.length) {
    const foot = el('div', 'drawer-foot');
    for (const action of actions) {
      foot.appendChild(button(action.label, { variant: action.variant || 'default', onClick: () => action.onClick ? action.onClick(close) : close() }));
    }
    drawer.appendChild(foot);
  }
  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
  return { close, drawer };
}

export function confirmDialog({ title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { close } = openModal({
      title,
      size: 'sm',
      body: el('p', 'dim', message),
      actions: [
        { label: cancelText, onClick: (done) => { finish(false); done(); } },
        { label: confirmText, variant: danger ? 'danger' : 'primary', onClick: (done) => { finish(true); done(); } },
      ],
      onClose: () => finish(false),
    });
    void close;
  });
}

let toastHost = null;
export function toast(message, tone = 'info', timeout = 3200) {
  if (!toastHost) {
    toastHost = el('div', 'toasts');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const node = el('div', `toast ${tone}`);
  const iconName = tone === 'success' ? 'check' : tone === 'error' ? 'alert' : tone === 'warning' ? 'alert' : 'info';
  append(node, [icon(iconName, 15), el('span', '', message)]);
  toastHost.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s ease';
    setTimeout(() => node.remove(), 220);
  }, timeout);
  return node;
}

export function kvList(items) {
  const dl = el('dl', 'kv');
  for (const item of items) {
    if (!item) continue;
    append(dl, [el('dt', '', item.label), el('dd', '', item.value === null || item.value === undefined || item.value === '' ? '—' : item.value)]);
  }
  return dl;
}

export function detailRows(items) {
  const node = el('div', 'detail-list');
  for (const item of items) {
    if (!item) continue;
    const row = el('div', 'detail-row');
    append(row, [el('span', 'k', item.label), el('span', 'v', item.value === null || item.value === undefined || item.value === '' ? '—' : item.value)]);
    node.appendChild(row);
  }
  return node;
}

export function timeline(items = []) {
  const wrap = el('div', 'timeline');
  for (const item of items) {
    const row = el('div', `timeline-item${item.accent ? ' accent' : ''}`);
    const head = el('div', 'timeline-head');
    append(head, [el('span', '', item.title || ''), el('span', 'timeline-time', item.timeLabel || relativeTime(item.time))]);
    append(row, [head]);
    if (item.body) append(row, [el('div', 'timeline-body', item.body)]);
    wrap.appendChild(row);
  }
  return wrap;
}

export function chips(items = [], { onRemove = null } = {}) {
  const wrap = el('div', 'tag-list');
  for (const item of items) {
    const chip = el('span', 'chip');
    append(chip, [typeof item === 'string' ? item : item.label || '']);
    if (onRemove) {
      const close = el('button', '', '×');
      close.type = 'button';
      close.setAttribute('aria-label', '移除');
      close.addEventListener('click', () => onRemove(item));
      append(chip, [close]);
    }
    wrap.appendChild(chip);
  }
  return wrap;
}

export function sectionTitle(label, help = null) {
  const node = el('div', 'section-title');
  append(node, [label]);
  if (help) append(node, [helpTip(help)]);
  return node;
}

export function copyButton(value, label = '复制') {
  return button(label, {
    variant: 'ghost',
    size: 'sm',
    iconName: 'copy',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(String(value ?? ''));
        toast('已复制到剪贴板', 'success', 1600);
      } catch {
        toast('复制失败，请手动选择文本', 'error');
      }
    },
  });
}

export function mailBody(textValue) {
  return el('div', 'mail-body', textValue || '');
}

export function emptyTable(title, description = '') {
  return emptyState({ title, description });
}

export function dateCell(value) {
  return el('span', 'muted', formatDateTime(value));
}

export function relativeCell(value) {
  return el('span', 'muted', relativeTime(value));
}

export function formatDateCell(value) {
  return el('span', 'muted', formatDate(value));
}

export function refreshSelectOptions(selectNode, options, value) {
  clear(selectNode);
  for (const item of options) {
    const option = el('option', '', typeof item === 'string' ? item : item.label);
    option.value = typeof item === 'string' ? item : item.value;
    selectNode.appendChild(option);
  }
  selectNode.value = value ?? '';
}

export { attr, text };
