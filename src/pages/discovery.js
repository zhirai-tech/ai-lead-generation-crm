/**
 * Company discovery page: run form (product, ICP, countries, keywords,
 * provider, result limit), provider catalogue and run history with a detail
 * drawer.
 *
 * Demo providers are clearly marked; discovery never invents company facts —
 * every result keeps a company_sources row with provider, URL and confidence.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { countryName, formatDateTime, formatNumber, relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  confirmDialog,
  dataTable,
  detailRows,
  emptyState,
  field,
  helpTip,
  loadingBlock,
  notice,
  openDrawer,
  pageHeader,
  pagination,
  sectionTitle,
  select,
  statusBadge,
  textarea,
  toast,
} from '../components/ui.mjs';
import { EU_COUNTRIES, splitList, typeLabel } from './companies.js';

export const meta = {
  title: '企业发现',
  help: '企业发现只负责找到并去重企业（潜在客户）；下一步在「邮件草稿」生成每个客户的文案与附件，再人工审批、发送。「联系人库」保存所有企业的联系人。默认使用 OpenStreetMap 真实企业数据；不选国家=全部市场。',
};

const RUN_STATUS_MAP = {
  queued: 'queued',
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

const PROVIDER_LABELS = {
  brave: 'Brave Search API',
  serper: 'Serper（Google 结果）',
  tavily: 'Tavily（免注册）',
  browser: '浏览器搜索（本机 Edge/Chrome）',
  osm: 'OpenStreetMap 真实企业',
  simulation: '内置模拟数据源',
  search_api: '可配置搜索 API',
  csv: 'CSV / 表格导入',
  csv_import: 'CSV / 表格导入',
  public_web: '公开网站抓取',
};

const FALLBACK_PROVIDER = {
  key: 'osm',
  name: 'OpenStreetMap 真实企业（免费）',
  adapter: 'osm',
  isEnabled: true,
  implemented: true,
  offline: false,
  costModel: '免费',
  capabilities: ['search', 'offline'],
};

const RUN_PAGE_SIZE = 10;

let disposed = false;
let pollTimer = null;

function errorMessage(error) {
  return error && error.message ? error.message : '请求失败，请稍后重试';
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapList(data) {
  if (Array.isArray(data)) return { items: data, total: data.length };
  const items = Array.isArray(data && data.items) ? data.items : [];
  const total = Number(data && data.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

function fillSelect(node, options, value, placeholder = null) {
  clear(node);
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
}

function providerValue(provider) {
  const adapter = String(provider.adapter || provider.key || '');
  if (['brave', 'serper', 'tavily', 'browser', 'osm', 'simulation', 'search_api', 'csv'].includes(adapter)) return adapter;
  return provider.key || adapter;
}

function providerLabel(value) {
  return PROVIDER_LABELS[value] || value || '—';
}

function runProvider(run) {
  return providerLabel(run.provider || (run.query && run.query.provider) || '—');
}

function runStatus(run) {
  return RUN_STATUS_MAP[run.status] || run.status || 'queued';
}

function querySummary(query) {
  const keywords = safeArray(query.keywords);
  const countries = safeArray(query.countries).map((code) => countryName(code) || code);
  const parts = [];
  if (keywords.length) parts.push(keywords.slice(0, 4).join('、'));
  if (countries.length) parts.push(countries.slice(0, 4).join('、'));
  else parts.push('全部市场');
  if (query.industry) parts.push(query.industry);
  return parts.filter(Boolean).join(' · ') || '未设置条件';
}

function runNeedsCsv(provider) {
  const adapter = String(provider.adapter || provider.key || '').toLowerCase();
  return adapter === 'csv' || provider.key === 'csv_import';
}

// ------------------------------------------------------------------ page
export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  const state = {
    products: [],
    icps: [],
    providers: [],
    countries: new Set(),
    provider: '',
    total: 0,
    page: 1,
    keywordsCache: new Map(),
  };
  const refs = {};

  const formHost = el('div', 'stack');
  const runsHost = el('div', 'stack');
  const runsPagerHost = el('div', '');
  const runsBody = el('div', 'stack hidden');
  let runsExpanded = false;
  let countryExpanded = false;
  let providerExpanded = false;
  const consoleHost = el('div', 'agent-console');
  const consoleStatus = el('div', 'agent-console-status', '空闲');
  const consoleLog = el('div', 'agent-console-log');
  let consoleTimer = null;
  let activeRunId = null;
  let lastProgressMessage = '';
  const writable = can('discovery.run');
  const canWriteData = can('data.write');

  // ------------------------------------------------------- reference data
  const PROVIDER_PREFERENCE = ['browser', 'tavily', 'brave', 'serper', 'osm', 'search_api', 'csv'];

  function providerDisabledReason(provider) {
    if (provider.implemented === false) return '暂未实现';
    if (['brave', 'serper', 'tavily'].includes(provider.key) && provider.hasCredential === false) return '需配置 API Key';
    if (provider.key === 'search_api' && provider.hasCredential === false) return '需配置 API Key';
    if (provider.isEnabled === false) {
      return provider.key === 'search_api' ? '需配置 API Key' : '未启用';
    }
    return '';
  }

  function ensureProvider() {
    const available = state.providers.filter((provider) => !providerDisabledReason(provider));
    if (!available.length) {
      state.providers = [FALLBACK_PROVIDER];
      state.provider = providerValue(FALLBACK_PROVIDER);
      return;
    }
    const stillValid = available.some((provider) => providerValue(provider) === state.provider);
    if (!stillValid) {
      const preferred = PROVIDER_PREFERENCE.map((value) =>
        available.find((provider) => providerValue(provider) === value),
      ).find(Boolean);
      state.provider = providerValue(preferred || available[0]);
    }
  }

  function renderProviders() {
    if (!refs.providerHost) return;
    clear(refs.providerHost);
    for (const provider of state.providers) {      const value = providerValue(provider);
      const disabledReason = providerDisabledReason(provider);
      const disabled = Boolean(disabledReason);
      const label = el('label', `page-provider${disabled ? ' disabled' : ''}`);
      const radio = el('input', 'page-provider-radio');
      radio.type = 'radio';
      radio.name = 'discovery-provider';
      radio.value = value;
      radio.checked = state.provider === value;
      radio.disabled = disabled;
      if (!disabled) {
        radio.addEventListener('change', () => {
          state.provider = value;
          renderProviders();
          updateCsvField();
        });
      }
      const main = el('div', 'page-provider-main');
      append(main, [
        el('b', '', provider.name || provider.key || value),
        el('span', 'muted', safeArray(provider.capabilities).join(' · ')),
      ]);
      const badges = el('div', 'page-provider-badges');
      append(badges, [
        badge(disabled ? disabledReason : '可用', disabled ? 'gray' : 'green'),
        badge(`成本：${provider.costModel || '—'}`, 'gray'),
      ]);
      if (provider.offline) append(badges, [badge('演示数据源', 'yellow')]);
      append(label, [radio, main, badges]);
      refs.providerHost.appendChild(label);
    }
    refs.providerHost.classList.toggle('is-collapsed', !providerExpanded);
    const selected = state.providers.find((provider) => providerValue(provider) === state.provider);
    if (refs.providerSummary) {
      refs.providerSummary.textContent = selected
        ? `当前：${selected.name || selected.key}`
        : '未选择数据源';
    }
    if (refs.providerToggle) {
      refs.providerToggle.textContent = providerExpanded ? '收起数据源 ▲' : '展开数据源 ▼';
    }
  }

  function updateCsvField() {
    if (!refs.csvField) return;
    const current = state.providers.find((provider) => providerValue(provider) === state.provider) || null;
    refs.csvField.classList.toggle('hidden', !current || !runNeedsCsv(current));
  }

  function renderCountryChips() {
    if (!refs.countryHost) return;
    clear(refs.countryHost);
    for (const code of EU_COUNTRIES) {
      const active = state.countries.has(code);
      const label = countryName(code) || code;
      const chip = el('button', `page-chip${active ? ' active' : ''}`, label);
      chip.type = 'button';
      chip.title = code;
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      chip.addEventListener('click', () => {
        if (state.countries.has(code)) state.countries.delete(code);
        else state.countries.add(code);
        renderCountryChips();
      });
      refs.countryHost.appendChild(chip);
    }
    if (refs.countryHost) refs.countryHost.classList.toggle('is-collapsed', !countryExpanded);
    const count = state.countries.size;
    if (refs.countryCount) {
      refs.countryCount.textContent = count ? `已选 ${count} 个国家` : '未选择国家';
    }
    if (refs.countryToggle) {
      refs.countryToggle.textContent = countryExpanded ? '收起国家列表 ▲' : '展开国家列表 ▼';
    }
    if (refs.countryAllBadge) refs.countryAllBadge.classList.toggle('hidden', count > 0);
  }

  function selectAllCountries() {
    state.countries = new Set(EU_COUNTRIES);
    renderCountryChips();
  }

  function randomCountries() {
    const pool = [...EU_COUNTRIES];
    const picked = new Set();
    while (picked.size < 8 && pool.length) {
      const index = Math.floor(Math.random() * pool.length);
      picked.add(pool.splice(index, 1)[0]);
    }
    state.countries = picked;
    renderCountryChips();
  }

  function clearCountries() {
    state.countries = new Set();
    renderCountryChips();
  }

  /** Fill the keyword box from the selected product when it is still empty. */
  async function applyProductKeywords(productId, { force = false } = {}) {
    if (!refs.keywords || !productId) return;
    const current = String(refs.keywords.value || '').trim();
    if (current && !force) return;
    const product = state.products.find((item) => item.id === productId) || null;
    let keywords = null;
    if (product && Array.isArray(product.keywords)) {
      keywords = product.keywords;
    } else if (state.keywordsCache.has(productId)) {
      keywords = state.keywordsCache.get(productId);
    } else {
      try {
        const detail = await api.get(`/api/v1/products/${encodeURIComponent(productId)}`);
        keywords = safeArray(detail && detail.keywords);
      } catch {
        keywords = [];
      }
      state.keywordsCache.set(productId, keywords);
    }
    if (Array.isArray(keywords) && keywords.length && refs.keywords && !String(refs.keywords.value || '').trim()) {
      refs.keywords.value = keywords.join(', ');
    }
  }

  function renderKeywordNotes(result) {
    if (!refs.keywordNoteHost) return;
    clear(refs.keywordNoteHost);
    const negativeKeywords = safeArray(result && result.negativeKeywords);
    const notes = (result && result.notes) || '仅基于产品已填资料扩展关键词';
    const parts = [`AI 说明：${notes}`];
    if (negativeKeywords.length) parts.push(`建议排除词：${negativeKeywords.slice(0, 12).join('、')}`);
    refs.keywordNoteHost.appendChild(helpTip(parts.join('；')));
  }

  async function generateKeywords() {
    const productId = refs.product ? refs.product.value : '';
    if (!productId) {
      toast('请先选择产品', 'warning');
      return;
    }
    if (!canWriteData) {
      toast('当前角色没有生成关键词的权限', 'warning');
      return;
    }
    if (!refs.aiKeywordsBtn || refs.aiKeywordsBtn.disabled) return;
    refs.aiKeywordsBtn.disabled = true;
    if (refs.aiKeywordsLabel) refs.aiKeywordsLabel.textContent = '生成中…';
    try {
      const result = await api.post(
        `/api/v1/products/${encodeURIComponent(productId)}/generate-keywords`,
        {},
      );
      const keywords = safeArray(result && result.keywords)
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 30);
      if (!keywords.length) {
        toast('AI 未返回可用关键词，请稍后重试', 'warning');
        return;
      }
      refs.keywords.value = keywords.join(', ');
      toast(`已生成 ${keywords.length} 个关键词`, 'success');
      renderKeywordNotes(result);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      if (refs.aiKeywordsBtn) refs.aiKeywordsBtn.disabled = false;
      if (refs.aiKeywordsLabel) refs.aiKeywordsLabel.textContent = 'AI 生成关键词';
    }
  }

  function buildCountryActions() {
    const actions = el('div', 'page-country-actions');
    append(actions, [
      button('全选欧洲', { size: 'sm', variant: 'ghost', onClick: selectAllCountries }),
      button('随机 8 国', { size: 'sm', variant: 'ghost', onClick: randomCountries }),
      button('清空', { size: 'sm', variant: 'ghost', onClick: clearCountries }),
    ]);
    return actions;
  }

  function buildForm() {
    if (disposed) return;
    clear(formHost);

    refs.product = select({
      value: '',
      options: [],
      placeholder: '请选择产品',
      onChange: (value) => {
        void applyProductKeywords(value);
      },
    });
    fillSelect(
      refs.product,
      state.products.map((product) => ({
        value: product.id,
        label: product.category ? `${product.name} · ${product.category}` : product.name,
      })),
      state.products[0] ? state.products[0].id : '',
      '请选择产品',
    );
    refs.icp = select({ value: '', options: [], placeholder: '不关联 ICP' });
    fillSelect(
      refs.icp,
      state.icps.map((icp) => ({ value: icp.id, label: `${icp.name}${icp.isActive === false ? '（已停用）' : ''}` })),
      '',
      '不关联 ICP',
    );
    refs.keywords = textarea({
      rows: 2,
      placeholder: '例如：brake pads, aftermarket, distributor（逗号或换行分隔）',
    });
    refs.aiKeywordsLabel = el('span', '', 'AI 生成关键词');
    refs.aiKeywordsBtn = button(null, {
      size: 'sm',
      variant: 'outline',
      iconName: 'sparkles',
      disabled: !canWriteData || !state.products.length,
      title: '基于产品资料生成关键词',
      onClick: generateKeywords,
    });
    refs.aiKeywordsBtn.appendChild(refs.aiKeywordsLabel);
    refs.keywordNoteHost = el('span', 'row');
    const keywordActions = el('div', 'page-keyword-actions');
    append(keywordActions, [refs.aiKeywordsBtn, refs.keywordNoteHost]);
    const keywordWrap = el('div', 'page-keyword-field');
    append(keywordWrap, [refs.keywords, keywordActions]);
    refs.countryHost = el('div', 'page-chip-group');
    refs.countryCount = el('span', 'muted', '未选择国家');
    refs.countryAllBadge = badge('全部市场', 'yellow');
    refs.providerHost = el('div', 'page-provider-list');
    refs.maxResults = select({
      value: '25',
      options: [
        { value: '10', label: '10 家' },
        { value: '25', label: '25 家' },
        { value: '50', label: '50 家' },
        { value: '100', label: '100 家' },
      ],
    });
    refs.csvText = textarea({ rows: 5, placeholder: 'name,domain,country,companyType,industry' });
    refs.csvField = field('CSV 内容', refs.csvText, {
      help: 'CSV 数据源需要粘贴表头与数据；首行为表头，UTF-8 编码。',
    });
    refs.csvField.classList.add('span-2', 'hidden');

    const countryField = field('目标国家', refs.countryHost, {
      help: '可多选；不选任何国家表示「全部市场」（由数据源覆盖范围决定）。可用「全选欧洲 / 随机 8 国 / 清空」快速调整。',
    });
    const countryMeta = el('div', 'page-chip-meta');
    refs.countryToggle = button('展开国家列表 ▼', {
      size: 'sm',
      variant: 'ghost',
      onClick: () => {
        countryExpanded = !countryExpanded;
        renderCountryChips();
      },
    });
    append(countryMeta, [refs.countryCount, refs.countryAllBadge, el('span', 'grow'), refs.countryToggle, buildCountryActions()]);
    const countryWrap = el('div', 'span-2');
    append(countryWrap, [countryField, countryMeta]);

    refs.providerSummary = el('span', 'muted', '未选择数据源');
    refs.providerToggle = button('展开数据源 ▼', {
      size: 'sm',
      variant: 'ghost',
      onClick: () => {
        providerExpanded = !providerExpanded;
        renderProviders();
      },
    });
    const providerMeta = el('div', 'page-chip-meta');
    append(providerMeta, [refs.providerSummary, el('span', 'grow'), refs.providerToggle]);
    const providerWrap = el('div', 'span-2');
    append(providerWrap, [providerMeta, refs.providerHost]);
    const providerField = field('数据源', providerWrap, {
      help: '数据源决定企业来源与成本。展开后选择；默认收起，只显示当前数据源。',
    });
    providerField.classList.add('span-2');

    const keywordField = field('关键词', keywordWrap, {
      help: '逗号或换行分隔，最多 20 个；选择产品后会自动带出已保存的关键词（若为空），也可用 AI 生成后核对。',
    });
    keywordField.classList.add('span-2');

    const form = el('div', 'form-grid');
    append(form, [
      field('产品', refs.product, { required: true, help: '发现结果会按产品类目与 ICP 规则匹配与评分。' }),
      field('ICP（可选）', refs.icp, { help: '选择 ICP 后，企业类型、目标国家与关键词会作为发现条件。' }),
      field('最大结果数', refs.maxResults),
      countryWrap,
      keywordField,
      providerField,
      refs.csvField,
    ]);

    const foot = el('div', 'row-between');
    append(foot, [
      helpTip('提交后任务立即入队，结果企业会自动去重并记录来源；发现过程在后台执行，可在下方运行记录中查看状态。'),
    ]);

    formHost.appendChild(
      card({
        title: '新建发现任务',
        help: '发现任务在后台执行，可随时查看状态。来源记录（provider / URL / 置信度）会随企业保存，供人工复核。',
        body: form,
        foot,
      }),
    );
    headerSubmitBtn.disabled = !writable || !state.products.length;
    if (!state.products.length) {
      const actions = el('div', 'row page-empty-actions');
      append(actions, [
        button('去创建产品', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: () => navigate('/products') }),
        button('去创建 ICP', { variant: 'outline', size: 'sm', iconName: 'target', onClick: () => navigate('/icps') }),
      ]);
      formHost.appendChild(
        emptyState({
          iconName: 'box',
          title: '先准备产品资料',
          description: '发现任务需要以产品为锚点，才能按类目与关键词检索并对结果评分。',
          action: actions,
        }),
      );
    }
    renderCountryChips();
    renderProviders();
    updateCsvField();
    void applyProductKeywords(refs.product.value);
  }

  async function submit() {
    if (!writable) {
      toast('当前角色没有执行发现的权限', 'warning');
      return;
    }
    if (!state.products.length) {
      toast('请先创建产品资料', 'warning');
      return;
    }
    const productId = refs.product ? refs.product.value : '';
    if (!productId) {
      toast('请选择产品', 'warning');
      return;
    }
    const maxResults = Number(refs.maxResults.value) || 25;
    const current = state.providers.find((provider) => providerValue(provider) === state.provider) || null;
    const payload = {
      productId,
      icpId: refs.icp && refs.icp.value ? refs.icp.value : null,
      countries: [...state.countries],
      keywords: splitList(refs.keywords ? refs.keywords.value : ''),
      provider: state.provider,
      maxResults,
      limit: maxResults,
    };
    if (current && runNeedsCsv(current)) {
      const csv = refs.csvText ? String(refs.csvText.value || '').trim() : '';
      if (!csv) {
        toast('CSV 数据源需要粘贴 CSV 内容', 'warning');
        return;
      }
      payload.csvText = csv;
    }
    headerSubmitBtn.disabled = true;
    try {
      const result = await api.post('/api/v1/discovery/runs', payload);
      const queued = !(result && result.job && result.job.queued === false);
      toast(queued ? '发现任务已创建并排队执行' : '发现任务已创建', 'success');
      if (refs.csvText) refs.csvText.value = '';
      if (result?.id) startConsole(result.id);
      state.page = 1;
      loadRuns();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      headerSubmitBtn.disabled = !writable || !state.products.length;
    }
  }

  // --------------------------------------------------------------- runs
  function runColumns() {
    return [
      {
        key: 'createdAt',
        label: '时间',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [
            el('div', 'cell-main', relativeTime(row.createdAt)),
            el('div', 'cell-sub', formatDateTime(row.createdAt)),
          ]);
          return wrap;
        },
      },
      {
        key: 'query',
        label: '查询摘要',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [
            el('div', '', truncate(querySummary(row.query || {}), 54)),
            el('div', 'cell-sub', `上限 ${row.query && row.query.limit ? formatNumber(row.query.limit) : '—'} 家`),
          ]);
          return wrap;
        },
      },
      { key: 'provider', label: '数据源', render: (row) => runProvider(row) },
      { key: 'status', label: '状态', render: (row) => statusBadge(runStatus(row), 'job') },
      {
        key: 'result',
        label: '找到 / 新增',
        align: 'right',
        render: (row) => `${formatNumber(row.resultCount ?? 0)} / ${formatNumber(row.companiesCreated ?? 0)}`,
      },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) => {
          const wrap = el('div', 'row page-row-actions');
          const active = ['queued', 'running'].includes(row.status);
          append(wrap, [button('查看', { size: 'sm', variant: 'ghost', iconName: 'eye', onClick: () => openRun(row) })]);
          if (active) {
            append(wrap, [
              button('取消', {
                size: 'sm',
                variant: 'ghost',
                iconName: 'pause',
                disabled: !writable,
                onClick: () => cancelRun(row),
              }),
            ]);
          }
          append(wrap, [
            button('查看企业', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'building',
              disabled: !row.companiesCreated,
              onClick: () => navigate('/companies'),
            }),
          ]);
          return wrap;
        },
      },
    ];
  }

  function renderRunsEmpty() {
    const actions = el('div', 'row page-empty-actions');
    if (!state.products.length) {
      append(actions, [
        button('去创建产品', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: () => navigate('/products') }),
      ]);
    } else {
      append(actions, [button('刷新', { size: 'sm', iconName: 'refresh', onClick: () => loadRuns() })]);
    }
    return emptyState({
      iconName: 'compass',
      title: '还没有发现任务',
      description: '填写上方表单并提交后，运行记录、状态与结果企业会显示在这里。',
      action: actions,
    });
  }

  function renderRunsPager() {
    clear(runsPagerHost);
    if (!state.total) return;
    runsPagerHost.appendChild(
      pagination({
        page: state.page,
        pageSize: RUN_PAGE_SIZE,
        total: state.total,
        onChange: (nextPage) => {
          state.page = Math.max(1, Number(nextPage) || 1);
          loadRuns();
        },
      }),
    );
  }

  async function loadRuns({ silent = false } = {}) {
    if (disposed) return;
    if (!silent) {
      clear(runsHost);
      runsHost.appendChild(dataTable({ columns: runColumns(), rows: [], loading: true }));
    }
    try {
      const data = await api.get(
        `/api/v1/discovery/runs${queryString({ page: state.page, pageSize: RUN_PAGE_SIZE })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      state.total = total;
      clear(runsHost);
      runsHost.appendChild(
        dataTable({
          columns: runColumns(),
          rows: items,
          empty: renderRunsEmpty(),
          onRowClick: (row) => openRun(row),
        }),
      );
      renderRunsPager();
      const hasActive = items.some((row) => ['queued', 'running'].includes(row.status));
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (hasActive && !disposed) {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          loadRuns({ silent: true });
        }, 8000);
      }
    } catch (error) {
      if (disposed) return;
      clear(runsHost);
      const box = el('div', 'page-state');
      append(box, [
        notice(`运行记录加载失败：${errorMessage(error)}`, 'danger'),
        el('div', 'row', [
          button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => loadRuns() }),
        ]),
      ]);
      runsHost.appendChild(box);
      clear(runsPagerHost);
    }
  }

  function buildRunDetail(detail, closeDrawer) {
    const query = detail.query || {};
    const companies = safeArray(detail.companies);
    const body = el('div', 'stack');
    body.appendChild(
      detailRows([
        { label: '状态', value: statusBadge(runStatus(detail), 'job') },
        { label: '数据源', value: runProvider(detail) },
        { label: '创建时间', value: formatDateTime(detail.createdAt) },
        { label: '开始时间', value: detail.startedAt ? formatDateTime(detail.startedAt) : '—' },
        { label: '结束时间', value: detail.finishedAt ? formatDateTime(detail.finishedAt) : '—' },
        { label: '找到企业', value: formatNumber(detail.resultCount ?? 0) },
        { label: '新增企业', value: formatNumber(detail.companiesCreated ?? 0) },
        {
          label: '目标国家',
          value: safeArray(query.countries).map((code) => countryName(code) || code).join('、') || '全部市场',
        },
        { label: '关键词', value: safeArray(query.keywords).join('、') || '—' },
        { label: '结果上限', value: query.limit ? `${formatNumber(query.limit)} 家` : '—' },
      ]),
    );
    if (detail.error) body.appendChild(notice(`任务信息：${detail.error}`, 'warn'));
    if (['queued', 'running'].includes(detail.status)) {
      body.appendChild(
        button('取消该任务', {
          size: 'sm',
          variant: 'danger',
          iconName: 'pause',
          disabled: !writable,
          onClick: () => cancelRun(detail),
        }),
      );
    }
    if (companies.length) {
      body.appendChild(sectionTitle('结果企业'));
      body.appendChild(
        dataTable({
          columns: [
            { key: 'name', label: '企业', render: (row) => el('span', 'cell-main', row.name || '未命名') },
            { key: 'country', label: '国家', render: (row) => (row.country ? countryName(row.country) : '—') },
            { key: 'companyType', label: '类型', render: (row) => typeLabel(row.companyType) },
            { key: 'status', label: '状态', render: (row) => statusBadge(row.status, 'company') },
          ],
          rows: companies,
          onRowClick: (row) => {
            closeDrawer();
            navigate(`/companies/${encodeURIComponent(row.id)}`);
          },
        }),
      );
    } else if (!['queued', 'running'].includes(detail.status)) {
      body.appendChild(el('div', 'muted', '该任务没有新增企业（可能全部命中已有记录）。'));
    }
    return body;
  }

  async function openRun(run) {
    const bodyHost = el('div', 'stack');
    bodyHost.appendChild(loadingBlock('正在加载运行详情…'));
    const drawer = openDrawer({ title: '发现任务详情', body: bodyHost, actions: [{ label: '关闭' }] });
    try {
      const data = await api.get(`/api/v1/discovery/runs/${encodeURIComponent(run.id)}`);
      if (disposed) return;
      const detail = data && data.run ? { ...data.run, companies: safeArray(data.companies) } : data || {};
      clear(bodyHost);
      bodyHost.appendChild(buildRunDetail(detail, drawer.close));
    } catch (error) {
      clear(bodyHost);
      append(bodyHost, [
        notice(`加载失败：${errorMessage(error)}`, 'danger'),
        button('重试', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: () => openRun(run) }),
      ]);
    }
  }

  async function cancelRun(run) {
    const confirmed = await confirmDialog({
      title: '取消发现任务',
      message: `确认取消「${truncate(querySummary(run.query || {}), 60)}」？已创建的企业不会被删除。`,
      confirmText: '取消任务',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post(`/api/v1/discovery/runs/${encodeURIComponent(run.id)}/cancel`, {});
      toast('任务已取消', 'success');
      loadRuns();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function appendConsole(text, tone = '') {
    const line = el('div', `agent-console-line ${tone}`.trim(), text);
    consoleLog.appendChild(line);
    while (consoleLog.childElementCount > 80) consoleLog.removeChild(consoleLog.firstElementChild);
    consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  function stopConsole(statusText = '空闲') {
    if (consoleTimer) {
      clearTimeout(consoleTimer);
      consoleTimer = null;
    }
    consoleStatus.textContent = statusText;
  }

  async function pollConsole() {
    if (!activeRunId || disposed) return;
    try {
      const data = await api.get(`/api/v1/discovery/runs/${encodeURIComponent(activeRunId)}/progress`);
      const progress = data?.progress;
      if (progress) {
        if (progress.message && progress.message !== lastProgressMessage) {
          lastProgressMessage = progress.message;
          appendConsole(
            `${new Date().toLocaleTimeString('zh-CN')}  ${progress.message}${progress.total ? `  (${progress.checked || 0}/${progress.total})` : ''}`,
            progress.stage === 'failed' ? 'danger' : progress.stage === 'completed' ? 'success' : '',
          );
        }
        consoleStatus.textContent = progress.stage === 'completed'
          ? `完成：新建/恢复 ${progress.created || 0} 家`
          : progress.stage === 'failed'
            ? '失败'
            : `${progress.message || '运行中'} ${progress.total ? `${progress.checked || 0}/${progress.total}` : ''}`;
        if (['completed', 'failed'].includes(progress.stage)) {
          stopConsole(consoleStatus.textContent);
          activeRunId = null;
          return;
        }
      }
      consoleTimer = setTimeout(pollConsole, 1000);
    } catch {
      consoleTimer = setTimeout(pollConsole, 2000);
    }
  }

  function startConsole(runId) {
    activeRunId = runId;
    lastProgressMessage = '';
    clear(consoleLog);
    consoleStatus.textContent = '任务已提交，等待后台执行…';
    appendConsole('任务已提交，等待 worker 接单…');
    if (consoleTimer) clearTimeout(consoleTimer);
    consoleTimer = setTimeout(pollConsole, 500);
  }

  // ------------------------------------------------------------------ boot
  const refreshBtn = button('刷新', { iconName: 'refresh', onClick: () => loadRuns() });
  const headerSubmitBtn = button('开始发现', {
    variant: 'primary',
    iconName: 'play',
    disabled: !writable || !state.products.length,
    onClick: () => submit(),
  });
  const workbench = el('div', 'page-discovery-workbench');
  append(consoleHost, [consoleStatus, consoleLog]);
  const consoleCard = card({
    title: 'Agent 运行窗口',
    help: '显示当前发现任务正在做什么、检查到第几条、已创建多少企业。',
    body: consoleHost,
  });
  append(workbench, [formHost, consoleCard]);
  append(runsBody, [runsHost, runsPagerHost]);
  const runsToggle = button('展开运行记录 ▼', {
    size: 'sm',
    variant: 'ghost',
    onClick: () => {
      runsExpanded = !runsExpanded;
      runsBody.classList.toggle('hidden', !runsExpanded);
      runsToggle.textContent = runsExpanded ? '收起运行记录 ▲' : '展开运行记录 ▼';
      if (runsExpanded) loadRuns();
    },
  });
  append(root, [
    pageHeader({ title: meta.title, help: meta.help, actions: [headerSubmitBtn, refreshBtn] }),
    workbench,
    card({
      title: '运行记录',
      help: '默认收起，展开后查看历史任务。',
      body: el('div', 'stack', [runsToggle, runsBody]),
    }),
  ]);

  formHost.appendChild(card({ title: '新建发现任务', body: loadingBlock('正在加载产品、ICP 与数据源…') }));
  const runsPromise = Promise.resolve();

  try {
    const [productsResult, icpsResult, providersResult] = await Promise.allSettled([
      api.get(`/api/v1/products${queryString({ pageSize: 100 })}`),
      api.get(`/api/v1/icps${queryString({ pageSize: 100 })}`),
      api.get('/api/v1/discovery/providers'),
    ]);
    if (disposed) return;
    if (productsResult.status === 'fulfilled') {
      state.products = unwrapList(productsResult.value).items;
      for (const product of state.products) {
        if (product && product.id && Array.isArray(product.keywords)) {
          state.keywordsCache.set(product.id, product.keywords);
        }
      }
    }
    if (icpsResult.status === 'fulfilled') state.icps = unwrapList(icpsResult.value).items;
    const providers = providersResult.status === 'fulfilled'
      ? unwrapList(providersResult.value).items.filter((provider) => providerValue(provider) !== 'simulation')
      : [];
    let usedFallback = false;
    if (!providers.length) usedFallback = true;
    state.providers = providers.length ? providers : [FALLBACK_PROVIDER];
    ensureProvider();
    buildForm();
    if (productsResult.status === 'rejected') {
      formHost.appendChild(
        notice(`产品资料加载失败：${errorMessage(productsResult.reason)}。可稍后刷新，或先创建产品。`, 'warn'),
      );
    }
    if (providersResult.status === 'rejected') {
      formHost.appendChild(notice('数据源目录暂不可用，已使用 OpenStreetMap 真实企业数据源。', 'info'));
    } else if (usedFallback) {
      formHost.appendChild(notice('未发现可用数据源，已使用 OpenStreetMap 真实企业数据源。', 'info'));
    }
  } catch (error) {
    if (disposed) return;
    clear(formHost);
    const box = el('div', 'page-state');
    append(box, [
      notice(`初始化失败：${errorMessage(error)}`, 'danger'),
      button('重试', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: () => render(root, params, ctx) }),
    ]);
    formHost.appendChild(box);
  }

  await runsPromise;
}

export function destroy() {
  disposed = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
