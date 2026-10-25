/**
 * Potential customers (companies) page.
 *
 * Owns: search / country / status / score filters, pagination, row actions,
 * CSV import & export, bulk scoring and the shared company create/edit form.
 * The company detail page reuses `openCompanyForm`, `pickProduct` and the
 * label constants exported here so both screens stay consistent.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, downloadText, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { countryName, domainOf, formatNumber, relativeTime } from '../utils/format.mjs';
import {
  badge,
  button,
  checkbox,
  confirmDialog,
  copyButton,
  dataTable,
  emptyState,
  field,
  helpTip,
  input,
  notice,
  openModal,
  pageHeader,
  pagination,
  scoreMeter,
  searchInput,
  select,
  statusBadge,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';

function maskContact(value, kind = 'email') {
  const text = String(value || '');
  if (kind === 'phone') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 6) return text;
    return `${text.slice(0, Math.min(6, Math.ceil(text.length / 2)))}****${text.slice(-4)}`;
  }
  const [local, domain] = text.split('@');
  if (!local || !domain) return text;
  return `${local.slice(0, 2)}****@${domain}`;
}

async function openContactDialog(company, kind) {
  const data = await api.get(`/api/v1/contacts${queryString({ companyId: company.id, pageSize: 100 })}`);
  const contacts = data?.items || [];
  const emails = [...new Set(contacts.map((item) => item.email).filter(Boolean))];
  const phones = [...new Set([
    ...contacts.map((item) => item.phone).filter(Boolean),
    company.phone,
  ].filter(Boolean))];
  const values = kind === 'email' ? emails : phones;
  const title = `${company.name || '企业'} · ${kind === 'email' ? '邮箱' : '电话'}`;
  const body = el('div', 'contact-dialog-list');
  if (!values.length) {
    body.appendChild(el('div', 'muted', kind === 'email' ? '未识别到可用邮箱' : '未识别到可用电话'));
  }
  for (const value of values) {
    const row = el('div', 'contact-dialog-row');
    const label = el('span', 'contact-dialog-value', maskContact(value, kind));
    row.appendChild(label);
    row.appendChild(copyButton(value, kind === 'email' ? '复制邮箱' : '复制电话'));
    if (kind === 'email') {
      row.appendChild(button('查看完整', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => { label.textContent = value; },
      }));
      row.appendChild(button('写邮件', {
        size: 'sm',
        variant: 'primary',
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: '发送邮件',
            message: `是否给 ${value} 发送邮件？`,
            confirmText: '打开邮件',
            cancelText: '取消',
          });
          if (confirmed) window.location.href = `mailto:${value}`;
        },
      }));
    } else {
      row.appendChild(button('查看完整', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => { label.textContent = value; },
      }));
      row.appendChild(button('拨打', {
        size: 'sm',
        variant: 'primary',
        onClick: () => { window.location.href = `tel:${value.replace(/[^\d+]/g, '')}`; },
      }));
    }
    body.appendChild(row);
  }
  openModal({ title, body, size: 'sm' });
}

export const meta = {
  title: '潜在客户',
  help: '所有企业的统一主记录。支持按国家、状态与评分筛选，评分由规则引擎基于产品资料和 ICP 计算，可追溯、可解释。',
};



const PAGE_SIZE = 25;

/** Common European buyer markets (ISO-3166 alpha-2). */
export const EU_COUNTRIES = [
  'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PL', 'PT', 'DK', 'SE', 'NO', 'FI', 'IE', 'GB', 'CH',
  'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'LT', 'LV', 'EE', 'LU',
];

export const COMPANY_TYPES = [
  ['manufacturer', '制造商'],
  ['distributor', '分销商'],
  ['wholesaler', '批发商'],
  ['importer', '进口商'],
  ['retailer', '零售商'],
  ['dealer', '经销商'],
  ['trader', '贸易商'],
  ['trading_company', '贸易公司'],
  ['reseller', '代理商'],
  ['other', '其他'],
];

export const COMPANY_STATUS_OPTIONS = [
  ['new', '新线索'],
  ['qualified', '已合格'],
  ['contacted', '已触达'],
  ['replied', '已回复'],
  ['customer', '已成交'],
  ['disqualified', '不合格'],
  ['archived', '已归档'],
];

export const CONFIDENCE_OPTIONS = [
  ['unverified', '未验证'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
];

export const EMPLOYEE_RANGES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];

/**
 * Display labels for company types. The API stores free-form values (imports,
 * discovery and manual edits may use different spellings), so labels are
 * normalised token by token and unknown values fall back to the original text.
 */
const COMPANY_TYPE_LABELS = {
  manufacturer: '制造商',
  producer: '制造商',
  factory: '工厂',
  distributor: '分销商',
  wholesaler: '批发商',
  wholesale: '批发商',
  importer: '进口商',
  import: '进口商',
  exporter: '出口商',
  export: '出口商',
  retailer: '零售商',
  retail: '零售商',
  dealer: '经销商',
  dealership: '经销商',
  trader: '贸易商',
  trading: '贸易公司',
  trading_company: '贸易公司',
  tradingcompany: '贸易公司',
  reseller: '代理商',
  agent: '代理商',
  agency: '代理商',
  supplier: '供应商',
  vendor: '供应商',
  aftermarket: '售后市场',
  after_market: '售后市场',
  oem: 'OEM 代工',
  brand_owner: '品牌方',
  service_provider: '服务商',
  other: '其他',
  unknown: '未知',
};

export function countryOptions() {
  return EU_COUNTRIES.map((code) => ({ value: code, label: `${countryName(code)}（${code}）` }));
}

export function typeOptions() {
  return COMPANY_TYPES.map(([value, label]) => ({ value, label }));
}

export function typeLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  const parts = raw
    .split(/[/,;|、]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return '—';
  return parts
    .map((part) => {
      const token = part.toLowerCase().replace(/[\s-]+/g, '_');
      return COMPANY_TYPE_LABELS[token] || part;
    })
    .join('、');
}

export function confidenceLabel(value) {
  const found = CONFIDENCE_OPTIONS.find(([key]) => key === value);
  return found ? found[1] : value || '未验证';
}

export function gradeFor(score) {
  const value = Number(score) || 0;
  if (value >= 80) return 'A';
  if (value >= 65) return 'B';
  if (value >= 45) return 'C';
  return 'D';
}

export function gradeTone(grade) {
  if (grade === 'A') return 'green';
  if (grade === 'B') return 'cyan';
  if (grade === 'C') return 'yellow';
  return 'red';
}

export function splitList(value) {
  return String(value || '')
    .split(/[,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Load products for score pickers (silently degrades when the API is down). */
export async function loadProducts() {
  const data = await api.get(`/api/v1/products${queryString({ pageSize: 100 })}`);
  const { items } = unwrapList(data);
  return items;
}

/**
 * Ask the user to pick a product then resolve `{productId, product}`.
 * Resolves `null` when cancelled or when there is no product yet.
 */
export async function pickProduct({ title = '选择产品', confirmText = '确认', help = null } = {}) {
  let products = [];
  try {
    products = await loadProducts();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return null;
  }
  if (!products.length) {
    toast('还没有产品资料，请先创建产品后再评分', 'warning');
    navigate('/products');
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const productSelect = select({
      value: products[0].id,
      options: products.map((product) => ({
        value: product.id,
        label: product.category ? `${product.name} · ${product.category}` : product.name,
      })),
    });
    const body = el('div', 'stack');
    append(body, [
      field('产品', productSelect, {
        required: true,
        help: help || '评分只基于所选产品的已确认资料、ICP 条件与企业记录，不会编造事实。',
      }),
      el('div', 'muted', `共 ${products.length} 个产品可选`),
    ]);
    openModal({
      title,
      body,
      size: 'sm',
      actions: [
        { label: '取消' },
        {
          label: confirmText,
          variant: 'primary',
          onClick: (done) => {
            const productId = productSelect.value;
            if (!productId) {
              toast('请选择产品', 'warning');
              return;
            }
            const product = products.find((item) => item.id === productId) || null;
            finish({ productId, product });
            done();
          },
        },
      ],
      onClose: () => finish(null),
    });
  });
}

/** Company create/edit dialog shared with the company detail page. */
export function openCompanyForm({ company = null, onSaved = null } = {}) {
  const editing = Boolean(company && company.id);
  const values = {
    name: company && company.name ? company.name : '',
    domain: company && company.domain ? company.domain : '',
    website: company && company.website ? company.website : '',
    country: company && company.country ? company.country : '',
    companyType: company && company.companyType ? company.companyType : '',
    industry: company && company.industry ? company.industry : '',
    employeeRange: company && company.employeeRange ? company.employeeRange : '',
    description: company && company.description ? company.description : '',
    tags: safeArray(company && company.tags).join(', '),
  };
  const controls = {
    name: input({ value: values.name, placeholder: '例如 Muster Autoteile GmbH' }),
    domain: input({ value: values.domain, placeholder: 'muster-autoteile.de' }),
    website: input({ value: values.website, placeholder: 'https://muster-autoteile.de' }),
    country: select({ value: values.country, options: countryOptions(), placeholder: '请选择国家' }),
    companyType: select({ value: values.companyType, options: typeOptions(), placeholder: '请选择企业类型' }),
    industry: input({ value: values.industry, placeholder: '例如 Automotive Aftermarket' }),
    employeeRange: select({
      value: values.employeeRange,
      options: EMPLOYEE_RANGES.map((range) => ({ value: range, label: `${range} 人` })),
      placeholder: '请选择规模',
    }),
    description: textarea({ value: values.description, rows: 3, placeholder: '主营业务、采购习惯、已知的采购品类…' }),
    tags: input({ value: values.tags, placeholder: '例如 distributor, aftermarket, DACH' }),
  };
  const descriptionField = field('描述', controls.description, { help: '用于产品匹配与评分的说明字段，尽量写清主营业务与采购品类。' });
  descriptionField.classList.add('span-2');
  const body = el('div', 'form-grid');
  append(body, [
    field('企业名称', controls.name, { required: true }),
    field('域名', controls.domain, { help: '仅域名，不含协议与路径。域名用于去重与来源追踪。' }),
    field('网站', controls.website, { help: '留空时会根据域名自动生成。' }),
    field('国家', controls.country, { help: '两位国家代码；欧洲买家市场常用国家已列出。' }),
    field('企业类型', controls.companyType),
    field('行业', controls.industry),
    field('员工规模', controls.employeeRange),
    field('标签', controls.tags, { help: '逗号分隔，最多 30 个。' }),
    descriptionField,
  ]);

  let saving = false;
  const dialog = openModal({
    title: editing ? '编辑企业' : '新建企业',
    body,
    size: 'lg',
    actions: [
      { label: '取消' },
      {
        label: editing ? '保存修改' : '创建企业',
        variant: 'primary',
        onClick: async (done) => {
          if (saving) return;
          const name = String(controls.name.value || '').trim();
          if (!name) {
            toast('企业名称不能为空', 'warning');
            controls.name.focus();
            return;
          }
          const payload = {
            name,
            domain: String(controls.domain.value || '').trim(),
            website: String(controls.website.value || '').trim(),
            country: controls.country.value || null,
            companyType: controls.companyType.value || null,
            industry: String(controls.industry.value || '').trim() || null,
            employeeRange: controls.employeeRange.value || null,
            description: String(controls.description.value || '').trim() || null,
            tags: splitList(controls.tags.value),
          };
          const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
          saving = true;
          if (saveBtn) saveBtn.disabled = true;
          try {
            const saved = editing
              ? await api.patch(`/api/v1/companies/${encodeURIComponent(company.id)}`, payload)
              : await api.post('/api/v1/companies', payload);
            toast(editing ? '企业已更新' : '企业已创建', 'success');
            done();
            if (typeof onSaved === 'function') onSaved(saved);
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

function renderErrorState(host, message, retry) {
  clear(host);
  const box = el('div', 'page-state');
  append(box, [
    notice(`加载失败：${message}`, 'danger'),
    el('div', 'row', [button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: retry })]),
  ]);
  host.appendChild(box);
}

// ------------------------------------------------------------------ page
let disposed = false;
let cleanup = [];

export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  cleanup = [];
  let searchTimer = null;

  const query = ctx && ctx.query ? ctx.query : new URLSearchParams();
  const state = {
    page: 1,
    q: query.get('q') || '',
    country: '',
    status: '',
    minScore: '',
    hasEmail: null,
    contactLevel: '',
    items: [],
    total: 0,
    selected: new Set(),
  };

  const tableHost = el('div', 'stack');
  const paginationHost = el('div', '');
  const batchBar = el('div', 'page-batch hidden');
  const writable = can('data.write');

  function renderEmpty() {
    const filtered = Boolean(state.q || state.country || state.status || state.minScore || state.hasEmail !== null || state.contactLevel);
    if (filtered) {
      return emptyState({
        iconName: 'search',
        title: '没有匹配的企业',
        description: '尝试调整关键词、国家或评分筛选。',
        action: button('清除筛选', { size: 'sm', onClick: () => ctx?.refresh?.() }),
      });
    }
    const actions = el('div', 'row page-empty-actions');
    append(actions, [
      button('新建企业', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: () => openCompanyForm({ onSaved: load }) }),
      button('导入 CSV', { variant: 'outline', size: 'sm', iconName: 'upload', disabled: !can('import.run'), onClick: openImportModal }),
      button('去企业发现', { variant: 'outline', size: 'sm', iconName: 'compass', onClick: () => navigate('/discovery') }),
    ]);
    return emptyState({
      iconName: 'building',
      title: '还没有企业',
      description: '新建一家企业、导入 CSV，或让「企业发现」按产品与 ICP 自动采集。',
      action: actions,
    });
  }

  function columns() {
    return [
      {
        key: 'select',
        label: '',
        width: 30,
        render: (row) =>
          checkbox({
            checked: state.selected.has(row.id),
            onChange: (checked) => toggleSelection(row.id, checked),
          }),
      },
      {
        key: 'name',
        label: '企业名称',
        render: (row) => el('span', 'cell-main', row.name || '未命名企业'),
      },
      {
        key: 'country',
        label: '国家',
        render: (row) => (row.country ? countryName(row.country) : '—'),
      },
      {
        key: 'category',
        label: '分类',
        render: (row) => {
          const type = row.companyType ? typeLabel(row.companyType) : '';
          const industry = row.industry || '';
          return el('div', '', [
            el('span', '', type || industry || '—'),
            type && industry && industry !== type ? el('div', 'cell-sub', industry) : null,
          ].filter(Boolean));
        },
      },
      {
        key: 'website',
        label: '网址',
        render: (row) => {
          const raw = row.website || row.domain || '';
          if (!raw) return '—';
          const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
          const link = el('a', 'cell-main', domainOf(raw));
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.addEventListener('click', (event) => event.stopPropagation());
          return link;
        },
      },
      {
        key: 'status',
        label: '状态',
        render: (row) => {
          const stageLabels = {
            discovered: '发现池',
            new_lead: '新线索',
            potential: '潜在客户',
            contacted: '已联系',
            intent: '意向客户',
            qualified: '已合格',
            customer: '确认客户',
            excluded: '已排除',
          };
          const tones = {
            discovered: 'gray',
            new_lead: 'gray',
            potential: 'blue',
            contacted: 'yellow',
            intent: 'green',
            qualified: 'green',
            customer: 'green',
            excluded: 'red',
          };
          return badge(stageLabels[row.leadStage] || row.status || '—', tones[row.leadStage] || 'gray');
        },
      },
      {
        key: 'contactCompleteness',
        label: '联系方式',
        render: (row) => {
          const emailCount = Number(row.emailCount ?? 0);
          const phoneCount = row.phone ? 1 : 0;
          const wrap = el('div', 'row contact-actions');
          wrap.appendChild(emailCount > 0
            ? button(`邮箱 ${emailCount}`, { size: 'sm', variant: 'ghost', onClick: () => openContactDialog(row, 'email') })
            : el('span', 'muted', '无邮箱'));
          wrap.appendChild(phoneCount > 0
            ? button(`电话 ${phoneCount}`, { size: 'sm', variant: 'ghost', onClick: () => openContactDialog(row, 'phone') })
            : el('span', 'muted', '无电话'));
          return wrap;
        },
      },
      {
        key: 'score',
        label: '评分',
        render: (row) => {
          const score = row.latestScore ?? row.score ?? null;
          if (score === null || score === undefined) return badge('未评分', 'gray');
          const grade = gradeFor(score);
          const wrap = el('div', 'row');
          append(wrap, [scoreMeter(score), badge(grade, gradeTone(grade))]);
          return wrap;
        },
      },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) => {
          const wrap = el('div', 'row page-row-actions');
          append(wrap, [
            button('查看', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'eye',
              onClick: () => navigate(`/companies/${encodeURIComponent(row.id)}`),
            }),
            button('删除', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              disabled: !can('data.delete'),
              onClick: () => deleteOne(row),
            }),
          ]);
          return wrap;
        },
      },
    ];
  }

  function renderRows() {
    clear(tableHost);
    tableHost.appendChild(
      dataTable({
        columns: columns(),
        rows: state.items,
        empty: renderEmpty(),
        onRowClick: (row) => navigate(`/companies/${encodeURIComponent(row.id)}`),
      }),
    );
  }

  function updateBatchBar() {
    const count = state.selected.size;
    batchBar.classList.toggle('hidden', count === 0);
    clear(batchBar);
    if (!count) return;
    append(batchBar, [
      el('span', 'page-batch-count', `已选 ${count} 家企业`),
      el('span', 'grow'),
      button('全选本页', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          for (const row of state.items) state.selected.add(row.id);
          renderRows();
          updateBatchBar();
        },
      }),
      button('清除', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          state.selected.clear();
          renderRows();
          updateBatchBar();
        },
      }),
      button('批量评分', {
        size: 'sm',
        variant: 'primary',
        iconName: 'zap',
        disabled: !writable,
        onClick: bulkScore,
      }),
      button('批量补全', {
        size: 'sm',
        variant: 'outline',
        iconName: 'search',
        disabled: !can('discovery.run'),
        onClick: bulkEnrich,
      }),
      button('批量写信', {
        size: 'sm',
        variant: 'outline',
        iconName: 'mail',
        disabled: !writable,
        onClick: bulkDraft,
      }),
      button('批量删除', {
        size: 'sm',
        variant: 'danger',
        iconName: 'trash',
        disabled: !can('data.delete'),
        onClick: bulkDelete,
      }),
    ]);
  }

  async function bulkDelete() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const confirmed = await confirmDialog({
      title: '批量删除企业',
      message: `确认删除选中的 ${ids.length} 家企业？删除后它们会从潜在客户列表移除，但不会影响已发送的历史邮件。`,
      confirmText: '确认删除',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post('/api/v1/companies/bulk', { action: 'delete', ids });
      toast(`已删除 ${ids.length} 家企业`, 'success');
      state.selected.clear();
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function toggleSelection(id, checked) {
    if (checked) state.selected.add(id);
    else state.selected.delete(id);
    updateBatchBar();
  }

  function renderPagination() {
    clear(paginationHost);
    if (!state.total) return;
    paginationHost.appendChild(
      pagination({
        page: state.page,
        pageSize: PAGE_SIZE,
        total: state.total,
        onChange: (nextPage) => {
          state.page = Math.max(1, Number(nextPage) || 1);
          load();
        },
      }),
    );
  }

  async function load() {
    if (disposed) return;
    clear(tableHost);
    tableHost.appendChild(dataTable({ columns: columns(), rows: [], loading: true }));
    clear(paginationHost);
    try {
      const data = await api.get(
        `/api/v1/companies${queryString({
          page: state.page,
          pageSize: PAGE_SIZE,
          q: state.q,
          country: state.country,
          status: state.status,
          minScore: state.minScore,
          hasEmail: state.hasEmail,
          contactLevel: state.contactLevel,
        })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      state.items = items;
      state.total = total;
      const serverPage = Number(data && data.page);
      if (Number.isFinite(serverPage) && serverPage > 0) state.page = serverPage;
      renderRows();
      renderPagination();
      updateBatchBar();
    } catch (error) {
      if (disposed) return;
      renderErrorState(tableHost, errorMessage(error), load);
      state.items = [];
      state.total = 0;
      renderPagination();
    }
  }

  async function deleteOne(row) {
    const confirmed = await confirmDialog({
      title: '删除企业',
      message: `确认删除「${row.name || '该企业'}」？删除后会从潜在客户列表移除，但不会删除已发送的历史邮件。`,
      confirmText: '确认删除',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/v1/companies/${encodeURIComponent(row.id)}`);
      toast('企业已删除', 'success');
      state.selected.delete(row.id);
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function scoreOne(row) {
    const picked = await pickProduct({ title: `为「${row.name || '企业'}」评分`, confirmText: '开始评分' });
    if (!picked) return;
    try {
      const result = await api.post(`/api/v1/companies/${encodeURIComponent(row.id)}/score`, {
        productId: picked.productId,
      });
      const score = result && result.score !== undefined ? `：${result.score} 分（${result.grade || gradeFor(result.score)} 级）` : '';
      toast(`评分完成${score}`, 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function bulkScore() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const picked = await pickProduct({ title: `批量评分（${ids.length} 家）`, confirmText: '开始评分' });
    if (!picked) return;
    try {
      const result = await api.post('/api/v1/companies/bulk', {
        action: 'score',
        ids,
        productId: picked.productId,
      });
      const updated = result && result.updated !== undefined ? result.updated : ids.length;
      toast(`已提交 ${updated} 家企业的评分`, 'success');
      state.selected.clear();
      updateBatchBar();
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function bulkEnrich() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const confirmed = await confirmDialog({
      title: '批量补全联系方式',
      message: `将依次打开选中的 ${ids.length} 家企业官网，补全邮箱、电话和社交链接。网站较多时会比较慢，是否继续？`,
      confirmText: '开始补全',
      cancelText: '取消',
    });
    if (!confirmed) return;
    try {
      const result = await api.post('/api/v1/companies/bulk', { action: 'enrich', ids });
      const updated = result?.updated ?? 0;
      toast(`已补全 ${updated} 家企业，刷新查看邮箱/电话`, 'success');
      state.selected.clear();
      updateBatchBar();
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function bulkDraft() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const confirmed = await confirmDialog({
      title: '批量生成开发信',
      message: `将为选中的 ${ids.length} 家企业生成开发信草稿。只有有邮箱的企业会生成，生成后需人工审批才能发送。`,
      confirmText: '开始生成',
      cancelText: '取消',
    });
    if (!confirmed) return;
    try {
      const result = await api.post('/api/v1/companies/bulk', { action: 'draft', ids });
      toast(`已生成 ${result?.updated ?? 0} 封草稿，请到「邮件草稿」检查`, 'success');
      state.selected.clear();
      updateBatchBar();
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function showImportResult(result) {
    const data = result && typeof result === 'object' ? result : {};
    const grid = el('div', 'page-kpi-grid');
    const counts = [
      ['总行数', data.totalRows],
      ['新增', data.createdCount],
      ['更新', data.updatedCount],
      ['跳过', data.skippedCount],
      ['错误', data.errorCount],
    ];
    for (const [label, value] of counts) {
      append(grid, [el('div', 'fact', [el('span', 'k', label), el('span', 'v', formatNumber(value ?? 0))])]);
    }
    const body = el('div', 'stack');
    body.appendChild(grid);
    const status = data.status === 'completed' ? 'succeeded' : data.status;
    if (status) body.appendChild(el('div', 'row', [el('span', 'muted', '状态'), statusBadge(status, 'job')]));
    const errors = safeArray(data.errors);
    if (errors.length) {
      const list = el('div', 'page-import-errors');
      for (const item of errors.slice(0, 10)) {
        const text = typeof item === 'string' ? item : `第 ${item.row ?? '?'} 行：${item.message || item.error || '导入失败'}`;
        list.appendChild(el('div', 'page-import-error', text));
      }
      body.appendChild(list);
    }
    body.appendChild(el('div', 'row', [helpTip('重复域名会被跳过或更新；导入记录与错误明细已写入审计日志，可追溯。')]));
    openModal({ title: '导入结果', body, size: 'sm', actions: [{ label: '完成', variant: 'primary' }] });
  }

  function openImportModal() {
    const fileInput = input({ type: 'file', className: 'input' });
    fileInput.accept = '.csv,text/csv,text/plain';
    const fileHint = el('div', 'field-hint', '未选择文件');
    const csvText = textarea({
      rows: 8,
      placeholder: 'name,domain,country,companyType,industry,website\nMuster Autoteile GmbH,muster-autoteile.de,DE,distributor,Automotive Aftermarket,',
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      fileHint.textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
      const reader = new FileReader();
      reader.onload = () => {
        csvText.value = String(reader.result || '');
      };
      reader.onerror = () => toast('读取文件失败，请改用粘贴文本', 'error');
      reader.readAsText(file, 'utf-8');
    });
    const body = el('div', 'stack');
    append(body, [
      field('CSV 文件', fileInput, {
        help: 'UTF-8 编码，首行为表头。支持 name、domain、country、companyType、industry、website、description、tags 列。',
      }),
      fileHint,
      el('div', 'muted', '— 或直接粘贴 CSV 文本 —'),
      field('粘贴 CSV 内容', csvText, { help: '按域名去重：重复企业会被跳过或更新；所有导入记录保留来源与错误明细。' }),
    ]);
    let importing = false;
    const dialog = openModal({
      title: '导入企业 CSV',
      body,
      size: 'lg',
      actions: [
        { label: '取消' },
        {
          label: '开始导入',
          variant: 'primary',
          onClick: async (done) => {
            if (importing) return;
            const text = String(csvText.value || '').trim();
            if (!text) {
              toast('请选择文件或粘贴 CSV 内容', 'warning');
              return;
            }
            const file = fileInput.files && fileInput.files[0];
            const filename = (file && file.name) || 'pasted-companies.csv';
            const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
            importing = true;
            if (saveBtn) {
              saveBtn.disabled = true;
              saveBtn.textContent = '导入中…';
            }
            try {
              const result = await api.post('/api/v1/imports', { kind: 'companies', filename, text });
              done();
              showImportResult(result);
              load();
            } catch (error) {
              toast(errorMessage(error), 'error');
            } finally {
              importing = false;
              if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = '开始导入';
              }
            }
          },
        },
      ],
    });
    void dialog;
  }

  async function exportCompanies(buttonNode) {
    if (buttonNode) buttonNode.disabled = true;
    try {
      const data = await api.get(
        `/api/v1/export/companies${queryString({
          format: 'csv',
          q: state.q,
          country: state.country,
          status: state.status,
          minScore: state.minScore,
          hasEmail: state.hasEmail,
          contactLevel: state.contactLevel,
        })}`,
      );
      const content = typeof data === 'string' ? data : data && data.content;
      if (!content) throw new Error('导出内容为空');
      const filename = (data && data.filename) || 'companies.csv';
      downloadText(filename, content, 'text/csv;charset=utf-8');
      toast('CSV 已开始下载', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      if (buttonNode) buttonNode.disabled = false;
    }
  }

  const exportBtn = button('导出 CSV', {
    iconName: 'download',
    disabled: !can('export.run'),
    onClick: () => exportCompanies(exportBtn),
  });
  const refreshBtn = button('刷新', { iconName: 'refresh', onClick: () => load() });
  const newBtn = button('新建企业', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !writable,
    onClick: () => openCompanyForm({ onSaved: load }),
  });
  const importBtn = button('导入 CSV', {
    iconName: 'upload',
    variant: 'outline',
    disabled: !can('import.run'),
    onClick: openImportModal,
  });
  const cleanupBtn = button('剔除无联系方式', {
    iconName: 'trash',
    variant: 'outline',
    disabled: !can('data.delete'),
    onClick: cleanupNoEmail,
  });

  async function cleanupNoEmail() {
    try {
      const data = await api.get('/api/v1/companies?hasEmail=false&pageSize=100');
      const { items } = unwrapList(data);
      const ids = items.map((item) => item.id);
      if (!ids.length) {
        toast('没有需要剔除的无联系方式企业', 'info');
        return;
      }
      const confirmed = await confirmDialog({
        title: '剔除无联系方式企业',
        message: `找到 ${ids.length} 家没有有效邮箱的企业。确认从潜在客户列表删除？`,
        confirmText: '确认剔除',
        cancelText: '取消',
        danger: true,
      });
      if (!confirmed) return;
      await api.post('/api/v1/companies/bulk', { action: 'delete', ids });
      toast(`已剔除 ${ids.length} 家无联系方式企业`, 'success');
      state.selected.clear();
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const searchNode = searchInput({
    placeholder: '搜索企业名称 / 域名 / 行业…',
    value: state.q,
    onInput: (value) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = String(value || '').trim();
        state.page = 1;
        load();
      }, 300);
    },
  });
  cleanup.push(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  const countrySelect = select({
    value: '',
    options: countryOptions(),
    placeholder: '全部国家',
    className: 'select filter-select',
    onChange: (value) => {
      state.country = value;
      state.page = 1;
      load();
    },
  });
  const statusSelect = select({
    value: '',
    options: COMPANY_STATUS_OPTIONS.map(([value, label]) => ({ value, label })),
    placeholder: '全部状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      load();
    },
  });
  const minScoreSelect = select({
    value: '',
    options: [
      { value: '40', label: '评分 ≥ 40' },
      { value: '60', label: '评分 ≥ 60' },
      { value: '80', label: '评分 ≥ 80' },
    ],
    placeholder: '评分不限',
    className: 'select filter-select',
    onChange: (value) => {
      state.minScore = value;
      state.page = 1;
      load();
    },
  });

  const hasEmailSelect = select({
    value: 'all',
    options: [
      { value: 'all', label: '全部联系方式' },
      { value: 'with', label: '有邮箱' },
      { value: 'without', label: '无邮箱' },
    ],
    className: 'select filter-select',
    onChange: (value) => {
      state.hasEmail = value === 'with' ? true : value === 'without' ? false : null;
      state.page = 1;
      load();
    },
  });

  const contactLevelSelect = select({
    value: '',
    options: [
      { value: '', label: '全部联系方式等级' },
      { value: 'A', label: 'A 完整' },
      { value: 'B', label: 'B 较全' },
      { value: 'C', label: 'C 部分' },
      { value: 'D', label: 'D 仅官网' },
      { value: 'none', label: '无官网' },
    ],
    className: 'select filter-select',
    onChange: (value) => {
      state.contactLevel = value;
      state.page = 1;
      load();
    },
  });

  append(root, [
    pageHeader({
      title: meta.title,
      help: meta.help,
      actions: [cleanupBtn, refreshBtn, newBtn],
    }),
    toolbar(searchNode, countrySelect, statusSelect, minScoreSelect, hasEmailSelect, contactLevelSelect, el('span', 'grow'), importBtn, exportBtn),
    batchBar,
    tableHost,
    paginationHost,
  ]);

  await load();
}

export function destroy() {
  disposed = true;
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // cleanup must never break navigation
    }
  }
}
