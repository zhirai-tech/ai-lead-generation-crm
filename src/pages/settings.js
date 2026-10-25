/**
 * System settings: workspace, members, AI provider, data sources, email
 * accounts, sending limits, compliance, API keys, usage, audit and ops.
 *
 * Every group is loaded lazily and every write is guarded by the same
 * capability the server enforces. Secrets are only ever submitted, never
 * rendered — the UI only shows masked previews returned by the backend.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { can, currentUser, membership } from '../app/state.mjs';
import {
  formatCompact,
  formatDate,
  formatDateTime,
  formatNumber,
  relativeTime,
  truncate,
} from '../utils/format.mjs';
import { lineChart } from '../components/charts.mjs';
import {
  badge,
  button,
  card,
  checkbox,
  chips,
  confirmDialog,
  copyButton,
  dataTable,
  detailRows,
  emptyState,
  field,
  helpTip,
  icon,
  input,
  kvList,
  loadingBlock,
  notice,
  openDrawer,
  openModal,
  pageHeader,
  pagination,
  sectionTitle,
  segmented,
  select,
  statCard,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '系统设置',
  help: '按分组维护工作空间、成员、模型、数据源、邮箱、发送策略、合规、密钥、用量、审计与备份。所有写操作由服务端再次校验权限。',
};

const TABS = [
  { key: 'workspace', label: '工作空间' },
  { key: 'members', label: '成员' },
  { key: 'ai', label: 'AI 模型' },
  { key: 'providers', label: '数据源' },
  { key: 'email', label: '邮箱账户' },
  { key: 'outreach', label: '发送与限额' },
  { key: 'compliance', label: '合规' },
  { key: 'api-keys', label: 'API 密钥' },
  { key: 'usage', label: '用量' },
  { key: 'audit', label: '审计' },
  { key: 'system', label: '备份与系统' },
];

const TAB_ALIASES = {
  security: 'api-keys',
  api_keys: 'api-keys',
  'api-key': 'api-keys',
  providers: 'providers',
  datasource: 'providers',
  data: 'providers',
  ai_provider: 'ai',
  models: 'ai',
  mail: 'email',
  limits: 'outreach',
  sending: 'outreach',
  backup: 'system',
  ops: 'system',
};

const DEFAULT_SETTINGS = {
  outreach: {
    requireApproval: true,
    autoSendEnabled: false,
    dailySendLimit: 50,
    sendWindow: { start: 9, end: 17, weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' },
    signature: '',
    defaultLanguage: 'en',
  },
  limits: {
    dailyEmailLimit: 50,
    dailyAiTokens: 500000,
    hourlyJobLimit: 300,
    maxCrawlPagesPerJob: 30,
    maxCompaniesPerDiscovery: 100,
  },
  ai: {
    provider: 'simulation',
    model: 'zhirai-sim-1',
    temperature: 0.3,
    maxTokensPerRun: 4096,
  },
  compliance: {
    legalBasis: 'legitimate_interest',
    includeUnsubscribe: true,
    senderCompanyName: '',
    senderAddress: '',
    privacyUrl: '',
    doNotContactNote: '',
  },
};

const PROVIDER_LABELS = {
  simulation: '内置模拟模型（离线）',
  openai_compatible: 'OpenAI 兼容接口',
};

const CATEGORY_LABELS = {
  search: ['搜索发现', 'cyan'],
  enrichment: ['企业补全', 'blue'],
  verification: ['邮箱验证', 'green'],
  ai: ['模型', 'purple'],
};

const ROLE_TONES = { owner: 'purple', admin: 'blue', member: 'cyan', viewer: 'gray' };
const ROLE_LABELS = { owner: '拥有者', admin: '管理员', member: '成员', viewer: '只读' };

const MEMBER_STATUS = {
  active: ['有效', 'green'],
  suspended: ['已停用', 'gray'],
  invited: ['待接受', 'yellow'],
};

const ACCOUNT_STATUS = {
  active: ['正常', 'green'],
  paused: ['已暂停', 'yellow'],
  error: ['异常', 'red'],
};

const AUDIT_CATEGORY_LABELS = {
  ai_tokens: 'AI Token',
  email_sent: '邮件发送',
  agent_run: 'Agent 执行',
  data_lookup: '数据查询',
};

const AGENT_ROLE_LABELS = {
  orchestrator: '任务编排',
  market_research: '市场调研',
  company_qualification: '企业资质评分',
  contact_research: '联系人研究',
  product_matching: '产品匹配',
  outreach_writer: '开发信撰写',
  reply_classification: '回复分类',
  follow_up_planning: '跟进规划',
  compliance_guard: '合规检查',
  quality_review: '质量复核',
};

const LANGUAGE_OPTIONS = [
  { value: 'en', label: '英语' },
  { value: 'de', label: '德语' },
  { value: 'fr', label: '法语' },
  { value: 'es', label: '西班牙语' },
  { value: 'it', label: '意大利语' },
  { value: 'nl', label: '荷兰语' },
  { value: 'pl', label: '波兰语' },
];

const LEGAL_BASIS_OPTIONS = [
  { value: 'legitimate_interest', label: '正当利益（B2B 营销常用）' },
  { value: 'consent', label: '明确同意' },
  { value: 'contract', label: '合同履行' },
  { value: 'legal_obligation', label: '法律义务' },
  { value: 'vital_interest', label: '重大利益' },
  { value: 'public_task', label: '公共任务' },
];

const API_SCOPES = [
  { value: 'data.read', label: '读取企业/联系人数据' },
  { value: 'data.write', label: '写入企业/联系人数据' },
  { value: 'agents.run', label: '执行 Agent' },
  { value: 'jobs.read', label: '查看任务队列' },
  { value: 'settings.read', label: '读取设置' },
  { value: 'audit.read', label: '读取审计日志' },
  { value: 'discovery.run', label: '运行企业发现' },
  { value: 'email.sync', label: '同步邮箱' },
];

const SECTION_RENDERERS = {
  workspace: renderWorkspaceSection,
  members: renderMembersSection,
  ai: renderAiSection,
  providers: renderProvidersSection,
  email: renderEmailAccountsSection,
  outreach: renderOutreachSection,
  compliance: renderComplianceSection,
  'api-keys': renderApiKeysSection,
  usage: renderUsageSection,
  audit: renderAuditSection,
  system: renderSystemSection,
};

const usageState = { days: 30, metric: 'aiTokens' };
const auditState = { page: 1, action: '' };
const subTabState = {
  workspace: 'profile',
  providers: 'all',
  email: 'list',
  outreach: 'policy',
  compliance: 'policy',
  usage: 'overview',
  system: 'status',
};

export async function render(root, params, ctx) {
  clear(root);
  const requested = (ctx?.query?.get?.('tab') || '').toString().trim();
  let current = resolveTab(requested);

  const nav = el('div', 'settings-nav');
  const content = el('div', 'stack page-settings-section');
  const buttons = [];

  const setActive = (key) => {
    for (const entry of buttons) {
      entry.button.classList.toggle('active', entry.key === key);
    }
  };

  for (const tab of TABS) {
    const buttonNode = el('button', tab.key === current ? 'active' : '', tab.label);
    buttonNode.type = 'button';
    buttonNode.addEventListener('click', () => {
      if (current === tab.key) return;
      current = tab.key;
      setActive(current);
      const hash = `#/settings?tab=${tab.key}`;
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
      renderSection();
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
    buttons.push({ key: tab.key, button: buttonNode });
    nav.appendChild(buttonNode);
  }

  const layout = el('div', 'settings-grid');
  append(layout, [nav, content]);
  append(root, [
    pageHeader({
      title: '系统设置',
      help: meta.help,
      actions: [
        button('刷新当前分组', {
          iconName: 'refresh',
          onClick: () => renderSection(),
        }),
      ],
    }),
    layout,
  ]);

  async function renderSection() {
    clear(content);
    content.appendChild(loadingBlock('正在加载设置…'));
    const renderer = SECTION_RENDERERS[current] || renderWorkspaceSection;
    try {
      await renderer(content, ctx);
    } catch (error) {
      clear(content);
      content.appendChild(errorCard(error, () => renderSection()));
    }
  }

  setActive(current);
  await renderSection();
}

/* ------------------------------------------------------------------ shared */

function resolveTab(value) {
  const key = String(value || '').trim();
  if (!key) return 'workspace';
  const normalized = TAB_ALIASES[key] || key;
  return TABS.some((tab) => tab.key === normalized) ? normalized : 'workspace';
}

function errorCard(error, retry) {
  return card({
    body: el('div', 'stack', [
      notice(`加载失败：${error?.message || '未知错误'}`, 'danger'),
      el('div', 'row', [button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: retry })]),
    ]),
  });
}

function permissionNotice(capability, purpose) {
  return notice(`当前角色没有「${purpose}」权限（需要 ${capability}），相关操作已禁用，请联系管理员。`, 'info');
}

function disabledTip(capability) {
  return can(capability) ? '' : `需要 ${capability} 权限`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readInt(control, fallback = 0) {
  const parsed = Number.parseInt(control.value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checkControl(label, checked) {
  return checkbox({ checked, label });
}

function checkedOf(node) {
  return Boolean(node.querySelector('input')?.checked);
}

function numberInput(value, { min = null, max = null, step = 1 } = {}) {
  const node = input({ value: value ?? '', type: 'number' });
  if (min !== null) node.min = String(min);
  if (max !== null) node.max = String(max);
  node.step = String(step);
  return node;
}

function factGrid(items) {
  const grid = el('div', 'fact-grid');
  for (const item of items) {
    if (!item) continue;
    const node = el('div', 'fact');
    append(node, [el('span', 'k', item.label), el('span', 'v', item.value)]);
    grid.appendChild(node);
  }
  return grid;
}

/**
 * Secondary module navigation for one settings group: only one card is visible
 * at a time and switching never re-renders the module, so typed form values are
 * preserved. The active sub-tab is remembered across section reloads.
 */
function subTabs(key, items, fallbackKey) {
  const validFallback = items.some((item) => item.key === fallbackKey) ? fallbackKey : items[0]?.key;
  let active = items.some((item) => item.key === subTabState[key]) ? subTabState[key] : validFallback;
  subTabState[key] = active;

  const body = el('div', 'page-module-body');
  const wrappers = new Map();
  for (const item of items) {
    const wrapper = el('div', 'page-module');
    wrapper.appendChild(item.node);
    wrappers.set(item.key, wrapper);
    body.appendChild(wrapper);
  }

  const root = el('div', 'stack page-module-tabs');
  let nav = null;

  const paint = () => {
    for (const [itemKey, wrapper] of wrappers) {
      wrapper.classList.toggle('hidden', itemKey !== active);
    }
    if (nav) {
      const index = items.findIndex((item) => item.key === active);
      const buttons = nav.querySelectorAll('button');
      buttons.forEach((node, buttonIndex) => node.classList.toggle('active', buttonIndex === index));
    }
  };

  if (items.length > 1) {
    const navWrap = el('div', 'page-subtabs');
    nav = segmented({
      items: items.map((item) => ({ value: item.key, label: item.label })),
      value: active,
      onChange: (value) => {
        if (!wrappers.has(value)) return;
        active = value;
        subTabState[key] = value;
        paint();
      },
    });
    navWrap.appendChild(nav);
    root.appendChild(navWrap);
  }

  root.appendChild(body);
  paint();

  const show = (value) => {
    if (!wrappers.has(value)) return;
    active = value;
    subTabState[key] = value;
    paint();
  };

  return { node: root, show, active: () => active };
}

function jsonBlock(value, { tall = false } = {}) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const pre = el('pre', `page-json${tall ? ' tall' : ''}`);
  pre.textContent = raw === undefined || raw === null ? '—' : truncate(String(raw), 16000);
  return pre;
}

function jsonText(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function maskPreview(credential) {
  const preview = credential?.secretPreview || credential?.masked || credential?.secretMask;
  if (preview) return String(preview);
  return credential?.hasSecret === false ? '—' : '已保存';
}

function normalizeCredential(raw) {
  const item = asObject(raw);
  return {
    id: item.id || '',
    kind: item.kind || '',
    providerKey: item.providerKey || item.provider_key || '',
    label: item.label || '',
    status: item.status || 'active',
    config: asObject(item.config || item.config_json),
    hasSecret: item.hasSecret ?? item.has_secret ?? true,
    secretPreview: item.secretPreview || item.secret_preview || null,
    updatedAt: item.updatedAt || item.updated_at || null,
  };
}

function normalizeSettings(raw) {
  const source = asObject(raw?.settings ?? raw);
  const merge = (key) => ({ ...DEFAULT_SETTINGS[key], ...asObject(source[key]) });
  return {
    outreach: {
      ...merge('outreach'),
      sendWindow: { ...DEFAULT_SETTINGS.outreach.sendWindow, ...asObject(source?.outreach?.sendWindow) },
    },
    limits: merge('limits'),
    ai: merge('ai'),
    compliance: merge('compliance'),
  };
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(toNumber(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function formatBytes(bytes) {
  const value = Math.max(0, toNumber(bytes));
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatCost(value) {
  const number = toNumber(value);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: number < 1 ? 4 : 2,
    }).format(number);
  } catch {
    return `$${number.toFixed(4)}`;
  }
}

function runProviderTest(buttonNode, resultHost) {
  buttonNode.disabled = true;
  clear(resultHost);
  resultHost.appendChild(el('div', 'loading-inline', [el('span', 'spinner'), '正在调用模型 Provider…']));
  (async () => {
    try {
      const result = await api.post('/api/v1/agents/test-provider', {});
      const ok = result?.ok !== false;
      clear(resultHost);
      resultHost.appendChild(
        factGrid([
          { label: '结果', value: badge(ok ? '连接成功' : '连接失败', ok ? 'green' : 'red') },
          { label: 'Provider', value: PROVIDER_LABELS[result?.provider] || result?.provider || '—' },
          { label: '模型', value: result?.model || '—' },
          {
            label: '延迟',
            value: result?.latencyMs === null || result?.latencyMs === undefined ? '—' : `${formatNumber(result.latencyMs)} ms`,
          },
        ]),
      );
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
      buttonNode.disabled = !can('agents.run');
    }
  })();
}

/* -------------------------------------------------------------- workspace */

async function renderWorkspaceSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载工作空间…'));
  let data;
  try {
    data = await api.get('/api/v1/workspace');
  } catch (error) {
    clear(host);
    host.appendChild(errorCard(error, () => renderWorkspaceSection(host)));
    return;
  }
  clear(host);
  const workspace = asObject(data?.workspace);
  const me = asObject(data?.membership);
  const counts = asObject(data?.counts);
  const canEdit = can('workspace.update');

  const nameInput = input({ value: workspace.name || '', placeholder: '工作空间名称' });
  nameInput.maxLength = 100;
  nameInput.disabled = !canEdit;

  const saveButton = button('保存名称', {
    variant: 'primary',
    iconName: 'check',
    disabled: !canEdit,
    title: disabledTip('workspace.update'),
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast('工作空间名称不能为空', 'error');
        nameInput.focus();
        return;
      }
      if (name.length > 100) {
        toast('工作空间名称不能超过 100 个字符', 'error');
        return;
      }
      saveButton.disabled = true;
      try {
        await api.patch('/api/v1/workspace', { name });
        toast('工作空间名称已保存', 'success');
        await renderWorkspaceSection(host);
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
        saveButton.disabled = !canEdit;
      }
    },
  });

  const form = el('div', 'stack');
  form.appendChild(
    field('工作空间名称', nameInput, {
      required: true,
      help: '名称会显示在成员界面与邮件签名中；重命名不影响历史数据。',
    }),
  );
  form.appendChild(el('div', 'row', [saveButton]));

  const profileCard = card({
    title: '工作空间资料',
    help: '修改名称属于管理操作；删除工作空间为高危操作，当前界面不提供入口，需要由拥有者在数据库层面处理。',
    body: form,
  });
  const infoCard = card({
    title: '工作空间信息',
    body: kvList([
      { label: '工作空间 ID', value: el('span', 'mono', workspace.id || '—') },
      { label: '标识', value: workspace.slug || '—' },
      { label: '状态', value: workspace.status || '—' },
      { label: '创建时间', value: workspace.createdAt ? formatDateTime(workspace.createdAt) : '—' },
      { label: '当前角色', value: badge(ROLE_LABELS[me.role] || me.roleLabel || me.role || '—', ROLE_TONES[me.role] || 'gray') },
      { label: '成员数', value: formatNumber(counts.members ?? 0) },
      { label: '企业数', value: formatNumber(counts.companies ?? 0) },
      { label: '联系人', value: formatNumber(counts.contacts ?? 0) },
      { label: '产品数', value: formatNumber(counts.products ?? 0) },
    ]),
  });
  const tabs = subTabs(
    'workspace',
    [
      { key: 'profile', label: '工作空间资料', node: profileCard },
      { key: 'info', label: '工作空间信息', node: infoCard },
    ],
    'profile',
  );
  host.appendChild(tabs.node);
  if (!canEdit) host.appendChild(permissionNotice('workspace.update', '修改工作空间'));
}

/* --------------------------------------------------------------- members */

async function renderMembersSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载成员…'));
  let data;
  try {
    data = await api.get('/api/v1/workspace/members');
  } catch (error) {
    clear(host);
    host.appendChild(errorCard(error, () => renderMembersSection(host)));
    return;
  }
  clear(host);
  const members = (Array.isArray(data?.items) ? data.items : asArray(data?.members)).map(normalizeMember);
  const roles = asArray(data?.roles).length ? data.roles : [
    { value: 'admin', label: '管理员' },
    { value: 'member', label: '成员' },
    { value: 'viewer', label: '只读' },
  ];
  const canManage = can('members.manage');
  const me = currentUser();
  const myRole = membership()?.role;

  const reload = () => renderMembersSection(host);

  const addButton = button('添加成员', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !canManage,
    title: disabledTip('members.manage'),
    onClick: () => openAddMemberModal(roles, reload),
  });

  const columns = [
    {
      key: 'name',
      label: '成员',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main', row.name || row.email || '—'),
          el('div', 'cell-sub', row.email || ''),
        ]);
        return wrap;
      },
    },
    { key: 'role', label: '角色', render: (row) => badge(ROLE_LABELS[row.role] || row.roleLabel || row.role, ROLE_TONES[row.role] || 'gray') },
    {
      key: 'status',
      label: '状态',
      render: (row) => {
        const [label, tone] = MEMBER_STATUS[row.status] || [row.status || '未知', 'gray'];
        return badge(label, tone, { dot: true });
      },
    },
    { key: 'lastLoginAt', label: '最后登录', render: (row) => el('span', 'muted nowrap', row.lastLoginAt ? relativeTime(row.lastLoginAt) : '从未登录') },
    { key: 'createdAt', label: '加入时间', render: (row) => el('span', 'muted nowrap', formatDate(row.createdAt)) },
    {
      key: 'actions',
      label: '操作',
      className: 'cell-actions',
      render: (row) => memberActions(row),
    },
  ];

  function memberActions(row) {
    if (row.role === 'owner') return el('span', 'muted', '拥有者不可修改');
    const isSelf = Boolean(me && row.userId === me.id);
    const roleLocked = !canManage || isSelf || (row.role === 'admin' && myRole !== 'owner');
    const statusLocked = !canManage || isSelf || (row.role === 'admin' && myRole !== 'owner');
    const wrap = el('div', 'row page-row-actions');
    const roleSelect = select({
      value: row.role,
      options: roles.filter((item) => item.value !== 'owner'),
      className: 'select input-sm page-role-select',
      disabled: roleLocked,
      onChange: async (value) => {
        if (!value || value === row.role) return;
        const confirmed = await confirmDialog({
          title: '调整成员角色',
          message: `将把「${row.name || row.email}」的角色从「${ROLE_LABELS[row.role] || row.role}」调整为「${ROLE_LABELS[value] || value}」。角色变更会立即影响其可执行的操作。`,
          confirmText: '确认调整',
        });
        if (!confirmed) {
          reload();
          return;
        }
        try {
          await api.patch(`/api/v1/workspace/members/${encodeURIComponent(row.userId)}`, { role: value });
          toast('成员角色已更新', 'success');
          reload();
        } catch (error) {
          toast(error?.message || '更新失败', 'error');
          reload();
        }
      },
    });
    if (roleLocked) roleSelect.title = isSelf ? '不能修改自己的角色' : disabledTip('members.manage');
    wrap.appendChild(roleSelect);
    const suspending = row.status === 'active';
    wrap.appendChild(
      button(suspending ? '停用' : '启用', {
        variant: 'ghost',
        size: 'sm',
        iconName: suspending ? 'lock' : 'check',
        disabled: statusLocked,
        title: statusLocked ? (isSelf ? '不能停用自己' : disabledTip('members.manage')) : '',
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: suspending ? '停用成员' : '启用成员',
            message: suspending
              ? `停用后「${row.name || row.email}」将无法登录当前工作空间，已登录会话会被撤销。`
              : `启用后「${row.name || row.email}」可以重新登录当前工作空间。`,
            confirmText: suspending ? '停用' : '启用',
            danger: suspending,
          });
          if (!confirmed) return;
          try {
            await api.patch(`/api/v1/workspace/members/${encodeURIComponent(row.userId)}`, {
              status: suspending ? 'suspended' : 'active',
            });
            toast(suspending ? '成员已停用' : '成员已启用', 'success');
            reload();
          } catch (error) {
            toast(error?.message || '操作失败', 'error');
          }
        },
      }),
    );
    wrap.appendChild(
      button('移除', {
        variant: 'ghost',
        size: 'sm',
        iconName: 'trash',
        disabled: !canManage || isSelf || row.role === 'admin' && myRole !== 'owner',
        title: isSelf ? '不能移除自己' : disabledTip('members.manage'),
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: '移除成员',
            message: `将把「${row.name || row.email}」从当前工作空间移除，其会话会被撤销。该用户在其他工作空间的身份不受影响。`,
            confirmText: '移除',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await api.delete(`/api/v1/workspace/members/${encodeURIComponent(row.userId)}`);
            toast('成员已移除', 'success');
            reload();
          } catch (error) {
            toast(error?.message || '移除失败', 'error');
          }
        },
      }),
    );
    return wrap;
  }

  host.appendChild(
    el('div', 'row-between', [
      el('div', 'row', [
        sectionTitle(
          '工作空间成员',
          '拥有者不可被修改或移除；管理员只能由拥有者调整。新用户首次登录会要求修改初始密码。',
        ),
      ]),
      addButton,
    ]),
  );
  host.appendChild(
    dataTable({
      columns,
      rows: members,
      empty: emptyState({
        iconName: 'users',
        title: '还没有成员',
        description: '添加成员后，他们可以按角色访问工作空间。',
      }),
    }),
  );
  if (!canManage) host.appendChild(permissionNotice('members.manage', '管理成员'));
}

function openAddMemberModal(roles, reload) {
  let submitting = false;
  const emailInput = input({ value: '', placeholder: 'name@company.com', type: 'email' });
  const nameInput = input({ value: '', placeholder: '成员姓名' });
  const roleSelect = select({
    value: 'member',
    options: roles.filter((item) => item.value !== 'owner'),
    placeholder: null,
  });
  const passwordInput = input({ value: '', placeholder: '至少 10 位，包含字母和数字', type: 'password', autocomplete: 'new-password' });
  const errorBox = el('div', 'field-error hidden');
  const body = el('div', 'stack');
  append(body, [
    field('邮箱', emailInput, { required: true, help: '已存在的系统用户会直接加入当前工作空间。' }),
    field('姓名', nameInput),
    field('角色', roleSelect, { required: true, help: '管理员可管理设置与成员；成员可写业务数据；只读仅可查看。' }),
    field('初始密码', passwordInput, {
      help: '新用户必须设置初始密码（至少 10 位，含字母和数字）；已有用户可留空。',
    }),
    errorBox,
  ]);
  openModal({
    title: '添加成员',
    body,
    actions: [
      { label: '取消' },
      {
        label: '添加',
        variant: 'primary',
        onClick: async (close) => {
          if (submitting) return;
          errorBox.classList.add('hidden');
          const email = emailInput.value.trim();
          const name = nameInput.value.trim();
          const role = roleSelect.value;
          const password = passwordInput.value;
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errorBox.textContent = '请输入合法的邮箱地址';
            errorBox.classList.remove('hidden');
            return;
          }
          if (!role) {
            errorBox.textContent = '请选择角色';
            errorBox.classList.remove('hidden');
            return;
          }
          if (password && password.length < 10) {
            errorBox.textContent = '初始密码至少需要 10 位';
            errorBox.classList.remove('hidden');
            return;
          }
          if (password && (!/[A-Za-z]/.test(password) || !/\d/.test(password))) {
            errorBox.textContent = '初始密码必须同时包含字母和数字';
            errorBox.classList.remove('hidden');
            return;
          }
          try {
            submitting = true;
            await api.post('/api/v1/workspace/members', { email, name, role, password: password || undefined });
            toast('成员已添加', 'success');
            close();
            reload();
          } catch (error) {
            errorBox.textContent = error?.message || '添加失败';
            errorBox.classList.remove('hidden');
          } finally {
            submitting = false;
          }
        },
      },
    ],
  });
}

function normalizeMember(raw) {
  const item = asObject(raw);
  return {
    userId: item.userId || item.user_id || item.id || '',
    membershipId: item.membershipId || item.membership_id || '',
    email: item.email || '',
    name: item.name || '',
    role: item.role || 'member',
    roleLabel: item.roleLabel || item.role_label || '',
    status: item.status || 'active',
    lastLoginAt: item.lastLoginAt || item.last_login_at || null,
    createdAt: item.createdAt || item.created_at || null,
  };
}

/* --------------------------------------------------------------- AI model */

async function renderAiSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载模型配置…'));
  let settingsResponse = null;
  let settingsError = null;
  let catalogResponse = null;
  try {
    settingsResponse = await api.get('/api/v1/settings');
  } catch (error) {
    settingsError = error;
  }
  try {
    catalogResponse = await api.get('/api/v1/agents');
  } catch {
    catalogResponse = null;
  }
  clear(host);
  if (settingsError) {
    host.appendChild(notice(`设置接口暂不可用，已显示默认值（保存可能失败）：${settingsError.message}`, 'warn'));
  }

  const settings = normalizeSettings(settingsResponse?.settings);
  const ai = settings.ai;
  const credentials = asArray(settingsResponse?.credentials)
    .map(normalizeCredential)
    .filter((item) => item?.kind === 'ai_provider');
  const providerState = asObject(catalogResponse?.provider);
  const canManage = can('settings.manage');
  const canCredentials = can('credentials.manage');
  const canTest = can('agents.run');
  const reload = () => renderAiSection(host);

  const openaiCredential = credentials.find((item) => item.providerKey === 'openai_compatible') || null;
  const credentialConfig = asObject(openaiCredential?.config);
  const providerKey = ai.provider || providerState.provider || 'simulation';
  const isSimulation = providerKey === 'simulation';
  const effectiveModel = ai.model || credentialConfig.model || providerState.model || '—';

  const statusItem = (label, value) => {
    const node = el('span', 'row');
    append(node, [el('span', 'muted', label), el('span', 'dim', value)]);
    return node;
  };

  // Compact status strip: current model, configuration state and last check.
  const statusStrip = el('div', 'toolbar page-ai-status');
  append(statusStrip, [
    statusItem(
      '当前模型',
      isSimulation
        ? '内置模拟（离线）'
        : `${PROVIDER_LABELS[providerKey] || providerKey} · ${effectiveModel}`,
    ),
    statusItem(
      '状态',
      isSimulation
        ? badge('离线模拟', 'purple')
        : providerState.configured
          ? badge('已配置', 'green')
          : badge('未配置', 'yellow'),
    ),
    statusItem(
      '可达性',
      providerState.reachable === undefined || providerState.reachable === null
        ? badge('未检测', 'gray')
        : badge(providerState.reachable ? '可达' : '不可达', providerState.reachable ? 'green' : 'red'),
    ),
    statusItem('最近检查', providerState.lastCheckedAt ? formatDateTime(providerState.lastCheckedAt) : '—'),
  ]);
  host.appendChild(statusStrip);

  // ------------------------------------------------------------ single form
  const serviceSelect = select({
    value: isSimulation ? 'simulation' : 'openai_compatible',
    options: [
      { value: 'openai_compatible', label: 'OpenAI 兼容接口（DeepSeek / OpenAI 等）' },
      { value: 'simulation', label: '内置模拟（离线演示）' },
    ],
    onChange: () => syncServiceMode(),
  });
  const baseUrlInput = input({
    value: credentialConfig.baseUrl || 'https://api.deepseek.com/v1',
    placeholder: 'https://api.deepseek.com/v1',
  });
  const modelInput = input({
    value: credentialConfig.model || ai.model || 'deepseek-chat',
    placeholder: '例如 deepseek-chat',
  });
  const apiKeyInput = input({
    value: '',
    type: 'password',
    autocomplete: 'new-password',
    placeholder: openaiCredential ? '已保存 API Key，留空则不修改' : '粘贴 API Key（保存后不回显）',
  });
  const temperatureInput = numberInput(ai.temperature ?? 0.3, { min: 0, max: 2, step: 0.1 });
  const maxTokensInput = numberInput(ai.maxTokensPerRun ?? 4096, { min: 64, max: 8192, step: 1 });

  const wide = (node) => {
    node.classList.add('span-2');
    return node;
  };

  const connectionFields = el('div', 'form-grid page-form page-ai-connection');
  append(connectionFields, [
    wide(
      field('请求地址 Base URL', baseUrlInput, {
        required: true,
        help: 'DeepSeek 常用 https://api.deepseek.com/v1；OpenAI 为 https://api.openai.com/v1。',
      }),
    ),
    wide(
      field('API Key', apiKeyInput, {
        required: !openaiCredential,
        help: openaiCredential
          ? '已保存密钥，留空表示继续使用；修改请求地址或模型 ID 时需要重新填写。密钥不会回显。'
          : '密钥由服务端加密保存，保存后任何页面都不会回显明文。',
      }),
    ),
  ]);

  const modelField = field('模型 ID', modelInput, {
    required: true,
    help: '由服务商提供的模型标识，例如 deepseek-chat、gpt-4o-mini。所有 Agent 共用。',
  });
  const serviceModelFields = el('div', 'form-grid page-form');
  append(serviceModelFields, [
    field('模型服务', serviceSelect, { required: true, help: '选择真实接口或离线模拟；所有 Agent 共用这一个模型。' }),
    modelField,
  ]);

  const simulationNote = notice('内置模拟模式仅用于演示与测试，不会调用外部模型，也不产生费用。', 'info');

  const advanced = el('details', 'page-advanced');
  const advancedSummary = el('summary', '', '高级参数（温度 / 单次最大 Token）');
  const advancedGrid = el('div', 'form-grid page-form');
  append(advancedGrid, [
    field('温度 Temperature', temperatureInput, { help: '0 更稳定，1 更发散；建议 0.2–0.5。' }),
    field('单次最大 Token', maxTokensInput, { help: '服务端会限制在 64–8192 之间。' }),
  ]);
  append(advanced, [advancedSummary, advancedGrid]);

  const testResultHost = el('div', 'stack page-ai-test-result');

  const testButton = button('测试连接', {
    iconName: 'zap',
    onClick: () => runProviderTest(testButton, testResultHost),
  });
  const saveButton = button('保存并应用', {
    variant: 'primary',
    iconName: 'check',
    onClick: async () => {
      const provider = serviceSelect.value;
      const temperature = toNumber(temperatureInput.value, NaN);
      const maxTokensPerRun = readInt(maxTokensInput, NaN);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        toast('温度必须在 0 到 2 之间', 'error');
        temperatureInput.focus();
        advanced.open = true;
        return;
      }
      if (!Number.isFinite(maxTokensPerRun) || maxTokensPerRun < 64 || maxTokensPerRun > 8192) {
        toast('单次最大 Token 必须在 64 到 8192 之间', 'error');
        maxTokensInput.focus();
        advanced.open = true;
        return;
      }
      const model = modelInput.value.trim();

      if (provider === 'simulation') {
        saveButton.disabled = true;
        try {
          await api.patch('/api/v1/settings', {
            ai: { provider: 'simulation', model: 'zhirai-sim-1', temperature, maxTokensPerRun },
          });
          toast('已切换到内置模拟模型', 'success');
          reload();
        } catch (error) {
          toast(error?.message || '保存失败', 'error');
          saveButton.disabled = false;
        }
        return;
      }

      const baseUrl = baseUrlInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
        toast('请求地址 Base URL 必须是 http(s) 地址', 'error');
        baseUrlInput.focus();
        return;
      }
      if (!model) {
        toast('请填写模型 ID', 'error');
        modelInput.focus();
        return;
      }
      const isLocalEndpoint = /^https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(baseUrl)
        || /ollama/i.test(baseUrl);
      if (!openaiCredential && !apiKey && !isLocalEndpoint) {
        toast('请填写 API Key', 'error');
        apiKeyInput.focus();
        return;
      }
      if (apiKey && apiKey.length < 8) {
        toast('API Key 长度不足（至少 8 位）', 'error');
        apiKeyInput.focus();
        return;
      }
      const configChanged =
        openaiCredential &&
        (baseUrl !== String(credentialConfig.baseUrl || '') || model !== String(credentialConfig.model || ''));
      if (!apiKey && configChanged && !isLocalEndpoint) {
        toast('修改请求地址或模型 ID 后需要重新填写 API Key（已保存的密钥不会回显）', 'error');
        apiKeyInput.focus();
        return;
      }

      saveButton.disabled = true;
      try {
        if (!apiKey && isLocalEndpoint) {
          // Local/LAN Ollama does not use an API key. Saving through the model
          // setup endpoint replaces the endpoint without deleting the model.
          await api.post('/api/v1/model-setup/use', { baseUrl, model });
        } else if (apiKey) {
          await api.put('/api/v1/settings/credentials/ai_provider/openai_compatible', {
            label: openaiCredential?.label || '全局模型',
            secret: { apiKey },
            config: { baseUrl, model },
          });
        }
        await api.patch('/api/v1/settings', {
          ai: { provider: 'openai_compatible', model, temperature, maxTokensPerRun },
        });
        apiKeyInput.value = '';
        toast('模型配置已保存并应用到全部 Agent', 'success');
        reload();
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
        saveButton.disabled = false;
      }
    },
  });

  const actionRow = el('div', 'row page-ai-actions');
  append(actionRow, [saveButton, testButton]);

  const formBody = el('div', 'stack');
  append(formBody, [serviceModelFields, simulationNote, connectionFields, advanced, actionRow, testResultHost]);

  // -------------------------------------------------------- saved credential
  const credList = el('div', 'detail-list');
  if (!credentials.length) {
    credList.appendChild(el('div', 'muted', '还没有保存凭据；保存上面的 API Key 后会在这里显示掩码。'));
  } else {
    for (const credential of credentials) {
      const info = el('div', '');
      const configText = [asObject(credential.config).baseUrl, asObject(credential.config).model].filter(Boolean).join(' / ');
      append(info, [
        el('div', '', credential.label || credential.providerKey || 'AI 凭据'),
        el('div', 'cell-sub mono', `${credential.providerKey || '—'} · ${maskPreview(credential)}`),
        configText ? el('div', 'cell-sub mono page-break', configText) : null,
      ]);
      const removeButton = button('删除', {
        variant: 'ghost',
        size: 'sm',
        iconName: 'trash',
        disabled: !canCredentials,
        title: disabledTip('credentials.manage'),
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: '删除凭据',
            message: `将删除凭据「${credential.label || credential.providerKey}」。删除后真实模型调用会失败，需要重新填写 API Key。`,
            confirmText: '删除',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await api.delete(`/api/v1/settings/credentials/${encodeURIComponent(credential.id)}`);
            toast('凭据已删除', 'success');
            reload();
          } catch (error) {
            toast(error?.message || '删除失败', 'error');
          }
        },
      });
      const row = el('div', 'detail-row');
      append(row, [info, removeButton]);
      credList.appendChild(row);
    }
  }

  const cardBody = el('div', 'stack');
  append(cardBody, [
    formBody,
    el('div', 'divider'),
    sectionTitle('已保存凭据', '只显示掩码；删除后需要重新填写 API Key。'),
    credList,
  ]);
  host.appendChild(
    card({
      title: '模型配置',
      help: '所有 Agent 共用这一个全局模型。保存后立即对全部 Agent 生效；如需更换模型，只需修改这里。',
      body: cardBody,
    }),
  );

  if (!canManage) host.appendChild(permissionNotice('settings.manage', '修改模型配置'));
  if (!canCredentials) host.appendChild(permissionNotice('credentials.manage', '保存或删除 API Key'));

  function syncServiceMode() {
    const simulation = serviceSelect.value === 'simulation';
    connectionFields.classList.toggle('hidden', simulation);
    modelField.classList.toggle('hidden', simulation);
    advanced.classList.toggle('hidden', simulation);
    simulationNote.classList.toggle('hidden', !simulation);
    saveButton.disabled = !canManage || (!simulation && !canCredentials);
    saveButton.title = !canManage
      ? disabledTip('settings.manage')
      : !simulation && !canCredentials
        ? disabledTip('credentials.manage')
        : '';
    testButton.disabled = !canTest || (!simulation && !openaiCredential);
    testButton.title = !canTest
      ? disabledTip('agents.run')
      : !simulation && !openaiCredential
        ? '保存 API Key 后即可测试'
        : '测试当前已保存的模型配置';
  }

  syncServiceMode();
}

/* ------------------------------------------------------------- providers */

async function renderProvidersSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载数据源…'));
  let data;
  try {
    data = await api.get('/api/v1/settings');
  } catch (error) {
    clear(host);
    host.appendChild(errorCard(error, () => renderProvidersSection(host)));
    return;
  }
  clear(host);
  const providers = asArray(data?.providers).map((item) => asObject(item));
  const canManage = can('settings.manage');
  const reload = () => renderProvidersSection(host);

  const columns = [
    {
      key: 'name',
      label: '数据源',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main', row.name || row.key || '—'),
          el('div', 'cell-sub mono', row.key || ''),
        ]);
        return wrap;
      },
    },
    {
      key: 'category',
      label: '类别',
      render: (row) => {
        const [label, tone] = CATEGORY_LABELS[row.category] || [row.category || '—', 'gray'];
        return badge(label, tone);
      },
    },
    { key: 'capabilities', label: '能力', render: (row) => chips(asArray(row.capabilities)) },
    { key: 'costModel', label: '成本', render: (row) => el('span', 'muted', row.costModel || row.cost_model || '—') },
    {
      key: 'isEnabled',
      label: '状态',
      render: (row) => badge(row.isEnabled ? '已启用' : '已停用', row.isEnabled ? 'green' : 'gray', { dot: true }),
    },
    {
      key: 'config',
      label: '配置摘要',
      render: (row) => {
        const config = asObject(row.config);
        const keys = Object.keys(config);
        if (!keys.length) return el('span', 'muted', '—');
        return el('span', 'mono page-break', truncate(keys.map((key) => `${key}: ${String(config[key])}`).join(' · '), 64));
      },
    },
    {
      key: 'actions',
      label: '操作',
      className: 'cell-actions',
      render: (row) => {
        const wrap = el('div', 'row page-row-actions');
        wrap.appendChild(
          button(row.isEnabled ? '停用' : '启用', {
            variant: 'ghost',
            size: 'sm',
            iconName: row.isEnabled ? 'pause' : 'play',
            disabled: !canManage,
            title: disabledTip('settings.manage'),
            onClick: async () => {
              try {
                await api.patch(`/api/v1/settings/providers/${encodeURIComponent(row.key)}`, {
                  isEnabled: !row.isEnabled,
                });
                toast(row.isEnabled ? '数据源已停用' : '数据源已启用', 'success');
                reload();
              } catch (error) {
                toast(error?.message || '更新失败', 'error');
              }
            },
          }),
        );
        wrap.appendChild(
          button('配置', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'settings',
            disabled: !canManage,
            title: disabledTip('settings.manage'),
            onClick: () => openProviderConfigModal(row, reload),
          }),
        );
        return wrap;
      },
    },
  ];

  const categoryOrder = ['search', 'enrichment', 'verification', 'ai'];
  const categories = [...new Set(providers.map((item) => item.category).filter(Boolean))].sort(
    (left, right) => categoryOrder.indexOf(left) - categoryOrder.indexOf(right),
  );

  const providerCard = (rows, label) =>
    card({
      title: '外部数据源',
      help: '启停与配置即时生效；API 密钥等敏感凭据由服务端加密保存，不在此处回显。',
      actions: [el('span', 'muted page-updated', `${label} · 共 ${formatNumber(rows.length)} 个`)],
      body: dataTable({
        columns,
        rows,
        empty: emptyState({
          iconName: 'database',
          title: '该类别还没有数据源',
          description: '后端初始化后会写入模拟数据源、公开网站抓取等目录。',
        }),
      }),
    });

  if (categories.length <= 1) {
    host.appendChild(providerCard(providers, '数据源列表'));
  } else {
    const items = [{ key: 'all', label: '全部', node: providerCard(providers, '全部数据源') }];
    for (const category of categories) {
      const label = CATEGORY_LABELS[category]?.[0] || category;
      items.push({
        key: category,
        label,
        node: providerCard(providers.filter((item) => item.category === category), label),
      });
    }
    const tabs = subTabs('providers', items, 'all');
    host.appendChild(tabs.node);
  }
  const braveKeyInput = input({
    value: '',
    type: 'password',
    placeholder: '粘贴 Brave Search API Key（留空不改）',
    autocomplete: 'new-password',
  });
  const serperKeyInput = input({
    value: '',
    type: 'password',
    placeholder: '粘贴 Serper API Key（留空不改）',
    autocomplete: 'new-password',
  });
  const tavilyKeyInput = input({
    value: '',
    type: 'password',
    placeholder: '粘贴 Tavily API Key（留空不改）',
    autocomplete: 'new-password',
  });
  const saveSearchKeysBtn = button('保存搜索 API Key', {
    variant: 'primary',
    iconName: 'key',
    disabled: !can('credentials.manage'),
    onClick: async () => {
      const brave = braveKeyInput.value.trim();
      const serper = serperKeyInput.value.trim();
      const tavily = tavilyKeyInput.value.trim();
      if (!brave && !serper && !tavily) {
        toast('至少填写一个 API Key', 'warning');
        return;
      }
      saveSearchKeysBtn.disabled = true;
      try {
        if (brave) {
          await api.put('/api/v1/settings/credentials/data_provider/brave', {
            label: 'Brave Search API',
            secret: { apiKey: brave },
            config: {},
          });
        }
        if (serper) {
          await api.put('/api/v1/settings/credentials/data_provider/serper', {
            label: 'Serper Search API',
            secret: { apiKey: serper },
            config: {},
          });
        }
        if (tavily) {
          await api.put('/api/v1/settings/credentials/data_provider/tavily', {
            label: 'Tavily Search API',
            secret: { apiKey: tavily },
            config: {},
          });
        }
        toast('搜索 API Key 已保存，服务端加密存储', 'success');
        braveKeyInput.value = '';
        serperKeyInput.value = '';
        tavilyKeyInput.value = '';
        reload();
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
      } finally {
        saveSearchKeysBtn.disabled = false;
      }
    },
  });
  const searchKeyLink = (href, label) => {
    const link = el('a', 'link', label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    return link;
  };
  host.appendChild(
    card({
      title: '全网搜索引擎 API Key',
      help: 'Brave 和 Serper 用于搜索企业官网；没有 Key 时只能使用 OpenStreetMap。Key 由服务端加密保存，不会回显。',
      body: el('div', 'stack', [
        el('div', 'cell-sub', [
          el('span', '', 'Brave 申请入口：'),
          searchKeyLink('https://api-dashboard.search.brave.com/register', 'brave.com/search/api'),
        ]),
        field('Brave Search API Key', braveKeyInput),
        el('div', 'cell-sub', [
          el('span', '', 'Serper 申请入口：'),
          searchKeyLink('https://serper.dev/', 'serper.dev'),
        ]),
        field('Serper API Key', serperKeyInput),
        el('div', 'cell-sub', [
          el('span', '', 'Tavily 免 Key 入口：'),
          searchKeyLink('https://app.tavily.com', 'app.tavily.com'),
          el('span', '', '（不填 Key 也可限额使用；填 Key 后额度更高）'),
        ]),
        field('Tavily API Key（可选）', tavilyKeyInput),
        el('div', 'row', [saveSearchKeysBtn]),
      ]),
    }),
  );
  host.appendChild(
    card({
      title: '数据源说明',
      body: el('div', 'stack', [
        el('div', 'cell-sub', 'CSV / 表格导入：导入你自己已有的企业表格，不是全网搜索。'),
        el('div', 'cell-sub', 'DeepSeek：语言模型，只负责对话、分析和文案，不负责搜索企业。'),
        el('div', 'cell-sub', 'Brave / Serper / Tavily：真正的全网企业搜索源，需要 API Key。'),
        el('div', 'cell-sub', 'OpenStreetMap：免费真实地图数据，但通常没有邮箱，且进口商覆盖有限。'),
      ]),
    }),
  );
  if (!canManage) host.appendChild(permissionNotice('settings.manage', '修改数据源'));
}

function openProviderConfigModal(provider, reload) {
  let submitting = false;
  const key = provider.key || '';
  const config = asObject(provider.config);
  const usesSimpleFields = ['search_api', 'company_enrichment'].includes(key);
  const body = el('div', 'stack');
  const errorBox = el('div', 'field-error hidden');

  if (usesSimpleFields) {
    const baseUrlInput = input({ value: config.baseUrl || '', placeholder: 'https://api.example.com' });
    const providerInput = input({ value: config.provider || '', placeholder: '服务商标识，如 serper / apollo' });
    append(body, [
      field('Base URL', baseUrlInput, { help: '搜索/补全服务的接口根地址。' }),
      field('服务商标识', providerInput, { help: '仅作记录，用于区分不同供应商。' }),
    ]);
    openModal({
      title: `配置数据源：${provider.name || key}`,
      body,
      actions: [
        { label: '取消' },
        {
          label: '保存',
          variant: 'primary',
          onClick: async (close) => {
            if (submitting) return;
            const baseUrl = baseUrlInput.value.trim();
            if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
              errorBox.textContent = 'Base URL 必须是 http(s) 地址';
              errorBox.classList.remove('hidden');
              return;
            }
            try {
              submitting = true;
              await api.patch(`/api/v1/settings/providers/${encodeURIComponent(key)}`, {
                config: { baseUrl, provider: providerInput.value.trim() },
              });
              toast('数据源配置已保存', 'success');
              close();
              reload();
            } catch (error) {
              errorBox.textContent = error?.message || '保存失败';
              errorBox.classList.remove('hidden');
            } finally {
              submitting = false;
            }
          },
        },
      ],
    });
  } else {
    const area = textarea({ value: jsonText(config), rows: 8, className: 'textarea page-json-input' });
    append(body, [
      notice('该数据源使用 JSON 配置；保存时会与服务端现有配置合并。', 'info'),
      field('配置 JSON', area, { help: '必须是 JSON 对象，例如 {"baseUrl": "https://..."}。' }),
    ]);
    openModal({
      title: `配置数据源：${provider.name || key}`,
      body,
      actions: [
        { label: '取消' },
        {
          label: '保存',
          variant: 'primary',
          onClick: async (close) => {
            if (submitting) return;
            let parsed;
            try {
              parsed = JSON.parse(area.value || '{}');
            } catch (error) {
              errorBox.textContent = `JSON 格式错误：${error.message}`;
              errorBox.classList.remove('hidden');
              return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              errorBox.textContent = '配置必须是 JSON 对象';
              errorBox.classList.remove('hidden');
              return;
            }
            try {
              submitting = true;
              await api.patch(`/api/v1/settings/providers/${encodeURIComponent(key)}`, { config: parsed });
              toast('数据源配置已保存', 'success');
              close();
              reload();
            } catch (error) {
              errorBox.textContent = error?.message || '保存失败';
              errorBox.classList.remove('hidden');
            } finally {
              submitting = false;
            }
          },
        },
      ],
    });
  }
  body.appendChild(errorBox);
}

/* --------------------------------------------------------- email accounts */

async function renderEmailAccountsSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载邮箱账户…'));
  let data;
  try {
    data = await api.get('/api/v1/email-accounts');
  } catch (error) {
    clear(host);
    host.appendChild(
      el('div', 'stack', [
        notice(`邮箱账户接口暂不可用（后端可能仍在开发）：${error?.message || '未知错误'}`, 'warn'),
        errorCard(error, () => renderEmailAccountsSection(host)),
      ]),
    );
    return;
  }
  clear(host);
  const accounts = (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : asArray(data?.accounts)).map(normalizeAccount);
  const canManage = can('email.accounts.manage');
  const canSync = can('email.sync');
  const reload = () => renderEmailAccountsSection(host);
  let tabs = null;

  const addButton = button('添加邮箱账户', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !canManage,
    title: disabledTip('email.accounts.manage'),
    onClick: () => tabs?.show('create'),
  });

  const columns = [
    {
      key: 'name',
      label: '账户',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main', row.name || row.address || '—'),
          el('div', 'cell-sub', row.address || ''),
        ]);
        return wrap;
      },
    },
    {
      key: 'protocol',
      label: '协议',
      render: (row) => badge(row.protocol === 'simulation' ? '模拟邮箱' : 'SMTP / IMAP', row.protocol === 'simulation' ? 'purple' : 'cyan'),
    },
    {
      key: 'servers',
      label: '服务器',
      render: (row) => {
        if (row.protocol === 'simulation') return el('span', 'muted', '离线模拟');
        const textValue = `SMTP ${row.smtpHost || '—'}:${row.smtpPort || '—'} / IMAP ${row.imapHost || '—'}:${row.imapPort || '—'}`;
        return el('span', 'mono page-break', truncate(textValue, 70));
      },
    },
    { key: 'dailyLimit', label: '日限额', align: 'right', render: (row) => formatNumber(row.dailyLimit) },
    {
      key: 'status',
      label: '状态',
      render: (row) => {
        const [label, tone] = ACCOUNT_STATUS[row.status] || [row.status || '未知', 'gray'];
        return badge(label, tone, { dot: true });
      },
    },
    {
      key: 'lastSyncAt',
      label: '最近同步',
      render: (row) => el('span', 'muted nowrap', row.lastSyncAt ? relativeTime(row.lastSyncAt) : '从未同步'),
    },
    {
      key: 'actions',
      label: '操作',
      className: 'cell-actions',
      render: (row) => {
        const wrap = el('div', 'row page-row-actions');
        wrap.appendChild(
          button('编辑', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'edit',
            disabled: !canManage,
            title: disabledTip('email.accounts.manage'),
            onClick: () => openAccountModal(row, reload),
          }),
        );
        wrap.appendChild(
          button('测试', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'zap',
            disabled: !canManage,
            title: disabledTip('email.accounts.manage'),
            onClick: () => testAccount(row),
          }),
        );
        wrap.appendChild(
          button('同步', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'refresh',
            disabled: !canSync,
            title: disabledTip('email.sync'),
            onClick: () => syncAccount(row),
          }),
        );
        wrap.appendChild(
          button(row.status === 'paused' ? '启用' : '暂停', {
            variant: 'ghost',
            size: 'sm',
            iconName: row.status === 'paused' ? 'play' : 'pause',
            disabled: !canManage,
            title: disabledTip('email.accounts.manage'),
            onClick: () => toggleAccount(row),
          }),
        );
        wrap.appendChild(
          button('删除', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'trash',
            disabled: !canManage,
            title: disabledTip('email.accounts.manage'),
            onClick: () => removeAccount(row),
          }),
        );
        return wrap;
      },
    },
  ];

  async function testAccount(row) {
    try {
      const result = await api.post(`/api/v1/email-accounts/${encodeURIComponent(row.id)}/test-connection`, {});
      const ok = result?.ok !== false;
      const latency = result?.latencyMs !== undefined ? ` · ${formatNumber(result.latencyMs)} ms` : '';
      toast(ok ? `连接成功${latency}` : `连接失败${result?.error ? `：${result.error}` : ''}`, ok ? 'success' : 'error');
    } catch (error) {
      toast(error?.message || '测试连接失败', 'error');
    }
  }

  async function syncAccount(row) {
    try {
      await api.post(`/api/v1/email-accounts/${encodeURIComponent(row.id)}/sync`, {});
      toast('同步任务已排队，可在任务队列查看进度', 'success');
    } catch (error) {
      toast(error?.message || '同步请求失败', 'error');
    }
  }

  async function toggleAccount(row) {
    try {
      await api.patch(`/api/v1/email-accounts/${encodeURIComponent(row.id)}`, {
        status: row.status === 'paused' ? 'active' : 'paused',
      });
      toast(row.status === 'paused' ? '邮箱账户已启用' : '邮箱账户已暂停', 'success');
      reload();
    } catch (error) {
      toast(error?.message || '操作失败', 'error');
    }
  }

  async function removeAccount(row) {
    const confirmed = await confirmDialog({
      title: '删除邮箱账户',
      message: `将删除「${row.name || row.address}」。删除后无法再使用该账户发送或同步邮件，历史邮件仍保留。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/v1/email-accounts/${encodeURIComponent(row.id)}`);
      toast('邮箱账户已删除', 'success');
      reload();
    } catch (error) {
      toast(error?.message || '删除失败', 'error');
    }
  }

  const listCard = card({
    title: '邮箱账户列表',
    help: '密码只提交加密存储，保存后不会回显；发送仍受审批、抑制名单与发送窗口限制。',
    actions: [addButton],
    body: dataTable({
      columns,
      rows: accounts,
      empty: emptyState({
        iconName: 'mail',
        title: '还没有邮箱账户',
        description: '添加 SMTP/IMAP 账户或使用模拟邮箱，才能发送开发信与同步回复。',
        action: canManage
          ? button('去新增账户', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: () => tabs?.show('create') })
          : null,
      }),
    }),
  });
  const createCard = card({
    title: '新增邮箱账户',
    help: '真实邮箱需填写 SMTP / IMAP 与密码；Hostinger 用户可一键填入官方服务器地址。密码保存后不会回显。',
    body: createAccountFormNode({
      account: null,
      onSaved: async () => {
        subTabState.email = 'list';
        await reload();
      },
    }),
  });
  tabs = subTabs(
    'email',
    [
      { key: 'list', label: '账户列表', node: listCard },
      { key: 'create', label: '新增账户', node: createCard },
    ],
    'list',
  );
  host.appendChild(tabs.node);
  if (!canManage) host.appendChild(permissionNotice('email.accounts.manage', '管理邮箱账户'));
}

function createAccountFormNode({ account = null, onSaved = null } = {}) {
  let submitting = false;
  const isEdit = Boolean(account?.id);
  const canSave = can('email.accounts.manage');
  const source = account || {
    protocol: 'smtp_imap',
    smtpPort: 587,
    imapPort: 993,
    smtpSecure: true,
    imapSecure: true,
    dailyLimit: 50,
  };
  const nameInput = input({ value: source.name || '', placeholder: '例如：欧洲销售主邮箱' });
  const addressInput = input({ value: source.address || '', placeholder: 'sales@company.com', type: 'email' });
  const displayNameInput = input({ value: source.displayName || '', placeholder: '发件人显示名' });
  const protocolSelect = select({
    value: source.protocol || 'smtp_imap',
    options: [
      { value: 'smtp_imap', label: 'SMTP / IMAP（真实邮箱）' },
      { value: 'simulation', label: '模拟邮箱（离线演示）' },
    ],
  });
  const smtpHostInput = input({ value: source.smtpHost || '', placeholder: 'smtp.example.com' });
  const smtpPortInput = numberInput(source.smtpPort ?? 587, { min: 1, max: 65535 });
  const smtpSecureBox = checkControl('SMTP 使用 SSL/TLS', source.smtpSecure !== false);
  const imapHostInput = input({ value: source.imapHost || '', placeholder: 'imap.example.com' });
  const imapPortInput = numberInput(source.imapPort ?? 993, { min: 1, max: 65535 });
  const imapSecureBox = checkControl('IMAP 使用 SSL/TLS', source.imapSecure !== false);
  const usernameInput = input({ value: source.username || '', placeholder: '登录用户名（通常为邮箱）' });
  const passwordInput = input({
    value: '',
    type: 'password',
    autocomplete: 'new-password',
    placeholder: isEdit ? '留空则不修改密码' : '邮箱密码或应用专用密码',
  });
  const signatureInput = textarea({ value: source.signature || '', rows: 3, placeholder: '邮件签名（纯文本）' });
  const dailyLimitInput = numberInput(source.dailyLimit ?? 50, { min: 1, max: 1000 });
  const errorBox = el('div', 'field-error hidden');

  const hostingerButton = !isEdit
    ? button('Hostinger 预设', {
        variant: 'outline',
        size: 'sm',
        iconName: 'zap',
        title: '填入 Hostinger 官方 SMTP / IMAP 地址与端口，不会填写密码',
        onClick: () => {
          protocolSelect.value = 'smtp_imap';
          smtpHostInput.value = 'smtp.hostinger.com';
          smtpPortInput.value = '465';
          smtpSecureBox.querySelector('input').checked = true;
          imapHostInput.value = 'imap.hostinger.com';
          imapPortInput.value = '993';
          imapSecureBox.querySelector('input').checked = true;
          toast('已填入 Hostinger 预设，请补充邮箱地址与密码', 'info');
        },
      })
    : null;

  const servers = el('div', 'form-grid page-form');
  append(servers, [
    field('SMTP 主机', smtpHostInput, { required: true }),
    field('SMTP 端口', smtpPortInput, { required: true }),
    field('SMTP 加密', smtpSecureBox),
    field('IMAP 主机', imapHostInput, { required: true }),
    field('IMAP 端口', imapPortInput, { required: true }),
    field('IMAP 加密', imapSecureBox),
    field('用户名', usernameInput, { help: '留空时默认使用邮箱地址。' }),
    field('密码', passwordInput, {
      help: '密码只提交给服务端加密存储，保存后不会回显；编辑时留空表示不修改。',
    }),
  ]);

  const body = el('div', 'stack');
  const basics = el('div', 'form-grid page-form');
  append(basics, [
    field('账户名称', nameInput, { required: true }),
    field('邮箱地址', addressInput, { required: true }),
    field('显示名', displayNameInput),
    field('协议', protocolSelect, { required: true, help: '模拟邮箱仅用于演示，不会连接真实服务器。' }),
    field('日发送限额', dailyLimitInput, { required: true, help: '单账户每日发送上限，仍受工作空间总限额约束。' }),
  ]);
  body.appendChild(basics);
  body.appendChild(sectionTitle('服务器与登录'));
  if (hostingerButton) {
    const presetRow = el('div', 'row page-hostinger-row');
    append(presetRow, [
      hostingerButton,
      helpTip('一键填入 Hostinger 官方 SMTP（smtp.hostinger.com:465，SSL）与 IMAP（imap.hostinger.com:993，SSL）；不会填写密码，请自行补充邮箱地址与密码。'),
    ]);
    body.appendChild(presetRow);
  }
  body.appendChild(servers);
  body.appendChild(field('邮件签名', signatureInput, { help: '纯文本签名，会附加在发送邮件末尾。' }));
  body.appendChild(errorBox);

  const saveButton = button(isEdit ? '保存修改' : '添加邮箱账户', {
    variant: 'primary',
    iconName: 'check',
    disabled: !canSave,
    title: disabledTip('email.accounts.manage'),
    onClick: async () => {
      if (submitting) return;
          errorBox.classList.add('hidden');
          const name = nameInput.value.trim();
          const address = addressInput.value.trim();
          const protocol = protocolSelect.value;
          const password = passwordInput.value;
          const dailyLimit = readInt(dailyLimitInput, 0);
          if (!name) {
            errorBox.textContent = '请填写账户名称';
            errorBox.classList.remove('hidden');
            return;
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
            errorBox.textContent = '请输入合法的邮箱地址';
            errorBox.classList.remove('hidden');
            return;
          }
          if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) {
            errorBox.textContent = '日发送限额必须是 1–1000 的整数';
            errorBox.classList.remove('hidden');
            return;
          }
          if (protocol === 'smtp_imap') {
            const smtpPort = readInt(smtpPortInput, 0);
            const imapPort = readInt(imapPortInput, 0);
            if (!smtpHostInput.value.trim() || !smtpPortInput.value.trim()) {
              errorBox.textContent = '真实邮箱需要填写 SMTP 主机与端口';
              errorBox.classList.remove('hidden');
              return;
            }
            if (!imapHostInput.value.trim() || !imapPortInput.value.trim()) {
              errorBox.textContent = '真实邮箱需要填写 IMAP 主机与端口';
              errorBox.classList.remove('hidden');
              return;
            }
            if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
              errorBox.textContent = 'SMTP 端口必须是 1–65535 的整数';
              errorBox.classList.remove('hidden');
              return;
            }
            if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
              errorBox.textContent = 'IMAP 端口必须是 1–65535 的整数';
              errorBox.classList.remove('hidden');
              return;
            }
          }
          if (password && password.length < 6) {
            errorBox.textContent = '密码至少需要 6 位';
            errorBox.classList.remove('hidden');
            return;
          }
          if (!isEdit && protocol === 'smtp_imap' && !password) {
            errorBox.textContent = '新建真实邮箱需要填写密码或应用专用密码';
            errorBox.classList.remove('hidden');
            return;
          }
          const payload = {
            name,
            address,
            displayName: displayNameInput.value.trim(),
            protocol,
            smtpHost: smtpHostInput.value.trim(),
            smtpPort: readInt(smtpPortInput, 587),
            smtpSecure: checkedOf(smtpSecureBox),
            imapHost: imapHostInput.value.trim(),
            imapPort: readInt(imapPortInput, 993),
            imapSecure: checkedOf(imapSecureBox),
            username: usernameInput.value.trim(),
            password: password || undefined,
            signature: signatureInput.value,
            dailyLimit,
          };
          try {
            submitting = true;
            if (isEdit) {
              await api.patch(`/api/v1/email-accounts/${encodeURIComponent(account.id)}`, payload);
              toast('邮箱账户已更新', 'success');
            } else {
              await api.post('/api/v1/email-accounts', payload);
              toast('邮箱账户已添加', 'success');
            }
            await onSaved?.();
          } catch (error) {
            errorBox.textContent = error?.message || '保存失败';
            errorBox.classList.remove('hidden');
          } finally {
            submitting = false;
            saveButton.disabled = !canSave;
          }
        },
  });
  body.appendChild(el('div', 'row', [saveButton]));
  return body;
}

function openAccountModal(account, reload) {
  let closeModal = () => {};
  const isEdit = Boolean(account?.id);
  const formNode = createAccountFormNode({
    account,
    onSaved: async () => {
      closeModal();
      await reload();
    },
  });
  const modal = openModal({
    title: isEdit ? '编辑邮箱账户' : '添加邮箱账户',
    size: 'lg',
    body: formNode,
    actions: [{ label: '取消' }],
  });
  closeModal = modal.close;
}

function normalizeAccount(raw) {
  const item = asObject(raw);
  return {
    id: item.id || '',
    name: item.name || '',
    address: item.address || item.email || '',
    displayName: item.displayName || item.display_name || '',
    protocol: item.protocol || 'smtp_imap',
    smtpHost: item.smtpHost || item.smtp_host || '',
    smtpPort: item.smtpPort ?? item.smtp_port ?? null,
    smtpSecure: item.smtpSecure ?? item.smtp_secure ?? true,
    imapHost: item.imapHost || item.imap_host || '',
    imapPort: item.imapPort ?? item.imap_port ?? null,
    imapSecure: item.imapSecure ?? item.imap_secure ?? true,
    username: item.username || '',
    signature: item.signature || '',
    dailyLimit: item.dailyLimit ?? item.daily_limit ?? 50,
    status: item.status || 'active',
    lastSyncAt: item.lastSyncAt || item.last_sync_at || null,
    lastError: item.lastError || item.last_error || null,
    createdAt: item.createdAt || item.created_at || null,
  };
}

/* ------------------------------------------------------ outreach & limits */

async function renderOutreachSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载发送设置…'));
  let data = null;
  let error = null;
  try {
    data = await api.get('/api/v1/settings');
  } catch (requestError) {
    error = requestError;
  }
  clear(host);
  if (error) {
    host.appendChild(notice(`设置接口暂不可用，已显示默认值（保存可能失败）：${error.message}`, 'warn'));
  }
  const settings = normalizeSettings(data?.settings);
  const outreach = settings.outreach;
  const limits = settings.limits;
  const canManage = can('settings.manage');
  const reload = () => renderOutreachSection(host);
  const windowSettings = asObject(outreach.sendWindow);

  // Sending policy
  const approvalBox = checkControl('人工审批（关闭 = AI 草稿自动批准）', outreach.requireApproval !== false);
  const autoSendBox = checkControl('开启自动发送（仍受全部发送前检查限制）', outreach.autoSendEnabled === true);
  const dailySendInput = numberInput(outreach.dailySendLimit ?? 50, { min: 1, max: 1000 });
  const startSelect = select({
    value: String(windowSettings.start ?? 9),
    options: Array.from({ length: 24 }, (_, index) => ({ value: String(index), label: `${String(index).padStart(2, '0')}:00` })),
    placeholder: null,
  });
  const endSelect = select({
    value: String(Math.min(23, Math.max(0, Number(windowSettings.end ?? 17)))),
    options: Array.from({ length: 24 }, (_, index) => ({
      value: String(index),
      label: `${String(index).padStart(2, '0')}:00`,
    })),
    placeholder: null,
  });
  const timezoneInput = input({ value: windowSettings.timezone || 'Europe/Berlin', placeholder: 'Europe/Berlin' });
  const weekdays = Array.isArray(windowSettings.weekdays) ? windowSettings.weekdays.map(Number) : [1, 2, 3, 4, 5];
  const weekdayBoxes = [
    ['周一', 1],
    ['周二', 2],
    ['周三', 3],
    ['周四', 4],
    ['周五', 5],
    ['周六', 6],
    ['周日', 7],
  ].map(([label, value]) => ({ value, node: checkControl(label, weekdays.includes(value)) }));
  const weekdayRow = el('div', 'row page-weekdays');
  for (const item of weekdayBoxes) weekdayRow.appendChild(item.node);
  const signatureInput = textarea({ value: outreach.signature || '', rows: 3, placeholder: '邮件签名（纯文本）' });
  const languageOptions = [...LANGUAGE_OPTIONS];
  if (outreach.defaultLanguage && !languageOptions.some((item) => item.value === outreach.defaultLanguage)) {
    languageOptions.push({ value: outreach.defaultLanguage, label: outreach.defaultLanguage });
  }
  const languageSelect = select({
    value: outreach.defaultLanguage || 'en',
    options: languageOptions,
    placeholder: null,
  });

  const outreachForm = el('div', 'form-grid page-form');
  append(outreachForm, [
    field('人工审批', approvalBox, {
      help: '关闭后 AI 草稿会自动变为“已批准”；发送仍需手动触发，或由自动发送结合发送窗口检查执行。默认建议保持开启。',
    }),
    field('自动发送', autoSendBox, {
      help: '自动发送仍受审批、抑制名单、人工接管、发送窗口与限额限制；关闭人工审批不等于自动发送。',
    }),
    field('每日发送上限', dailySendInput, { required: true, help: '工作空间级每日发送上限（1–1000）。' }),
    field('默认语言', languageSelect, { help: '生成开发信时的默认语言。' }),
    field('发送窗口开始', startSelect, { help: '仅在窗口内发送，时区见右侧。' }),
    field('发送窗口结束', endSelect, { help: '结束时间必须晚于开始时间。' }),
    field('时区', timezoneInput, { required: true, help: 'IANA 时区，默认 Europe/Berlin。' }),
    field('发送日', weekdayRow, { help: '只有勾选的星期会发送邮件。' }),
    field('邮件签名', signatureInput, { help: '会附加到发送邮件末尾，建议包含公司与地址信息。' }),
  ]);
  const saveOutreachButton = button('保存发送策略', {
    variant: 'primary',
    iconName: 'check',
    disabled: !canManage,
    title: disabledTip('settings.manage'),
    onClick: async () => {
      const dailySendLimit = readInt(dailySendInput, 0);
      const start = Number(startSelect.value);
      const end = Number(endSelect.value);
      const timezone = timezoneInput.value.trim();
      const selectedWeekdays = weekdayBoxes.filter((item) => checkedOf(item.node)).map((item) => item.value);
      if (!Number.isInteger(dailySendLimit) || dailySendLimit < 1 || dailySendLimit > 1000) {
        toast('每日发送上限必须是 1–1000 的整数', 'error');
        return;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        toast('发送窗口结束时间必须晚于开始时间', 'error');
        return;
      }
      if (!selectedWeekdays.length) {
        toast('至少选择一个发送日', 'error');
        return;
      }
      if (!timezone) {
        toast('请填写发送时区', 'error');
        return;
      }
      saveOutreachButton.disabled = true;
      try {
        await api.patch('/api/v1/settings', {
          outreach: {
            requireApproval: checkedOf(approvalBox),
            autoSendEnabled: checkedOf(autoSendBox),
            dailySendLimit,
            sendWindow: { start, end, weekdays: selectedWeekdays, timezone },
            signature: signatureInput.value,
            defaultLanguage: languageSelect.value,
          },
        });
        toast('发送策略已保存', 'success');
        reload();
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
        saveOutreachButton.disabled = !canManage;
      }
    },
  });
  outreachForm.appendChild(el('div', 'span-2 row', [saveOutreachButton]));
  const policyCard = card({
    title: '发送策略',
    help: '默认开启人工审批。关闭人工审批后 AI 草稿会自动变为已批准，但发送仍需手动触发或由自动发送结合发送窗口执行；自动发送仍受审批、抑制名单、人工接管、发送窗口与限额限制。',
    body: outreachForm,
  });

  // Resource limits
  const limitFields = [
    { key: 'dailyEmailLimit', label: '每日邮件上限', min: 1, max: 5000, help: '工作空间每天最多发送的邮件数。' },
    { key: 'dailyAiTokens', label: '每日 AI Token 上限', min: 0, max: 100000000, help: '0 表示不限制；超出后 Agent 执行会被拒绝。' },
    { key: 'hourlyJobLimit', label: '每小时任务上限', min: 1, max: 10000, help: '控制后台任务与外部请求频率。' },
    { key: 'maxCrawlPagesPerJob', label: '单任务抓取页数上限', min: 1, max: 200, help: '单个抓取任务最多访问的页面数。' },
    { key: 'maxCompaniesPerDiscovery', label: '单次发现企业上限', min: 1, max: 2000, help: '一次企业发现最多写入的企业数。' },
  ];
  const limitInputs = {};
  const limitForm = el('div', 'form-grid page-form');
  for (const item of limitFields) {
    const control = numberInput(limits[item.key] ?? DEFAULT_SETTINGS.limits[item.key], { min: item.min, max: item.max });
    limitInputs[item.key] = control;
    limitForm.appendChild(field(item.label, control, { required: true, help: item.help }));
  }
  const saveLimitsButton = button('保存限额', {
    variant: 'primary',
    iconName: 'check',
    disabled: !canManage,
    title: disabledTip('settings.manage'),
    onClick: async () => {
      const next = {};
      for (const item of limitFields) {
        const value = readInt(limitInputs[item.key], NaN);
        if (!Number.isInteger(value) || value < item.min || value > item.max) {
          toast(`${item.label}必须在 ${item.min}–${item.max} 之间`, 'error');
          limitInputs[item.key].focus();
          return;
        }
        next[item.key] = value;
      }
      saveLimitsButton.disabled = true;
      try {
        await api.patch('/api/v1/settings', { limits: next });
        toast('资源限额已保存', 'success');
        reload();
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
        saveLimitsButton.disabled = !canManage;
      }
    },
  });
  limitForm.appendChild(el('div', 'span-2 row', [saveLimitsButton]));
  const limitsCard = card({
    title: '资源与成本限额',
    help: '限额用于控制外部请求、AI Token 与抓取成本；超限时任务会被拒绝或延后，而不是伪造成功。',
    body: limitForm,
  });
  const tabs = subTabs(
    'outreach',
    [
      { key: 'policy', label: '发送策略', node: policyCard },
      { key: 'limits', label: '资源与成本限额', node: limitsCard },
    ],
    'policy',
  );
  host.appendChild(tabs.node);
  if (!canManage) host.appendChild(permissionNotice('settings.manage', '修改发送与限额'));
}

/* ------------------------------------------------------------- compliance */

async function renderComplianceSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载合规设置…'));
  let data = null;
  let error = null;
  try {
    data = await api.get('/api/v1/settings');
  } catch (requestError) {
    error = requestError;
  }
  clear(host);
  if (error) host.appendChild(notice(`设置接口暂不可用，已显示默认值（保存可能失败）：${error.message}`, 'warn'));
  const compliance = normalizeSettings(data?.settings).compliance;
  const canManage = can('settings.manage');
  const reload = () => renderComplianceSection(host);

  const legalOptions = [...LEGAL_BASIS_OPTIONS];
  if (compliance.legalBasis && !legalOptions.some((item) => item.value === compliance.legalBasis)) {
    legalOptions.push({ value: compliance.legalBasis, label: compliance.legalBasis });
  }
  const legalSelect = select({ value: compliance.legalBasis || 'legitimate_interest', options: legalOptions, placeholder: null });
  const unsubscribeBox = checkControl('邮件包含退订链接与说明', compliance.includeUnsubscribe !== false);
  const companyInput = input({ value: compliance.senderCompanyName || '', placeholder: '发件公司法定名称' });
  const addressInput = textarea({ value: compliance.senderAddress || '', rows: 2, placeholder: '公司注册地址（用于邮件页脚）' });
  const privacyInput = input({ value: compliance.privacyUrl || '', placeholder: 'https://example.com/privacy', type: 'url' });
  const dncInput = textarea({ value: compliance.doNotContactNote || '', rows: 2, placeholder: '拒绝联系说明/记录方式' });

  const policyForm = el('div', 'form-grid page-form');
  append(policyForm, [
    field('法律依据', legalSelect, { required: true, help: 'B2B 营销常用正当利益，但仍需按目标国家规则评估。' }),
    field('退订机制', unsubscribeBox, { help: '建议始终保留；退订会自动加入抑制名单并停止自动化。' }),
    field('拒绝联系说明', dncInput, { help: '记录如何处理拒绝联系请求，便于内部审计。' }),
  ]);
  const savePolicyButton = button('保存合规策略', {
    variant: 'primary',
    iconName: 'shield',
    disabled: !canManage,
    title: disabledTip('settings.manage'),
    onClick: async () => {
      savePolicyButton.disabled = true;
      try {
        await api.patch('/api/v1/settings', {
          compliance: {
            legalBasis: legalSelect.value,
            includeUnsubscribe: checkedOf(unsubscribeBox),
            doNotContactNote: dncInput.value.trim(),
          },
        });
        toast('合规策略已保存', 'success');
        reload();
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
        savePolicyButton.disabled = !canManage;
      }
    },
  });
  policyForm.appendChild(el('div', 'span-2 row', [savePolicyButton]));

  const senderForm = el('div', 'form-grid page-form');
  append(senderForm, [
    field('发件公司名称', companyInput, { help: '用于邮件页脚与身份识别。' }),
    field('公司地址', addressInput, { help: '欧盟电子营销规则通常要求可识别的发件人信息。' }),
    field('隐私政策链接', privacyInput, { help: '可选；填写时必须是 http(s) 地址。' }),
  ]);
  const saveSenderButton = button('保存发件人信息', {
    variant: 'primary',
    iconName: 'shield',
    disabled: !canManage,
    title: disabledTip('settings.manage'),
    onClick: async () => {
      const privacyUrl = privacyInput.value.trim();
      if (privacyUrl && !/^https?:\/\/[^\s]+$/i.test(privacyUrl)) {
        toast('隐私政策链接必须是 http(s) 地址', 'error');
        privacyInput.focus();
        return;
      }
      saveSenderButton.disabled = true;
      try {
        await api.patch('/api/v1/settings', {
          compliance: {
            senderCompanyName: companyInput.value.trim(),
            senderAddress: addressInput.value.trim(),
            privacyUrl,
          },
        });
        toast('发件人信息已保存', 'success');
        reload();
      } catch (error) {
        toast(error?.message || '保存失败', 'error');
        saveSenderButton.disabled = !canManage;
      }
    },
  });
  senderForm.appendChild(el('div', 'span-2 row', [saveSenderButton]));

  const tabs = subTabs(
    'compliance',
    [
      {
        key: 'policy',
        label: '合规策略',
        node: card({
          title: '合规策略',
          help: '涉及 GDPR 与欧盟电子营销规则（如 ePrivacy）。避免对个人邮箱做未经请求的营销，保留退订与拒绝联系记录；本配置不构成法律意见。',
          body: policyForm,
        }),
      },
      {
        key: 'sender',
        label: '发件人信息',
        node: card({
          title: '发件人信息',
          help: '欧盟电子营销规则通常要求可识别的发件人身份与地址；信息会用于邮件页脚与隐私政策链接。',
          body: senderForm,
        }),
      },
    ],
    'policy',
  );
  host.appendChild(tabs.node);
  if (!canManage) host.appendChild(permissionNotice('settings.manage', '修改合规设置'));
}

/* -------------------------------------------------------------- API keys */

async function renderApiKeysSection(host) {
  clear(host);
  host.appendChild(loadingBlock('正在加载 API 密钥…'));
  let data;
  try {
    data = await api.get('/api/v1/auth/api-keys');
  } catch (error) {
    clear(host);
    host.appendChild(errorCard(error, () => renderApiKeysSection(host)));
    return;
  }
  clear(host);
  const keys = (Array.isArray(data?.items) ? data.items : asArray(data?.keys)).map(normalizeApiKey);
  const canManage = can('credentials.manage');
  const reload = () => renderApiKeysSection(host);

  const createButton = button('创建 API 密钥', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !canManage,
    title: disabledTip('credentials.manage'),
    onClick: () => openApiKeyCreateModal(reload),
  });

  const columns = [
    {
      key: 'name',
      label: '名称',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main', row.name || '未命名密钥'),
          el('div', 'cell-sub mono', row.prefix ? `${row.prefix}…` : ''),
        ]);
        return wrap;
      },
    },
    { key: 'scopes', label: '权限范围', render: (row) => (row.scopes.length ? chips(row.scopes) : el('span', 'muted', '—')) },
    { key: 'lastUsedAt', label: '最后使用', render: (row) => el('span', 'muted nowrap', row.lastUsedAt ? relativeTime(row.lastUsedAt) : '从未使用') },
    { key: 'createdAt', label: '创建时间', render: (row) => el('span', 'muted nowrap', formatDateTime(row.createdAt)) },
    {
      key: 'status',
      label: '状态',
      render: (row) => badge(row.revokedAt ? '已吊销' : '有效', row.revokedAt ? 'red' : 'green', { dot: true }),
    },
    {
      key: 'actions',
      label: '操作',
      className: 'cell-actions',
      render: (row) =>
        row.revokedAt
          ? el('span', 'muted', '已吊销')
          : button('吊销', {
              variant: 'ghost',
              size: 'sm',
              iconName: 'trash',
              disabled: !canManage,
              title: disabledTip('credentials.manage'),
              onClick: async () => {
                const confirmed = await confirmDialog({
                  title: '吊销 API 密钥',
                  message: `吊销「${row.name || row.prefix}」后，使用该密钥的自动化会立即失效，且无法恢复。`,
                  confirmText: '吊销',
                  danger: true,
                });
                if (!confirmed) return;
                try {
                  await api.delete(`/api/v1/auth/api-keys/${encodeURIComponent(row.id)}`);
                  toast('API 密钥已吊销', 'success');
                  reload();
                } catch (error) {
                  toast(error?.message || '吊销失败', 'error');
                }
              },
            }),
    },
  ];

  host.appendChild(
    el('div', 'row-between', [
      sectionTitle(
        'API 密钥',
        '用于自动化脚本或外部系统调用本平台接口。密钥只在创建时显示一次，请立即妥善保存；按最小权限原则只勾选必要的范围。',
      ),
      createButton,
    ]),
  );
  host.appendChild(
    dataTable({
      columns,
      rows: keys,
      empty: emptyState({
        iconName: 'key',
        title: '还没有 API 密钥',
        description: '创建后可用于自动化集成；密钥仅在创建时显示一次。',
        action: canManage
          ? button('创建 API 密钥', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: () => openApiKeyCreateModal(reload) })
          : null,
      }),
    }),
  );
  if (!canManage) host.appendChild(permissionNotice('credentials.manage', '管理 API 密钥'));
}

function openApiKeyCreateModal(reload) {
  let submitting = false;
  const nameInput = input({ value: '', placeholder: '例如：CI 同步脚本' });
  const scopeBoxes = API_SCOPES.map((scope) => ({ scope, node: checkControl(scope.label, false) }));
  const scopeList = el('div', 'stack page-scope-list');
  for (const item of scopeBoxes) scopeList.appendChild(item.node);
  const errorBox = el('div', 'field-error hidden');
  const body = el('div', 'stack');
  append(body, [
    field('名称', nameInput, { required: true, help: '用于识别密钥用途。' }),
    field('权限范围', scopeList, { help: '不勾选表示仅能通过会话访问，不能作为自动化密钥使用。' }),
    errorBox,
  ]);
  openModal({
    title: '创建 API 密钥',
    body,
    actions: [
      { label: '取消' },
      {
        label: '创建',
        variant: 'primary',
        onClick: async (close) => {
          if (submitting) return;
          errorBox.classList.add('hidden');
          const name = nameInput.value.trim();
          if (!name) {
            errorBox.textContent = '请填写密钥名称';
            errorBox.classList.remove('hidden');
            return;
          }
          const scopes = scopeBoxes.filter((item) => checkedOf(item.node)).map((item) => item.scope.value);
          try {
            submitting = true;
            const created = await api.post('/api/v1/auth/api-keys', { name, scopes });
            close();
            showApiKeyTokenModal(created);
            reload();
          } catch (error) {
            errorBox.textContent = error?.message || '创建失败';
            errorBox.classList.remove('hidden');
          } finally {
            submitting = false;
          }
        },
      },
    ],
  });
}

function showApiKeyTokenModal(created) {
  const token = created?.token || '';
  const body = el('div', 'stack');
  body.appendChild(
    notice('令牌仅显示一次，关闭后无法再次查看。请立即复制并保存到安全的密钥管理工具中。', 'warn'),
  );
  body.appendChild(
    detailRows([
      { label: '名称', value: created?.name || '—' },
      { label: '权限范围', value: asArray(created?.scopes).length ? chips(created.scopes) : '—' },
      { label: '提示', value: created?.note || '令牌仅显示一次，请立即保存' },
    ]),
  );
  const line = el('div', 'copy-line page-break');
  line.textContent = token || '—';
  body.appendChild(line);
  if (token) body.appendChild(el('div', 'row', [copyButton(token, '复制令牌')]));
  openModal({ title: 'API 密钥已创建', body, actions: [{ label: '我已保存', variant: 'primary' }] });
}

function normalizeApiKey(raw) {
  const item = asObject(raw);
  return {
    id: item.id || '',
    name: item.name || '',
    prefix: item.prefix || item.keyPrefix || '',
    scopes: asArray(item.scopes),
    lastUsedAt: item.lastUsedAt || item.last_used_at || null,
    expiresAt: item.expiresAt || item.expires_at || null,
    revokedAt: item.revokedAt || item.revoked_at || null,
    createdAt: item.createdAt || item.created_at || null,
  };
}

/* ----------------------------------------------------------------- usage */

async function renderUsageSection(host) {
  clear(host);
  const canRead = can('settings.read');
  if (!canRead) {
    host.appendChild(permissionNotice('settings.read', '查看用量'));
    return;
  }
  const toolbarRow = el('div', 'row page-usage-toolbar');
  const daySelect = select({
    value: String(usageState.days),
    options: [
      { value: '7', label: '近 7 天' },
      { value: '30', label: '近 30 天' },
      { value: '90', label: '近 90 天' },
    ],
    className: 'select filter-select',
    onChange: (value) => {
      usageState.days = Number(value) || 30;
      loadUsage();
    },
  });
  const metricSeg = segmented({
    items: [
      { value: 'aiTokens', label: 'AI Token' },
      { value: 'emailsSent', label: '邮件' },
      { value: 'cost', label: '成本' },
    ],
    value: usageState.metric,
    onChange: (value) => {
      usageState.metric = value;
      renderTrend();
    },
  });
  append(toolbarRow, [
    daySelect,
    el('span', 'grow'),
    helpTip('数据来源：usage_records 与 agent_executions，按天聚合；成本为按 Provider 单价的估算值。'),
  ]);

  const bodyHost = el('div', 'stack');
  append(host, [toolbarRow, bodyHost]);

  let usage = null;
  let trendHost = null;

  async function loadUsage() {
    clear(bodyHost);
    bodyHost.appendChild(loadingBlock('正在统计用量…'));
    try {
      usage = await api.get(`/api/v1/usage${queryString({ days: usageState.days })}`);
      renderUsage();
    } catch (error) {
      clear(bodyHost);
      bodyHost.appendChild(errorCard(error, () => loadUsage()));
    }
  }

  function renderUsage() {
    clear(bodyHost);
    const totals = asObject(usage?.totals);
    const statGrid = el('div', 'stat-grid');
    statGrid.appendChild(
      statCard({
        label: 'AI Token',
        value: formatCompact(totals.aiTokens ?? totals.ai_tokens ?? 0),
        hint: `近 ${usageState.days} 天`,
        iconName: 'zap',
        help: '模型调用消耗的输入与输出 Token 合计。',
      }),
    );
    statGrid.appendChild(
      statCard({
        label: '邮件发送',
        value: formatCompact(totals.emailsSent ?? totals.emails_sent ?? 0),
        hint: `近 ${usageState.days} 天`,
        iconName: 'send',
        help: '实际发送成功的邮件数量（失败不会计入）。',
      }),
    );
    statGrid.appendChild(
      statCard({
        label: 'Agent 执行',
        value: formatCompact(totals.agentRuns ?? totals.agent_runs ?? 0),
        hint: '含成功与失败',
        iconName: 'brain',
        help: 'Agent 执行次数，失败调用同样会消耗 Token。',
      }),
    );
    statGrid.appendChild(
      statCard({
        label: '成本估算',
        value: formatCost(totals.costEstimate ?? totals.cost_estimate ?? 0),
        hint: `按供应商单价估算`,
        iconName: 'chart',
        help: '按 Provider 定价估算的成本，仅供参考；模拟模型成本为 0。',
      }),
    );
    const overviewCard = card({
      title: '用量总览',
      help: '近一段时间内 AI Token、邮件发送、Agent 执行与估算成本的总量。',
      body: statGrid,
    });
    bodyHost.appendChild(overviewCard);

    trendHost = el('div', '');
    const trendCard = card({
      title: '用量趋势',
      help: '按天聚合的用量走势，用于判断成本与发送节奏是否异常。',
      actions: [metricSeg],
      body: trendHost,
    });

    const tables = el('div', 'page-module-split');
    const byCategory = asArray(usage?.byCategory);
    const byAgent = asArray(usage?.byAgent);
    tables.appendChild(
      card({
        title: '按类别',
        body: dataTable({
          columns: [
            {
              key: 'category',
              label: '类别',
              render: (row) => AUDIT_CATEGORY_LABELS[row.category] || row.category || '—',
            },
            { key: 'quantity', label: '数量', align: 'right', render: (row) => formatCompact(row.quantity) },
            { key: 'cost', label: '成本', align: 'right', render: (row) => formatCost(row.cost) },
          ],
          rows: byCategory,
          empty: emptyState({ iconName: 'chart', title: '暂无用量记录', description: '执行 Agent 或发送邮件后会出现统计。' }),
        }),
      }),
    );
    tables.appendChild(
      card({
        title: '按 Agent',
        body: dataTable({
          columns: [
            {
              key: 'agentRole',
              label: 'Agent',
              render: (row) => AGENT_ROLE_LABELS[row.agentRole || row.agent_role] || row.agentRole || row.agent_role || '—',
            },
            { key: 'runs', label: '执行次数', align: 'right', render: (row) => formatCompact(row.runs) },
            { key: 'tokens', label: 'Token', align: 'right', render: (row) => formatCompact(row.tokens) },
            { key: 'cost', label: '成本', align: 'right', render: (row) => formatCost(row.cost) },
          ],
          rows: byAgent,
          empty: emptyState({ iconName: 'brain', title: '暂无 Agent 执行', description: 'Agent 执行后会按角色统计。' }),
        }),
      }),
    );

    const tabs = subTabs(
      'usage',
      [
        { key: 'overview', label: '总览', node: overviewCard },
        { key: 'trend', label: '趋势', node: trendCard },
        { key: 'category', label: '分类明细', node: tables },
      ],
      'overview',
    );
    bodyHost.appendChild(tabs.node);
    renderTrend();
  }

  function renderTrend() {
    if (!trendHost) return;
    clear(trendHost);
    const byDay = asArray(usage?.byDay);
    if (!byDay.length) {
      trendHost.appendChild(
        emptyState({
          iconName: 'chart',
          title: '还没有用量数据',
          description: '执行 Agent、发送邮件或调用数据源后，这里会显示按天趋势。',
        }),
      );
      return;
    }
    const metric = usageState.metric;
    const items = byDay.map((row) => {
      const value =
        metric === 'emailsSent'
          ? toNumber(row.emailsSent ?? row.emails_sent)
          : metric === 'cost'
            ? toNumber(row.cost)
            : toNumber(row.aiTokens ?? row.ai_tokens);
      return { label: String(row.day || '').slice(5), value };
    });
    trendHost.appendChild(lineChart(items));
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const label = metric === 'emailsSent' ? '邮件合计' : metric === 'cost' ? '成本合计' : 'Token 合计';
    const display = metric === 'cost' ? formatCost(total) : formatNumber(total);
    trendHost.appendChild(el('div', 'chart-legend', [el('span', '', [el('i', ''), `${label} ${display}`])]));
  }

  await loadUsage();
}

/* ----------------------------------------------------------------- audit */

async function renderAuditSection(host) {
  clear(host);
  if (!can('audit.read')) {
    host.appendChild(permissionNotice('audit.read', '查看审计日志'));
    return;
  }
  const filterInput = input({ value: auditState.action, placeholder: '按动作筛选，如 settings.update', className: 'input page-filter-input' });
  const applyFilter = () => {
    auditState.action = filterInput.value.trim();
    auditState.page = 1;
    loadAudit();
  };
  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyFilter();
  });
  const toolbarRow = toolbar(
    filterInput,
    button('筛选', { variant: 'primary', size: 'sm', iconName: 'filter', onClick: applyFilter }),
    button('重置', {
      variant: 'ghost',
      size: 'sm',
      iconName: 'refresh',
      onClick: () => {
        auditState.action = '';
        auditState.page = 1;
        filterInput.value = '';
        loadAudit();
      },
    }),
    el('span', 'grow'),
    helpTip('敏感字段（密码、密钥、令牌）在写入审计前由服务端自动脱敏；before/after 仅用于排查变更。'),
  );
  const tableHost = el('div', '');
  const pagerHost = el('div', '');
  append(host, [toolbarRow, tableHost, pagerHost]);

  const columns = [
    {
      key: 'createdAt',
      label: '时间',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main nowrap', formatDateTime(row.createdAt)),
          el('div', 'cell-sub', relativeTime(row.createdAt)),
        ]);
        return wrap;
      },
    },
    { key: 'action', label: '动作', render: (row) => el('span', 'mono page-break', row.action || '—') },
    {
      key: 'entity',
      label: '实体',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main', row.entityType || '—'),
          el('div', 'cell-sub mono page-break', row.entityId || ''),
        ]);
        return wrap;
      },
    },
    {
      key: 'actor',
      label: '操作者',
      render: (row) => {
        const wrap = el('div');
        append(wrap, [
          el('div', 'cell-main', row.actorType || '—'),
          el('div', 'cell-sub mono page-break', row.actorId || ''),
        ]);
        return wrap;
      },
    },
    { key: 'ip', label: 'IP', render: (row) => el('span', 'mono muted', row.ip || '—') },
  ];

  function openAuditDetail(row) {
    const body = el('div', 'stack');
    body.appendChild(
      detailRows([
        { label: '事件 ID', value: el('span', 'mono page-break', row.id || '—') },
        { label: '时间', value: formatDateTime(row.createdAt) },
        { label: '动作', value: el('span', 'mono', row.action || '—') },
        { label: '实体', value: `${row.entityType || '—'}${row.entityId ? ` / ${row.entityId}` : ''}` },
        { label: '操作者', value: `${row.actorType || '—'}${row.actorId ? ` / ${row.actorId}` : ''}` },
        { label: 'IP', value: row.ip || '—' },
        { label: '请求 ID', value: row.requestId || '—' },
      ]),
    );
    body.appendChild(sectionTitle('变更前'));
    body.appendChild(jsonBlock(row.before));
    body.appendChild(sectionTitle('变更后'));
    body.appendChild(jsonBlock(row.after));
    openDrawer({ title: '审计事件详情', body });
  }

  async function loadAudit() {
    clear(tableHost);
    tableHost.appendChild(loadingBlock('正在加载审计日志…'));
    clear(pagerHost);
    try {
      const data = await api.get(
        `/api/v1/audit${queryString({ page: auditState.page, limit: 25, action: auditState.action })}`,
      );
      const items = asArray(data?.items);
      const total = toNumber(data?.total ?? items.length);
      clear(tableHost);
      tableHost.appendChild(
        dataTable({
          columns,
          rows: items,
          onRowClick: openAuditDetail,
          empty: emptyState({
            iconName: 'list',
            title: '暂无审计记录',
            description: '关键操作（设置、成员、发送、接管等）会自动写入审计日志。',
          }),
        }),
      );
      if (total > 0) {
        pagerHost.appendChild(
          pagination({
            page: auditState.page,
            pageSize: 25,
            total,
            label: '条审计事件',
            onChange: (nextPage) => {
              auditState.page = Math.max(1, nextPage);
              loadAudit();
            },
          }),
        );
      }
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(errorCard(error, () => loadAudit()));
    }
  }

  await loadAudit();
}

/* ----------------------------------------------------------------- system */

async function renderSystemSection(host) {
  clear(host);
  const canOps = can('audit.read');
  const statusHost = el('div', 'stack');
  const backupHost = el('div', 'stack');
  const logsHost = el('div', 'stack');
  const licenseHost = el('div', 'stack');
  const items = [];
  if (canOps) {
    items.push({ key: 'status', label: '运行状态', node: statusHost });
    items.push({ key: 'backup', label: '数据库备份', node: backupHost });
    items.push({ key: 'logs', label: '系统日志', node: logsHost });
  }
  items.push({ key: 'license', label: '许可证与依赖', node: licenseHost });
  const tabs = subTabs('system', items, canOps ? 'status' : 'license');
  host.appendChild(tabs.node);
  if (!canOps) host.appendChild(permissionNotice('audit.read', '查看系统状态与日志'));
  await Promise.all([
    canOps ? loadSystem({ statusHost, backupHost }) : Promise.resolve(),
    loadLicense(licenseHost),
    canOps ? loadLogs(logsHost) : Promise.resolve(),
  ]);
}

async function loadSystem({ statusHost, backupHost }) {
  clear(statusHost);
  clear(backupHost);
  statusHost.appendChild(loadingBlock('正在读取系统状态…'));
  backupHost.appendChild(loadingBlock('正在读取备份列表…'));
  let data;
  try {
    data = await api.get('/api/v1/ops/system');
  } catch (error) {
    clear(statusHost);
    clear(backupHost);
    statusHost.appendChild(errorCard(error, () => loadSystem({ statusHost, backupHost })));
    backupHost.appendChild(errorCard(error, () => loadSystem({ statusHost, backupHost })));
    return;
  }
  clear(statusHost);
  clear(backupHost);
  const app = asObject(data?.app);
  const processInfo = asObject(data?.process);
  const storage = asObject(data?.storage);
  const counts = asObject(data?.counts);
  const worker = asObject(data?.worker);
  const backups = asArray(data?.backups);
  const canBackup = can('backup.run');

  const workerFacts = Object.entries(worker)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ label: workerLabel(key), value: typeof value === 'boolean' ? badge(value ? '是' : '否', value ? 'green' : 'gray') : String(value) }));

  statusHost.appendChild(
    card({
      title: '运行状态',
      help: '运行时长、内存与数据库大小用于判断实例健康；版本信息来自服务端构建元数据。',
      actions: [button('刷新', { variant: 'ghost', size: 'sm', iconName: 'refresh', onClick: () => loadSystem({ statusHost, backupHost }) })],
      body: el('div', 'stack', [
        factGrid([
          { label: '应用', value: app.nameZh || app.name || '—' },
          { label: '版本', value: app.version || '—' },
          { label: '环境', value: app.env || '—' },
          { label: '运行时长', value: formatUptime(processInfo.uptimeSeconds) },
          { label: '内存占用', value: `${formatNumber(processInfo.memoryMb)} MB` },
          { label: 'Node', value: processInfo.node || '—' },
          { label: '进程 PID', value: processInfo.pid ?? '—' },
          { label: '数据库', value: `${storage.dbFile || '—'} · ${formatBytes(storage.dbSize)}` },
        ]),
        sectionTitle('数据量'),
        factGrid([
          { label: '企业', value: formatNumber(counts.companies ?? 0) },
          { label: '联系人', value: formatNumber(counts.contacts ?? 0) },
          { label: '邮件', value: formatNumber(counts.messages ?? 0) },
          { label: '任务', value: formatNumber(counts.jobs ?? 0) },
          { label: '审计事件', value: formatNumber(counts.auditEvents ?? 0) },
        ]),
        sectionTitle('Worker'),
        workerFacts.length ? factGrid(workerFacts) : el('div', 'muted', 'Worker 状态暂不可用'),
      ]),
    }),
  );

  const backupTable = dataTable({
    columns: [
      { key: 'name', label: '备份文件', render: (row) => el('span', 'mono page-break', row.name || '—') },
      { key: 'size', label: '大小', align: 'right', render: (row) => formatBytes(row.size) },
      { key: 'createdAt', label: '创建时间', render: (row) => el('span', 'muted nowrap', formatDateTime(row.createdAt)) },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) => {
          if (!canBackup) return el('span', 'muted', '无权限下载');
          const link = el('a', 'btn btn-sm');
          link.href = `/api/v1/ops/backup/${encodeURIComponent(row.name)}`;
          link.download = row.name || '';
          append(link, [icon('download', 13), '下载']);
          return link;
        },
      },
    ],
    rows: backups,
    empty: emptyState({
      iconName: 'hardDrive',
      title: '还没有备份',
      description: '创建备份后会在此列出；下载需要备份权限。',
    }),
  });

  const backupButton = button('立即备份', {
    variant: 'primary',
    iconName: 'database',
    disabled: !canBackup,
    title: disabledTip('backup.run'),
    onClick: async () => {
      const confirmed = await confirmDialog({
        title: '创建数据库备份',
        message: '将使用 SQLite VACUUM INTO 创建一个完整数据库备份文件。备份期间数据库写入可能短暂等待。',
        confirmText: '开始备份',
      });
      if (!confirmed) return;
      backupButton.disabled = true;
      try {
        const result = await api.post('/api/v1/ops/backup', {});
        const name = result?.backup?.name || result?.name || '备份';
        toast(`备份已创建：${name}`, 'success');
        await loadSystem({ statusHost, backupHost });
      } catch (error) {
        toast(error?.message || '备份失败', 'error');
        backupButton.disabled = !canBackup;
      }
    },
  });

  backupHost.appendChild(
    card({
      title: '数据库备份',
      help: '备份文件保存在服务端 data/backups 目录。建议在批量发送或数据迁移前创建备份；下载使用当前登录会话，不会把令牌写入 URL，且需要 backup.run 权限。',
      actions: [backupButton],
      body: backupTable,
    }),
  );
}

async function loadLicense(licenseHost) {
  clear(licenseHost);
  licenseHost.appendChild(loadingBlock('正在读取许可证信息…'));
  let data;
  try {
    data = await api.get('/api/v1/ops/license');
  } catch (error) {
    clear(licenseHost);
    licenseHost.appendChild(errorCard(error, () => loadLicense(licenseHost)));
    return;
  }
  clear(licenseHost);
  const product = asObject(data?.product);
  const runtime = asObject(data?.runtime);
  const runtimeDeps = asArray(data?.runtimeDependencies);
  const devDeps = asArray(data?.devDependencies);
  const thirdParty = asArray(data?.thirdPartyComponents);
  const references = asArray(data?.researchReferences);
  const notes = asArray(data?.notes);

  const runtimeFacts = Object.entries(runtime).map(([key, value]) => ({ label: runtimeLabel(key), value: String(value) }));
  const depTable = dataTable({
    columns: [
      { key: 'name', label: '名称', render: (row) => el('span', 'mono', row.name || String(row)) },
      { key: 'license', label: '许可证', render: (row) => row.license || '—' },
      { key: 'usage', label: '用途', render: (row) => row.usage || '—' },
    ],
    rows: references,
    empty: emptyState({ iconName: 'book', title: '没有登记参考资料', description: '本项目为零第三方运行时依赖实现。' }),
  });

  licenseHost.appendChild(
    card({
      title: '许可证与依赖',
      help: '许可证清单由服务端维护；本项目仅研究参考项目功能，不复制第三方源码。',
      body: el('div', 'stack', [
        factGrid([
          { label: '产品', value: product.nameZh || product.name || '—' },
          { label: '版本', value: product.version || '—' },
          { label: '作者', value: product.author || '—' },
          { label: '许可证', value: product.license || '—' },
          { label: '官网', value: product.website || '—' },
          { label: '支持', value: product.support || '—' },
        ]),
        sectionTitle('运行时'),
        runtimeFacts.length ? factGrid(runtimeFacts) : el('div', 'muted', '—'),
        sectionTitle('第三方依赖'),
        runtimeDeps.length + devDeps.length + thirdParty.length
          ? el('div', 'stack', [
              kvList([
                { label: '运行时依赖', value: runtimeDeps.length ? runtimeDeps.map((item) => item.name || String(item)).join('、') : '无' },
                { label: '开发依赖', value: devDeps.length ? devDeps.map((item) => item.name || String(item)).join('、') : '无' },
              ]),
            ])
          : notice('无第三方运行时依赖：仅使用 Node.js 内置模块（node:sqlite、node:crypto、node:http 等）。', 'info'),
        sectionTitle('参考资料（仅研究，不复制代码）'),
        depTable,
        notes.length
          ? el('ul', 'page-notes', notes.map((line) => el('li', '', String(line))))
          : null,
        el('div', 'muted page-copyright', product.copyright || ''),
      ]),
    }),
  );
}

async function loadLogs(logsHost) {
  clear(logsHost);
  logsHost.appendChild(loadingBlock('正在读取系统日志…'));
  let data;
  try {
    data = await api.get('/api/v1/ops/logs?lines=200');
  } catch (error) {
    clear(logsHost);
    logsHost.appendChild(errorCard(error, () => loadLogs(logsHost)));
    return;
  }
  clear(logsHost);
  const lines = asArray(data?.lines);
  const body = el('div', 'stack');
  if (lines.length) {
    const pre = el('pre', 'page-log');
    pre.textContent = lines.join('\n');
    body.appendChild(pre);
  } else {
    body.appendChild(emptyState({ iconName: 'terminal', title: '暂无日志', description: '服务端日志文件为空或尚未产生日志。' }));
  }
  logsHost.appendChild(
    card({
      title: '系统日志',
      help: '只读展示最近的服务端日志，用于排查后台任务与模型调用问题；不要在日志中记录密码或密钥。',
      actions: [button('刷新', { variant: 'ghost', size: 'sm', iconName: 'refresh', onClick: () => loadLogs(logsHost) })],
      body,
    }),
  );
}

function workerLabel(key) {
  const labels = {
    running: '运行中',
    workerId: 'Worker ID',
    lastTickAt: '最近心跳',
    lastHeartbeatAt: '最近心跳',
    processed: '已处理任务',
    activeJobs: '活跃任务',
    queued: '排队任务',
    paused: '是否暂停',
    startedAt: '启动时间',
    concurrency: '并发数',
  };
  return labels[key] || key;
}

function runtimeLabel(key) {
  const labels = {
    node: 'Node.js',
    database: '数据库',
    externalServices: '外部服务',
  };
  return labels[key] || key;
}

export function destroy() {
  auditState.page = 1;
  auditState.action = '';
}
