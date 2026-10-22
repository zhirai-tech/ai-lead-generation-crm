/**
 * Outreach campaigns page (OWNER: t-front-outreach).
 *
 * List + create/edit dialog + detail drawer with sequence steps, enrolled
 * targets, enrollment dialog (company/contact picker) and campaign statistics.
 *
 * Business rules surfaced in the UI:
 *  - sending requires human approval by default (`requireApproval`);
 *  - enrollment is guarded on the server (suppression / automation state),
 *    the UI only reports what the server accepted.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { can } from '../app/state.mjs';
import { formatDate, formatDateTime, formatNumber, relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  checkbox,
  confirmDialog,
  dataTable,
  emptyState,
  field,
  helpTip,
  input,
  loadingBlock,
  notice,
  openDrawer,
  openModal,
  pageHeader,
  pagination,
  searchInput,
  sectionTitle,
  select,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '开发信活动',
  help: '按产品与 ICP 组织多步开发信序列。活动默认需要人工审批，发送前仍会经过服务端的抑制名单、自动化状态、发送窗口与限额校验。',
};

const API = '/api/v1';
const PAGE_SIZE = 15;
const TIMEZONE = 'Europe/Berlin';

const LANGUAGES = [
  ['en', '英语'],
  ['de', '德语'],
  ['fr', '法语'],
  ['es', '西班牙语'],
  ['it', '意大利语'],
  ['nl', '荷兰语'],
  ['pl', '波兰语'],
  ['cs', '捷克语'],
  ['sv', '瑞典语'],
  ['da', '丹麦语'],
];

const WEEKDAYS = [
  [1, '周一'],
  [2, '周二'],
  [3, '周三'],
  [4, '周四'],
  [5, '周五'],
  [6, '周六'],
  [7, '周日'],
];

const CAMPAIGN_STATUS = {
  draft: ['草稿', 'gray'],
  active: ['进行中', 'green'],
  paused: ['已暂停', 'yellow'],
  archived: ['已归档', 'gray'],
};

const TARGET_STATUS = {
  enrolled: ['已加入', 'gray'],
  active: ['待发送', 'cyan'],
  paused: ['已暂停', 'yellow'],
  completed: ['已完成', 'gray'],
  replied: ['已回复', 'green'],
  unsubscribed: ['已退订', 'red'],
  bounced: ['退信', 'red'],
  failed: ['失败', 'red'],
};

function campaignBadge(status) {
  const [label, tone] = CAMPAIGN_STATUS[status] || [status || '未知', 'gray'];
  return badge(label, tone, { dot: true });
}

function targetBadge(status) {
  const [label, tone] = TARGET_STATUS[status] || [status || '未知', 'gray'];
  return badge(label, tone, { dot: true });
}

function errorMessage(error) {
  return error && error.message ? error.message : '请求失败，请稍后重试';
}

function unwrapList(data) {
  if (Array.isArray(data)) return { items: data, total: data.length };
  const items = Array.isArray(data && data.items) ? data.items : [];
  const total = Number(data && data.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function countOf(row, keys, fallback = null) {
  for (const key of keys) {
    const value = row ? row[key] : undefined;
    if (typeof value === 'number') return value;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

async function safeGet(path) {
  try {
    return await api.get(path);
  } catch {
    return null;
  }
}

function languageLabel(code) {
  const found = LANGUAGES.find(([value]) => value === code);
  return found ? found[1] : code || '—';
}

function windowSummary(sendWindow) {
  const source = sendWindow && typeof sendWindow === 'object' ? sendWindow : {};
  const start = source.startHour === undefined ? 9 : Number(source.startHour);
  const end = source.endHour === undefined ? 18 : Number(source.endHour);
  const days = Array.isArray(source.weekdays) && source.weekdays.length ? source.weekdays.map(Number) : [1, 2, 3, 4, 5];
  const dayLabels = days
    .slice()
    .sort((a, b) => a - b)
    .map((day) => {
      const found = WEEKDAYS.find(([value]) => value === Number(day));
      return found ? found[1] : String(day);
    })
    .join('、');
  return `${dayLabels || '未设置'} ${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00（${TIMEZONE}）`;
}

function fact(label, value) {
  return el('div', 'fact', [
    el('span', 'k', label),
    el('span', 'v', value === null || value === undefined || value === '' ? '—' : String(value)),
  ]);
}

let disposed = false;
let cleanup = [];
const overlays = new Set();

function trackOverlay(node) {
  if (node && node.parentElement) overlays.add(node.parentElement);
}

function showModal(options) {
  const handle = openModal(options);
  trackOverlay(handle.modal);
  return handle;
}

function showDrawer(options) {
  const handle = openDrawer(options);
  trackOverlay(handle.drawer);
  return handle;
}

export function destroy() {
  disposed = true;
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // page cleanup must never break navigation
    }
  }
  for (const node of overlays) {
    try {
      node.remove();
    } catch {
      // ignore
    }
  }
  overlays.clear();
}

async function loadReferences() {
  const [productsResult, icpsResult] = await Promise.all([
    safeGet(`${API}/products${queryString({ pageSize: 100 })}`),
    safeGet(`${API}/icps${queryString({ pageSize: 100 })}`),
  ]);
  return {
    products: unwrapList(productsResult).items,
    icps: unwrapList(icpsResult).items,
  };
}

function productLabel(row, products) {
  if (row && row.productName) return row.productName;
  if (row && row.product && row.product.name) return row.product.name;
  const found = products.find((item) => item.id === (row && row.productId));
  return found ? found.name : '—';
}

function icpLabel(row, icps) {
  if (row && row.icpName) return row.icpName;
  if (row && row.icp && row.icp.name) return row.icp.name;
  const found = icps.find((item) => item.id === (row && row.icpId));
  return found ? found.name : '—';
}

// ------------------------------------------------------------- campaign form
function openCampaignForm(campaign, { products, icps, onSaved }) {
  const editing = Boolean(campaign && campaign.id);
  const sendWindow = (campaign && campaign.sendWindow) || {};
  const values = {
    name: (campaign && campaign.name) || '',
    productId: (campaign && campaign.productId) || '',
    icpId: (campaign && campaign.icpId) || '',
    goal: (campaign && campaign.goal) || '',
    dailyLimit: campaign && campaign.dailyLimit !== undefined && campaign.dailyLimit !== null ? String(campaign.dailyLimit) : '30',
    requireApproval: !(campaign && campaign.requireApproval === false),
    startHour: sendWindow.startHour === undefined ? '9' : String(sendWindow.startHour),
    endHour: sendWindow.endHour === undefined ? '18' : String(sendWindow.endHour),
    weekdays: new Set(
      Array.isArray(sendWindow.weekdays) && sendWindow.weekdays.length ? sendWindow.weekdays.map((day) => Number(day)) : [1, 2, 3, 4, 5],
    ),
  };

  const controls = {
    name: input({ value: values.name, placeholder: '例如：德国汽车零部件客户 Q4 首轮' }),
    productId: select({
      value: values.productId,
      options: products.map((item) => ({ value: item.id, label: item.name })),
      placeholder: '不关联产品',
    }),
    icpId: select({
      value: values.icpId,
      options: icps.map((item) => ({ value: item.id, label: item.name })),
      placeholder: '不关联 ICP',
    }),
    goal: textarea({ value: values.goal, rows: 3, placeholder: '本轮活动想达成的目标，例如：拿到 10 个有效询盘' }),
    dailyLimit: input({ value: values.dailyLimit, type: 'number', placeholder: '30' }),
    startHour: select({
      value: values.startHour,
      options: Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` })),
    }),
    endHour: select({
      value: values.endHour,
      options: Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` })),
    }),
    requireApproval: checkbox({ checked: values.requireApproval, label: '草稿必须人工审批后才能发送（推荐）' }),
    weekdays: values.weekdays,
  };

  const weekdayRow = el('div', 'page-outreach-weekdays');
  for (const [day, label] of WEEKDAYS) {
    weekdayRow.appendChild(
      checkbox({
        checked: controls.weekdays.has(day),
        label,
        onChange: (checked) => {
          if (checked) controls.weekdays.add(day);
          else controls.weekdays.delete(day);
        },
      }),
    );
  }

  const goalField = field('活动目标', controls.goal, {
    help: '活动目标会作为草稿生成时的上下文，并显示在列表里，便于团队对齐。',
  });
  goalField.classList.add('span-2');
  const windowBlock = el('div', 'page-outreach-form-block span-2');
  append(windowBlock, [
    sectionTitle('发送时间窗', '只在该时间窗内发送；时区固定为欧洲中部时间，服务端发送管线会再次校验。'),
    el('div', 'form-grid', [
      field('开始小时', controls.startHour),
      field('结束小时', controls.endHour),
      el('div', 'page-outreach-field-span', [el('span', 'field-label', '工作日'), weekdayRow]),
      field('时区', el('div', 'page-readonly', TIMEZONE)),
    ]),
  ]);

  const body = el('div', 'form-grid');
  append(body, [
    field('活动名称', controls.name, { required: true }),
    field('每日限额', controls.dailyLimit, {
      help: '单个活动每天最多排队的开发信数量，服务端仍会叠加工作空间与账号限额。',
    }),
    field('产品', controls.productId, { help: '关联产品后，草稿生成只使用该产品的已确认资料。' }),
    field('ICP', controls.icpId, { help: '关联 ICP 后，目标人群与评分口径以该 ICP 为准。' }),
    goalField,
    windowBlock,
    field('时间窗时区', el('div', 'page-readonly', `${TIMEZONE}（夏令时自动切换）`), {
      help: '欧洲默认使用欧洲中部时间，避免在当地深夜发送。',
    }),
    el('div', 'page-outreach-approval span-2', [controls.requireApproval]),
  ]);

  let saving = false;
  const dialog = showModal({
    title: editing ? '编辑活动' : '新建开发信活动',
    body,
    size: 'lg',
    actions: [
      { label: '取消' },
      {
        label: editing ? '保存修改' : '创建活动',
        variant: 'primary',
        onClick: async (done) => {
          if (saving) return;
          const name = String(controls.name.value || '').trim();
          if (!name) {
            toast('活动名称不能为空', 'warning');
            controls.name.focus();
            return;
          }
          const dailyLimit = Number(controls.dailyLimit.value);
          if (!Number.isFinite(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) {
            toast('每日限额需在 1–1000 之间', 'warning');
            controls.dailyLimit.focus();
            return;
          }
          const startHour = Number(controls.startHour.value);
          const endHour = Number(controls.endHour.value);
          if (!(endHour > startHour)) {
            toast('结束小时必须晚于开始小时', 'warning');
            return;
          }
          if (!controls.weekdays.size) {
            toast('请至少选择一天工作日', 'warning');
            return;
          }
          const payload = {
            name,
            productId: controls.productId.value || null,
            icpId: controls.icpId.value || null,
            goal: String(controls.goal.value || '').trim() || null,
            dailyLimit,
            sendWindow: {
              startHour,
              endHour,
              weekdays: [...controls.weekdays].sort((a, b) => a - b),
              timezone: TIMEZONE,
            },
            requireApproval: Boolean(controls.requireApproval.querySelector('input')?.checked),
          };
          const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
          saving = true;
          if (saveBtn) saveBtn.disabled = true;
          try {
            if (editing) await api.patch(`${API}/campaigns/${encodeURIComponent(campaign.id)}`, payload);
            else await api.post(`${API}/campaigns`, payload);
            toast(editing ? '活动已更新' : '活动已创建', 'success');
            done();
            onSaved();
          } catch (error) {
            toast(errorMessage(error), 'error');
          } finally {
            saving = false;
            if (saveBtn) saveBtn.disabled = false;
          }
        },
      },
    ],
  });
  void dialog;
  setTimeout(() => controls.name.focus(), 40);
}

// ------------------------------------------------------------------ step form
function openStepForm(campaign, step, { onSaved }) {
  const editing = Boolean(step && step.id);
  const controls = {
    name: input({ value: (step && step.name) || '', placeholder: '例如：首次触达 / 第 3 天跟进' }),
    subject: textarea({ value: (step && step.subjectTemplate) || '', rows: 2, placeholder: '主题模板，可使用 {{company}} 等占位符' }),
    body: textarea({ value: (step && step.bodyTemplate) || '', rows: 7, placeholder: '正文模板，AI 生成时会以该模板为骨架' }),
    delay: input({
      value: step && step.delayDays !== undefined ? String(step.delayDays) : '0',
      type: 'number',
      placeholder: '0',
    }),
    language: select({
      value: (step && step.language) || 'en',
      options: LANGUAGES.map(([value, label]) => ({ value, label: `${label}（${value}）` })),
    }),
    isActive: checkbox({ checked: !(step && step.isActive === false), label: '启用该步骤' }),
  };
  const bodyField = field('正文模板', controls.body, {
    help: '模板只决定结构与语气；产品认证、价格与案例仍以产品资料库为准，AI 不会编造。',
  });
  bodyField.classList.add('span-2');
  const subjectField = field('主题模板', controls.subject, { help: '留空时由 AI 结合产品与客户信息生成主题。' });
  subjectField.classList.add('span-2');
  const body = el('div', 'form-grid');
  append(body, [
    field('步骤名称', controls.name, { required: true }),
    field('延迟天数', controls.delay, { help: '相对上一步发送成功后的等待天数，0 表示立即发送。' }),
    subjectField,
    bodyField,
    field('语言', controls.language),
    el('div', 'page-outreach-approval', [controls.isActive]),
  ]);

  let saving = false;
  const dialog = showModal({
    title: editing ? '编辑步骤' : '新增步骤',
    body,
    size: 'lg',
    actions: [
      { label: '取消' },
      {
        label: editing ? '保存步骤' : '添加步骤',
        variant: 'primary',
        onClick: async (done) => {
          if (saving) return;
          const name = String(controls.name.value || '').trim();
          if (!name) {
            toast('步骤名称不能为空', 'warning');
            controls.name.focus();
            return;
          }
          const delayDays = Number(controls.delay.value);
          if (!Number.isFinite(delayDays) || delayDays < 0 || delayDays > 365) {
            toast('延迟天数需在 0–365 之间', 'warning');
            return;
          }
          const payload = {
            name,
            subjectTemplate: String(controls.subject.value || ''),
            bodyTemplate: String(controls.body.value || ''),
            delayDays: Math.round(delayDays),
            language: controls.language.value || 'en',
            isActive: Boolean(controls.isActive.querySelector('input')?.checked),
          };
          const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
          saving = true;
          if (saveBtn) saveBtn.disabled = true;
          try {
            if (editing) {
              await api.patch(
                `${API}/campaigns/${encodeURIComponent(campaign.id)}/steps/${encodeURIComponent(step.id)}`,
                payload,
              );
            } else {
              await api.post(`${API}/campaigns/${encodeURIComponent(campaign.id)}/steps`, payload);
            }
            toast(editing ? '步骤已保存' : '步骤已添加', 'success');
            done();
            onSaved();
          } catch (error) {
            toast(errorMessage(error), 'error');
          } finally {
            saving = false;
            if (saveBtn) saveBtn.disabled = false;
          }
        },
      },
    ],
  });
  void dialog;
}

// -------------------------------------------------------------- enroll dialog
function openEnrollDialog(campaign, { onSaved }) {
  let companySearchTimer = null;
  let selectedCompany = null;
  let contacts = [];
  const selectedContacts = new Set();
  const companyHost = el('div', 'page-outreach-pick-list');
  const contactHost = el('div', 'stack');
  const hint = el('div', 'muted', '先搜索并选择一家企业，再勾选要加入活动的联系人；不勾选时按企业整体加入。');

  const search = searchInput({
    placeholder: '搜索企业名称 / 域名…',
    onInput: (value) => {
      if (companySearchTimer) clearTimeout(companySearchTimer);
      companySearchTimer = setTimeout(() => loadCompanies(value), 280);
    },
  });

  async function loadCompanies(query) {
    clear(companyHost);
    companyHost.appendChild(loadingBlock('正在搜索企业…'));
    const data = await safeGet(`${API}/companies${queryString({ pageSize: 20, q: String(query || '').trim() })}`);
    clear(companyHost);
    const { items } = unwrapList(data);
    if (!data) {
      companyHost.appendChild(notice('企业接口暂不可用，请稍后重试。', 'warn'));
      return;
    }
    if (!items.length) {
      companyHost.appendChild(el('div', 'muted', '没有匹配的企业，可先在「潜在客户」中创建企业。'));
      return;
    }
    for (const company of items) {
      const row = el('button', 'page-outreach-pick-item');
      row.type = 'button';
      append(row, [
        el('span', 'page-outreach-pick-main', company.name || '未命名企业'),
        el('span', 'muted', company.domain || company.country || ''),
      ]);
      row.addEventListener('click', () => selectCompany(company));
      companyHost.appendChild(row);
    }
  }

  async function selectCompany(company) {
    selectedCompany = company;
    selectedContacts.clear();
    clear(contactHost);
    contactHost.appendChild(loadingBlock('正在加载联系人…'));
    const data = await safeGet(`${API}/contacts${queryString({ companyId: company.id, pageSize: 100 })}`);
    const { items } = unwrapList(data);
    contacts = items;
    clear(contactHost);
    contactHost.appendChild(el('div', 'page-outreach-selected', `已选择：${company.name || '未命名企业'}`));
    if (!data) {
      contactHost.appendChild(
        notice('联系人接口暂不可用；也可以直接按企业加入，服务端会筛选有邮箱且未被抑制的联系人。', 'warn'),
      );
      return;
    }
    if (!contacts.length) {
      contactHost.appendChild(el('div', 'muted', '该企业暂无联系人。按企业加入时，服务端只能加入已有邮箱的联系人。'));
      return;
    }
    const list = el('div', 'page-outreach-contact-list');
    const allRow = checkbox({
      checked: false,
      label: '全选有邮箱的联系人',
      onChange: (checked) => {
        selectedContacts.clear();
        if (checked) {
          for (const contact of contacts) {
            if (contact.email) selectedContacts.add(contact.id);
          }
        }
        for (const box of list.querySelectorAll('input[type="checkbox"]')) box.checked = checked;
      },
    });
    list.appendChild(allRow);
    for (const contact of contacts) {
      const box = checkbox({
        checked: false,
        label: `${contact.fullName || contact.email || '未命名联系人'}${contact.email ? ` · ${contact.email}` : ' · 缺少邮箱'}`,
        onChange: (checked) => {
          if (checked) selectedContacts.add(contact.id);
          else selectedContacts.delete(contact.id);
        },
      });
      const boxInput = box.querySelector('input');
      if (boxInput) {
        boxInput.disabled = !contact.email;
        boxInput.dataset.contactId = contact.id;
      }
      list.appendChild(box);
    }
    contactHost.appendChild(list);
  }

  let submitting = false;
  const dialog = showModal({
    title: `加入目标 · ${campaign.name || '活动'}`,
    body: el('div', 'stack', [
      field('选择企业', search, {
        help: '只能加入有邮箱且未被抑制名单命中的联系人；服务端会跳过重复与不可发送的目标。',
      }),
      hint,
      companyHost,
      contactHost,
    ]),
    size: 'lg',
    actions: [
      { label: '取消' },
      {
        label: '加入活动',
        variant: 'primary',
        onClick: async (done) => {
          if (submitting) return;
          if (!selectedCompany) {
            toast('请先选择一家企业', 'warning');
            return;
          }
          const contactIds = [...selectedContacts];
          const payload = contactIds.length ? { contactIds } : { companyIds: [selectedCompany.id] };
          const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
          submitting = true;
          if (saveBtn) saveBtn.disabled = true;
          try {
            const result = await api.post(`${API}/campaigns/${encodeURIComponent(campaign.id)}/enroll`, payload);
            const enrolled = asNumber(result && result.enrolled, 0);
            const skipped = asNumber(result && result.skipped, 0);
            const parts = [`已加入 ${enrolled} 个目标`];
            if (skipped) parts.push(`跳过 ${skipped} 个`);
            if (result && result.suppressed) parts.push(`抑制 ${result.suppressed} 个`);
            if (result && result.automationBlocked) parts.push(`自动化拦截 ${result.automationBlocked} 个`);
            if (result && result.noEmail) parts.push(`缺少邮箱 ${result.noEmail} 个`);
            toast(parts.join('，'), enrolled ? 'success' : 'warning');
            done();
            onSaved();
          } catch (error) {
            toast(errorMessage(error), 'error');
          } finally {
            submitting = false;
            if (saveBtn) saveBtn.disabled = false;
          }
        },
      },
    ],
    onClose: () => {
      if (companySearchTimer) clearTimeout(companySearchTimer);
    },
  });
  void dialog;
  loadCompanies('');
}

// -------------------------------------------------------------- detail drawer
function openCampaignDetail(campaign, { products, icps, reloadList }) {
  let current = campaign;
  const bodyHost = el('div', 'stack');
  const drawer = showDrawer({
    title: `活动详情 · ${campaign.name || '未命名活动'}`,
    body: bodyHost,
    actions: [
      {
        label: '编辑活动',
        onClick: (done) => {
          done();
          openCampaignForm(current, {
            products,
            icps,
            onSaved: () => {
              reloadList();
              loadDetail();
            },
          });
        },
      },
      { label: '关闭' },
    ],
  });
  void drawer;

  const writable = can('campaigns.write');

  async function loadDetail() {
    clear(bodyHost);
    bodyHost.appendChild(loadingBlock('正在加载活动详情…'));
    const [detail, stepsResult, targetsResult, statsResult] = await Promise.all([
      safeGet(`${API}/campaigns/${encodeURIComponent(current.id)}`),
      safeGet(`${API}/campaigns/${encodeURIComponent(current.id)}/steps`),
      safeGet(`${API}/campaigns/${encodeURIComponent(current.id)}/targets${queryString({ pageSize: 50 })}`),
      safeGet(`${API}/campaigns/${encodeURIComponent(current.id)}/stats`),
    ]);
    if (disposed) return;
    if (detail && detail.campaign) current = { ...current, ...detail.campaign };
    else if (detail && detail.id) current = { ...current, ...detail };
    const steps = unwrapList((detail && detail.steps) || stepsResult).items;
    const targetList = unwrapList(targetsResult).items;
    const stats = (detail && detail.stats) || statsResult || null;

    clear(bodyHost);
    async function toggleStatus(action) {
      try {
        await api.post(`${API}/campaigns/${encodeURIComponent(current.id)}/${action}`, {});
        toast(action === 'pause' ? '活动已暂停' : '活动已恢复', 'success');
        reloadList();
        loadDetail();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
    bodyHost.appendChild(
      card({
        title: '概览',
        help: '活动状态、产品/ICP 与发送窗口。恢复活动只表示允许排队，发送仍需要审批与服务端安全校验。',
        actions: [
          campaignBadge(current.status),
          current.status === 'active'
            ? button('暂停活动', {
                size: 'sm',
                variant: 'outline',
                iconName: 'pause',
                disabled: !writable,
                onClick: () => toggleStatus('pause'),
              })
            : button('恢复活动', {
                size: 'sm',
                variant: 'outline',
                iconName: 'play',
                disabled: !writable || !['paused', 'draft'].includes(current.status),
                onClick: () => toggleStatus('resume'),
              }),
        ],
        body: el('div', 'stack', [
          current.goal ? el('div', 'page-outreach-goal', current.goal) : el('div', 'muted', '未填写活动目标'),
          el('div', 'page-outreach-facts', [
            fact('产品', productLabel(current, products)),
            fact('ICP', icpLabel(current, icps)),
            fact('每日限额', formatNumber(current.dailyLimit ?? 0)),
            fact('发送时间窗', windowSummary(current.sendWindow)),
            fact('审批', current.requireApproval === false ? '无需人工审批（谨慎）' : '默认人工审批'),
            fact('创建时间', formatDateTime(current.createdAt)),
          ]),
        ]),
      }),
    );

    const statItems = stats
      ? [
          ['目标总数', stats.total],
          ['已发送', stats.sent],
          ['已回复', stats.replied],
          ['待处理', stats.pending],
          ['回复率', stats.replyRate !== undefined && stats.replyRate !== null ? `${stats.replyRate}%` : '—'],
          ['退订', stats.unsubscribed],
        ]
      : [
          ['目标数', countOf(current, ['targetCount', 'targets', 'target_count'], 0)],
          ['已发送', countOf(current, ['sentCount', 'sent', 'sent_count'], 0)],
          ['已回复', countOf(current, ['repliedCount', 'replied', 'replied_count'], 0)],
          ['待审批', countOf(current, ['pendingApprovalCount', 'pendingApproval', 'pending_approval'], 0)],
        ];
    const statGrid = el('div', 'page-outreach-kpis');
    for (const [label, value] of statItems) {
      append(statGrid, [fact(label, value === null || value === undefined ? '—' : String(value))]);
    }
    if (!stats) statGrid.appendChild(notice('统计接口暂不可用，以上为列表中的汇总数据。', 'info'));
    bodyHost.appendChild(statGrid);

    // ------------------------------------------------------------------ steps
    const stepsCard = card({
      title: `发送序列（${steps.length} 步）`,
      help: '每一步包含主题与正文模板、延迟天数与语言。新步骤默认启用；停用的步骤不会推进。',
      actions: [
        button('新增步骤', {
          variant: 'primary',
          size: 'sm',
          iconName: 'plus',
          disabled: !writable,
          onClick: () => openStepForm(current, null, { onSaved: loadDetail }),
        }),
      ],
      body: steps.length
        ? el('div', 'page-outreach-steps', steps.map((step) => stepRow(step)))
        : emptyState({
            iconName: 'layers',
            title: '还没有发送步骤',
            description: '至少添加一个步骤后，活动才能生成开发信。',
            action: writable
              ? button('新增步骤', {
                  variant: 'primary',
                  size: 'sm',
                  iconName: 'plus',
                  onClick: () => openStepForm(current, null, { onSaved: loadDetail }),
                })
              : null,
          }),
    });
    bodyHost.appendChild(stepsCard);

    function stepRow(step) {
      const row = el('div', 'page-outreach-step');
      const head = el('div', 'page-outreach-step-head');
      append(head, [
        el('b', '', `步骤 ${step.stepNo ?? '—'} · ${step.name || '未命名步骤'}`),
        el('div', 'row', [
          badge(step.isActive === false ? '已停用' : '启用', step.isActive === false ? 'gray' : 'green', { dot: true }),
          badge(languageLabel(step.language), 'blue'),
          badge(`延迟 ${formatNumber(step.delayDays ?? 0)} 天`, 'gray'),
        ]),
      ]);
      const body = el('div', 'page-outreach-step-body');
      append(body, [
        el('div', 'page-outreach-template', [el('span', 'k', '主题'), el('span', 'v', step.subjectTemplate || '（AI 生成主题）')]),
        el('div', 'page-outreach-template', [el('span', 'k', '正文'), el('span', 'v', truncate(step.bodyTemplate || '（AI 生成正文）', 180))]),
      ]);
      const actions = el('div', 'row page-row-actions');
      append(actions, [
        button('编辑', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'edit',
          disabled: !writable,
          onClick: () => openStepForm(current, step, { onSaved: loadDetail }),
        }),
        button('删除', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'trash',
          disabled: !writable,
          onClick: async () => {
            const ok = await confirmDialog({
              title: '删除步骤',
              message: `确认删除「步骤 ${step.stepNo} · ${step.name || ''}」？已发送记录不受影响，但序列会立即变化。`,
              confirmText: '删除步骤',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.delete(
                `${API}/campaigns/${encodeURIComponent(current.id)}/steps/${encodeURIComponent(step.id)}`,
              );
              toast('步骤已删除', 'success');
              loadDetail();
              reloadList();
            } catch (error) {
              toast(errorMessage(error), 'error');
            }
          },
        }),
      ]);
      append(row, [head, body, actions]);
      return row;
    }

    // ---------------------------------------------------------------- targets
    const targetsCard = card({
      title: `目标（${targetList.length}${stats ? ` / ${stats.total ?? targetList.length}` : ''}）`,
      help: '目标来自企业联系人。服务端加入时会跳过重复、缺少邮箱、抑制名单命中与自动化被拦截的联系人。',
      actions: [
        button('加入目标', {
          variant: 'outline',
          size: 'sm',
          iconName: 'plus',
          disabled: !writable,
          onClick: () =>
            openEnrollDialog(current, {
              onSaved: () => {
                loadDetail();
                reloadList();
              },
            }),
        }),
      ],
      body: targetsResult
        ? targetTable(targetList)
        : el('div', 'stack', [
            notice('目标列表接口暂不可用，可查看上方统计了解目标进度。', 'info'),
            stats ? targetSummary(stats) : el('div', 'muted', '暂无统计'),
          ]),
    });
    bodyHost.appendChild(targetsCard);

    function targetTable(rows) {
      if (!rows.length) {
        return emptyState({
          iconName: 'users',
          title: '还没有目标',
          description: '点击「加入目标」，按企业选择联系人加入本轮活动。',
        });
      }
      return dataTable({
        columns: [
          {
            key: 'contact',
            label: '联系人',
            render: (row) => {
              const wrap = el('div', '');
              append(wrap, [el('div', 'cell-main', row.contactName || row.contactEmail || '未知联系人')]);
              append(wrap, [el('div', 'cell-sub', row.companyName || row.email || '')]);
              return wrap;
            },
          },
          { key: 'email', label: '邮箱', render: (row) => row.email || row.contactEmail || '—' },
          { key: 'status', label: '状态', render: (row) => targetBadge(row.status) },
          { key: 'step', label: '当前步骤', align: 'right', render: (row) => formatNumber(row.currentStep ?? 0) },
          {
            key: 'enrolledAt',
            label: '加入时间',
            render: (row) => el('span', 'muted', relativeTime(row.enrolledAt || row.createdAt)),
          },
        ],
        rows,
        rowKey: 'id',
      });
    }

    function targetSummary(source) {
      const grid = el('div', 'page-outreach-kpis');
      const byStatus = source.byStatus && typeof source.byStatus === 'object' ? source.byStatus : {};
      const entries = Object.entries(byStatus);
      if (!entries.length) {
        for (const [label, value] of [
          ['目标', source.total],
          ['待处理', source.pending],
          ['已完成', source.completed],
          ['已回复', source.replied],
        ]) {
          append(grid, [fact(label, String(value ?? '—'))]);
        }
        return grid;
      }
      for (const [status, value] of entries) {
        const [label] = TARGET_STATUS[status] || [status, 'gray'];
        append(grid, [fact(label, formatNumber(value))]);
      }
      return grid;
    }
  }

  loadDetail();
}

// --------------------------------------------------------------------- page
export async function render(root) {
  clear(root);
  disposed = false;
  cleanup = [];

  const state = { page: 1, pageSize: PAGE_SIZE, q: '', status: '' };
  let searchTimer = null;
  let products = [];
  let icps = [];
  const tableHost = el('div');
  const pagerHost = el('div', 'page-outreach-pager');
  const writable = can('campaigns.write');

  function errorState(message) {
    return el('div', 'page-state', [
      notice(`活动列表加载失败：${message}`, 'danger'),
      el('div', 'row', [button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: loadList })]),
    ]);
  }

  function emptyPanel() {
    const filtered = Boolean(state.q || state.status);
    if (filtered) {
      return emptyState({
        iconName: 'search',
        title: '没有匹配的活动',
        description: '尝试调整关键词或状态筛选。',
        action: button('清除筛选', {
          size: 'sm',
          onClick: () => {
            state.q = '';
            state.status = '';
            state.page = 1;
            loadList();
          },
        }),
      });
    }
    return emptyState({
      iconName: 'mail',
      title: '还没有开发信活动',
      description: '创建活动 → 添加发送步骤 → 加入目标企业，AI 生成的草稿会进入「发送审批」等待人工确认。',
      action: writable
        ? button('新建活动', {
            variant: 'primary',
            size: 'sm',
            iconName: 'plus',
            onClick: () => openCampaignForm(null, { products, icps, onSaved: loadList }),
          })
        : null,
    });
  }

  function columns() {
    return [
      {
        key: 'name',
        label: '活动',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [el('div', 'cell-main', row.name || '未命名活动')]);
          append(wrap, [el('div', 'cell-sub', truncate(row.goal || '未填写目标', 46))]);
          return wrap;
        },
      },
      { key: 'status', label: '状态', render: (row) => campaignBadge(row.status) },
      { key: 'product', label: '产品', render: (row) => productLabel(row, products) },
      { key: 'icp', label: 'ICP', render: (row) => icpLabel(row, icps) },
      {
        key: 'steps',
        label: '步骤数',
        align: 'right',
        render: (row) => formatNumber(countOf(row, ['stepCount', 'steps', 'step_count'], 0) ?? 0),
      },
      {
        key: 'targets',
        label: '目标数',
        align: 'right',
        render: (row) => formatNumber(countOf(row, ['targets', 'targetCount', 'target_count'], 0) ?? 0),
      },
      {
        key: 'sent',
        label: '已发送/回复',
        align: 'right',
        render: (row) =>
          `${formatNumber(countOf(row, ['sentCount', 'sent', 'sent_count'], 0) ?? 0)} / ${formatNumber(
            countOf(row, ['repliedCount', 'replied', 'replied_count'], 0) ?? 0,
          )}`,
      },
      {
        key: 'pending',
        label: '待审批',
        align: 'right',
        render: (row) => {
          const pending = countOf(row, ['pendingApprovalCount', 'pendingApproval', 'pending_approval'], null);
          if (pending === null) return el('span', 'muted', '—');
          return pending > 0 ? badge(String(pending), 'yellow') : el('span', 'muted', '0');
        },
      },
      { key: 'createdAt', label: '创建时间', render: (row) => el('span', 'muted', formatDate(row.createdAt)) },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) => {
          const wrap = el('div', 'row page-row-actions');
          append(wrap, [
            button('详情', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'eye',
              onClick: () => openCampaignDetail(row, { products, icps, reloadList: loadList }),
            }),
            button('编辑', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'edit',
              disabled: !writable,
              onClick: () => openCampaignForm(row, { products, icps, onSaved: loadList }),
            }),
            row.status === 'active'
              ? button('暂停', {
                  size: 'sm',
                  variant: 'ghost',
                  iconName: 'pause',
                  disabled: !writable,
                  onClick: () => changeStatus(row, 'pause'),
                })
              : button('恢复', {
                  size: 'sm',
                  variant: 'ghost',
                  iconName: 'play',
                  disabled: !writable || !['paused', 'draft'].includes(row.status),
                  onClick: () => changeStatus(row, 'resume'),
                }),
            button('删除', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              disabled: !writable,
              onClick: () => removeCampaign(row),
            }),
          ]);
          return wrap;
        },
      },
    ];
  }

  async function changeStatus(row, action) {
    try {
      await api.post(`${API}/campaigns/${encodeURIComponent(row.id)}/${action}`, {});
      toast(action === 'pause' ? '活动已暂停' : '活动已恢复', 'success');
      loadList();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeCampaign(row) {
    const ok = await confirmDialog({
      title: '删除活动',
      message: `确认删除活动「${row.name || '未命名'}」？活动将被归档，不再继续发送，历史草稿与发送记录保留。`,
      confirmText: '删除活动',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`${API}/campaigns/${encodeURIComponent(row.id)}`);
      toast('活动已删除', 'success');
      loadList();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function loadList() {
    if (disposed) return;
    clear(tableHost);
    tableHost.appendChild(dataTable({ columns: columns(), rows: [], loading: true }));
    clear(pagerHost);
    try {
      const data = await api.get(
        `${API}/campaigns${queryString({ page: state.page, pageSize: state.pageSize, search: state.q, status: state.status })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      const serverPage = Number(data && data.page);
      if (Number.isFinite(serverPage) && serverPage > 0) state.page = serverPage;
      clear(tableHost);
      tableHost.appendChild(
        dataTable({
          columns: columns(),
          rows: items,
          empty: emptyPanel(),
          onRowClick: (row) => openCampaignDetail(row, { products, icps, reloadList: loadList }),
        }),
      );
      clear(pagerHost);
      if (total > 0) {
        pagerHost.appendChild(
          pagination({
            page: state.page,
            pageSize: state.pageSize,
            total,
            onChange: (nextPage) => {
              state.page = Math.max(1, Number(nextPage) || 1);
              loadList();
            },
          }),
        );
      }
    } catch (error) {
      if (disposed) return;
      clear(tableHost);
      tableHost.appendChild(errorState(errorMessage(error)));
      clear(pagerHost);
    }
  }

  const searchNode = searchInput({
    placeholder: '搜索活动名称…',
    value: '',
    onInput: (value) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = String(value || '').trim();
        state.page = 1;
        loadList();
      }, 300);
    },
  });
  cleanup.push(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  const statusSelect = select({
    value: '',
    options: Object.entries(CAMPAIGN_STATUS).map(([value, entry]) => ({ value, label: entry[0] })),
    placeholder: '全部状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      loadList();
    },
  });

  append(root, [
    pageHeader({
      title: meta.title,
      help: meta.help,
      actions: [
        button('刷新', { iconName: 'refresh', onClick: loadList }),
        button('新建活动', {
          variant: 'primary',
          iconName: 'plus',
          disabled: !writable,
          onClick: () => openCampaignForm(null, { products, icps, onSaved: loadList }),
        }),
      ],
    }),
    toolbar(
      searchNode,
      statusSelect,
      el('span', 'grow'),
      helpTip('活动只负责组织序列与目标；草稿生成后在「发送审批」逐封确认，默认不会自动发送。'),
    ),
    tableHost,
    pagerHost,
  ]);

  const references = await loadReferences();
  products = references.products;
  icps = references.icps;
  await loadList();
}
