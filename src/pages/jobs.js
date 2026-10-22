/**
 * Job queue: live stats, filters, pagination, detail drawer, cancel/retry and
 * the workspace-wide pause switch. All job execution happens on the server;
 * this page only observes and requests state changes.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { formatDateTime, formatNumber, relativeTime, truncate } from '../utils/format.mjs';
import {
  button,
  checkbox,
  confirmDialog,
  dataTable,
  detailRows,
  emptyState,
  loadingBlock,
  notice,
  openDrawer,
  pageHeader,
  pagination,
  sectionTitle,
  select,
  statCard,
  statusBadge,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '任务队列',
  help: '后台任务负责发现、抓取、补全、发送与同步。任务按 dedupeKey 幂等入队，失败会按指数退避重试；发送任务还受审批、抑制名单与人工接管限制。',
};

const JOB_TYPE_LABELS = {
  'discovery.search': '企业发现',
  'company.crawl': '官网抓取',
  'company.enrich': '企业补全',
  'contact.verify': '邮箱验证',
  'lead.score': '线索评分',
  'draft.generate': '草稿生成',
  'email.send': '邮件发送',
  'email.sync': '邮箱同步',
  'reply.classify': '回复分类',
  'followup.plan': '跟进规划',
  'campaign.tick': '活动推进',
  'maintenance.retention': '数据清理',
};

const JOB_TYPES = Object.keys(JOB_TYPE_LABELS);

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'dead', label: '已终止' },
];

const TYPE_OPTIONS = [{ value: '', label: '全部类型' }, ...JOB_TYPES.map((type) => ({ value: type, label: `${JOB_TYPE_LABELS[type]} · ${type}` }))];

const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'dead'];

let viewState = { page: 1, pageSize: 25, status: '', type: '', auto: false };
let autoTimer = null;

export async function render(root) {
  clear(root);
  stopAutoTimer();

  const canManage = can('jobs.manage');
  let stats = zeroStats();

  const statsHost = el('div', 'stack');
  const statGrid = el('div', 'stat-grid');
  const pauseNoticeHost = el('div', '');
  const pauseSlot = el('div', 'row');
  const tableHost = el('div', '');
  const paginationHost = el('div', '');
  const updatedText = el('span', 'muted page-updated');

  const autoBox = checkbox({
    checked: viewState.auto,
    label: '自动刷新 (10s)',
    onChange: (checked) => {
      viewState.auto = checked;
      if (checked) startAutoTimer();
      else stopAutoTimer();
      toast(checked ? '已开启自动刷新（10 秒）' : '已关闭自动刷新', 'info', 1600);
    },
  });

  const statusSelect = select({
    value: viewState.status,
    options: STATUS_OPTIONS,
    className: 'select filter-select',
    onChange: (value) => {
      viewState.status = value;
      viewState.page = 1;
      loadJobs();
    },
  });

  const typeSelect = select({
    value: viewState.type,
    options: TYPE_OPTIONS,
    className: 'select filter-select page-type-select',
    onChange: (value) => {
      viewState.type = value;
      viewState.page = 1;
      loadJobs();
    },
  });

  append(root, [
    pageHeader({
      title: '任务队列',
      help: meta.help,
      actions: [
        autoBox,
        pauseSlot,
        button('刷新', {
          iconName: 'refresh',
          onClick: () => loadAll(),
        }),
      ],
    }),
    pauseNoticeHost,
    statsHost,
    toolbar(
      statusSelect,
      typeSelect,
      button('刷新列表', { variant: 'ghost', size: 'sm', iconName: 'refresh', onClick: () => loadJobs() }),
      el('span', 'grow'),
      updatedText,
    ),
    tableHost,
    paginationHost,
  ]);

  statsHost.appendChild(statGrid);
  renderStatsSkeleton();
  tableHost.appendChild(loadingBlock('正在加载任务…'));

  function renderStatsSkeleton() {
    clear(statGrid);
    for (let index = 0; index < 4; index += 1) {
      const cell = el('div', 'stat');
      cell.appendChild(el('div', 'skeleton skeleton-line'));
      statGrid.appendChild(cell);
    }
  }

  function renderStats() {
    clear(statGrid);
    statGrid.appendChild(
      statCard({
        label: '排队中',
        value: formatNumber(stats.queued),
        hint: stats.oldestQueuedAt ? `最早计划 ${formatDateTime(stats.oldestQueuedAt)}` : '等待 Worker 领取',
        iconName: 'clock',
        help: '尚未被 Worker 领取的任务。暂停全局队列时任务会保持排队状态。',
      }),
    );
    statGrid.appendChild(
      statCard({
        label: '执行中',
        value: formatNumber(stats.running),
        hint: 'Worker 正在处理',
        iconName: 'play',
        help: '已领取并正在执行的任务。运行中的任务取消会记录取消意图，在检查点停止。',
      }),
    );
    statGrid.appendChild(
      statCard({
        label: '失败',
        value: formatNumber(stats.failed),
        hint: `近 24 小时失败 ${formatNumber(stats.last24h.failed)}${stats.dead ? ` · 已终止 ${formatNumber(stats.dead)}` : ''}`,
        iconName: 'alert',
        help: '最近一次执行失败的任务。达到最大尝试次数后会变为「已终止」，需人工重试或修复配置。',
      }),
    );
    statGrid.appendChild(
      statCard({
        label: '成功',
        value: formatNumber(stats.succeeded),
        hint: `近 24 小时成功 ${formatNumber(stats.last24h.succeeded)}`,
        iconName: 'check',
        tone: 'green',
        help: '已完成执行的任务数量，用于判断后台管线是否健康。',
      }),
    );
  }

  function createPauseButton() {
    const paused = stats.paused;
    return button(paused ? '恢复队列' : '全局暂停', {
      variant: paused ? 'primary' : 'outline',
      iconName: paused ? 'play' : 'pause',
      disabled: !canManage,
      title: canManage ? (paused ? '恢复所有工作空间的排队任务' : '暂停所有工作空间的后台任务') : '需要 jobs.manage 权限',
      onClick: () => togglePause(),
    });
  }

  function renderPauseState() {
    clear(pauseSlot);
    pauseSlot.appendChild(createPauseButton());
    clear(pauseNoticeHost);
    if (stats.paused) {
      pauseNoticeHost.appendChild(
        notice('任务队列当前处于全局暂停状态：排队中的任务不会执行，恢复后继续。发送类任务同样停止。', 'warn'),
      );
    }
  }

  function renderStatsError(error) {
    clear(statGrid);
    statsHost.appendChild(notice(`任务统计加载失败：${error?.message || '未知错误'}`, 'danger'));
  }

  function setUpdated() {
    updatedText.textContent = `更新于 ${formatDateTime(new Date().toISOString())}`;
  }

  function jsonBlock(value, { tall = false } = {}) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const pre = el('pre', `page-json${tall ? ' tall' : ''}`);
    pre.textContent = raw === undefined || raw === null ? '—' : truncate(String(raw), 16000);
    return pre;
  }

  function durationText(row) {
    const start = row.startedAt ? new Date(row.startedAt).getTime() : null;
    const end = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
    if (start && end && end >= start) return formatDuration(end - start);
    if (start && row.status === 'running') return formatDuration(Date.now() - start);
    return '—';
  }

  function typeCell(row) {
    const wrap = el('div');
    append(wrap, [
      el('div', 'cell-main', JOB_TYPE_LABELS[row.type] || row.type || '—'),
      el('div', 'cell-sub mono', row.type || ''),
    ]);
    return wrap;
  }

  function statusCell(row) {
    return statusBadge(row.status || 'unknown', 'job');
  }

  function actionCell(row) {
    const wrap = el('div', 'row page-row-actions');
    wrap.appendChild(
      button('查看', {
        variant: 'ghost',
        size: 'sm',
        iconName: 'eye',
        onClick: () => openJobDrawer(row),
      }),
    );
    if (canManage && ['queued', 'running'].includes(row.status)) {
      wrap.appendChild(
        button('取消', {
          variant: 'ghost',
          size: 'sm',
          iconName: 'close',
          onClick: () => requestCancel(row),
        }),
      );
    }
    if (canManage && TERMINAL_STATUSES.includes(row.status)) {
      wrap.appendChild(
        button('重试', {
          variant: 'ghost',
          size: 'sm',
          iconName: 'refresh',
          onClick: () => requestRetry(row),
        }),
      );
    }
    return wrap;
  }

  function jobColumns() {
    return [
      {
        key: 'createdAt',
        label: '创建时间',
        render: (row) => {
          const wrap = el('div');
          append(wrap, [
            el('div', 'cell-main nowrap', formatDateTime(row.createdAt)),
            el('div', 'cell-sub', relativeTime(row.createdAt)),
          ]);
          return wrap;
        },
      },
      { key: 'type', label: '类型', render: typeCell },
      { key: 'status', label: '状态', render: statusCell },
      {
        key: 'attempts',
        label: '尝试',
        align: 'right',
        render: (row) => `${formatNumber(row.attempts)} / ${formatNumber(row.maxAttempts)}`,
      },
      {
        key: 'runAt',
        label: '计划时间',
        render: (row) => el('span', 'muted nowrap', formatDateTime(row.runAt)),
      },
      {
        key: 'startedAt',
        label: '开始',
        render: (row) => el('span', 'muted nowrap', formatDateTime(row.startedAt)),
      },
      {
        key: 'finishedAt',
        label: '结束',
        render: (row) => el('span', 'muted nowrap', formatDateTime(row.finishedAt)),
      },
      { key: 'duration', label: '耗时', align: 'right', render: (row) => durationText(row) },
      {
        key: 'lastError',
        label: '错误摘要',
        render: (row) => {
          if (!row.lastError) return el('span', 'muted', '—');
          const node = el('span', 'page-error-text', truncate(row.lastError, 70));
          node.title = row.lastError;
          return node;
        },
      },
      { key: 'actions', label: '操作', className: 'cell-actions', render: actionCell },
    ];
  }

  function renderJobs(items, total) {
    clear(tableHost);
    tableHost.appendChild(
      dataTable({
        columns: jobColumns(),
        rows: items,
        onRowClick: (row) => openJobDrawer(row),
        empty: emptyState({
          iconName: 'activity',
          title: '还没有后台任务',
          description: '触发企业发现、抓取、补全或发送等操作后，任务会出现在这里。',
          action: button('去企业发现', {
            variant: 'primary',
            size: 'sm',
            iconName: 'compass',
            onClick: () => navigate('/discovery'),
          }),
        }),
      }),
    );
    clear(paginationHost);
    if (total > 0) {
      paginationHost.appendChild(
        pagination({
          page: viewState.page,
          pageSize: viewState.pageSize,
          total,
          label: '个任务',
          onChange: (nextPage) => {
            viewState.page = Math.max(1, nextPage);
            loadJobs();
          },
        }),
      );
    }
  }

  function renderJobsError(error) {
    clear(tableHost);
    clear(paginationHost);
    tableHost.appendChild(
      el('div', 'card', [
        el('div', 'card-body stack', [
          notice(`任务列表加载失败：${error?.message || '未知错误'}`, 'danger'),
          el('div', 'row', [button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => loadJobs() })]),
        ]),
      ]),
    );
  }

  async function loadJobs({ silent = false } = {}) {
    if (!silent) {
      clear(tableHost);
      tableHost.appendChild(loadingBlock('正在加载任务…'));
    }
    try {
      const data = await api.get(
        `/api/v1/jobs${queryString({
          page: viewState.page,
          pageSize: viewState.pageSize,
          status: viewState.status,
          type: viewState.type,
        })}`,
      );
      const items = (Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.jobs)
            ? data.jobs
            : []).map(normalizeJob);
      const total = Number(data?.total ?? items.length) || 0;
      renderJobs(items, total);
      setUpdated();
    } catch (error) {
      if (!silent) {
        renderJobsError(error);
        updatedText.textContent = '更新失败';
      }
    }
  }

  async function loadStats({ silent = false } = {}) {
    if (!silent) renderStatsSkeleton();
    try {
      const raw = await api.get('/api/v1/jobs/stats');
      stats = normalizeStats(raw);
      clear(statGrid);
      renderStats();
      renderPauseState();
    } catch (error) {
      if (!silent) renderStatsError(error);
      // Fallback: some backends expose the pause switch through settings.
      try {
        const settings = await api.get('/api/v1/settings');
        const paused =
          settings?.settings?.jobs?.globalPaused ??
          settings?.jobs?.globalPaused ??
          settings?.settings?.jobsPaused ??
          settings?.jobsPaused;
        if (typeof paused === 'boolean' && paused !== stats.paused) {
          stats.paused = paused;
          renderPauseState();
        }
      } catch {
        // Stats stay unknown; the pause button remains usable.
      }
    }
  }

  async function loadAll({ silent = false } = {}) {
    await Promise.all([loadStats({ silent }), loadJobs({ silent })]);
  }

  async function togglePause() {
    if (!canManage) return;
    const target = !stats.paused;
    const confirmed = await confirmDialog({
      title: target ? '暂停所有后台任务' : '恢复后台任务',
      message: target
        ? '暂停后所有工作空间的排队任务将停止领取，发送与同步也会停止，直到恢复。确认暂停？'
        : '恢复后排队中的任务会继续执行，发送仍受审批、抑制名单与发送窗口限制。确认恢复？',
      confirmText: target ? '暂停队列' : '恢复队列',
      danger: target,
    });
    if (!confirmed) return;
    const buttonNode = pauseSlot.querySelector('button');
    if (buttonNode) buttonNode.disabled = true;
    try {
      await api.post(`/api/v1/jobs/${target ? 'pause' : 'resume'}`, {});
      toast(target ? '任务队列已全局暂停' : '任务队列已恢复', 'success');
      await loadAll({ silent: true });
    } catch (error) {
      toast(error?.message || '操作失败', 'error');
      if (buttonNode) buttonNode.disabled = !canManage;
    }
  }

  async function requestCancel(row) {
    const confirmed = await confirmDialog({
      title: '取消任务',
      message: `将取消任务「${JOB_TYPE_LABELS[row.type] || row.type}」（${row.id}）。排队中的任务立即取消；运行中的任务会记录取消意图，在当前检查点后停止。`,
      confirmText: '取消任务',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post(`/api/v1/jobs/${encodeURIComponent(row.id)}/cancel`, {});
      toast('已提交取消请求', 'success');
      await loadAll({ silent: true });
    } catch (error) {
      toast(error?.message || '取消失败', 'error');
    }
  }

  async function requestRetry(row) {
    const confirmed = await confirmDialog({
      title: '重试任务',
      message: `任务「${JOB_TYPE_LABELS[row.type] || row.type}」（${row.id}）会重新排队并在后台执行，尝试次数将重置。`,
      confirmText: '重新排队',
    });
    if (!confirmed) return;
    try {
      await api.post(`/api/v1/jobs/${encodeURIComponent(row.id)}/retry`, {});
      toast('任务已重新排队', 'success');
      await loadAll({ silent: true });
    } catch (error) {
      toast(error?.message || '重试失败', 'error');
    }
  }

  function openJobDrawer(row) {
    const body = el('div', 'stack');
    body.appendChild(loadingBlock('正在加载任务详情…'));
    openDrawer({ title: '任务详情', body });
    (async () => {
      let detail = row;
      let loadError = null;
      try {
        const payload = await api.get(`/api/v1/jobs/${encodeURIComponent(row.id)}`);
        detail = payload?.job || payload || row;
      } catch (error) {
        loadError = error;
        detail = row;
      }
      clear(body);
      if (loadError) body.appendChild(notice(`任务详情加载失败，展示列表中的缓存数据：${loadError.message}`, 'warn'));

      const facts = detailRows([
        { label: '任务 ID', value: el('span', 'mono', detail.id || '—') },
        { label: '类型', value: `${JOB_TYPE_LABELS[detail.type] || detail.type || '—'}（${detail.type || '—'}）` },
        { label: '状态', value: statusBadge(detail.status || 'unknown', 'job') },
        { label: '尝试次数', value: `${formatNumber(detail.attempts)} / ${formatNumber(detail.maxAttempts)}` },
        { label: '优先级', value: formatNumber(detail.priority ?? 100) },
        { label: '计划时间', value: formatDateTime(detail.runAt) },
        { label: '开始时间', value: formatDateTime(detail.startedAt) },
        { label: '结束时间', value: formatDateTime(detail.finishedAt) },
        { label: '耗时', value: durationText(detail) },
        { label: 'Worker', value: detail.workerId || '—' },
        { label: 'dedupeKey', value: detail.dedupeKey ? el('span', 'mono page-break', detail.dedupeKey) : '—' },
      ]);
      body.appendChild(facts);

      body.appendChild(sectionTitle('审计信息'));
      body.appendChild(
        detailRows([
          { label: '创建人', value: detail.createdBy || '—' },
          { label: '创建时间', value: formatDateTime(detail.createdAt) },
          { label: '更新时间', value: formatDateTime(detail.updatedAt) },
          { label: '租约到期', value: fmtMaybeDate(detail.leaseUntil) },
          { label: '请求 ID', value: detail.requestId ? el('span', 'mono page-break', detail.requestId) : '—' },
        ]),
      );

      if (detail.lastError) body.appendChild(notice(detail.lastError, 'danger'));
      if (detail.result && detail.result.cancelRequested) {
        body.appendChild(notice('已记录取消意图，Worker 将在当前步骤结束后停止该任务。', 'warn'));
      }

      body.appendChild(sectionTitle('Payload'));
      body.appendChild(jsonBlock(detail.payload));
      body.appendChild(sectionTitle('执行结果'));
      body.appendChild(jsonBlock(detail.result));
      if (detail.audit) {
        body.appendChild(sectionTitle('审计附加数据'));
        body.appendChild(jsonBlock(detail.audit));
      }

      if (canManage && ['queued', 'running'].includes(detail.status)) {
        body.appendChild(
          el('div', 'row', [
            button('取消任务', {
              variant: 'danger',
              size: 'sm',
              iconName: 'close',
              onClick: () => requestCancel(detail),
            }),
          ]),
        );
      } else if (canManage && TERMINAL_STATUSES.includes(detail.status)) {
        body.appendChild(
          el('div', 'row', [
            button('重试任务', {
              variant: 'primary',
              size: 'sm',
              iconName: 'refresh',
              onClick: () => requestRetry(detail),
            }),
          ]),
        );
      }
    })();
  }

  function startAutoTimer() {
    stopAutoTimer();
    autoTimer = setInterval(() => {
      if (document.hidden) return;
      loadAll({ silent: true });
    }, 10_000);
  }

  function stopAutoTimer() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  renderPauseState();
  if (viewState.auto) startAutoTimer();
  await loadAll();
}

export function destroy() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  viewState = { page: 1, pageSize: 25, status: '', type: '', auto: false };
}

function zeroStats() {
  return {
    queued: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
    dead: 0,
    cancelled: 0,
    total: 0,
    paused: false,
    oldestQueuedAt: null,
    last24h: { succeeded: 0, failed: 0 },
  };
}

function normalizeStats(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const last24h = source.last24h && typeof source.last24h === 'object' ? source.last24h : {};
  return {
    queued: number(source.queued ?? source.pending ?? source.queuedCount),
    running: number(source.running ?? source.processing ?? source.runningCount),
    failed: number(source.failed ?? source.failure ?? source.failedCount),
    succeeded: number(source.succeeded ?? source.success ?? source.completed ?? source.succeededCount),
    dead: number(source.dead),
    cancelled: number(source.cancelled),
    total: number(source.total),
    paused: Boolean(source.paused ?? source.globalPaused ?? source.isPaused),
    oldestQueuedAt: source.oldestQueuedAt || source.oldestQueued || null,
    last24h: {
      succeeded: number(last24h.succeeded ?? last24h.success),
      failed: number(last24h.failed ?? last24h.failure),
    },
  };
}

function normalizeJob(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const parseMaybeJson = (value) => {
    if (typeof value === 'string' && /^[[{]/.test(value.trim())) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  };
  return {
    id: item.id || item.jobId || '',
    type: item.type || item.jobType || '',
    status: String(item.status || 'queued').toLowerCase(),
    priority: item.priority ?? 100,
    attempts: item.attempts ?? 0,
    maxAttempts: item.maxAttempts ?? item.max_attempts ?? 3,
    payload: parseMaybeJson(item.payload ?? item.payloadJson ?? {}),
    result: parseMaybeJson(item.result ?? item.resultJson ?? {}),
    lastError: item.lastError || item.last_error || '',
    runAt: item.runAt || item.run_at || null,
    startedAt: item.startedAt || item.started_at || null,
    finishedAt: item.finishedAt || item.finished_at || null,
    leaseUntil: item.leaseUntil || item.lease_until || null,
    workerId: item.workerId || item.worker_id || null,
    dedupeKey: item.dedupeKey || item.dedupe_key || null,
    createdBy: item.createdBy || item.created_by || null,
    createdAt: item.createdAt || item.created_at || null,
    updatedAt: item.updatedAt || item.updated_at || null,
    audit: item.audit || null,
  };
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

function fmtMaybeDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return formatDateTime(value);
}
