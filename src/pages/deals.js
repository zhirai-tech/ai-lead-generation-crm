/**
 * Sales pipeline (OWNER: t-front-outreach).
 *
 * Kanban by stage + deal create/edit drawer + recent sales activities and
 * follow-up tasks. Stage and amounts are maintained manually — the AI never
 * decides that a deal is won (see helpTip on the pipeline card).
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { can } from '../app/state.mjs';
import { formatDate, formatDateTime, formatMoney, formatNumber, relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  checkbox,
  confirmDialog,
  emptyState,
  field,
  helpTip,
  input,
  loadingBlock,
  notice,
  openDrawer,
  openModal,
  pageHeader,
  select,
  statusBadge,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '销售管道',
  help: '按阶段管理商机金额与下一步动作。阶段、金额、概率与预计成交日期均为人工维护，AI 不会自动判定成交。',
};

const API = '/api/v1';

const STAGES = [
  ['lead', '线索'],
  ['qualified', '已合格'],
  ['proposal', '已报价'],
  ['negotiation', '谈判中'],
  ['won', '赢单'],
  ['lost', '输单'],
];

const CURRENCIES = ['EUR', 'USD', 'CNY', 'GBP', 'CHF', 'SEK', 'PLN'];

const ACTIVITY_TYPES = {
  email: ['邮件', 'blue'],
  call: ['电话', 'cyan'],
  meeting: ['会议', 'purple'],
  note: ['备注', 'gray'],
  task: ['任务', 'yellow'],
  system: ['系统', 'gray'],
};

const TASK_TYPES = {
  follow_up: '跟进',
  email: '邮件',
  call: '电话',
  review: '复核',
  reminder: '提醒',
};

const TASK_STATUS = {
  pending: ['待处理', 'yellow'],
  done: ['已完成', 'green'],
  cancelled: ['已取消', 'gray'],
  skipped: ['已跳过', 'gray'],
};

function stageLabel(key) {
  const found = STAGES.find(([value]) => value === key);
  return found ? found[1] : key || '—';
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

async function safeGet(path) {
  try {
    return await api.get(path);
  } catch {
    return null;
  }
}

function toDateInput(value) {
  if (!value) return '';
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

function moneyOf(deal) {
  return formatMoney(deal.valueAmount ?? deal.value_amount ?? 0, deal.currency || 'EUR');
}

let disposed = false;
let cleanup = [];
const overlays = new Set();

function showModal(options) {
  const handle = openModal(options);
  if (handle.modal && handle.modal.parentElement) overlays.add(handle.modal.parentElement);
  return handle;
}

function showDrawer(options) {
  const handle = openDrawer(options);
  if (handle.drawer && handle.drawer.parentElement) overlays.add(handle.drawer.parentElement);
  return handle;
}

export function destroy() {
  disposed = true;
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // ignore
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

/** Normalise the pipeline payload into ordered stages with cards. */
function normalizePipeline(data) {
  const source = data && typeof data === 'object' ? data : {};
  let rawStages = [];
  if (Array.isArray(source.stages)) rawStages = source.stages;
  else if (Array.isArray(source.pipeline)) rawStages = source.pipeline;
  else if (Array.isArray(data)) rawStages = data;
  const byKey = new Map();
  for (const stage of rawStages) {
    if (!stage || typeof stage !== 'object') continue;
    const key = stage.key || stage.stage || stage.stageKey;
    if (!key) continue;
    byKey.set(key, {
      key,
      label: stage.label || stageLabel(key),
      items: Array.isArray(stage.items) ? stage.items : Array.isArray(stage.deals) ? stage.deals : [],
      count: Number(stage.count ?? (Array.isArray(stage.items) ? stage.items.length : 0)),
      totalValue: Number(stage.totalValue ?? stage.total_value ?? 0),
    });
  }
  return STAGES.map(([key, label]) => {
    const found = byKey.get(key);
    if (found) {
      return {
        ...found,
        label: found.label || label,
        count: Number.isFinite(found.count) ? found.count : found.items.length,
        totalValue: Number.isFinite(found.totalValue) ? found.totalValue : 0,
      };
    }
    return { key, label, items: [], count: 0, totalValue: 0 };
  });
}

// --------------------------------------------------------------- deal editor
function openDealEditor(deal, { companies, products, onSaved }) {
  const editing = Boolean(deal && deal.id);
  const contactParam = deal && deal.contactId ? String(deal.contactId) : '';
  const values = {
    title: (deal && deal.title) || '',
    companyId: (deal && deal.companyId) || '',
    contactId: contactParam,
    productId: (deal && deal.productId) || '',
    stage: (deal && deal.stage) || 'lead',
    valueAmount: deal && deal.valueAmount !== undefined && deal.valueAmount !== null ? String(deal.valueAmount) : '',
    currency: (deal && deal.currency) || 'EUR',
    probability: deal && deal.probability !== undefined && deal.probability !== null ? String(deal.probability) : '20',
    expectedCloseDate: toDateInput(deal && deal.expectedCloseDate),
    lostReason: (deal && deal.lostReason) || '',
  };

  const companySelect = select({
    value: values.companyId,
    options: companies.map((company) => ({ value: company.id, label: company.name || company.domain || '未命名企业' })),
    placeholder: '选择企业',
  });
  if (editing) companySelect.disabled = true;
  // Keep the current company selectable even when it is outside the loaded page.
  if (deal && deal.companyId && !companies.some((company) => company.id === deal.companyId)) {
    const option = el('option', '', deal.companyName || deal.companyId);
    option.value = deal.companyId;
    companySelect.appendChild(option);
    companySelect.value = deal.companyId;
  }
  const contactSelect = select({ value: values.contactId, options: [], placeholder: '请先选择企业' });
  const productSelect = select({
    value: values.productId,
    options: products.map((product) => ({ value: product.id, label: product.name })),
    placeholder: '不关联产品',
  });
  const stageSelect = select({
    value: values.stage,
    options: STAGES.map(([value, label]) => ({ value, label })),
  });
  const titleInput = input({ value: values.title, placeholder: '例如：Muster Autoteile · 首单 500 套' });
  const amountInput = input({ value: values.valueAmount, type: 'number', placeholder: '0' });
  const currencySelect = select({
    value: values.currency,
    options: CURRENCIES.map((code) => ({ value: code, label: code })),
  });
  const probabilityInput = input({ value: values.probability, type: 'number', placeholder: '0–100' });
  const closeDateInput = input({ value: values.expectedCloseDate, type: 'date' });
  const lostReasonInput = textarea({ value: values.lostReason, rows: 2, placeholder: '输单原因（阶段为「输单」时填写）' });
  const lostField = field('丢单原因', lostReasonInput, {
    help: '阶段为「输单」时记录原因，便于复盘；阶段变更不会由 AI 自动判定。',
  });
  lostField.classList.add('span-2');
  lostField.classList.toggle('hidden', values.stage !== 'lost');

  async function loadContacts(companyId, keepValue) {
    clear(contactSelect);
    const placeholder = el('option', '', companyId ? '不指定联系人' : '请先选择企业');
    placeholder.value = '';
    contactSelect.appendChild(placeholder);
    contactSelect.value = '';
    if (!companyId) return;
    const data = await safeGet(`${API}/contacts${queryString({ companyId, pageSize: 100 })}`);
    if (disposed) return;
    const { items } = unwrapList(data);
    for (const contact of items) {
      const option = el('option', '', `${contact.fullName || contact.email || '未命名联系人'}${contact.email ? ` · ${contact.email}` : ''}`);
      option.value = contact.id;
      contactSelect.appendChild(option);
    }
    if (keepValue && items.some((contact) => contact.id === keepValue)) contactSelect.value = keepValue;
  }

  companySelect.addEventListener('change', () => {
    values.contactId = '';
    loadContacts(companySelect.value, '');
  });
  stageSelect.addEventListener('change', () => {
    lostField.classList.toggle('hidden', stageSelect.value !== 'lost');
  });

  const body = el('div', 'form-grid');
  append(body, [
    field('商机标题', titleInput, { required: true }),
    field('企业', companySelect, { required: true, help: '商机必须归属一家企业；企业可在「潜在客户」中维护。' }),
    field('联系人', contactSelect),
    field('产品', productSelect),
    field('阶段', stageSelect, {
      help: '阶段与金额由人工维护。赢单/输单需要人工确认，AI 不会自动判定成交。',
    }),
    field('金额', amountInput),
    field('币种', currencySelect),
    field('概率（%）', probabilityInput, { help: '0–100 的人工预估赢单概率，仅用于排序参考。' }),
    field('预计成交日', closeDateInput),
    lostField,
  ]);

  let saving = false;
  const dialog = showModal({
    title: editing ? '编辑商机' : '新建商机',
    body,
    size: 'lg',
    actions: [
      { label: '取消' },
      {
        label: editing ? '保存修改' : '创建商机',
        variant: 'primary',
        onClick: async (done) => {
          if (saving) return;
          const title = String(titleInput.value || '').trim();
          const companyId = companySelect.value;
          if (!title) {
            toast('商机标题不能为空', 'warning');
            titleInput.focus();
            return;
          }
          if (!companyId) {
            toast('请选择企业', 'warning');
            companySelect.focus();
            return;
          }
          const probability = Number(probabilityInput.value);
          if (probabilityInput.value !== '' && (!Number.isFinite(probability) || probability < 0 || probability > 100)) {
            toast('概率需在 0–100 之间', 'warning');
            probabilityInput.focus();
            return;
          }
          const payload = {
            title,
            stage: stageSelect.value || 'lead',
            contactId: contactSelect.value || null,
            productId: productSelect.value || null,
            valueAmount: amountInput.value === '' ? null : Number(amountInput.value),
            currency: currencySelect.value || 'EUR',
            probability: probabilityInput.value === '' ? null : Math.round(probability),
            expectedCloseDate: closeDateInput.value || null,
            lostReason: stageSelect.value === 'lost' ? String(lostReasonInput.value || '').trim() || null : null,
          };
          const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
          saving = true;
          if (saveBtn) saveBtn.disabled = true;
          try {
            if (editing) await api.patch(`${API}/deals/${encodeURIComponent(deal.id)}`, payload);
            else await api.post(`${API}/deals`, { ...payload, companyId });
            toast(editing ? '商机已更新' : '商机已创建', 'success');
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
  loadContacts(companySelect.value, values.contactId);
}

// ------------------------------------------------------------- deal drawer
function openDealDrawer(deal, { companies, products, reload }) {
  let current = deal;
  const bodyHost = el('div', 'stack');
  showDrawer({
    title: `商机详情 · ${deal.title || '未命名商机'}`,
    body: bodyHost,
    actions: [
      {
        label: '编辑',
        onClick: (done) => {
          done();
          openDealEditor(current, { companies, products, onSaved: reload });
        },
      },
      {
        label: '删除',
        variant: 'danger',
        onClick: async (done) => {
          const ok = await confirmDialog({
            title: '删除商机',
            message: `确认删除商机「${current.title || '未命名'}」？删除后不可恢复，销售活动与跟进任务会保留。`,
            confirmText: '删除商机',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.delete(`${API}/deals/${encodeURIComponent(current.id)}`);
            toast('商机已删除', 'success');
            done();
            reload();
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        },
      },
      { label: '关闭' },
    ],
  });

  async function load() {
    clear(bodyHost);
    bodyHost.appendChild(loadingBlock('正在加载商机…'));
    const data = await safeGet(`${API}/deals/${encodeURIComponent(current.id)}`);
    if (disposed) return;
    if (data && data.id) current = { ...current, ...data };
    else if (data && data.deal && data.deal.id) current = { ...current, ...data.deal };
    clear(bodyHost);
    const facts = el('div', 'page-outreach-facts');
    const contact = current.contactName || current.contactEmail || '—';
    append(facts, [
      fact('企业', current.companyName || '—'),
      fact('联系人', contact),
      fact('产品', current.productName || '—'),
      fact('阶段', stageLabel(current.stage)),
      fact('金额', moneyOf(current)),
      fact('概率', current.probability === null || current.probability === undefined ? '—' : `${current.probability}%`),
      fact('预计成交日', current.expectedCloseDate ? formatDate(current.expectedCloseDate) : '未设置'),
      fact('创建时间', formatDateTime(current.createdAt)),
      fact('更新时间', formatDateTime(current.updatedAt)),
      current.lostReason ? fact('丢单原因', current.lostReason) : null,
      current.closedAt ? fact('关闭时间', formatDateTime(current.closedAt)) : null,
    ]);
    bodyHost.appendChild(
      card({
        title: '商机信息',
        help: '阶段与金额为手工维护，AI 不自动判定成交。',
        actions: [statusBadge(current.stage, 'deal')],
        body: facts,
      }),
    );
    if (current.status && current.status !== 'open') {
      bodyHost.appendChild(
        notice(current.status === 'won' ? '该商机已标记为赢单。' : '该商机已标记为输单。', current.status === 'won' ? 'info' : 'warn'),
      );
    }
    bodyHost.appendChild(
      el('div', 'muted', '如需修改阶段、金额或预计成交日，点击下方「编辑」。'),
    );
  }

  load();
}

function fact(label, value) {
  return el('div', 'fact', [
    el('span', 'k', label),
    el('span', 'v', value === null || value === undefined || value === '' ? '—' : String(value)),
  ]);
}

// --------------------------------------------------------------------- page
export async function render(root) {
  clear(root);
  disposed = false;
  cleanup = [];

  const writable = can('deals.write');
  let companies = [];
  let products = [];
  const pipelineHost = el('div');
  const activityHost = el('div');
  const taskHost = el('div');

  function openEditor(deal) {
    openDealEditor(deal, {
      companies,
      products,
      onSaved: () => {
        loadPipeline();
        loadBottom();
      },
    });
  }

  async function loadReferences() {
    const [companyResult, productResult] = await Promise.all([
      safeGet(`${API}/companies${queryString({ pageSize: 100 })}`),
      safeGet(`${API}/products${queryString({ pageSize: 100 })}`),
    ]);
    companies = unwrapList(companyResult).items;
    products = unwrapList(productResult).items;
  }

  async function loadPipeline() {
    if (disposed) return;
    clear(pipelineHost);
    pipelineHost.appendChild(loadingBlock('正在加载销售管道…'));
    const data = await safeGet(`${API}/deals/pipeline`);
    if (disposed) return;
    clear(pipelineHost);
    if (!data) {
      pipelineHost.appendChild(
        el('div', 'page-state', [
          notice('销售管道接口暂不可用，请稍后重试（后端 /deals/pipeline 可能仍在开发中）。', 'danger'),
          button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: loadPipeline }),
        ]),
      );
      return;
    }
    const stages = normalizePipeline(data);
    const kanban = el('div', 'kanban page-outreach-kanban');
    for (const stage of stages) {
      const column = el('div', 'kanban-col');
      const head = el('div', 'kanban-col-head');
      append(head, [
        el('span', '', stage.label),
        el('span', 'count', `${stage.count} 个 · ${formatMoney(stage.totalValue, 'EUR')}`),
      ]);
      column.appendChild(head);
      const cards = el('div', 'kanban-cards');
      if (!stage.items.length) {
        cards.appendChild(el('div', 'page-outreach-kanban-empty', '暂无商机'));
      } else {
        for (const deal of stage.items) {
          cards.appendChild(dealCard(deal, stage));
        }
      }
      column.appendChild(cards);
      kanban.appendChild(column);
    }
    pipelineHost.appendChild(kanban);
  }

  function dealCard(deal, stage) {
    const node = el('div', 'kanban-card');
    node.appendChild(el('b', '', deal.title || '未命名商机'));
    node.appendChild(el('span', '', deal.companyName || '—'));
    const meta = el('span', 'page-outreach-deal-meta');
    append(meta, [
      el('span', '', deal.probability === null || deal.probability === undefined ? '概率 —' : `概率 ${deal.probability}%`),
      el('span', '', deal.expectedCloseDate ? `成交 ${formatDate(deal.expectedCloseDate)}` : '未定成交日'),
    ]);
    node.appendChild(meta);
    node.appendChild(el('span', 'amount', moneyOf(deal)));
    node.addEventListener('click', () => openDealDrawer(deal, {
      companies,
      products,
      reload: () => {
        loadPipeline();
        loadBottom();
      },
    }));
    void stage;
    return node;
  }

  async function loadBottom() {
    if (disposed) return;
    const [activityResult, taskResult] = await Promise.all([
      safeGet(`${API}/activities${queryString({ pageSize: 10 })}`),
      safeGet(`${API}/follow-up-tasks${queryString({ status: 'pending', pageSize: 10 })}`),
    ]);
    if (disposed) return;

    clear(activityHost);
    if (activityResult === null) {
      activityHost.appendChild(notice('销售活动接口暂不可用。', 'info'));
    } else {
      const activities = unwrapList(activityResult).items;
      if (!activities.length) {
        activityHost.appendChild(emptyState({ iconName: 'activity', title: '暂无销售活动', description: '发送邮件、记录电话或会议后，这里会显示最近动作。' }));
      } else {
        const list = el('div', 'page-outreach-activity-list');
        for (const activity of activities) {
          const row = el('div', 'page-outreach-activity');
          const type = ACTIVITY_TYPES[activity.type] || [activity.type || '活动', 'gray'];
          append(row, [
            badge(type[0], type[1]),
            el('div', 'page-outreach-activity-main', [
              el('b', '', activity.subject || '销售活动'),
              el('span', 'muted', `${activity.companyName || ''}${activity.contactName ? ` · ${activity.contactName}` : ''}`),
            ]),
            el('span', 'page-outreach-activity-time', relativeTime(activity.occurredAt || activity.createdAt)),
          ]);
          list.appendChild(row);
        }
        activityHost.appendChild(list);
      }
    }

    clear(taskHost);
    if (taskResult === null) {
      taskHost.appendChild(notice('跟进任务接口暂不可用。', 'info'));
    } else {
      const tasks = unwrapList(taskResult).items;
      if (!tasks.length) {
        taskHost.appendChild(emptyState({ iconName: 'checkSquare', title: '暂无待处理跟进任务', description: '客户回复后系统会生成跟进建议，也可在企业详情中手动创建。' }));
      } else {
        const list = el('div', 'page-outreach-task-list');
        for (const task of tasks) {
          const statusEntry = TASK_STATUS[task.status] || [task.status || '—', 'gray'];
          const row = el('div', 'page-outreach-task');
          const overdue = task.dueAt && new Date(task.dueAt).getTime() < Date.now();
          append(row, [
            el('div', 'page-outreach-task-main', [
              el('b', '', task.title || '跟进任务'),
              el('span', 'muted', `${task.companyName || ''}${task.contactName ? ` · ${task.contactName}` : ''}`),
            ]),
            el('div', 'page-outreach-task-meta', [
              badge(TASK_TYPES[task.type] || task.type || '跟进', 'gray'),
              badge(statusEntry[0], statusEntry[1], { dot: true }),
              el('span', overdue ? 'page-outreach-overdue' : 'muted', `截止 ${formatDate(task.dueAt)}`),
            ]),
            el('div', 'row page-row-actions', [
              button('完成', {
                size: 'sm',
                variant: 'ghost',
                iconName: 'check',
                disabled: !writable,
                onClick: () => updateTask(task, 'done', '任务已标记完成'),
              }),
              button('取消', {
                size: 'sm',
                variant: 'ghost',
                iconName: 'close',
                disabled: !writable,
                onClick: () => updateTask(task, 'cancelled', '任务已取消', true),
              }),
            ]),
          ]);
          list.appendChild(row);
        }
        taskHost.appendChild(list);
      }
    }
  }

  async function updateTask(task, status, message, confirmFirst = false) {
    if (confirmFirst) {
      const ok = await confirmDialog({
        title: '取消跟进任务',
        message: `确认取消「${task.title || '跟进任务'}」？取消后不会再提醒。`,
        confirmText: '取消任务',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.patch(`${API}/follow-up-tasks/${encodeURIComponent(task.id)}`, { status });
      toast(message, 'success');
      loadBottom();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  append(root, [
    pageHeader({
      title: meta.title,
      help: meta.help,
      actions: [
        button('刷新', {
          iconName: 'refresh',
          onClick: () => {
            loadPipeline();
            loadBottom();
          },
        }),
        button('新建商机', {
          variant: 'primary',
          iconName: 'plus',
          disabled: !writable,
          onClick: () => openEditor(null),
        }),
      ],
    }),
    toolbar(
      el('span', 'grow'),
      helpTip('看板按阶段展示全部进行中的商机。阶段定义、金额与概率均为人工维护，AI 不会自动判定成交；列头显示数量与金额合计，修改阶段请在编辑抽屉中完成。'),
    ),
    pipelineHost,
    el('div', 'grid grid-2 page-outreach-bottom', [
      card({
        title: '最近销售活动',
        help: '来自客户往来与人工记录的销售动作，用于回顾最近的推进情况。',
        actions: [helpTip('活动由系统在收发邮件、记录电话/会议时写入，原始内容保留。')],
        body: activityHost,
      }),
      card({
        title: '跟进任务',
        help: '待处理的跟进提醒。标记完成或取消都会记录操作人；接管客户时会自动取消未发送任务。',
        body: taskHost,
      }),
    ]),
  ]);

  await loadReferences();
  await Promise.all([loadPipeline(), loadBottom()]);
  void truncate;
  void formatNumber;
  void checkbox;
}
