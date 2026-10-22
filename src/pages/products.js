/**
 * Product catalogue page.
 *
 * Products are the single source of truth for outward claims. Certifications,
 * capacity, MOQ, pricing and lead time are stored exactly as entered; the UI
 * never generates or suggests facts.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { can } from '../app/state.mjs';
import { relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  confirmDialog,
  dataTable,
  emptyState,
  field,
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
import { splitList } from './companies.js';

export const meta = {
  title: '产品资料',
  help: '产品参数、认证、MOQ 与交付条件。所有对外承诺（认证、产能、价格、交期）必须来自这里的已确认资料；AI 不得编造任何未在此登记的事实。',
};

const PAGE_SIZE = 12;

const PRODUCT_STATUS = {
  active: ['在售', 'green'],
  draft: ['草稿', 'yellow'],
  archived: ['已归档', 'gray'],
};

const STATUS_OPTIONS = [
  ['active', '在售'],
  ['draft', '草稿'],
  ['archived', '已归档'],
];

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

function productStatusBadge(status) {
  const found = PRODUCT_STATUS[status] || [status || '未知', 'gray'];
  return badge(found[0], found[1]);
}

// ------------------------------------------------------------------ page
export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  cleanup = [];
  let searchTimer = null;

  const state = {
    q: '',
    status: '',
    page: 1,
    items: [],
    total: 0,
  };
  const listHost = el('div', 'stack');
  const paginationHost = el('div', '');
  const writable = can('data.write');
  const canDelete = can('data.delete');

  function openProductForm(product = null) {
    const editing = Boolean(product && product.id);
    const specsValue = product && product.specs && Object.keys(product.specs).length ? JSON.stringify(product.specs, null, 2) : '';
    const controls = {
      name: input({ value: product ? product.name || '' : '', placeholder: '例如 陶瓷刹车片 Ceramic Brake Pads' }),
      category: input({ value: product ? product.category || '' : '', placeholder: '例如 Automotive Aftermarket' }),
      sku: input({ value: product ? product.sku || '' : '', placeholder: '例如 BP-2024-CER' }),
      status: select({
        value: product && product.status ? product.status : 'active',
        options: STATUS_OPTIONS.map(([value, label]) => ({ value, label })),
      }),
      description: textarea({ value: product ? product.description || '' : '', rows: 3 }),
      materials: input({ value: product ? product.materials || '' : '', placeholder: '例如 陶瓷纤维、钢背' }),
      capacity: input({ value: product ? product.capacity || '' : '', placeholder: '例如 月产 50,000 套' }),
      moq: input({ value: product ? product.moq || '' : '', placeholder: '例如 500 套 / 型号' }),
      pricingTerms: input({ value: product ? product.pricingTerms || '' : '', placeholder: '例如 FOB Shanghai，30% 预付' }),
      samples: input({ value: product ? product.samples || '' : '', placeholder: '例如 可提供付费样品，7 天寄出' }),
      leadTime: input({ value: product ? product.leadTime || '' : '', placeholder: '例如 30-45 天' }),
      certifications: textarea({
        value: product ? safeArray(product.certifications).join('\n') : '',
        rows: 3,
        placeholder: '每行一项，例如\nE-Mark\nISO 9001:2015',
      }),
      applications: textarea({
        value: product ? safeArray(product.applications).join(', ') : '',
        rows: 2,
        placeholder: '逗号分隔，例如 乘用车, 商用车, 售后维修',
      }),
      specs: textarea({ value: specsValue, rows: 5, placeholder: '{"voltage":"12V","thickness":"18mm"}' }),
    };

    const descriptionField = field('产品描述', controls.description, {
      help: '只写已确认的参数与用途；描述会作为匹配与写信的事实依据。',
    });
    descriptionField.classList.add('span-2');
    const certField = field('认证', controls.certifications, {
      help: '每行一项，仅填写已获得的认证；不允许编造。',
    });
    certField.classList.add('span-2');
    const appField = field('应用场景', controls.applications, { help: '逗号分隔；用于规则匹配产品与企业业务。' });
    appField.classList.add('span-2');
    const specsField = field('规格（JSON）', controls.specs, {
      help: '必须是合法 JSON 对象，例如 {"material":"ceramic"}；保存前会校验格式。',
    });
    specsField.classList.add('span-2');

    const body = el('div', 'form-grid');
    append(body, [
      field('产品名称', controls.name, { required: true }),
      field('分类', controls.category),
      field('SKU', controls.sku),
      field('状态', controls.status),
      field('材料', controls.materials),
      field('产能', controls.capacity),
      field('MOQ', controls.moq),
      field('报价条件', controls.pricingTerms),
      field('样品', controls.samples),
      field('交期', controls.leadTime),
      descriptionField,
      certField,
      appField,
      specsField,
    ]);

    let saving = false;
    const dialog = openModal({
      title: editing ? '编辑产品' : '新建产品',
      body,
      size: 'lg',
      actions: [
        { label: '取消' },
        {
          label: editing ? '保存修改' : '创建产品',
          variant: 'primary',
          onClick: async (done) => {
            if (saving) return;
            const name = String(controls.name.value || '').trim();
            if (!name) {
              toast('产品名称不能为空', 'warning');
              controls.name.focus();
              return;
            }
            const specsText = String(controls.specs.value || '').trim();
            let specs = {};
            if (specsText) {
              try {
                const parsed = JSON.parse(specsText);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  throw new Error('规格必须是 JSON 对象');
                }
                specs = parsed;
              } catch (error) {
                toast(`规格 JSON 格式错误：${errorMessage(error)}`, 'error');
                controls.specs.focus();
                return;
              }
            }
            const payload = {
              name,
              category: String(controls.category.value || '').trim() || null,
              sku: String(controls.sku.value || '').trim() || null,
              status: controls.status.value,
              description: String(controls.description.value || '').trim() || null,
              materials: String(controls.materials.value || '').trim() || null,
              capacity: String(controls.capacity.value || '').trim() || null,
              moq: String(controls.moq.value || '').trim() || null,
              pricingTerms: String(controls.pricingTerms.value || '').trim() || null,
              samples: String(controls.samples.value || '').trim() || null,
              leadTime: String(controls.leadTime.value || '').trim() || null,
              certifications: splitList(controls.certifications.value),
              applications: splitList(controls.applications.value),
              specs,
            };
            const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
            saving = true;
            if (saveBtn) saveBtn.disabled = true;
            try {
              if (editing) await api.patch(`/api/v1/products/${encodeURIComponent(product.id)}`, payload);
              else await api.post('/api/v1/products', payload);
              toast(editing ? '产品已更新' : '产品已创建', 'success');
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

  async function setStatus(product, status) {
    try {
      await api.patch(`/api/v1/products/${encodeURIComponent(product.id)}`, { status });
      toast(status === 'archived' ? '产品已归档' : '产品已恢复', 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeProduct(product) {
    const confirmed = await confirmDialog({
      title: '删除产品',
      message: `确认删除「${product.name}」？删除后不再参与评分与外联；历史评分记录保留。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/v1/products/${encodeURIComponent(product.id)}`);
      toast('产品已删除', 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function productCard(product) {
    const node = el('article', 'page-product-card');
    const head = el('div', 'page-product-head');
    const titleBlock = el('div', 'page-product-title');
    append(titleBlock, [
      el('b', '', product.name || '未命名产品'),
      el(
        'span',
        'cell-sub',
        [product.category, product.sku].filter(Boolean).join(' · ') || '未分类',
      ),
    ]);
    append(head, [titleBlock, productStatusBadge(product.status)]);
    node.appendChild(head);
    if (product.description) {
      node.appendChild(el('p', 'page-product-desc', truncate(product.description, 150)));
    }
    const meta = el('div', 'page-product-meta');
    const certificationCount = safeArray(product.certifications).length;
    const facts = [
      ['MOQ', product.moq || '—'],
      ['认证', `${certificationCount} 项`],
      ['交期', product.leadTime || '—'],
      ['匹配企业', String(product.matchCount ?? 0)],
    ];
    for (const [label, value] of facts) {
      append(meta, [el('div', 'page-product-fact', [el('span', 'k', label), el('span', 'v', String(value))])]);
    }
    node.appendChild(meta);
    const foot = el('div', 'page-product-foot');
    const actions = el('div', 'row page-row-actions');
    append(actions, [
      button('编辑', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'edit',
        disabled: !writable,
        onClick: () => openProductForm(product),
      }),
      product.status === 'archived'
        ? button('恢复', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'refresh',
            disabled: !writable,
            onClick: () => setStatus(product, 'active'),
          })
        : button('归档', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'archive',
            disabled: !writable,
            onClick: () => setStatus(product, 'archived'),
          }),
      button('删除', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'trash',
        disabled: !canDelete,
        onClick: () => removeProduct(product),
      }),
    ]);
    append(foot, [el('span', 'muted', `更新于 ${relativeTime(product.updatedAt)}`), actions]);
    node.appendChild(foot);
    return node;
  }

  function renderEmpty() {
    const filtered = Boolean(state.q || state.status);
    if (filtered) {
      return emptyState({
        iconName: 'search',
        title: '没有匹配的产品',
        description: '尝试调整搜索关键词或状态筛选。',
        action: button('清除筛选', { size: 'sm', onClick: () => ctx?.refresh?.() }),
      });
    }
    return emptyState({
      iconName: 'box',
      title: '还没有产品资料',
      description: '创建第一个产品，登记已确认的参数、认证与交付条件；评分与写信都以此为事实来源。',
      action: button('创建第一个产品', {
        variant: 'primary',
        iconName: 'plus',
        disabled: !writable,
        onClick: () => openProductForm(),
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
    listHost.appendChild(dataTable({ columns: [{ key: 'name', label: '产品' }], rows: [], loading: true }));
    clear(paginationHost);
    try {
      const data = await api.get(
        `/api/v1/products${queryString({ page: state.page, pageSize: PAGE_SIZE, q: state.q, status: state.status })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      state.items = items;
      state.total = total;
      clear(listHost);
      if (!items.length) {
        listHost.appendChild(el('div', 'page-state', [renderEmpty()]));
      } else {
        const grid = el('div', 'page-product-grid');
        for (const product of items) grid.appendChild(productCard(product));
        listHost.appendChild(grid);
      }
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
  const newBtn = button('新建产品', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !writable,
    onClick: () => openProductForm(),
  });
  const searchNode = searchInput({
    placeholder: '搜索产品名称 / SKU / 分类…',
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
  const statusSelect = select({
    value: '',
    options: STATUS_OPTIONS.map(([value, label]) => ({ value, label })),
    placeholder: '全部状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      load();
    },
  });

  append(root, [
    pageHeader({ title: meta.title, help: meta.help, actions: [refreshBtn, newBtn] }),
    toolbar(searchNode, statusSelect, el('span', 'grow')),
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
