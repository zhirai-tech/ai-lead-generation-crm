/**
 * Automation states + human takeover + suppression list (OWNER: t-front-outreach).
 *
 * This page is the operator's safety console:
 *  - takeover immediately cancels pending follow-ups and stops AI follow-up;
 *  - DO_NOT_CONTACT cannot be resumed until an owner/admin removed the
 *    suppression records (UI explains instead of offering a dead action);
 *  - every dangerous action is confirmed and the server remains the authority.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can, membership } from '../app/state.mjs';
import { formatDateTime, relativeTime } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  confirmDialog,
  dataTable,
  emptyState,
  field,
  helpTip,
  input,
  loadingBlock,
  notice,
  openModal,
  pageHeader,
  pagination,
  searchInput,
  select,
  statusBadge,
  tabs,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '自动化与接管',
  help: '查看每个客户的自动化状态并随时人工接管。接管后 AI 不再自动回复或跟进；退订与拒绝联系的优先级最高，任何发送都会被拒绝。',
};

const API = '/api/v1';
const PAGE_SIZE = 20;

const AUTOMATION_STATES = [
  ['AUTOMATION_ACTIVE', '自动运行'],
  ['NEEDS_HUMAN_REVIEW', '需人工复核'],
  ['HUMAN_TAKEOVER', '人工接管'],
  ['PAUSED', '已暂停'],
  ['DO_NOT_CONTACT', '禁止联系'],
  ['CLOSED', '已关闭'],
];

const RESUMABLE_STATES = ['HUMAN_TAKEOVER', 'PAUSED', 'NEEDS_HUMAN_REVIEW'];

const SUPPRESSION_REASONS = [
  ['unsubscribe', '客户退订'],
  ['hard_bounce', '硬退信'],
  ['complaint', '投诉'],
  ['manual', '人工添加'],
  ['do_not_contact', '拒绝联系'],
  ['gdpr_request', 'GDPR 请求'],
];

const SUPPRESSION_SCOPES = [
  ['email', '邮箱'],
  ['domain', '域名'],
];

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

let disposed = false;
const overlays = new Set();

function showModal(options) {
  const handle = openModal(options);
  if (handle.modal && handle.modal.parentElement) overlays.add(handle.modal.parentElement);
  return handle;
}

export function destroy() {
  disposed = true;
  for (const node of overlays) {
    try {
      node.remove();
    } catch {
      // ignore
    }
  }
  overlays.clear();
}

/** Ask for an audit reason; resolves `null` when cancelled. */
function promptReason({ title, label = '原因', placeholder = '', confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const control = textarea({ rows: 3, placeholder });
    const body = el('div', 'stack', [
      field(label, control, { required: true, help: '原因会写入审计记录，后续可在审计日志中追溯。' }),
    ]);
    showModal({
      title,
      body,
      size: 'sm',
      actions: [
        {
          label: '取消',
          onClick: (done) => {
            done();
            finish(null);
          },
        },
        {
          label: confirmText,
          variant: danger ? 'danger' : 'primary',
          onClick: (done) => {
            const value = String(control.value || '').trim();
            if (!value) {
              toast('请填写原因', 'warning');
              control.focus();
              return;
            }
            done();
            finish(value);
          },
        },
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => control.focus(), 40);
  });
}

// --------------------------------------------------------------------- page
export async function render(root) {
  clear(root);
  disposed = false;

  const role = membership() && membership().role ? membership().role : '';
  const isOwnerAdmin = role === 'owner' || role === 'admin';
  const canManageAutomation = can('automation.manage');
  const canWriteSuppression = can('suppression.write');

  const state = {
    tab: 'states',
    states: { page: 1, stateFilter: '' },
    suppression: { page: 1, q: '', scope: '', reason: '' },
  };

  const introHost = el('div');
  const tabsHost = el('div');
  const contentHost = el('div', 'stack');

  // ------------------------------------------------------------- intro card
  function renderIntro() {
    clear(introHost);
    const legend = el('div', 'page-outreach-auto-legend');
    for (const [value] of AUTOMATION_STATES) {
      append(legend, [statusBadge(value, 'automation')]);
    }
    introHost.appendChild(
      card({
        title: '人工接管与安全规则',
        help: '接管会立即取消该客户未发送的跟进任务与后台任务，并阻止 AI 自动回复与跟进。退订、拒绝联系（DO_NOT_CONTACT）优先级最高：命中抑制名单时任何发送都会被服务端拒绝；禁止联系状态需要管理员/拥有者先删除抑制记录才能恢复自动化。',
        body: legend,
      }),
    );
  }

  // ---------------------------------------------------------------- tabs
  function renderTabs() {
    clear(tabsHost);
    tabsHost.appendChild(
      tabs({
        items: [
          { key: 'states', label: '客户自动化状态' },
          { key: 'suppression', label: '抑制名单' },
        ],
        active: state.tab,
        onChange: (key) => {
          state.tab = key;
          renderTabs();
          renderTab();
        },
      }),
    );
  }

  function renderTab() {
    clear(contentHost);
    if (state.tab === 'suppression') renderSuppression();
    else renderStates();
  }

  // -------------------------------------------------------------- states tab
  async function renderStates() {
    const filters = state.states;
    const host = el('div', 'stack');
    const tableHost = el('div');
    const pagerHost = el('div', 'page-outreach-pager');

    const stateSelect = select({
      value: filters.stateFilter,
      options: AUTOMATION_STATES.map(([value, label]) => ({ value, label })),
      placeholder: '全部状态',
      className: 'select filter-select',
      onChange: (value) => {
        filters.stateFilter = value;
        filters.page = 1;
        loadStates();
      },
    });

    append(host, [
      toolbar(
        stateSelect,
        el('span', 'grow'),
        helpTip('状态由系统与人工操作共同维护。接管、禁止联系、关闭都会取消该客户尚未发送的跟进任务。'),
      ),
      tableHost,
      pagerHost,
    ]);
    contentHost.appendChild(host);
    await loadStates();

    async function loadStates() {
      if (disposed) return;
      clear(tableHost);
      tableHost.appendChild(dataTable({ columns: columns(), rows: [], loading: true }));
      try {
        const data = await api.get(
          `${API}/automation/states${queryString({
            page: filters.page,
            pageSize: PAGE_SIZE,
            state: filters.stateFilter,
          })}`,
        );
        if (disposed) return;
        const { items, total } = unwrapList(data);
        const serverPage = Number(data && data.page);
        if (Number.isFinite(serverPage) && serverPage > 0) filters.page = serverPage;
        clear(tableHost);
        tableHost.appendChild(
          dataTable({
            columns: columns(),
            rows: items,
            empty: emptyState({
              iconName: filters.stateFilter ? 'search' : 'shield',
              title: filters.stateFilter ? '该状态下暂无客户' : '暂无自动化状态记录',
              description: filters.stateFilter
                ? '尝试切换其它状态筛选。'
                : '客户加入活动或被 AI 处理后会生成自动化状态；也可以在企业详情中人工接管。',
              action: button('查看潜在客户', { variant: 'primary', size: 'sm', iconName: 'building', onClick: () => navigate('/companies') }),
            }),
          }),
        );
        clear(pagerHost);
        if (total > 0) {
          pagerHost.appendChild(
            pagination({
              page: filters.page,
              pageSize: PAGE_SIZE,
              total,
              onChange: (nextPage) => {
                filters.page = Math.max(1, Number(nextPage) || 1);
                loadStates();
              },
            }),
          );
        }
      } catch (error) {
        if (disposed) return;
        clear(tableHost);
        tableHost.appendChild(
          el('div', 'page-state', [
            notice(`自动化状态加载失败：${errorMessage(error)}`, 'danger'),
            button('重试', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: loadStates }),
          ]),
        );
        clear(pagerHost);
      }
    }

    function columns() {
      return [
        {
          key: 'companyName',
          label: '企业',
          render: (row) => {
            const wrap = el('div', '');
            append(wrap, [el('div', 'cell-main', row.companyName || row.companyId || '未知企业')]);
            if (row.suppressed) append(wrap, [el('div', 'cell-sub', '命中抑制名单')]);
            return wrap;
          },
        },
        { key: 'state', label: '状态', render: (row) => statusBadge(row.state, 'automation') },
        { key: 'reason', label: '原因', render: (row) => el('span', 'muted', row.reason || '—') },
        {
          key: 'changedAt',
          label: '更新时间',
          render: (row) => el('span', 'muted', relativeTime(row.changedAt || row.updatedAt)),
        },
        {
          key: 'actions',
          label: '操作',
          className: 'cell-actions',
          render: (row) => actionButtons(row),
        },
      ];
    }

    function actionButtons(row) {
      const wrap = el('div', 'row page-row-actions');
      const stateValue = row.state || 'AUTOMATION_ACTIVE';
      const locked = stateValue === 'DO_NOT_CONTACT';
      const closed = stateValue === 'CLOSED';
      const canTakeover = !locked && !closed;
      const canResume = RESUMABLE_STATES.includes(stateValue);
      const canPause = !locked && !closed && stateValue !== 'PAUSED';
      const canDnc = !locked && !closed;
      const canClose = !locked && !closed;

      if (stateValue !== 'HUMAN_TAKEOVER') {
        append(wrap, [
          button('接管', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'lock',
            disabled: !canManageAutomation || !canTakeover,
            title: canTakeover ? '人工接管：AI 停止自动回复与跟进' : '禁止联系/已关闭状态不能接管',
            onClick: () => confirmAction(row, 'takeover', {
              title: '人工接管客户',
              message: `接管「${row.companyName || '该客户'}」后，AI 会立即停止自动回复与自动跟进，并取消未发送的跟进任务。确认接管？`,
              confirmText: '确认接管',
              danger: true,
            }),
          }),
        ]);
      }

      if (stateValue === 'DO_NOT_CONTACT') {
        append(wrap, [
          button('恢复', { size: 'sm', variant: 'ghost', iconName: 'play', disabled: true, title: '禁止联系状态需先删除抑制记录' }),
          helpTip('「禁止联系」需要管理员/拥有者先在「抑制名单」中删除对应记录，才能恢复自动化。'),
        ]);
      } else {
        append(wrap, [
          button('恢复', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'play',
            disabled: !canManageAutomation || !canResume,
            title: closed ? '已关闭不可恢复' : canResume ? '恢复 AI 自动化' : '仅人工接管/暂停/需复核状态可恢复',
            onClick: () => confirmAction(row, 'resume', {
              title: '恢复自动化',
              message: `恢复「${row.companyName || '该客户'}」的自动化？AI 会重新按规则自动回复与跟进。`,
              confirmText: '确认恢复',
            }),
          }),
        ]);
      }

      append(wrap, [
        button('暂停', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'pause',
          disabled: !canManageAutomation || !canPause,
          title: canPause ? '暂停自动化（不接管对话）' : '当前状态不能暂停',
          onClick: () => confirmAction(row, 'pause', {
            title: '暂停自动化',
            message: `暂停「${row.companyName || '该客户'}」的自动化？AI 将停止自动回复与跟进，直到恢复。`,
            confirmText: '确认暂停',
          }),
        }),
        button('禁止联系', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'shield',
          disabled: !canManageAutomation || !canDnc,
          title: canDnc ? '加入抑制名单并置为禁止联系' : '当前状态不能标记禁止联系',
          onClick: () => doNotContact(row),
        }),
        button('关闭', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'archive',
          disabled: !canManageAutomation || !canClose,
          title: canClose ? '关闭该客户的自动化（终态）' : '禁止联系状态需先删除抑制记录',
          onClick: () => confirmAction(row, 'close', {
            title: '关闭客户自动化',
            message: `关闭「${row.companyName || '该客户'}」？关闭为终态，之后不再自动跟进。`,
            confirmText: '确认关闭',
            danger: true,
          }),
        }),
      ]);
      return wrap;
    }

    async function confirmAction(row, action, options) {
      const ok = await confirmDialog(options);
      if (!ok) return;
      const reason = await promptReason({
        title: options.title,
        label: '操作原因',
        placeholder: '例如：客户要求直接沟通 / 人工跟进中 / 数据质量问题',
        confirmText: options.confirmText,
        danger: Boolean(options.danger),
      });
      if (reason === null) return;
      await callAction(row, action, reason);
    }

    async function doNotContact(row) {
      const ok = await confirmDialog({
        title: '标记为禁止联系',
        message: `将「${row.companyName || '该客户'}」标记为禁止联系？系统会写入抑制名单（域名与全部联系人邮箱），停止所有自动发送，且需要管理员删除抑制记录后才能恢复。`,
        confirmText: '标记禁止联系',
        danger: true,
      });
      if (!ok) return;
      const reason = await promptReason({
        title: '禁止联系原因',
        label: '原因',
        placeholder: '例如：客户明确拒绝 / 投诉 / GDPR 请求',
        confirmText: '确认标记',
        danger: true,
      });
      if (reason === null) return;
      await callAction(row, 'do-not-contact', reason);
    }

    async function callAction(row, action, reason) {
      const companyId = row.companyId || row.id;
      try {
        const result = await api.post(`${API}/automation/${encodeURIComponent(companyId)}/${action}`, { reason });
        const cancelledTasks = Number(result && result.cancelledTasks);
        const cancelledJobs = Number(result && result.cancelledJobs);
        const extra = [];
        if (Number.isFinite(cancelledTasks) && cancelledTasks > 0) extra.push(`取消 ${cancelledTasks} 个跟进任务`);
        if (Number.isFinite(cancelledJobs) && cancelledJobs > 0) extra.push(`取消 ${cancelledJobs} 个后台任务`);
        toast(`操作成功${extra.length ? `：${extra.join('，')}` : ''}`, 'success');
        loadStates();
        renderIntro();
      } catch (error) {
        if (error && error.code === 'DO_NOT_CONTACT_LOCKED') {
          showModal({
            title: '需要先删除抑制记录',
            size: 'sm',
            body: el('div', 'stack', [
              notice(errorMessage(error), 'danger'),
              el('div', 'muted', '请到「抑制名单」删除该客户的邮箱/域名记录；只有管理员或拥有者可以删除，删除后即可恢复自动化。'),
              button('前往抑制名单', {
                variant: 'primary',
                size: 'sm',
                iconName: 'shield',
                onClick: () => {
                  state.tab = 'suppression';
                  renderTabs();
                  renderTab();
                },
              }),
            ]),
            actions: [{ label: '知道了' }],
          });
        } else {
          toast(errorMessage(error), 'error');
        }
      }
    }
  }

  // --------------------------------------------------------- suppression tab
  function renderSuppression() {
    const filters = state.suppression;
    let searchTimer = null;
    const host = el('div', 'stack');
    const tableHost = el('div');
    const pagerHost = el('div', 'page-outreach-pager');

    const searchNode = searchInput({
      placeholder: '搜索邮箱 / 域名…',
      value: filters.q,
      onInput: (value) => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          filters.q = String(value || '').trim();
          filters.page = 1;
          loadSuppression();
        }, 300);
      },
    });
    const scopeSelect = select({
      value: filters.scope,
      options: SUPPRESSION_SCOPES.map(([value, label]) => ({ value, label })),
      placeholder: '全部范围',
      className: 'select filter-select',
      onChange: (value) => {
        filters.scope = value;
        filters.page = 1;
        loadSuppression();
      },
    });
    const reasonSelect = select({
      value: filters.reason,
      options: SUPPRESSION_REASONS.map(([value, label]) => ({ value, label })),
      placeholder: '全部原因',
      className: 'select filter-select',
      onChange: (value) => {
        filters.reason = value;
        filters.page = 1;
        loadSuppression();
      },
    });

    append(host, [
      toolbar(
        searchNode,
        scopeSelect,
        reasonSelect,
        el('span', 'grow'),
        button('前往导入', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'upload',
          onClick: () => navigate('/settings'),
        }),
        button('新增记录', {
          size: 'sm',
          variant: 'primary',
          iconName: 'plus',
          disabled: !canWriteSuppression,
          onClick: openSuppressionForm,
        }),
        helpTip('批量导入请在「设置 → 导入」中选择抑制名单类型；抑制名单命中邮箱或域名时，任何发送都会被服务端拒绝。'),
      ),
      tableHost,
      pagerHost,
    ]);
    contentHost.appendChild(host);
    loadSuppression();

    function baseColumns() {
      return [
        {
          key: 'scope',
          label: '范围',
          render: (row) => badge(row.scope === 'domain' ? '域名' : '邮箱', row.scope === 'domain' ? 'purple' : 'cyan'),
        },
        {
          key: 'valueNormalized',
          label: '值',
          render: (row) => el('span', 'cell-main', row.valueNormalized || row.value || '—'),
        },
        { key: 'reason', label: '原因', render: (row) => statusBadge(row.reason, 'suppression') },
        { key: 'source', label: '来源', render: (row) => el('span', 'muted', row.source || '—') },
        {
          key: 'note',
          label: '备注',
          render: (row) => el('span', 'muted', row.note ? String(row.note).slice(0, 60) : '—'),
        },
        {
          key: 'createdAt',
          label: '时间',
          render: (row) => el('span', 'muted', formatDateTime(row.createdAt)),
        },
      ];
    }

    function columns() {
      const list = baseColumns();
      if (isOwnerAdmin) {
        list.push({
          key: 'actions',
          label: '操作',
          className: 'cell-actions',
          render: (row) => {
            const wrap = el('div', 'row page-row-actions');
            append(wrap, [
              button('删除', {
                size: 'sm',
                variant: 'ghost',
                iconName: 'trash',
                disabled: !canWriteSuppression,
                onClick: () => removeSuppression(row),
              }),
            ]);
            return wrap;
          },
        });
      }
      return list;
    }

    async function loadSuppression() {
      if (disposed) return;
      clear(tableHost);
      tableHost.appendChild(dataTable({ columns: columns(), rows: [], loading: true }));
      try {
        const data = await api.get(
          `${API}/suppression${queryString({
            page: filters.page,
            pageSize: PAGE_SIZE,
            scope: filters.scope,
            reason: filters.reason,
            search: filters.q,
          })}`,
        );
        if (disposed) return;
        const { items, total } = unwrapList(data);
        const serverPage = Number(data && data.page);
        if (Number.isFinite(serverPage) && serverPage > 0) filters.page = serverPage;
        clear(tableHost);
        tableHost.appendChild(
          dataTable({
            columns: columns(),
            rows: items,
            empty: emptyState({
              iconName: filters.q || filters.scope || filters.reason ? 'search' : 'shield',
              title: filters.q || filters.scope || filters.reason ? '没有匹配的抑制记录' : '抑制名单为空',
              description:
                filters.q || filters.scope || filters.reason
                  ? '尝试调整搜索或筛选条件。'
                  : '客户退订、硬退信、投诉或人工拒绝联系时会自动写入。命中后任何发送都会被拒绝。',
              action: canWriteSuppression
                ? button('新增记录', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: openSuppressionForm })
                : null,
            }),
          }),
        );
        clear(pagerHost);
        if (total > 0) {
          pagerHost.appendChild(
            pagination({
              page: filters.page,
              pageSize: PAGE_SIZE,
              total,
              onChange: (nextPage) => {
                filters.page = Math.max(1, Number(nextPage) || 1);
                loadSuppression();
              },
            }),
          );
        }
      } catch (error) {
        if (disposed) return;
        clear(tableHost);
        tableHost.appendChild(
          el('div', 'page-state', [
            notice(`抑制名单加载失败：${errorMessage(error)}`, 'danger'),
            button('重试', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: loadSuppression }),
          ]),
        );
        clear(pagerHost);
      }
    }

    function openSuppressionForm() {
      const scopeSelect = select({
        value: 'email',
        options: SUPPRESSION_SCOPES.map(([value, label]) => ({ value, label })),
      });
      const valueInput = input({ placeholder: '邮箱地址或域名，例如 buyer@example.com / example.com' });
      const reasonSelect = select({
        value: 'manual',
        options: SUPPRESSION_REASONS.map(([value, label]) => ({ value, label })),
      });
      const noteInput = input({ placeholder: '备注（可选，会写入抑制记录与审计）' });
      const body = el('div', 'stack', [
        notice('加入抑制名单后，该邮箱或域名的任何发送都会被服务端拒绝。请确认这是客户明确意愿或合规要求。', 'warn'),
        el('div', 'form-grid', [
          field('范围', scopeSelect, { required: true }),
          field('原因', reasonSelect, { required: true }),
          field('值', valueInput, { required: true, help: '邮箱会做标准化；域名只写主域，不含协议与路径。' }),
          field('备注', noteInput),
        ]),
      ]);
      let saving = false;
      const dialog = showModal({
        title: '新增抑制记录',
        body,
        actions: [
          { label: '取消' },
          {
            label: '添加',
            variant: 'primary',
            onClick: async (done) => {
              if (saving) return;
              const value = String(valueInput.value || '').trim();
              if (!value) {
                toast('请填写邮箱或域名', 'warning');
                valueInput.focus();
                return;
              }
              const scope = scopeSelect.value;
              if (scope === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                toast('邮箱格式不正确', 'warning');
                valueInput.focus();
                return;
              }
              if (scope === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))) {
                toast('域名格式不正确', 'warning');
                valueInput.focus();
                return;
              }
              const ok = await confirmDialog({
                title: '确认加入抑制名单',
                message: `确认将 ${scope === 'email' ? '邮箱' : '域名'}「${value}」加入抑制名单？加入后所有发送都会被拒绝。`,
                confirmText: '确认加入',
                danger: true,
              });
              if (!ok) return;
              const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
              saving = true;
              if (saveBtn) saveBtn.disabled = true;
              try {
                const result = await api.post(`${API}/suppression`, {
                  scope,
                  value,
                  reason: reasonSelect.value,
                  note: String(noteInput.value || '').trim() || null,
                });
                if (result && result.created === false) toast('该记录已存在，未重复添加', 'info');
                else toast('已加入抑制名单', 'success');
                done();
                loadSuppression();
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
      setTimeout(() => valueInput.focus(), 40);
    }

    async function removeSuppression(row) {
      const ok = await confirmDialog({
        title: '删除抑制记录',
        message: `确认删除「${row.valueNormalized || row.value || ''}」的抑制记录？删除后该邮箱/域名可能重新收到自动发送，请确认已完成合规确认。`,
        confirmText: '删除记录',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.delete(`${API}/suppression/${encodeURIComponent(row.id)}`);
        toast('抑制记录已删除', 'success');
        loadSuppression();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
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
            renderIntro();
            renderTab();
          },
        }),
        button('去统一收件箱', { iconName: 'inbox', onClick: () => navigate('/inbox') }),
      ],
    }),
    introHost,
    tabsHost,
    contentHost,
  ]);

  renderIntro();
  renderTabs();
  renderTab();
  void card;
  void input;
}
