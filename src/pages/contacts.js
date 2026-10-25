/**
 * Contact library page: searchable list, detail drawer (profile, sources,
 * verification records), email verification, inferred-email guidance and
 * suppression shortcuts.
 *
 * Truthfulness rule: an inferred address is never presented as verified.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { countryName, formatDateTime, relativeTime } from '../utils/format.mjs';
import {
  badge,
  button,
  confirmDialog,
  dataTable,
  detailRows,
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
  statusBadge,
  toast,
  toolbar,
} from '../components/ui.mjs';
import { CONFIDENCE_OPTIONS, confidenceLabel, countryOptions } from './companies.js';

export const meta = {
  title: '联系人库',
  help: '联系人库 = 所有企业下的联系人总库（采购经理、品类经理、技术负责人等）。企业发现先得到企业，联系人再在企业详情或这里补充/导入；邮箱状态区分推测/未验证/有效/有风险/无效，推测邮箱不能直接正式外联。',
};

const PAGE_SIZE = 25;

const EMAIL_TYPE_LABELS = {
  business: '企业邮箱',
  personal: '个人邮箱',
  role: '角色邮箱',
  inferred: '推测邮箱',
  unknown: '未知类型',
};

const EMAIL_STATUS_OPTIONS = [
  ['unverified', '未验证'],
  ['valid', '有效'],
  ['risky', '有风险'],
  ['invalid', '无效'],
  ['inferred', '推测'],
];

const EMAIL_TYPE_OPTIONS = [
  ['business', '企业邮箱'],
  ['personal', '个人邮箱'],
  ['role', '角色邮箱'],
  ['inferred', '推测邮箱'],
  ['unknown', '未知类型'],
];

const ROLE_OPTIONS = [
  ['decision_maker', '决策人'],
  ['influencer', '影响者'],
  ['gatekeeper', '把关人'],
  ['technical', '技术联系人'],
  ['unknown', '未知'],
];

const ROLE_LABELS = {
  decision_maker: '决策人',
  influencer: '影响者',
  gatekeeper: '把关人',
  technical: '技术联系人',
  unknown: '未知',
};

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

function emailOf(contact) {
  return contact.email || contact.emailNormalized || '';
}

async function fetchOptionalJson(path) {
  try {
    return await api.get(path);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ page
export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  cleanup = [];
  let searchTimer = null;

  const query = ctx && ctx.query ? ctx.query : new URLSearchParams();
  const state = {
    q: query.get('q') || '',
    emailStatus: '',
    page: 1,
    items: [],
    total: 0,
  };
  const tableHost = el('div', 'stack');
  const paginationHost = el('div', '');
  const writable = can('data.write');
  const canSuppress = can('suppression.write');

  async function verifyContact(contact) {
    try {
      const result = await api.post(`/api/v1/contacts/${encodeURIComponent(contact.id)}/verify`, {});
      const status = EMAIL_STATUS_LABELS[result && result.emailStatus] || (result && result.emailStatus) || '未验证';
      const mx = result && result.mx ? ` · MX ${result.mx}` : '';
      toast(`校验完成：${status}${mx}`, 'success');
      load();
      return true;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return false;
    }
  }

  async function addSuppression(contact) {
    const email = emailOf(contact);
    if (!email) {
      toast('该联系人没有邮箱，无法加入邮箱抑制名单', 'warning');
      return false;
    }
    const confirmed = await confirmDialog({
      title: '加入抑制名单',
      message: `确认将 ${email} 加入抑制名单？加入后系统不会再向其发送任何邮件（含活动与手动发送）。`,
      confirmText: '加入抑制名单',
      danger: true,
    });
    if (!confirmed) return false;
    try {
      const result = await api.post('/api/v1/suppression', {
        scope: 'email',
        value: email,
        reason: 'manual',
        source: 'contacts_page',
      });
      toast(result && result.created === false ? '该邮箱已在抑制名单中' : '已加入抑制名单', 'success');
      load();
      return true;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return false;
    }
  }

  async function deleteContact(contact) {
    const confirmed = await confirmDialog({
      title: '删除联系人',
      message: `确认删除 ${contact.fullName || emailOf(contact) || '该联系人'}？删除后不会再出现在列表中（历史邮件记录保留）。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/v1/contacts/${encodeURIComponent(contact.id)}`);
      toast('联系人已删除', 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function openContactForm(contact = null) {
    const editing = Boolean(contact && contact.id);
    let companies = [];
    if (!editing) {
      try {
        companies = unwrapList(await api.get(`/api/v1/companies${queryString({ pageSize: 100 })}`)).items;
      } catch {
        companies = [];
      }
    }
    const controls = {
      company: select({
        value: contact && contact.companyId ? contact.companyId : '',
        options: companies.map((company) => ({
          value: company.id,
          label: company.domain ? `${company.name} · ${company.domain}` : company.name,
        })),
        placeholder: '请选择企业',
      }),
      companyFallback: input({ placeholder: '企业 ID（如 cmp_…）' }),
      firstName: input({ value: contact && contact.firstName ? contact.firstName : '' }),
      lastName: input({ value: contact && contact.lastName ? contact.lastName : '' }),
      title: input({ value: contact && contact.title ? contact.title : '', placeholder: '例如 Purchasing Manager' }),
      email: input({ type: 'email', value: emailOf(contact) }),
      emailType: select({
        value: contact && contact.emailType ? contact.emailType : 'business',
        options: EMAIL_TYPE_OPTIONS.map(([value, label]) => ({ value, label })),
      }),
      roleCategory: select({
        value: contact && contact.roleCategory ? contact.roleCategory : 'unknown',
        options: ROLE_OPTIONS.map(([value, label]) => ({ value, label })),
      }),
      confidence: select({
        value: contact && contact.confidence ? contact.confidence : 'unverified',
        options: CONFIDENCE_OPTIONS.map(([value, label]) => ({ value, label })),
      }),
      phone: input({ value: contact && contact.phone ? contact.phone : '', placeholder: '+49 …' }),
      country: select({
        value: contact && contact.country ? contact.country : '',
        options: countryOptions(),
        placeholder: '请选择国家',
      }),
      department: input({ value: contact && contact.department ? contact.department : '' }),
      linkedinUrl: input({ value: contact && contact.linkedinUrl ? contact.linkedinUrl : '' }),
    };
    const companyField = field('所属企业', editing ? el('div', 'page-readonly', contact.companyName || contact.companyId || '—') : controls.company, {
      required: !editing,
      help: editing ? '联系人的所属企业不支持直接改绑；如需变更请在目标企业下新建联系人。' : '联系人必须归属一家企业。可在企业详情页中新建联系人。',
    });
    const fallbackField = field('或粘贴企业 ID', controls.companyFallback, {
      hint: companies.length ? '企业列表已加载，优先使用上方的选择。' : '企业列表加载失败或为空时可手动填写企业 ID。',
    });
    fallbackField.classList.add('hidden');
    if (!editing && !companies.length) fallbackField.classList.remove('hidden');
    const body = el('div', 'form-grid');
    append(body, [
      companyField,
      fallbackField,
      field('名', controls.firstName),
      field('姓', controls.lastName),
      field('职位', controls.title),
      field('邮箱', controls.email, {
        help: '推测邮箱请把邮箱类型选为「推测邮箱」，系统不会将其标记为有效。',
      }),
      field('邮箱类型', controls.emailType),
      field('角色', controls.roleCategory),
      field('可信度', controls.confidence),
      field('电话', controls.phone),
      field('国家', controls.country),
      field('部门', controls.department),
      field('LinkedIn', controls.linkedinUrl),
    ]);
    companyField.classList.add('span-2');
    fallbackField.classList.add('span-2');

    let saving = false;
    const dialog = openModal({
      title: editing ? '编辑联系人' : '新建联系人',
      body,
      size: 'lg',
      actions: [
        { label: '取消' },
        {
          label: editing ? '保存修改' : '创建联系人',
          variant: 'primary',
          onClick: async (done) => {
            if (saving) return;
            const companyId = editing
              ? contact.companyId
              : controls.company.value || String(controls.companyFallback.value || '').trim();
            if (!companyId) {
              toast('请选择所属企业', 'warning');
              return;
            }
            const email = String(controls.email.value || '').trim();
            const payload = {
              companyId,
              firstName: String(controls.firstName.value || '').trim(),
              lastName: String(controls.lastName.value || '').trim(),
              title: String(controls.title.value || '').trim() || null,
              email: email || null,
              emailType: controls.emailType.value,
              roleCategory: controls.roleCategory.value,
              confidence: controls.confidence.value,
              phone: String(controls.phone.value || '').trim() || null,
              country: controls.country.value || null,
              department: String(controls.department.value || '').trim() || null,
              linkedinUrl: String(controls.linkedinUrl.value || '').trim() || null,
            };
            if (!payload.firstName && !payload.lastName && !payload.email) {
              toast('请至少填写姓名或邮箱', 'warning');
              return;
            }
            const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
            saving = true;
            if (saveBtn) saveBtn.disabled = true;
            try {
              if (editing) await api.patch(`/api/v1/contacts/${encodeURIComponent(contact.id)}`, payload);
              else await api.post('/api/v1/contacts', payload);
              toast(editing ? '联系人已更新' : '联系人已创建', 'success');
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

  async function openContactDrawer(contact) {
    const bodyHost = el('div', 'stack');
    bodyHost.appendChild(loadingBlock('正在加载联系人资料…'));
    const drawerActions = [];
    if (writable) {
      drawerActions.push({
        label: '验证邮箱',
        variant: 'primary',
        onClick: async (close) => {
          const ok = await verifyContact(contact);
          if (ok) close();
        },
      });
      drawerActions.push({
        label: '编辑',
        onClick: (close) => {
          close();
          openContactForm(contact);
        },
      });
    }
    drawerActions.push({ label: '关闭' });
    const drawer = openDrawer({
      title: contact.fullName || emailOf(contact) || '联系人资料',
      body: bodyHost,
      actions: drawerActions,
    });

    const detail = await fetchOptionalJson(`/api/v1/contacts/${encodeURIComponent(contact.id)}`).catch(() => null);
    const merged =
      detail && typeof detail === 'object'
        ? detail.contact
          ? { ...contact, ...detail.contact }
          : { ...contact, ...detail }
        : { ...contact };
    const sources =
      safeArray(merged.sources).length
        ? merged.sources
        : safeArray((await fetchOptionalJson(`/api/v1/contacts/${encodeURIComponent(contact.id)}/sources`))?.items);
    const verifications = safeArray(
      merged.verifications ||
        (await fetchOptionalJson(`/api/v1/contacts/${encodeURIComponent(contact.id)}/verifications`))?.items,
    );
    if (disposed) return;

    const content = el('div', 'stack');
    content.appendChild(
      detailRows([
        { label: '姓名', value: merged.fullName || [merged.firstName, merged.lastName].filter(Boolean).join(' ') || '—' },
        {
          label: '公司',
          value: merged.companyName
            ? button(merged.companyName, {
                variant: 'ghost',
                size: 'sm',
                iconName: 'building',
                onClick: () => {
                  drawer.close();
                  navigate(`/companies/${encodeURIComponent(merged.companyId)}`);
                },
              })
            : '—',
        },
        { label: '职位', value: merged.title || '—' },
        { label: '邮箱', value: emailOf(merged) ? el('span', 'mono', emailOf(merged)) : '—' },
        { label: '邮箱类型', value: EMAIL_TYPE_LABELS[merged.emailType] || merged.emailType || '—' },
        { label: '邮箱状态', value: statusBadge(merged.emailStatus, 'email') },
        { label: '可信度', value: confidenceLabel(merged.confidence) },
        { label: '国家', value: merged.country ? countryName(merged.country) : '—' },
        { label: '部门', value: merged.department || '—' },
        { label: '电话', value: merged.phone || '—' },
        { label: 'LinkedIn', value: merged.linkedinUrl || '—' },
        { label: '最后验证', value: merged.lastVerifiedAt ? formatDateTime(merged.lastVerifiedAt) : '未验证' },
        { label: '创建时间', value: formatDateTime(merged.createdAt) },
      ]),
    );

    const sourceBody = el('div', 'stack');
    if (sources.length) {
      for (const source of sources) {
        append(sourceBody, [
          el('div', 'page-source', [
            el('div', 'page-source-main', [
              el('b', '', source.sourceType || source.method || '来源'),
              el('span', 'muted', source.sourceUrl || '未提供链接'),
            ]),
            el('div', 'page-source-meta', [
              badge(`可信度 ${source.confidence ?? '—'}`, 'gray'),
              el('span', 'muted', relativeTime(source.retrievedAt)),
            ]),
          ]),
        ]);
      }
    } else {
      sourceBody.appendChild(el('div', 'muted', '暂无来源记录。通过抓取、导入或推断得到的邮箱会记录来源与时间。'));
    }
    content.appendChild(sectionTitle('来源记录'));
    content.appendChild(sourceBody);

    const verifyBody = el('div', 'stack');
    if (verifications.length) {
      for (const record of verifications) {
        append(verifyBody, [
          el('div', 'page-source', [
            el('div', 'page-source-main', [
              el('b', '', record.checkType || '检查'),
              el('span', 'muted', record.result || ''),
            ]),
            el('span', 'muted', relativeTime(record.verifiedAt || record.createdAt)),
          ]),
        ]);
      }
    } else {
      verifyBody.appendChild(el('div', 'muted', '暂无验证记录。点击「验证邮箱」会检查语法与域名 MX，并写入验证记录。'));
    }
    content.appendChild(sectionTitle('验证记录', '推测邮箱不会被标记为有效；验证结果单独记录，可追溯。'));
    content.appendChild(verifyBody);

    if (canSuppress && emailOf(merged)) {
      content.appendChild(
        el('div', 'row', [
          button('加入抑制名单', {
            size: 'sm',
            variant: 'danger',
            iconName: 'shield',
            onClick: async () => {
              const ok = await addSuppression(merged);
              if (ok) drawer.close();
            },
          }),
          helpTip('加入抑制名单后，该邮箱不会再收到任何邮件；「推测」邮箱只是按姓名与域名生成的候选，发送前必须验证。'),
        ]),
      );
    }

    clear(bodyHost);
    bodyHost.appendChild(content);
  }

  function columns() {
    return [
      {
        key: 'fullName',
        label: '姓名',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [
            el('div', 'cell-main', row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' ') || '未命名'),
            el('div', 'cell-sub', ROLE_LABELS[row.roleCategory] || row.roleCategory || ''),
          ]);
          return wrap;
        },
      },
      {
        key: 'companyName',
        label: '公司',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [
            el('div', '', row.companyName || '—'),
            el('div', 'cell-sub', row.companyDomain || ''),
          ]);
          return wrap;
        },
      },
      { key: 'title', label: '职位', render: (row) => row.title || '—' },
      {
        key: 'email',
        label: '邮箱',
        render: (row) => {
          const email = emailOf(row);
          if (!email) return badge('无邮箱', 'gray');
          const wrap = el('div', '');
          append(wrap, [
            el('div', 'mono', email),
            el('div', 'row', [
              badge(EMAIL_TYPE_LABELS[row.emailType] || row.emailType || '未知类型', 'gray'),
              statusBadge(row.emailStatus, 'email'),
            ]),
          ]);
          return wrap;
        },
      },
      { key: 'country', label: '国家', render: (row) => (row.country ? countryName(row.country) : '—') },
      { key: 'confidence', label: '可信度', render: (row) => confidenceLabel(row.confidence) },
      {
        key: 'lastVerifiedAt',
        label: '最后验证',
        render: (row) => el('span', 'muted', row.lastVerifiedAt ? relativeTime(row.lastVerifiedAt) : '未验证'),
      },
      {
        key: 'actions',
        label: '操作',
        className: 'cell-actions',
        render: (row) => {
          const wrap = el('div', 'row page-row-actions');
          append(wrap, [
            button('验证', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'shield',
              disabled: !writable || !emailOf(row),
              onClick: () => verifyContact(row),
            }),
            button('编辑', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'edit',
              disabled: !writable,
              onClick: () => openContactForm(row),
            }),
            button('删除', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              disabled: !can('data.delete'),
              onClick: () => deleteContact(row),
            }),
          ]);
          return wrap;
        },
      },
    ];
  }

  function renderEmpty() {
    const filtered = Boolean(state.q || state.emailStatus);
    if (filtered) {
      return emptyState({
        iconName: 'search',
        title: '没有匹配的联系人',
        description: '尝试调整搜索关键词或邮箱状态筛选。',
        action: button('清除筛选', { size: 'sm', onClick: () => ctx?.refresh?.() }),
      });
    }
    const actions = el('div', 'row page-empty-actions');
    append(actions, [
      button('新建联系人', {
        variant: 'primary',
        size: 'sm',
        iconName: 'plus',
        disabled: !writable,
        onClick: () => openContactForm(),
      }),
      button('去潜在客户', { variant: 'outline', size: 'sm', iconName: 'building', onClick: () => navigate('/companies') }),
    ]);
    return emptyState({
      iconName: 'users',
      title: '还没有联系人',
      description: '联系人必须归属企业。可先在企业详情中补全联系人，或在此手动新建。',
      action: actions,
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
    clear(tableHost);
    tableHost.appendChild(dataTable({ columns: columns(), rows: [], loading: true }));
    clear(paginationHost);
    try {
      const data = await api.get(
        `/api/v1/contacts${queryString({
          page: state.page,
          pageSize: PAGE_SIZE,
          q: state.q,
          emailStatus: state.emailStatus,
        })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      state.items = items;
      state.total = total;
      clear(tableHost);
      tableHost.appendChild(
        dataTable({
          columns: columns(),
          rows: items,
          empty: renderEmpty(),
          onRowClick: (row) => openContactDrawer(row),
        }),
      );
      renderPagination();
    } catch (error) {
      if (disposed) return;
      clear(tableHost);
      const box = el('div', 'page-state');
      append(box, [
        notice(`加载失败：${errorMessage(error)}`, 'danger'),
        el('div', 'row', [
          button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => load() }),
        ]),
      ]);
      tableHost.appendChild(box);
      clear(paginationHost);
    }
  }

  const refreshBtn = button('刷新', { iconName: 'refresh', onClick: () => load() });
  const newBtn = button('新建联系人', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !writable,
    onClick: () => openContactForm(),
  });
  const searchNode = searchInput({
    placeholder: '搜索姓名 / 邮箱 / 职位 / 公司…',
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
  const statusSelect = select({
    value: '',
    options: EMAIL_STATUS_OPTIONS.map(([value, label]) => ({ value, label })),
    placeholder: '全部邮箱状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.emailStatus = value;
      state.page = 1;
      load();
    },
  });
  const statusHelp = el('span', 'page-toolbar-help');
  statusHelp.appendChild(helpTip('邮箱可信度：推测（模式生成）< 未验证 < 有风险 / 有效（通过语法与 MX 校验）。仅「有效」可直接用于正式外联。'));

  append(root, [
    pageHeader({ title: meta.title, help: meta.help, actions: [refreshBtn, newBtn] }),
    toolbar(searchNode, statusSelect, statusHelp, el('span', 'grow')),
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
