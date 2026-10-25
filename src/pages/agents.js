/**
 * Agent center: catalogue, model-provider status/testing and execution history.
 *
 * The page is read-only by default (`settings.read`); manual test runs need
 * `agents.run`. Credentials are never requested or displayed here — only the
 * provider metadata returned by the server.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api } from '../app/api.mjs';
import { can } from '../app/state.mjs';
import { formatDateTime, formatNumber, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  chips,
  dataTable,
  detailRows,
  emptyState,
  loadingBlock,
  notice,
  openDrawer,
  pageHeader,
  pagination,
  sectionTitle,
  statusBadge,
  textarea,
  toast,
} from '../components/ui.mjs';

export const meta = {
  title: 'Agent 中心',
  help: '查看各 Agent 角色、模型 Provider 状态与执行记录。所有 Agent 共用系统设置中的同一个全局模型；如需更换模型，请前往「系统设置 → AI 模型」。手动试运行会调用当前模型（模拟模式下为离线结果）并计入 Token 用量。',
};

const PROVIDER_LABELS = {
  simulation: '内置模拟模型（离线）',
  openai_compatible: 'OpenAI 兼容接口',
};

const EXECUTIONS_PAGE_SIZE = 20;

let pageState = { page: 1, pageSize: EXECUTIONS_PAGE_SIZE };

export async function render(root) {
  clear(root);
  const canRead = can('settings.read');
  const canRun = can('agents.run');

  const providerHost = el('div', 'stack');
  const agentGrid = el('div', 'agent-grid');
  const execHost = el('div', 'stack');

  const catalogCard = card({
    title: 'Agent 目录',
    help: '每个 Agent 负责一类明确任务。提示词保存在服务端，前端只展示公开的角色说明、能力与版本号。',
    actions: [
      button('刷新目录', {
        variant: 'ghost',
        size: 'sm',
        iconName: 'refresh',
        onClick: () => loadCatalog(),
      }),
    ],
    body: agentGrid,
  });

  const execCard = card({
    title: '执行记录',
    help: '每次 Agent 执行都会记录输入、输出、Token 与耗时，便于追溯与成本核算。',
    actions: [
      button('刷新记录', {
        variant: 'ghost',
        size: 'sm',
        iconName: 'refresh',
        onClick: () => loadExecutions(),
      }),
    ],
    body: execHost,
  });

  append(root, [
    pageHeader({
      title: 'Agent 中心',
      help: meta.help,
      subtitle: '所有 Agent 共用系统设置中的同一个全局模型；修改模型只需前往「系统设置 → AI 模型」。',
      actions: [
        button('刷新', {
          iconName: 'refresh',
          onClick: () => render(root),
        }),
      ],
    }),
    providerHost,
    catalogCard,
    execCard,
  ]);

  providerHost.appendChild(card({ title: '模型 Provider', body: loadingBlock('正在读取模型 Provider…') }));
  agentGrid.appendChild(loadingBlock('正在加载 Agent 目录…'));
  execHost.appendChild(loadingBlock('正在加载执行记录…'));

  if (!canRead) {
    clear(providerHost);
    providerHost.appendChild(
      notice('当前角色没有查看 Agent 配置的权限（需要 settings.read），页面数据暂不加载。', 'info'),
    );
    clear(agentGrid);
    agentGrid.appendChild(
      emptyState({
        iconName: 'lock',
        title: '无权查看 Agent 目录',
        description: '请联系管理员为当前账号分配 settings.read 权限。',
      }),
    );
    clear(execHost);
    execHost.appendChild(
      emptyState({
        iconName: 'lock',
        title: '无权查看执行记录',
        description: '执行记录仅对拥有 settings.read 权限的成员开放。',
      }),
    );
    return;
  }

  let catalog = [];
  let provider = null;
  let executionTotal = 0;

  function fact(label, value) {
    const node = el('div', 'fact');
    append(node, [el('span', 'k', label), el('span', 'v', value)]);
    return node;
  }

  function providerLabel(key) {
    if (!key) return '—';
    return PROVIDER_LABELS[key] || key;
  }

  function jsonBlock(value, { tall = false } = {}) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const pre = el('pre', `page-json${tall ? ' tall' : ''}`);
    pre.textContent = raw === undefined || raw === null ? '—' : truncate(String(raw), 16000);
    return pre;
  }

  function showProviderError(error) {
    clear(providerHost);
    providerHost.appendChild(
      card({
        title: '模型 Provider',
        body: el('div', 'stack', [
          notice(`Provider 状态读取失败：${error?.message || '未知错误'}`, 'danger'),
          el('div', 'row', [
            button('重试', {
              variant: 'primary',
              size: 'sm',
              iconName: 'refresh',
              onClick: () => loadCatalog(),
            }),
          ]),
        ]),
      }),
    );
  }

  async function runProviderTest(buttonNode, resultHost) {
    if (!canRun) {
      toast('当前角色没有 agents.run 权限，无法测试模型连接', 'warning');
      return;
    }
    buttonNode.disabled = true;
    clear(resultHost);
    resultHost.appendChild(el('div', 'loading-inline', [el('span', 'spinner'), '正在调用模型 Provider…']));
    try {
      const result = await api.post('/api/v1/agents/test-provider', {});
      const ok = result?.ok !== false;
      clear(resultHost);
      const facts = el('div', 'fact-grid');
      facts.appendChild(fact('结果', badge(ok ? '连接成功' : '连接失败', ok ? 'green' : 'red')));
      facts.appendChild(fact('Provider', providerLabel(result?.provider || provider?.provider)));
      facts.appendChild(fact('模型', result?.model || provider?.model || '—'));
      facts.appendChild(fact('延迟', result?.latencyMs === null || result?.latencyMs === undefined ? '—' : `${formatNumber(result.latencyMs)} ms`));
      resultHost.appendChild(facts);
      if (result?.sample !== undefined && result?.sample !== null) {
        resultHost.appendChild(sectionTitle('返回示例'));
        resultHost.appendChild(jsonBlock(result.sample));
      }
      toast(ok ? '模型 Provider 连接成功' : '模型 Provider 返回失败', ok ? 'success' : 'warning');
    } catch (error) {
      clear(resultHost);
      resultHost.appendChild(notice(`连接测试失败：${error?.message || '未知错误'}`, 'danger'));
      toast(error?.message || '连接测试失败', 'error');
    } finally {
      buttonNode.disabled = false;
    }
  }

  function renderProvider() {
    clear(providerHost);
    const info = provider || {};
    const isSimulation = info.provider === 'simulation';
    const configured = info.configured === true;
    const hasReachable = info.reachable !== undefined && info.reachable !== null;
    const facts = el('div', 'fact-grid');
    facts.appendChild(fact('当前 Provider', badge(providerLabel(info.provider), isSimulation ? 'purple' : 'cyan')));
    facts.appendChild(fact('模型', info.model || '—'));
    facts.appendChild(fact('配置状态', badge(configured ? '已配置' : '未配置', configured ? 'green' : 'yellow')));
    facts.appendChild(fact('可达性', hasReachable ? badge(info.reachable ? '可达' : '不可达', info.reachable ? 'green' : 'red') : badge('未检测', 'gray')));
    facts.appendChild(fact('最近检查时间', info.lastCheckedAt ? formatDateTime(info.lastCheckedAt) : '—'));

    const body = el('div', 'stack');
    body.appendChild(facts);
    if (isSimulation) {
      body.appendChild(
        notice('当前为离线模拟模式，用于演示与测试，不代表真实模型结果。配置 OpenAI 兼容接口后才会调用外部模型。', 'warn'),
      );
    }
    const resultHost = el('div', 'stack');
    const testButton = button('测试连接', {
      iconName: 'zap',
      disabled: !canRun,
      title: canRun ? '调用当前 Provider 做一次最小请求' : '需要 agents.run 权限',
      onClick: () => runProviderTest(testButton, resultHost),
    });
    body.appendChild(el('div', 'row', [testButton]));
    body.appendChild(resultHost);

    providerHost.appendChild(
      card({
        title: '模型 Provider',
        help: 'Provider 与模型由「系统设置 → AI 模型」维护；此处只展示服务端返回的状态，不会显示任何密钥。',
        body,
      }),
    );
  }

  function renderAgentCard(agent) {
    const node = el('button', 'agent-card page-agent-card');
    node.type = 'button';
    node.title = `查看 ${agent.nameZh || agent.role} 详情`;
    const top = el('div', 'agent-top');
    const iconWrap = el('span', 'agent-icon');
    iconWrap.appendChild(el('span', 'page-agent-glyph', 'AI'));
    append(top, [iconWrap, el('b', '', agent.nameZh || agent.name || agent.role)]);
    node.appendChild(top);
    node.appendChild(el('div', 'agent-meta', [el('span', 'mono', agent.role)]));
    node.appendChild(el('p', '', agent.description || '暂无说明'));
    node.appendChild(chips(agent.capabilities || []));
    node.appendChild(el('div', 'agent-meta', [el('span', '', `提示词版本 ${agent.promptVersion || '—'}`)]));
    node.addEventListener('click', () => openAgentDrawer(agent));
    return node;
  }

  function renderCatalog() {
    clear(agentGrid);
    if (!catalog.length) {
      agentGrid.appendChild(
        emptyState({
          iconName: 'brain',
          title: '没有可用的 Agent',
          description: 'Agent 目录接口暂未返回数据，后端就绪后刷新即可。',
          action: button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => loadCatalog() }),
        }),
      );
      return;
    }
    for (const agent of catalog) agentGrid.appendChild(renderAgentCard(agent));
  }

  async function loadCatalog() {
    clear(providerHost);
    providerHost.appendChild(card({ title: '模型 Provider', body: loadingBlock('正在读取模型 Provider…') }));
    clear(agentGrid);
    agentGrid.appendChild(loadingBlock('正在加载 Agent 目录…'));
    try {
      const data = await api.get('/api/v1/agents');
      const rawItems = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.agents)
            ? data.agents
            : [];
      catalog = rawItems.map(normalizeAgent);
      provider = normalizeProvider(Array.isArray(data) ? null : data?.provider || data?.providerStatus);
      renderProvider();
      renderCatalog();
    } catch (error) {
      showProviderError(error);
      clear(agentGrid);
      agentGrid.appendChild(
        emptyState({
          iconName: 'alert',
          title: 'Agent 目录加载失败',
          description: error?.message || '请求失败，请稍后重试。',
          action: button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => loadCatalog() }),
        }),
      );
    }
  }

  function buildInputTemplate(fields) {
    const value = {};
    for (const key of fields || []) value[key] = '';
    return JSON.stringify(value, null, 2);
  }

  function openAgentDrawer(agent) {
    const body = el('div', 'stack');
    body.appendChild(el('p', 'dim page-drawer-desc', agent.description || '暂无说明'));
    body.appendChild(
      detailRows([
        { label: '角色', value: el('span', 'mono', agent.role) },
        { label: '英文名', value: agent.name || '—' },
        { label: '提示词版本', value: agent.promptVersion || '—' },
      ]),
    );
    body.appendChild(sectionTitle('能力'));
    body.appendChild(chips(agent.capabilities || []));
    body.appendChild(sectionTitle('输入字段'));
    body.appendChild(chips(agent.inputFields || []));
    body.appendChild(el('div', 'divider'));

    body.appendChild(
      sectionTitle(
        '手动试运行',
        '用于验证提示词与输出结构：会真实调用当前 Provider 并计入执行记录与 Token 用量；模拟模式不会访问外部网络。',
      ),
    );
    body.appendChild(
      notice('试运行会产生一次真实的模型调用（模拟模式下为离线结果），请确认输入内容后再提交。', 'warn'),
    );
    const area = textarea({
      value: buildInputTemplate(agent.inputFields),
      rows: 10,
      className: 'textarea page-json-input',
      placeholder: '请输入 JSON 对象',
    });
    body.appendChild(area);
    const errorBox = el('div', 'field-error hidden');
    body.appendChild(errorBox);
    const resultHost = el('div', 'stack');
    const runButton = button('运行 Agent', {
      variant: 'primary',
      iconName: 'play',
      disabled: !canRun,
      title: canRun ? '调用当前 Provider 执行一次该 Agent' : '需要 agents.run 权限',
      onClick: async () => {
        errorBox.classList.add('hidden');
        let input;
        try {
          input = JSON.parse(area.value || '{}');
        } catch (error) {
          errorBox.textContent = `输入不是合法 JSON：${error.message}`;
          errorBox.classList.remove('hidden');
          return;
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          errorBox.textContent = 'Agent 输入必须是 JSON 对象（不能是数组或基础类型）';
          errorBox.classList.remove('hidden');
          return;
        }
        runButton.disabled = true;
        clear(resultHost);
        resultHost.appendChild(el('div', 'loading-inline', [el('span', 'spinner'), '正在执行 Agent…']));
        try {
          const result = await api.post('/api/v1/agents/run', { role: agent.role, input });
          clear(resultHost);
          const usage = result?.usage || {};
          const facts = el('div', 'fact-grid');
          facts.appendChild(fact('执行状态', badge('已执行', 'green')));
          facts.appendChild(fact('执行记录', el('span', 'mono', result?.executionId || '—')));
          if (usage.provider) facts.appendChild(fact('Provider', providerLabel(usage.provider)));
          if (usage.model) facts.appendChild(fact('模型', usage.model));
          if (usage.totalTokens !== undefined) facts.appendChild(fact('Token', formatNumber(usage.totalTokens)));
          if (usage.latencyMs !== undefined) facts.appendChild(fact('延迟', `${formatNumber(usage.latencyMs)} ms`));
          if (usage.isSimulation) facts.appendChild(fact('模式', badge('模拟', 'purple')));
          resultHost.appendChild(facts);
          resultHost.appendChild(sectionTitle('输出'));
          resultHost.appendChild(jsonBlock(result?.output, { tall: true }));
          toast('Agent 已执行，可查看下方输出与执行记录', 'success');
          pageState.page = 1;
          loadExecutions();
        } catch (error) {
          clear(resultHost);
          resultHost.appendChild(notice(`执行失败：${error?.message || '未知错误'}`, 'danger'));
          toast(error?.message || 'Agent 执行失败', 'error');
        } finally {
          runButton.disabled = !canRun;
        }
      },
    });
    body.appendChild(el('div', 'row', [runButton]));
    body.appendChild(resultHost);
    body.appendChild(el('div', 'divider'));
    body.appendChild(sectionTitle('最近执行记录'));
    const recentHost = el('div', 'stack');
    recentHost.appendChild(loadingBlock('正在加载最近执行记录…'));
    body.appendChild(recentHost);

    openDrawer({ title: `${agent.nameZh || agent.name || agent.role} · ${agent.role}`, body });

    (async () => {
      try {
        const data = await api.get(
          `/api/v1/agents/executions?role=${encodeURIComponent(agent.role)}&page=1&pageSize=5`,
        );
        const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.executions) ? data.executions : [];
        clear(recentHost);
        if (!items.length) {
          recentHost.appendChild(el('div', 'muted', '该 Agent 还没有执行记录。'));
          return;
        }
        for (const item of items) {
          const row = el('button', 'page-exec-row');
          row.type = 'button';
          append(row, [
            el('span', 'page-exec-time', formatDateTime(item.createdAt || item.startedAt)),
            statusBadge(item.status || 'unknown', 'job'),
            el('span', 'page-exec-meta', `${formatNumber(item.totalTokens ?? 0)} tokens`),
          ]);
          row.addEventListener('click', () => openExecutionDetail(item));
          recentHost.appendChild(row);
        }
      } catch (error) {
        clear(recentHost);
        recentHost.appendChild(el('div', 'muted', `最近执行记录暂不可用：${error?.message || '未知错误'}`));
      }
    })();
  }

  function executionDuration(row) {
    const started = row.startedAt ? new Date(row.startedAt).getTime() : null;
    const finished = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
    if (row.latencyMs !== null && row.latencyMs !== undefined) return `${formatNumber(row.latencyMs)} ms`;
    if (started && finished && finished >= started) return formatDuration(finished - started);
    if (started && row.status === 'running') return formatDuration(Date.now() - started);
    return '—';
  }

  function executionColumns() {
    return [
      {
        key: 'createdAt',
        label: '时间',
        render: (row) => el('span', 'muted', formatDateTime(row.createdAt || row.startedAt)),
      },
      {
        key: 'role',
        label: 'Agent',
        render: (row) => {
          const agent = catalog.find((item) => item.role === row.role);
          const wrap = el('div');
          append(wrap, [
            el('div', 'cell-main', agent?.nameZh || row.role || '—'),
            el('div', 'cell-sub mono', row.role || ''),
          ]);
          return wrap;
        },
      },
      {
        key: 'status',
        label: '状态',
        render: (row) => statusBadge(row.status || 'unknown', 'job'),
      },
      {
        key: 'provider',
        label: 'Provider / 模型',
        render: (row) => el('span', 'mono', `${row.provider || '—'} / ${row.model || '—'}`),
      },
      {
        key: 'tokens',
        label: 'Tokens',
        align: 'right',
        render: (row) => formatNumber(row.totalTokens ?? (Number(row.tokensIn || 0) + Number(row.tokensOut || 0))),
      },
      {
        key: 'latency',
        label: '耗时',
        align: 'right',
        render: (row) => executionDuration(row),
      },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) =>
          button('查看详情', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'eye',
            onClick: () => openExecutionDetail(row),
          }),
      },
    ];
  }

  function openExecutionDetail(row) {
    const body = el('div', 'stack');
    body.appendChild(loadingBlock('正在加载执行详情…'));
    openDrawer({ title: 'Agent 执行详情', body });
    (async () => {
      let detail = row;
      try {
        const payload = await api.get(`/api/v1/agents/executions/${encodeURIComponent(row.id)}`);
        detail = payload?.execution || payload || row;
      } catch (error) {
        clear(body);
        body.appendChild(notice(`执行详情加载失败：${error?.message || '未知错误'}`, 'danger'));
        return;
      }
      clear(body);
      if (!detail) {
        body.appendChild(emptyState({ iconName: 'alert', title: '执行记录不存在', description: '该记录可能已被清理。' }));
        return;
      }
      const agent = catalog.find((item) => item.role === detail.role);
      body.appendChild(
        detailRows([
          { label: 'Agent', value: agent?.nameZh ? `${agent.nameZh}（${detail.role}）` : detail.role || '—' },
          { label: '状态', value: statusBadge(detail.status || 'unknown', 'job') },
          { label: 'Provider', value: detail.provider || '—' },
          { label: '模型', value: detail.model || '—' },
          { label: '提示词版本', value: detail.promptVersion || '—' },
          { label: 'Token', value: `${formatNumber(detail.totalTokens ?? 0)}（输入 ${formatNumber(detail.tokensIn ?? 0)} / 输出 ${formatNumber(detail.tokensOut ?? 0)}）` },
          { label: '耗时', value: detail.latencyMs === null || detail.latencyMs === undefined ? '—' : `${formatNumber(detail.latencyMs)} ms` },
          { label: '开始时间', value: detail.startedAt ? formatDateTime(detail.startedAt) : '—' },
          { label: '结束时间', value: detail.finishedAt ? formatDateTime(detail.finishedAt) : '—' },
          { label: '关联任务', value: detail.jobId ? el('span', 'mono', detail.jobId) : '—' },
        ]),
      );
      if (detail.error) body.appendChild(notice(detail.error, 'danger'));
      body.appendChild(sectionTitle('输入'));
      body.appendChild(jsonBlock(detail.input));
      body.appendChild(sectionTitle('输出'));
      body.appendChild(jsonBlock(detail.output, { tall: true }));
    })();
  }

  async function loadExecutions() {
    clear(execHost);
    execHost.appendChild(loadingBlock('正在加载执行记录…'));
    try {
      const data = await api.get(`/api/v1/agents/executions?page=${pageState.page}&pageSize=${pageState.pageSize}`);
      const items = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.executions)
            ? data.executions
            : [];
      executionTotal = Number(data?.total ?? items.length) || 0;
      clear(execHost);
      const table = dataTable({
        columns: executionColumns(),
        rows: items,
        onRowClick: (row) => openExecutionDetail(row),
        empty: emptyState({
          iconName: 'brain',
          title: '还没有执行记录',
          description: '工作流触发或手动试运行后，这里会出现执行记录。',
        }),
      });
      execHost.appendChild(table);
      if (executionTotal > 0) {
        execHost.appendChild(
          pagination({
            page: pageState.page,
            pageSize: pageState.pageSize,
            total: executionTotal,
            label: '条执行记录',
            onChange: (nextPage) => {
              pageState.page = Math.max(1, nextPage);
              loadExecutions();
            },
          }),
        );
      }
    } catch (error) {
      clear(execHost);
      execHost.appendChild(
        el('div', 'stack', [
          notice(`执行记录加载失败：${error?.message || '未知错误'}`, 'danger'),
          el('div', 'row', [
            el('span', 'muted', '工作流触发后会自动记录执行结果。'),
            button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => loadExecutions() }),
          ]),
        ]),
      );
    }
  }

  await loadCatalog();
  await loadExecutions();
}

function normalizeAgent(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const role = String(item.role || item.key || item.id || '').trim();
  return {
    role,
    name: item.name || '',
    nameZh: item.nameZh || item.name_zh || item.name || role,
    description: item.description || '',
    promptVersion: item.promptVersion || item.prompt_version || '',
    capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter((value) => typeof value === 'string') : [],
    inputFields: Array.isArray(item.inputFields) ? item.inputFields : Array.isArray(item.input_fields) ? item.input_fields : [],
  };
}

function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    provider: raw.provider || raw.providerKey || raw.key || null,
    model: raw.model || raw.modelName || null,
    configured: raw.configured === true,
    reachable: raw.reachable === undefined ? null : raw.reachable,
    lastCheckedAt: raw.lastCheckedAt || raw.last_checked_at || raw.checkedAt || null,
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

export function destroy() {
  pageState = { page: 1, pageSize: EXECUTIONS_PAGE_SIZE };
}
