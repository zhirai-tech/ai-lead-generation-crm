/**
 * Ideal customer profile (ICP) page.
 *
 * ICPs describe the buyer profile used by discovery and rule-based scoring:
 * target countries, company types, sizes, buying roles, include/exclude
 * keywords and the minimum score. They never invent company facts.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { can } from '../app/state.mjs';
import { countryName, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  confirmDialog,
  dataTable,
  emptyState,
  field,
  helpTip,
  input,
  notice,
  openModal,
  pageHeader,
  pagination,
  searchInput,
  select,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';
import { EU_COUNTRIES, splitList, typeLabel } from './companies.js';

export const meta = {
  title: '客户画像',
  help: '理想客户画像（ICP）：目标国家、企业类型、规模、采购角色与排除条件。发现与评分会按 ICP 规则筛选企业，命中排除条件的企业会被明确标记。',
};

const PAGE_SIZE = 25;

const COMPANY_TYPE_OPTIONS = [
  ['importer', '进口商'],
  ['distributor', '分销商'],
  ['wholesaler', '批发商'],
  ['manufacturer', '制造商'],
  ['retailer', '零售商'],
  ['dealer', '经销商'],
  ['trader', '贸易商'],
  ['reseller', '代理商'],
  ['aftermarket', '售后市场'],
];

const SIZE_OPTIONS = [
  ['1-10', '1-10 人'],
  ['11-50', '11-50 人'],
  ['51-200', '51-200 人'],
  ['201-500', '201-500 人'],
  ['501-1000', '501-1000 人'],
  ['1000+', '1000+ 人'],
];

const ROLE_OPTIONS = [
  ['owner', '老板 / 拥有者'],
  ['ceo', 'CEO / 总经理'],
  ['managing_director', 'Managing Director'],
  ['purchasing_manager', '采购经理'],
  ['procurement', '采购专员'],
  ['sales_manager', '销售经理'],
  ['product_manager', '产品经理'],
  ['technical_manager', '技术经理'],
];

const FALLBACK_COUNTRIES = EU_COUNTRIES.slice(0, 12);

let disposed = false;
let cleanup = [];

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

function countryChips() {
  return (EU_COUNTRIES.length ? EU_COUNTRIES : FALLBACK_COUNTRIES).map((code) => ({
    value: code,
    label: countryName(code) || code,
  }));
}

/** Multi-select chip group. Returns `{ node, values(), selected() }`. */
function chipGroup(options, initialValues = []) {
  const selected = new Set(initialValues.filter(Boolean));
  const node = el('div', 'page-chip-group');
  const render = () => {
    clear(node);
    for (const option of options) {
      const active = selected.has(option.value);
      const chip = el('button', `page-chip${active ? ' active' : ''}`, option.label);
      chip.type = 'button';
      chip.title = String(option.value);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      chip.addEventListener('click', () => {
        if (selected.has(option.value)) selected.delete(option.value);
        else selected.add(option.value);
        render();
      });
      node.appendChild(chip);
    }
  };
  render();
  return { node, values: () => [...selected] };
}

// ------------------------------------------------------------------ page
export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  cleanup = [];
  let searchTimer = null;

  const state = {
    q: '',
    page: 1,
    items: [],
    total: 0,
    products: [],
  };
  const listHost = el('div', 'stack');
  const paginationHost = el('div', '');
  const writable = can('data.write');
  const canDelete = can('data.delete');
  let productsLoaded = false;

  async function ensureProducts() {
    if (productsLoaded) return;
    productsLoaded = true;
    try {
      state.products = unwrapList(await api.get(`/api/v1/products${queryString({ pageSize: 100 })}`)).items;
    } catch {
      state.products = [];
    }
  }

  function productOptions() {
    return state.products.map((product) => ({ value: product.id, label: product.name }));
  }

  async function openIcpForm(icp = null) {
    await ensureProducts();
    if (disposed) return;
    const editing = Boolean(icp && icp.id);
    const controls = {
      name: input({ value: icp ? icp.name || '' : '', placeholder: '例如 德国汽配分销商' }),
      description: textarea({ value: icp ? icp.description || '' : '', rows: 3, placeholder: '描述目标客户画像、采购习惯与排除条件…' }),
      product: select({
        value: icp && icp.productId ? icp.productId : '',
        options: productOptions(),
        placeholder: '不关联产品',
      }),
      minScore: input({
        type: 'number',
        value: icp && icp.minScore !== undefined && icp.minScore !== null ? String(icp.minScore) : '60',
      }),
      includeKeywords: textarea({
        value: icp ? safeArray(icp.includeKeywords).join(', ') : '',
        rows: 2,
        placeholder: '逗号或换行分隔，例如 aftermarket, brake, distributor',
      }),
      excludeKeywords: textarea({
        value: icp ? safeArray(icp.excludeKeywords).join(', ') : '',
        rows: 2,
        placeholder: '命中这些关键词的企业会被排除，例如 oem only, salvaged',
      }),
    };
    controls.minScore.min = '0';
    controls.minScore.max = '100';
    const isActive = icp ? icp.isActive !== false : true;
    const activeCheckbox = el('input', '');
    activeCheckbox.type = 'checkbox';
    activeCheckbox.checked = isActive;
    const activeLabel = el('label', 'checkbox', [activeCheckbox, '启用该 ICP']);

    const descriptionField = field('描述', controls.description, {
      help: '说明目标客户画像；发现任务会参考这里的条件。',
    });
    descriptionField.classList.add('span-2');
    const countryGroup = chipGroup(countryChips(), icp ? safeArray(icp.targetCountries) : []);
    const typeGroup = chipGroup(
      COMPANY_TYPE_OPTIONS.map(([value, label]) => ({ value, label })),
      icp ? safeArray(icp.targetCompanyTypes) : [],
    );
    const sizeGroup = chipGroup(
      SIZE_OPTIONS.map(([value, label]) => ({ value, label })),
      icp ? safeArray(icp.targetSizes) : [],
    );
    const roleGroup = chipGroup(
      ROLE_OPTIONS.map(([value, label]) => ({ value, label })),
      icp ? safeArray(icp.targetRoles) : [],
    );
    const countriesField = field('目标国家', countryGroup.node, { help: '可多选；用于地区匹配评分与发现过滤。' });
    countriesField.classList.add('span-2');
    const typeField = field('目标企业类型', typeGroup.node, { help: '分销商、进口商、批发商通常是主要买家类型。' });
    typeField.classList.add('span-2');
    const sizeField = field('目标企业规模', sizeGroup.node);
    const roleField = field('目标采购角色', roleGroup.node);
    const includeField = field('包含关键词', controls.includeKeywords);
    includeField.classList.add('span-2');
    const excludeField = field('排除关键词', controls.excludeKeywords);
    excludeField.classList.add('span-2');

    const body = el('div', 'form-grid');
    append(body, [
      field('ICP 名称', controls.name, { required: true }),
      field('关联产品', controls.product, { help: '关联产品后，评分会优先使用该产品与 ICP 条件。' }),
      field('最低评分', controls.minScore, { help: '0-100 的整数；低于该分数的企业不会被列为合格线索。' }),
      field('状态', activeLabel, { help: '停用的 ICP 不参与新发现的默认筛选。' }),
      descriptionField,
      countriesField,
      typeField,
      sizeField,
      roleField,
      includeField,
      excludeField,
    ]);

    let saving = false;
    const dialog = openModal({
      title: editing ? '编辑 ICP' : '新建 ICP',
      body,
      size: 'lg',
      actions: [
        { label: '取消' },
        {
          label: editing ? '保存修改' : '创建 ICP',
          variant: 'primary',
          onClick: async (done) => {
            if (saving) return;
            const name = String(controls.name.value || '').trim();
            if (!name) {
              toast('ICP 名称不能为空', 'warning');
              controls.name.focus();
              return;
            }
            const minScoreValue = Number(controls.minScore.value);
            if (!Number.isInteger(minScoreValue) || minScoreValue < 0 || minScoreValue > 100) {
              toast('最低评分必须是 0-100 的整数', 'warning');
              controls.minScore.focus();
              return;
            }
            const payload = {
              name,
              description: String(controls.description.value || '').trim() || null,
              productId: controls.product.value || null,
              minScore: minScoreValue,
              isActive: activeCheckbox.checked,
              targetCountries: countryGroup.values(),
              targetCompanyTypes: typeGroup.values(),
              targetSizes: sizeGroup.values(),
              targetRoles: roleGroup.values(),
              includeKeywords: splitList(controls.includeKeywords.value),
              excludeKeywords: splitList(controls.excludeKeywords.value),
            };
            const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
            saving = true;
            if (saveBtn) saveBtn.disabled = true;
            try {
              if (editing) await api.patch(`/api/v1/icps/${encodeURIComponent(icp.id)}`, payload);
              else await api.post('/api/v1/icps', payload);
              toast(editing ? 'ICP 已更新' : 'ICP 已创建', 'success');
              done();
              load();
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
  }

  async function toggleActive(icp) {
    try {
      await api.patch(`/api/v1/icps/${encodeURIComponent(icp.id)}`, { isActive: !icp.isActive });
      toast(icp.isActive ? 'ICP 已停用' : 'ICP 已启用', 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeIcp(icp) {
    const confirmed = await confirmDialog({
      title: '删除 ICP',
      message: `确认删除「${icp.name}」？已关联该 ICP 的企业不会被删除，但会失去画像关联。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await api.delete(`/api/v1/icps/${encodeURIComponent(icp.id)}`);
      const affected = result && result.affectedCompanies ? `（${result.affectedCompanies} 家企业解除关联）` : '';
      toast(`ICP 已删除${affected}`, 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function columns() {
    return [
      {
        key: 'name',
        label: '名称',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [
            el('div', 'cell-main', row.name || '未命名 ICP'),
            el('div', 'cell-sub', row.description ? truncate(row.description, 70) : ''),
          ]);
          return wrap;
        },
      },
      { key: 'productName', label: '关联产品', render: (row) => row.productName || '—' },
      {
        key: 'targetCountries',
        label: '目标国家',
        render: (row) => {
          const countries = safeArray(row.targetCountries);
          if (!countries.length) return '—';
          const names = countries.slice(0, 4).map((code) => countryName(code) || code);
          return countries.length > 4 ? `${names.join('、')} +${countries.length - 4}` : names.join('、');
        },
      },
      {
        key: 'targetCompanyTypes',
        label: '企业类型',
        render: (row) => {
          const types = safeArray(row.targetCompanyTypes);
          return types.length ? types.slice(0, 3).map(typeLabel).join('、') : '—';
        },
      },
      {
        key: 'minScore',
        label: '最低分',
        align: 'right',
        render: (row) => badge(`≥ ${row.minScore ?? 0}`, (row.minScore ?? 0) >= 60 ? 'cyan' : 'gray'),
      },
      {
        key: 'isActive',
        label: '状态',
        render: (row) => badge(row.isActive ? '启用' : '停用', row.isActive ? 'green' : 'gray'),
      },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) => {
          const wrap = el('div', 'row page-row-actions');
          append(wrap, [
            button('编辑', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'edit',
              disabled: !writable,
              onClick: () => openIcpForm(row),
            }),
            button(row.isActive ? '停用' : '启用', {
              size: 'sm',
              variant: 'ghost',
              iconName: row.isActive ? 'pause' : 'play',
              disabled: !writable,
              onClick: () => toggleActive(row),
            }),
            button('删除', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              disabled: !canDelete,
              onClick: () => removeIcp(row),
            }),
          ]);
          return wrap;
        },
      },
    ];
  }

  function renderEmpty() {
    if (state.q) {
      return emptyState({
        iconName: 'search',
        title: '没有匹配的 ICP',
        description: '尝试调整搜索关键词。',
        action: button('清除搜索', { size: 'sm', onClick: () => ctx?.refresh?.() }),
      });
    }
    return emptyState({
      iconName: 'target',
      title: '还没有客户画像',
      description: 'ICP 用于筛选企业并驱动规则评分：先定义目标国家、企业类型与采购角色。',
      action: button('新建第一个 ICP', {
        variant: 'primary',
        iconName: 'plus',
        disabled: !writable,
        onClick: () => openIcpForm(),
      }),
    });
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
    clear(listHost);
    listHost.appendChild(dataTable({ columns: [{ key: 'name', label: 'ICP' }], rows: [], loading: true }));
    clear(paginationHost);
    try {
      const data = await api.get(
        `/api/v1/icps${queryString({ page: state.page, pageSize: PAGE_SIZE, q: state.q })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      state.items = items;
      state.total = total;
      clear(listHost);
      listHost.appendChild(
        dataTable({
          columns: columns(),
          rows: items,
          empty: renderEmpty(),
          onRowClick: (row) => openIcpForm(row),
        }),
      );
      renderPagination();
    } catch (error) {
      if (disposed) return;
      clear(listHost);
      const box = el('div', 'page-state');
      append(box, [
        notice(`加载失败：${errorMessage(error)}`, 'danger'),
        el('div', 'row', [
          button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => load() }),
        ]),
      ]);
      listHost.appendChild(box);
      clear(paginationHost);
    }
  }

  const refreshBtn = button('刷新', { iconName: 'refresh', onClick: () => load() });
  const newBtn = button('新建 ICP', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !writable,
    onClick: () => openIcpForm(),
  });
  const searchNode = searchInput({
    placeholder: '搜索 ICP 名称 / 描述…',
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

  append(root, [
    pageHeader({ title: meta.title, help: meta.help, actions: [refreshBtn, newBtn] }),
    toolbar(searchNode, el('span', 'grow'), helpTip('ICP 决定企业发现与规则评分的目标范围：目标国家、企业类型、规模、采购角色与排除关键词。')),
    listHost,
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
