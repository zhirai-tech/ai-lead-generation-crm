/**
 * Company detail page: aggregated company record, rule score explanation,
 * contacts, email threads / drafts, deals and the merged timeline.
 * All sub-resources are optional — the page must render even when the backend
 * returns only the company object.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { countryName, domainOf, formatDate, formatDateTime, formatMoney, initials, relativeTime, truncate } from '../utils/format.mjs';
import { progressRow } from '../components/charts.mjs';
import {
  badge,
  button,
  card,
  dataTable,
  emptyState,
  field,
  helpTip,
  icon,
  input,
  loadingBlock,
  notice,
  openModal,
  pageHeader,
  scoreBadge,
  scoreMeter,
  sectionTitle,
  select,
  statusBadge,
  tabs,
  timeline,
  toast,
} from '../components/ui.mjs';
import {
  CONFIDENCE_OPTIONS,
  confidenceLabel,
  gradeFor,
  gradeTone,
  openCompanyForm,
  pickProduct,
  typeLabel,
} from './companies.js';

export const meta = {
  title: '企业详情',
  help: '企业档案、联系人、来源、评分、邮件与商机的统一视图。评分只基于已确认资料与规则，排除项会明确列出原因。',
};

const EMAIL_TYPE_LABELS = {
  business: '企业邮箱',
  personal: '个人邮箱',
  role: '角色邮箱',
  inferred: '推测邮箱',
  unknown: '未知类型',
};

const EMAIL_STATUS_LABELS = {
  unverified: '未验证',
  valid: '有效',
  risky: '有风险',
  invalid: '无效',
  inferred: '推测',
};

const CHECK_TYPE_LABELS = {
  email_syntax: '邮箱语法',
  domain_mx: '域名 MX',
  role_account: '角色邮箱',
  disposable: '一次性域名',
  freemail: '免费邮箱',
  website: '官网可达性',
  company: '企业资料',
};

const ROLE_OPTIONS = [
  ['decision_maker', '决策人'],
  ['influencer', '影响者'],
  ['gatekeeper', '把关人'],
  ['technical', '技术联系人'],
  ['unknown', '未知'],
];

const EMAIL_TYPE_OPTIONS = [
  ['business', '企业邮箱'],
  ['personal', '个人邮箱'],
  ['role', '角色邮箱'],
  ['inferred', '推测邮箱'],
  ['unknown', '未知类型'],
];

let pendingTimers = [];

function errorMessage(error) {
  return error && error.message ? error.message : '请求失败，请稍后重试';
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Normalise 0..1 or 0..100 scores into an integer percentage (0..100). */
function percentOf(value) {
  const number = Number(value) || 0;
  const percent = number > 1 ? number : number * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function scheduleReload(reload, delay = 1200) {
  const timer = setTimeout(() => {
    try {
      reload();
    } catch {
      // navigation may have happened in the meantime
    }
  }, delay);
  pendingTimers.push(timer);
}

function externalLink(url, label, className = '') {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const anchor = el('a', className, label || domainOf(href));
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function metaItem(iconName, label) {
  return el('span', '', [icon(iconName, 12), label]);
}

function fact(label, value) {
  const node = el('div', 'fact');
  const display = value === null || value === undefined || value === '' ? '—' : value;
  append(node, [el('span', 'k', label), el('span', 'v', display)]);
  return node;
}

function normalizeDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasCompany = raw.company && typeof raw.company === 'object';
  const company = hasCompany ? raw.company : raw;
  const list = (key) => safeArray(raw[key]);
  return {
    company,
    icp: raw.icp || null,
    contacts: list('contacts'),
    sources: Array.isArray(raw.sources) ? raw.sources : list('companySources'),
    matches: list('matches'),
    scores: list('scores'),
    scoreFeedback: list('scoreFeedback'),
    verifications: list('verifications'),
    automation: raw.automation || null,
    automationState: raw.automationState || (raw.automation && raw.automation.state) || company.automationState || null,
    emailThreads: Array.isArray(raw.emailThreads) ? raw.emailThreads : list('threads'),
    drafts: list('drafts'),
    deals: list('deals'),
    activities: list('activities'),
    followUpTasks: list('followUpTasks'),
    timeline: list('timeline'),
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : {},
  };
}

// ------------------------------------------------------------------ page
let disposed = false;

export async function render(root, params, ctx) {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers = [];
  disposed = false;
  clear(root);

  const companyId = (params && params.id) || (ctx && ctx.params && ctx.params.id) || '';

  const reload = () => render(root, params, ctx);
  const host = el('div', 'stack page-company-detail');
  append(root, [
    pageHeader({
      title: meta.title,
      help: meta.help,
      actions: [button('返回列表', { iconName: 'chevronLeft', onClick: () => navigate('/companies') })],
    }),
    host,
  ]);
  host.appendChild(loadingBlock('正在加载企业详情…'));

  let detail = null;
  try {
    const raw = await api.get(`/api/v1/companies/${encodeURIComponent(companyId)}`);
    if (disposed) return;
    detail = normalizeDetail(raw);
  } catch (error) {
    if (disposed) return;
    clear(host);
    const box = el('div', 'stack');
    const missing = error && error.status === 404;
    append(box, [
      notice(missing ? '企业不存在或已被删除。' : `加载失败：${errorMessage(error)}`, 'danger'),
      el('div', 'row', [
        button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: reload }),
        button('返回列表', { size: 'sm', onClick: () => navigate('/companies') }),
      ]),
    ]);
    host.appendChild(box);
    if (!missing) toast(errorMessage(error), 'error');
    return;
  }

  if (!detail || !detail.company || !detail.company.id) {
    clear(host);
    const box = el('div', 'stack');
    append(box, [
      notice('详情数据格式不完整（后端可能仍在开发中）。', 'warn'),
      el('div', 'row', [
        button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: reload }),
        button('返回列表', { size: 'sm', onClick: () => navigate('/companies') }),
      ]),
    ]);
    host.appendChild(box);
    return;
  }

  const { company, icp, contacts, sources, matches, scores, scoreFeedback, verifications } = detail;
  const { emailThreads, drafts, deals, activities, followUpTasks } = detail;
  const automationState = detail.automationState;
  const writable = can('data.write');
  let activeTab = 'overview';

  clear(host);

  // ------------------------------------------------------------ actions
  async function rescore() {
    const picked = await pickProduct({ title: '重新评分', confirmText: '开始评分' });
    if (!picked) return;
    try {
      const result = await api.post(`/api/v1/companies/${encodeURIComponent(company.id)}/score`, {
        productId: picked.productId,
      });
      const score = result && result.score !== undefined ? `${result.score} 分（${result.grade || gradeFor(result.score)} 级）` : '已完成';
      toast(`评分完成：${score}`, 'success');
      reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function crawlWebsite() {
    try {
      await api.post(`/api/v1/companies/${encodeURIComponent(company.id)}/crawl`, {});
      toast('官网抓取任务已排队，完成后企业资料会更新', 'success');
      scheduleReload(reload, 1800);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function enrichCompany() {
    try {
      const result = await api.post(`/api/v1/companies/${encodeURIComponent(company.id)}/enrich`, {});
      if (result && (result.contactsCreated !== undefined || result.emailsFound !== undefined || result.updated !== undefined)) {
        toast(
          `补全完成：新增联系人 ${result.contactsCreated ?? 0} · 发现邮箱 ${result.emailsFound ?? 0}`,
          'success',
        );
        scheduleReload(reload, 600);
      } else {
        toast('补全任务已排队', 'success');
        scheduleReload(reload, 1800);
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function verifyContact(contact) {
    try {
      const result = await api.post(`/api/v1/contacts/${encodeURIComponent(contact.id)}/verify`, {});
      const status = EMAIL_STATUS_LABELS[result && result.emailStatus] || (result && result.emailStatus) || '未验证';
      const mx = result && result.mx ? ` · MX ${result.mx}` : '';
      toast(`校验完成：${status}${mx}`, 'success');
      reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function openContactForm() {
    const controls = {
      firstName: input({ placeholder: 'First name' }),
      lastName: input({ placeholder: 'Last name' }),
      title: input({ placeholder: '例如 Purchasing Manager' }),
      email: input({ type: 'email', placeholder: 'name@company.com' }),
      emailType: select({ value: 'business', options: EMAIL_TYPE_OPTIONS.map(([value, label]) => ({ value, label })) }),
      roleCategory: select({ value: 'unknown', options: ROLE_OPTIONS.map(([value, label]) => ({ value, label })) }),
      confidence: select({ value: 'unverified', options: CONFIDENCE_OPTIONS.map(([value, label]) => ({ value, label })) }),
      phone: input({ placeholder: '+49 …' }),
    };
    const body = el('div', 'form-grid');
    append(body, [
      field('名', controls.firstName),
      field('姓', controls.lastName),
      field('职位', controls.title),
      field('邮箱', controls.email, { help: '推测邮箱请在邮箱类型中选择「推测邮箱」，系统不会把推测邮箱标为有效。' }),
      field('邮箱类型', controls.emailType),
      field('角色', controls.roleCategory),
      field('可信度', controls.confidence),
      field('电话', controls.phone),
    ]);
    let saving = false;
    const form = openModal({
      title: '新建联系人',
      body,
      actions: [
        { label: '取消' },
        {
          label: '创建联系人',
          variant: 'primary',
          onClick: async (done) => {
            if (saving) return;
            const payload = {
              companyId: company.id,
              firstName: String(controls.firstName.value || '').trim(),
              lastName: String(controls.lastName.value || '').trim(),
              title: String(controls.title.value || '').trim() || null,
              email: String(controls.email.value || '').trim() || null,
              emailType: controls.emailType.value,
              roleCategory: controls.roleCategory.value,
              confidence: controls.confidence.value,
              phone: String(controls.phone.value || '').trim() || null,
            };
            if (!payload.firstName && !payload.lastName && !payload.email) {
              toast('请至少填写姓名或邮箱', 'warning');
              return;
            }
            const saveBtn = form.modal.querySelector('.modal-foot .btn:last-child');
            saving = true;
            if (saveBtn) saveBtn.disabled = true;
            try {
              await api.post(`/api/v1/companies/${encodeURIComponent(company.id)}/contacts`, payload);
              toast('联系人已创建', 'success');
              done();
              reload();
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

  function openInferModal() {
    const firstInput = input({ placeholder: 'First name' });
    const lastInput = input({ placeholder: 'Last name' });
    const resultHost = el('div', 'stack');
    const body = el('div', 'stack');
    append(body, [
      el('div', 'form-grid', [
        field('名', firstInput, {
          help: '邮箱由「姓名 + 企业域名」按常见规则生成，属于推测结果，必须完成语法与 MX 验证后才能用于正式发送。',
        }),
        field('姓', lastInput),
      ]),
      resultHost,
    ]);
    let inferring = false;
    const form = openModal({
      title: '推断邮箱',
      body,
      size: 'lg',
      actions: [
        { label: '关闭' },
        {
          label: '开始推断',
          variant: 'primary',
          onClick: async () => {
            if (inferring) return;
            const firstName = String(firstInput.value || '').trim();
            const lastName = String(lastInput.value || '').trim();
            if (!firstName && !lastName) {
              toast('请至少填写姓或名', 'warning');
              return;
            }
            clear(resultHost);
            resultHost.appendChild(loadingBlock('正在生成候选邮箱…'));
            inferring = true;
            try {
              const data = await api.post('/api/v1/contacts/infer-email', {
                companyId: company.id,
                firstName,
                lastName,
              });
              const candidates = Array.isArray(data) ? data : safeArray(data && data.candidates);
              clear(resultHost);
              if (!candidates.length) {
                resultHost.appendChild(
                  emptyState({
                    iconName: 'mail',
                    title: '没有可用候选',
                    description: company.domain ? '请确认企业域名与联系人姓名。' : '该企业未填写域名，无法推断邮箱。',
                  }),
                );
                return;
              }
              for (const candidate of candidates) {
                resultHost.appendChild(candidateRow(candidate, firstName, lastName));
              }
            } catch (error) {
              clear(resultHost);
              resultHost.appendChild(notice(errorMessage(error), 'danger'));
            } finally {
              inferring = false;
            }
          },
        },
      ],
    });

    function candidateRow(candidate, firstName, lastName) {
      const row = el('div', 'page-candidate');
      const main = el('div', '');
      append(main, [
        el('div', 'page-candidate-main', [el('span', 'mono', candidate.email || ''), badge('推测，未验证', 'yellow')]),
        el('div', 'page-candidate-meta', [
          el('span', 'muted', `置信度 ${percentOf(candidate.confidence)}%`),
          candidate.exists ? badge('已是联系人', 'gray') : badge('新候选', 'cyan'),
        ]),
      ]);
      const addBtn = button('添加为联系人', {
        size: 'sm',
        variant: 'primary',
        iconName: 'plus',
        disabled: Boolean(candidate.exists) || !writable,
        onClick: async () => {
          addBtn.disabled = true;
          try {
            await api.post('/api/v1/contacts', {
              companyId: company.id,
              firstName,
              lastName,
              email: candidate.email,
              emailType: 'inferred',
              emailStatus: 'inferred',
              confidence: 'low',
            });
            toast('已添加为推测邮箱联系人，请先验证', 'success');
            form.close();
            reload();
          } catch (error) {
            toast(errorMessage(error), 'error');
            addBtn.disabled = false;
          }
        },
      });
      append(row, [main, addBtn]);
      return row;
    }
  }

  // -------------------------------------------------------------- header
  const hero = el('div', 'detail-hero');
  const avatarNode = el('span', 'detail-avatar', initials(company.name));
  const heroMain = el('div', 'detail-main');
  const heroTitle = el('h1');
  append(heroTitle, [company.name || '未命名企业']);
  const siteUrl = company.website || (company.domain ? `https://${company.domain}` : '');
  if (siteUrl) {
    append(heroTitle, [externalLink(siteUrl, domainOf(siteUrl), 'page-company-domain')]);
  }
  append(heroTitle, [statusBadge(company.status, 'company')]);
  if (automationState) append(heroTitle, [statusBadge(automationState, 'automation')]);
  const bestScore = scores.length ? scores[0] : null;
  if (bestScore) append(heroTitle, [scoreBadge(bestScore.score)]);

  const heroMeta = el('div', 'detail-meta');
  append(heroMeta, [
    metaItem('globe', [countryName(company.country) || '国家未填', company.city ? ` · ${company.city}` : ''].join('')),
    metaItem('tag', typeLabel(company.companyType)),
    metaItem('users', company.employeeRange ? `${company.employeeRange} 人` : '规模未填'),
    metaItem('shield', `可信度：${confidenceLabel(company.confidence)}`),
    metaItem('database', `来源记录 ${sources.length} 条`),
    metaItem('users', `联系人 ${contacts.length} 位`),
  ]);
  append(heroMain, [heroTitle, heroMeta]);
  if (company.description) {
    append(heroMain, [el('p', 'page-company-desc', truncate(company.description, 260))]);
  }
  const heroActions = el('div', 'detail-actions');
  append(heroActions, [
    button('重新评分', { variant: 'primary', size: 'sm', iconName: 'zap', disabled: !writable, onClick: rescore }),
    button('抓取官网', { size: 'sm', iconName: 'globe', disabled: !writable, onClick: crawlWebsite }),
    button('补全资料', { size: 'sm', iconName: 'sparkles', disabled: !writable, onClick: enrichCompany }),
    button('编辑企业', {
      size: 'sm',
      iconName: 'edit',
      disabled: !writable,
      onClick: () => openCompanyForm({ company, onSaved: reload }),
    }),
    button('返回列表', { size: 'sm', variant: 'ghost', iconName: 'chevronLeft', onClick: () => navigate('/companies') }),
  ]);
  append(hero, [avatarNode, heroMain, heroActions]);

  // --------------------------------------------------------------- tabs
  const tabHost = el('div', 'stack');
  const tabsHost = el('div', '');

  function renderTabs() {
    clear(tabsHost);
    tabsHost.appendChild(
      tabs({
        items: [
          { key: 'overview', label: '概览' },
          { key: 'contacts', label: '联系人', count: contacts.length },
          { key: 'emails', label: '邮件', count: emailThreads.length + drafts.length },
          { key: 'deals', label: '商机', count: deals.length },
          { key: 'timeline', label: '时间线', count: detail.timeline.length },
        ],
        active: activeTab,
        onChange: (key) => {
          activeTab = key;
          renderTabs();
          renderTab();
        },
      }),
    );
  }

  function renderTab() {
    clear(tabHost);
    if (activeTab === 'contacts') tabHost.appendChild(contactsTab());
    else if (activeTab === 'emails') tabHost.appendChild(emailsTab());
    else if (activeTab === 'deals') tabHost.appendChild(dealsTab());
    else if (activeTab === 'timeline') tabHost.appendChild(timelineTab());
    else tabHost.appendChild(overviewTab());
  }

  // ------------------------------------------------------------ overview
  function overviewTab() {
    const grid = el('div', 'page-detail-grid');
    const main = el('div', 'stack');
    const side = el('div', 'stack');
    append(grid, [main, side]);

    const facts = el('div', 'fact-grid');
    append(facts, [
      fact('官网', externalLink(siteUrl, domainOf(siteUrl)) || '未填写'),
      fact('国家/地区', [countryName(company.country), company.region, company.city].filter(Boolean).join(' · ')),
      fact('行业', company.industry),
      fact('企业类型', typeLabel(company.companyType)),
      fact('员工规模', company.employeeRange ? `${company.employeeRange} 人` : ''),
      fact('数据来源', sources.length ? `${sources.length} 条记录` : '暂无记录'),
      fact('可信度', confidenceLabel(company.confidence)),
      fact('最后验证', company.lastVerifiedAt ? formatDateTime(company.lastVerifiedAt) : '未验证'),
      fact('数据完整度', scoreMeter(company.dataQualityScore ?? 0)),
      fact('关联 ICP', icp && icp.name ? icp.name : '未关联'),
      fact('创建时间', formatDateTime(company.createdAt)),
      fact('更新时间', formatDateTime(company.updatedAt)),
    ]);
    main.appendChild(
      card({
        title: '企业资料',
        help: '所有事实字段来自企业主记录；外部抓取与导入数据都会记录来源、置信度与时间。',
        actions: [
          button('编辑', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'edit',
            disabled: !writable,
            onClick: () => openCompanyForm({ company, onSaved: reload }),
          }),
        ],
        body: facts,
      }),
    );

    // Product matches -----------------------------------------------------
    const matchBody = el('div', 'stack');
    if (matches.length) {
      for (const match of matches) {
        const row = el('div', 'page-match');
        const head = el('div', 'page-match-head');
        append(head, [
          el('b', '', match.productName || '未命名产品'),
          badge(match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已排除' : '待确认', match.status === 'confirmed' ? 'green' : match.status === 'rejected' ? 'red' : 'gray'),
          el('span', 'muted', `匹配度 ${percentOf(match.matchScore)}`),
        ]);
        append(row, [head, scoreMeter(percentOf(match.matchScore))]);
        const reasons = safeArray(match.reasons).filter(Boolean);
        if (reasons.length) {
          const chips = el('div', 'tag-list');
          for (const reason of reasons.slice(0, 6)) chips.appendChild(el('span', 'chip', reason));
          row.appendChild(chips);
        }
        matchBody.appendChild(row);
      }
    } else {
      matchBody.appendChild(el('div', 'muted', '还没有产品匹配记录。在企业评分中选择产品后，匹配度与依据会显示在这里。'));
    }
    main.appendChild(
      card({
        title: '产品匹配',
        help: '匹配度由产品类目、应用领域、企业类型与关键词规则计算，仅作排序建议，不构成事实判断。',
        body: matchBody,
      }),
    );

    // Sources -------------------------------------------------------------
    const sourceBody = el('div', 'stack');
    if (sources.length) {
      sourceBody.appendChild(
        dataTable({
          columns: [
            {
              key: 'sourceName',
              label: '来源',
              render: (row) => {
                const wrap = el('div', '');
                append(wrap, [
                  el('div', 'cell-main', row.sourceName || row.sourceType || '来源'),
                  el('div', 'cell-sub', row.sourceType || ''),
                ]);
                return wrap;
              },
            },
            {
              key: 'sourceUrl',
              label: '链接',
              render: (row) => externalLink(row.sourceUrl) || el('span', 'muted', '未提供链接'),
            },
            {
              key: 'confidence',
              label: '可信度',
              align: 'right',
              render: (row) => String(row.confidence ?? '—'),
            },
            { key: 'retrievedAt', label: '获取时间', render: (row) => el('span', 'muted', relativeTime(row.retrievedAt)) },
          ],
          rows: sources.slice(0, 20),
        }),
      );
    } else {
      sourceBody.appendChild(el('div', 'muted', '暂无来源记录。导入、发现或抓取企业时会自动写入来源。'));
    }
    main.appendChild(
      card({ title: '数据来源', help: '每条外部数据都必须能追溯到来源与获取时间，便于人工复核。', body: sourceBody }),
    );

    // Verifications -------------------------------------------------------
    const verifyBody = el('div', 'stack');
    if (verifications.length) {
      verifyBody.appendChild(
        dataTable({
          columns: [
            { key: 'checkType', label: '检查项', render: (row) => CHECK_TYPE_LABELS[row.checkType] || row.checkType || '—' },
            {
              key: 'result',
              label: '结果',
              render: (row) =>
                badge(
                  row.result === 'passed' ? '通过' : row.result === 'failed' ? '未通过' : '未知',
                  row.result === 'passed' ? 'green' : row.result === 'failed' ? 'red' : 'gray',
                ),
            },
            { key: 'confidence', label: '置信度', align: 'right', render: (row) => String(row.confidence ?? '—') },
            { key: 'verifiedAt', label: '时间', render: (row) => el('span', 'muted', formatDateTime(row.verifiedAt)) },
          ],
          rows: verifications,
        }),
      );
    } else {
      verifyBody.appendChild(el('div', 'muted', '暂无验证记录。执行抓取或邮箱校验后，检查结果会记录在这里。'));
    }
    main.appendChild(
      card({ title: '验证记录', help: '邮箱语法、域名 MX、角色邮箱等检查结果单独记录，推测邮箱不会被标记为有效。', body: verifyBody }),
    );

    // Side: score ---------------------------------------------------------
    side.appendChild(scoreCard());

    // Side: contact summary ----------------------------------------------
    const stats = detail.stats || {};
    const contactBody = el('div', 'stack');
    const statRow = el('div', 'page-stat-row');
    append(statRow, [
      el('div', 'fact', [el('span', 'k', '联系人'), el('span', 'v', String(stats.contacts ?? contacts.length))]),
      el('div', 'fact', [el('span', 'k', '有邮箱'), el('span', 'v', String(stats.contactsWithEmail ?? contacts.filter((row) => row.emailNormalized || row.email).length))]),
      el('div', 'fact', [el('span', 'k', '已验证'), el('span', 'v', String(stats.verifiedContacts ?? contacts.filter((row) => row.emailStatus === 'valid').length))]),
      el('div', 'fact', [el('span', 'k', '推测邮箱'), el('span', 'v', String(stats.inferredContacts ?? contacts.filter((row) => row.emailStatus === 'inferred').length))]),
    ]);
    append(contactBody, [statRow, button('查看联系人', { size: 'sm', variant: 'ghost', onClick: () => { activeTab = 'contacts'; renderTabs(); renderTab(); } })]);
    side.appendChild(card({ title: '联系人概况', help: '「已验证」表示邮箱通过语法与 MX 校验；「推测」邮箱不可直接用于正式发送。', body: contactBody }));

    if (followUpTasks.length) {
      const taskBody = el('div', 'stack');
      for (const task of followUpTasks.slice(0, 8)) {
        const row = el('div', 'page-source');
        append(row, [
          el('div', 'page-source-main', [el('b', '', task.title || '跟进任务'), el('span', 'muted', truncate(task.notes || '', 80))]),
          el('div', 'page-source-meta', [badge(task.status || '待处理', 'gray'), el('span', 'muted', task.dueAt ? relativeTime(task.dueAt) : '—')]),
        ]);
        taskBody.appendChild(row);
      }
      side.appendChild(card({ title: '跟进任务', help: '到期与待处理的跟进任务，可在销售管道中管理。', body: taskBody }));
    }

    return grid;
  }

  function scoreCard() {
    const body = el('div', 'stack');
    if (!scores.length) {
      append(body, [
        el('div', 'muted', '尚未评分。选择产品后可得到规则评分、加分因子与排除原因。'),
        button('开始评分', { variant: 'primary', size: 'sm', iconName: 'zap', disabled: !writable, onClick: rescore }),
      ]);
      return card({
        title: '评分与匹配',
        help: '评分是规则引擎结果（不是 AI 编造）：产品匹配、企业类型、地区、采购场景、信息可信度与联系信号加权计算。',
        body,
      });
    }
    const latest = scores[0];
    const latestGrade = latest.grade || gradeFor(latest.score);
    const head = el('div', 'page-score-head');
    append(head, [
      scoreMeter(latest.score),
      badge(`${latestGrade} 级`, gradeTone(latestGrade)),
      el('span', 'muted', latest.productName || '未关联产品'),
    ]);
    append(body, [head, el('div', 'muted', `评分时间：${formatDateTime(latest.scoredAt)}`)]);

    append(body, [sectionTitle('评分因子', '每项得分与权重来自规则引擎，可核对计算依据。')]);
    const factors = el('div', 'page-factors');
    for (const factor of safeArray(latest.factors)) {
      const item = el('div', 'page-factor');
      const value = percentOf(factor.score);
      item.appendChild(
        progressRow({
          label: factor.label || factor.key || '因子',
          value,
          max: 100,
          display: `${value}%`,
        }),
      );
      if (factor.reason) item.appendChild(el('div', 'page-factor-reason', factor.reason));
      factors.appendChild(item);
    }
    body.appendChild(factors);

    const exclusions = safeArray(latest.exclusions);
    if (exclusions.length) {
      body.appendChild(sectionTitle('排除项', '命中排除规则时总分为 0，必须先处理才能进入发送流程。'));
      const list = el('div', 'stack');
      for (const exclusion of exclusions) {
        list.appendChild(
          el('div', 'page-exclusion', [
            badge(exclusion.label || exclusion.code || '排除', 'red'),
            el('span', 'muted', exclusion.reason || ''),
          ]),
        );
      }
      body.appendChild(list);
    }
    if (latest.explanation) body.appendChild(el('div', 'page-explain', latest.explanation));

    if (scores.length > 1) {
      body.appendChild(sectionTitle('其他产品评分'));
      const list = el('div', 'stack');
      for (const score of scores.slice(1, 6)) {
        list.appendChild(
          el('div', 'page-source', [
            el('div', 'page-source-main', [el('b', '', score.productName || '未命名产品')]),
            el('div', 'page-source-meta', [scoreMeter(score.score), badge(score.grade || gradeFor(score.score), gradeTone(score.grade || gradeFor(score.score)))]),
          ]),
        );
      }
      body.appendChild(list);
    }

    if (scoreFeedback.length) {
      body.appendChild(sectionTitle('评分反馈'));
      for (const feedback of scoreFeedback.slice(0, 5)) {
        append(body, [
          el('div', 'page-source', [
            el('div', 'page-source-main', [
              el('b', '', feedback.field || '反馈'),
              el('span', 'muted', feedback.reason || ''),
            ]),
            el('span', 'muted', relativeTime(feedback.createdAt)),
          ]),
        ]);
      }
    }

    body.appendChild(
      button('重新评分', { variant: 'primary', size: 'sm', iconName: 'zap', disabled: !writable, onClick: rescore }),
    );
    return card({
      title: '评分与匹配',
      help: '评分是规则引擎结果（不是 AI 编造）：产品匹配、企业类型、地区、采购场景、信息可信度与联系信号加权计算；排除项会强制总分为 0。',
      body,
    });
  }

  // ------------------------------------------------------------ contacts
  function contactsTab() {
    const content = el('div', 'stack');
    const head = el('div', 'row-between');
    append(head, [
      el('div', 'row', [
        button('新建联系人', { variant: 'primary', size: 'sm', iconName: 'plus', disabled: !writable, onClick: openContactForm }),
        button('推断邮箱', { variant: 'outline', size: 'sm', iconName: 'sparkles', disabled: !writable, onClick: openInferModal }),
        helpTip('「推测」邮箱由姓名与域名生成，只可标记为 inferred；请先验证 MX 与语法后再用于正式外联。'),
      ]),
      el('span', 'muted', `共 ${contacts.length} 位联系人`),
    ]);
    content.appendChild(head);
    content.appendChild(
      dataTable({
        columns: [
          {
            key: 'fullName',
            label: '姓名',
            render: (row) => {
              const wrap = el('div', '');
              append(wrap, [
                el('div', 'cell-main', row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' ') || '未命名'),
                el('div', 'cell-sub', row.department || ''),
              ]);
              return wrap;
            },
          },
          { key: 'title', label: '职位', render: (row) => row.title || '—' },
          {
            key: 'email',
            label: '邮箱',
            render: (row) => {
              const email = row.email || row.emailNormalized || '';
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
          { key: 'confidence', label: '可信度', render: (row) => confidenceLabel(row.confidence) },
          { key: 'lastVerifiedAt', label: '最后验证', render: (row) => el('span', 'muted', row.lastVerifiedAt ? relativeTime(row.lastVerifiedAt) : '未验证') },
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
                  disabled: !writable || !(row.email || row.emailNormalized),
                  onClick: () => verifyContact(row),
                }),
              ]);
              return wrap;
            },
          },
        ],
        rows: contacts,
        empty: emptyState({
          iconName: 'users',
          title: '还没有联系人',
          description: '手动新建联系人，或先「补全资料」让系统从官网公开页抽取联系人。',
          action: button('新建联系人', { variant: 'primary', size: 'sm', onClick: openContactForm }),
        }),
      }),
    );
    return content;
  }

  // -------------------------------------------------------------- emails
  function emailItem({ title, subtitle, meta, onClick }) {
    const row = el('button', 'page-email-item');
    row.type = 'button';
    const main = el('div', 'page-email-main');
    append(main, [el('div', 'cell-main', title || '(无主题)'), el('div', 'cell-sub', subtitle || '')]);
    append(row, [main, el('div', 'page-email-meta', meta), icon('arrowRight', 14)]);
    row.addEventListener('click', onClick);
    return row;
  }

  function emailsTab() {
    const content = el('div', 'stack');
    const grid = el('div', 'page-detail-grid');
    const left = el('div', 'stack');
    const right = el('div', 'stack');
    append(grid, [left, right]);
    content.appendChild(grid);

    const threadBody = el('div', 'stack');
    if (emailThreads.length) {
      for (const thread of emailThreads) {
        threadBody.appendChild(
          emailItem({
            title: thread.subject || '(无主题)',
            subtitle: [thread.contactName, thread.messageCount ? `${thread.messageCount} 封邮件` : ''].filter(Boolean).join(' · '),
            meta: [badge(thread.status || '未知', 'gray'), el('span', 'muted', relativeTime(thread.lastMessageAt || thread.createdAt))],
            onClick: () => navigate('/inbox'),
          }),
        );
      }
    } else {
      threadBody.appendChild(
        emptyState({
          iconName: 'inbox',
          title: '还没有邮件线程',
          description: '发送开发信并收到回复后，线程会汇总到这里。',
          action: button('进入收件箱', { size: 'sm', variant: 'primary', onClick: () => navigate('/inbox') }),
        }),
      );
    }
    left.appendChild(
      card({
        title: '邮件线程',
        help: '与企业相关的收发邮件线程。点击进入统一收件箱查看完整往来。',
        actions: [button('进入收件箱', { size: 'sm', variant: 'ghost', onClick: () => navigate('/inbox') })],
        body: threadBody,
      }),
    );

    const draftBody = el('div', 'stack');
    if (drafts.length) {
      for (const draft of drafts) {
        draftBody.appendChild(
          emailItem({
            title: draft.subject || '(无主题)',
            subtitle: draft.bodyText ? truncate(draft.bodyText, 70) : '',
            meta: [statusBadge(draft.status, 'draft'), el('span', 'muted', relativeTime(draft.updatedAt || draft.createdAt))],
            onClick: () => navigate('/drafts'),
          }),
        );
      }
    } else {
      draftBody.appendChild(el('div', 'muted', '暂无针对该企业的开发信草稿。'));
    }
    right.appendChild(
      card({
        title: '开发信草稿',
        help: '草稿必须人工审批后才会发送；所有对外承诺只能来自产品资料库。',
        actions: [button('查看草稿', { size: 'sm', variant: 'ghost', onClick: () => navigate('/drafts') })],
        body: draftBody,
      }),
    );
    return content;
  }

  // --------------------------------------------------------------- deals
  function dealsTab() {
    const content = el('div', 'stack');
    content.appendChild(
      dataTable({
        columns: [
          { key: 'title', label: '商机', render: (row) => el('span', 'cell-main', row.title || '未命名商机') },
          { key: 'stage', label: '阶段', render: (row) => statusBadge(row.stage, 'deal') },
          {
            key: 'value',
            label: '金额',
            align: 'right',
            render: (row) => formatMoney(row.valueAmount, row.currency || 'EUR'),
          },
          { key: 'expectedCloseDate', label: '预计成交', render: (row) => formatDate(row.expectedCloseDate) },
          { key: 'createdAt', label: '创建时间', render: (row) => el('span', 'muted', relativeTime(row.createdAt)) },
        ],
        rows: deals,
        empty: emptyState({
          iconName: 'pipeline',
          title: '还没有商机',
          description: '把有意向的企业转化为商机，或在销售管道中统一管理。',
          action: button('进入销售管道', { size: 'sm', variant: 'primary', onClick: () => navigate('/deals') }),
        }),
        onRowClick: () => navigate('/deals'),
      }),
    );
    return content;
  }

  // ------------------------------------------------------------ timeline
  function timelineTab() {
    const items = detail.timeline.length
      ? detail.timeline
      : activities.map((activity) => ({
          title: activity.subject || activity.type || '销售动态',
          at: activity.occurredAt,
          summary: activity.body || '',
        }));
    if (!items.length) {
      return card({
        title: '时间线',
        body: emptyState({
          iconName: 'activity',
          title: '暂无时间线记录',
          description: '创建、导入、评分、抓取、邮件与商机事件都会按时间汇总。',
        }),
      });
    }
    const normalized = items.map((item) => ({
      title: item.title || item.type || '事件',
      time: item.at || item.createdAt || item.time || null,
      body: item.summary || item.detail || item.body || '',
      accent: Boolean(item.accent),
    }));
    return card({
      title: '时间线',
      help: '按时间倒序汇总企业相关的创建、来源、验证、评分、邮件、草稿、商机与跟进事件。',
      body: timeline(normalized),
    });
  }

  // --------------------------------------------------------------- mount
  append(host, [hero, tabsHost, tabHost]);
  renderTabs();
  renderTab();
}

export function destroy() {
  disposed = true;
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers = [];
}
