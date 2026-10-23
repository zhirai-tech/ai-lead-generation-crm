/**
 * Dashboard — the first working page of the workbench. It is also the reference
 * implementation for page structure (header, stats, cards, charts, empty states).
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { formatCompact, formatDateTime, formatMoney, relativeTime } from '../utils/format.mjs';
import { barChart, donutChart, lineChart, progressRow } from '../components/charts.mjs';
import {
  badge,
  button,
  card,
  emptyState,
  helpTip,
  icon,
  loadingBlock,
  notice,
  pageHeader,
  sectionTitle,
  statCard,
  statusBadge,
  timeline,
} from '../components/ui.mjs';

export const meta = {
  title: '全局总览',
  help: '用于快速判断当前获客是否健康：企业储备、合格线索、待审批邮件、高意向回复与后台任务状态。所有数字来自当前工作空间。',
};

const EMPTY_SUMMARY = {
  companies: { total: 0, new7d: 0, qualified: 0, contacted: 0, replied: 0 },
  contacts: { total: 0, withEmail: 0 },
  drafts: { pendingApproval: 0, approved: 0 },
  campaigns: { active: 0, total: 0 },
  inbox: { unreadThreads: 0, highIntent: 0, replies7d: 0 },
  deals: { open: 0, pipelineValue: 0, won30d: 0 },
  sends: { sent7d: 0, dailyUsed: 0, dailyLimit: 0, replyRate: 0 },
  agents: { runs7d: 0, tokens7d: 0 },
  jobs: { queued: 0, running: 0, failed: 0 },
  trend: [],
  funnel: [],
  alerts: [],
  recent: [],
};

const FUNNEL_LABELS = {
  new: '新线索',
  qualified: '已合格',
  contacted: '已触达',
  replied: '已回复',
  customer: '已成交',
  archived: '已归档',
};

const ACTION_TITLES = {
  'auth.login': '登录系统',
  'auth.logout': '退出登录',
  'draft.approve': '开发信已批准',
  'draft.reject': '开发信被驳回',
  'draft.send': '开发信进入发送队列',
  'automation.takeover': '人工接管客户',
  'automation.resume': '恢复客户自动化',
  'automation.pause': '暂停客户自动化',
  'automation.do_not_contact': '标记为禁止联系',
  'settings.update': '更新系统设置',
  'company.create': '新增企业',
  'company.update': '更新企业资料',
  'contact.create': '新增联系人',
  'contact.verify': '验证联系人邮箱',
  'campaign.create': '创建开发信活动',
  'campaign.enroll': '加入活动目标',
  'email.sent': '开发信已发送',
  'email.received': '收到客户回复',
  'agent.run': 'Agent 执行完成',
  'import.companies': '导入企业数据',
  'suppression.create': '添加禁止联系记录',
  'suppression.unsubscribe': '客户主动退订',
  'product.file_upload': '上传产品资料',
  'product.file_delete': '删除产品资料',
  'product.file_main': '设置产品主图',
  'product.keywords_generate': 'AI 生成产品关键词',
  'product.create': '新增产品',
  'product.update': '更新产品资料',
};

const NOISY_EVENT = /^(auth\.login|auth\.logout|settings\.update|reply\.classify|email\.sync|maintenance|queue\.|job\.|campaign\.tick|draft\.(generate|create)|agent\.execution)/;
const NOISY_EVENT_SUFFIX = /\.(completed|failed|queued|succeeded|cancelled|classified)$/;

function isBusinessEvent(item) {
  const title = String(item.title || '');
  if (!title) return false;
  if (NOISY_EVENT.test(title)) return false;
  if (NOISY_EVENT_SUFFIX.test(title)) return false;
  return true;
}

function friendlyTitle(item) {
  const raw = String(item.title || '');
  if (ACTION_TITLES[raw]) return ACTION_TITLES[raw];
  if (raw.includes('.')) return raw.replace(/\./g, ' · ');
  return raw;
}

function friendlyDetail(item) {
  const raw = String(item.detail || '').trim();
  if (!raw || raw === 'session' || raw === 'draft' || raw === 'company') return '';
  if (/^[a-z_]+ · [a-z]{2,4}_[A-Za-z0-9]+$/.test(raw)) return '';
  if (/^[a-z_]+ · [a-z]{2,4}_/.test(raw)) return '';
  return raw.replace(/^(message_draft|draft|company|contact|session|campaign|background_job|email_message)\s*·\s*/, '');
}

function safeGet(path) {
  return api.get(path).catch(() => null);
}

export async function render(root) {
  clear(root);
  const statGrid = el('div', 'stat-grid');
  const leftColumn = el('div', 'stack');
  const rightColumn = el('div', 'stack');
  const dashGrid = el('div', 'dash-grid');
  append(dashGrid, [leftColumn, rightColumn]);

  append(root, [
    pageHeader({
      title: '全局总览',
      help: meta.help,
      actions: [
        button('刷新', { iconName: 'refresh', onClick: () => render(root) }),
        button('开始企业发现', { variant: 'primary', iconName: 'compass', onClick: () => navigate('/discovery') }),
      ],
    }),
    statGrid,
    dashGrid,
  ]);

  // Loading placeholders
  for (let i = 0; i < 4; i += 1) statGrid.appendChild(el('div', 'stat', [el('div', 'skeleton skeleton-line')]));
  leftColumn.appendChild(card({ title: '获客漏斗', body: loadingBlock('正在加载概览…') }));
  rightColumn.appendChild(card({ title: '高意向提醒', body: loadingBlock('正在加载提醒…') }));

  const [summaryResult, alertsResult, activityResult] = await Promise.all([
    safeGet('/api/v1/dashboard/summary'),
    safeGet('/api/v1/dashboard/alerts'),
    safeGet('/api/v1/dashboard/activity?limit=8'),
  ]);

  const summary = normalize(summaryResult || EMPTY_SUMMARY);
  const alerts = (alertsResult?.items || summary.alerts || []).slice(0, 6);
  const recent = (activityResult?.items || summary.recent || []).filter(isBusinessEvent);
  const unavailable = !summaryResult;

  clear(statGrid);
  const stats = [
    {
      label: '企业总数',
      value: formatCompact(summary.companies.total),
      hint: `近 7 天新增 ${summary.companies.new7d}`,
      iconName: 'building',
      help: '当前工作空间内未删除的企业数量。',
    },
    {
      label: '合格线索',
      value: formatCompact(summary.companies.qualified),
      hint: `已触达 ${summary.companies.contacted} · 已回复 ${summary.companies.replied}`,
      iconName: 'target',
      help: '被标记为“已合格”的企业数量；评分与排除原因可在企业详情查看。',
    },
    {
      label: '待审批邮件',
      value: formatCompact(summary.drafts.pendingApproval),
      hint: '默认人工审批后才会发送',
      iconName: 'checkSquare',
      help: '等待人工审核的开发信数量。系统默认不自动发送。',
    },
    {
      label: '高意向回复',
      value: formatCompact(summary.inbox.highIntent),
      hint: `未读会话 ${summary.inbox.unreadThreads} · 7 天回复 ${summary.inbox.replies7d}`,
      iconName: 'bell',
      help: '被 AI 标记为正面意向、询价、报价或样品需求的回复数量。需要人工确认后跟进。',
    },
  ];
  for (const stat of stats) statGrid.appendChild(statCard(stat));

  // Left column -------------------------------------------------------------
  clear(leftColumn);
  const funnelItems = summary.funnel.length
    ? summary.funnel
    : [
        { stage: 'new', count: summary.companies.total },
        { stage: 'qualified', count: summary.companies.qualified },
        { stage: 'contacted', count: summary.companies.contacted },
        { stage: 'replied', count: summary.companies.replied },
        { stage: 'customer', count: summary.companies.customer || 0 },
      ];
  const funnelMax = Math.max(1, ...funnelItems.map((item) => item.count || 0));
  const funnelBody = el('div', 'funnel');
  for (const item of funnelItems) {
    const label = item.label || FUNNEL_LABELS[item.stage] || item.stage || '—';
    funnelBody.appendChild(progressRow({ label, value: item.count || 0, max: funnelMax }));
  }
  leftColumn.appendChild(
    card({
      title: '获客漏斗',
      help: '从企业储备到成回复的转化概览。若漏斗数据缺失，则根据企业状态统计。',
      actions: [button('查看潜在客户', { variant: 'ghost', size: 'sm', onClick: () => navigate('/companies') })],
      body: funnelBody,
    }),
  );

  const trend = (summary.trend || []).slice(-14);
  const trendCard = card({
    title: '触达趋势',
    help: '最近 14 天的发送与回复数量，用于判断活动节奏与回复质量。',
    body: trend.length
      ? el('div', '', [
          lineChart(trend.map((item) => ({ label: item.day?.slice(5) || '', value: item.emails || 0 }))),
          el('div', 'chart-legend', [
            el('span', '', [el('i', ''), '发送邮件']),
            el('span', '', [el('i', ''), `回复合计 ${formatCompact(trend.reduce((sum, item) => sum + (item.replies || 0), 0))}`]),
          ]),
        ])
      : emptyState({ iconName: 'chart', title: '还没有发送记录', description: '创建活动并审批第一封开发信后，这里会显示趋势。', action: button('去创建活动', { variant: 'primary', size: 'sm', onClick: () => navigate('/campaigns') }) }),
  });
  leftColumn.appendChild(trendCard);

  const recentCardBody = recent.length
    ? timeline(
        recent.map((item) => ({
          title: friendlyTitle(item),
          time: item.at || item.createdAt,
          body: friendlyDetail(item),
          accent: item.type === 'reply' || item.type === 'activity',
        })),
      )
    : emptyState({ iconName: 'activity', title: '暂无动态', description: '导入产品或开始企业发现后，这里会显示最近动作。' });
  leftColumn.appendChild(card({ title: '最近动态', help: '当前工作空间最近发生的关键事件。', body: recentCardBody }));

  // Right column ------------------------------------------------------------
  clear(rightColumn);
  const alertBody = el('div', 'alert-list');
  if (alerts.length) {
    for (const item of alerts) {
      const row = el('div', 'alert-item');
      const iconWrap = el('span', `alert-icon ${item.severity === 'critical' ? 'critical' : item.severity === 'warning' ? 'warning' : ''}`);
      iconWrap.appendChild(icon(item.severity === 'critical' ? 'alert' : 'bell', 14));
      const main = el('div', 'alert-main');
      append(main, [el('b', '', item.title || '提醒'), el('span', '', item.detail || '')]);
      append(row, [iconWrap, main, el('span', 'alert-time', relativeTime(item.createdAt || item.at))]);
      if (item.entityType === 'company' && item.entityId) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => navigate(`/companies/${item.entityId}`));
      } else if (item.type === 'approval') {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => navigate('/approvals'));
      }
      alertBody.appendChild(row);
    }
  } else {
    alertBody.appendChild(emptyState({ iconName: 'bell', title: '暂无高意向提醒', description: '收到客户回复并完成分类后，高意向客户会出现在这里。' }));
  }
  rightColumn.appendChild(
    card({
      title: '高意向提醒',
      help: 'AI 只负责提示，是否跟进、如何回复由你决定。所有分类都保留原始邮件与判断依据。',
      body: alertBody,
      actions: [button('进入收件箱', { variant: 'ghost', size: 'sm', onClick: () => navigate('/inbox') })],
    }),
  );

  const jobBody = el('div', 'funnel');
  const jobMax = Math.max(1, summary.jobs.queued + summary.jobs.running + summary.jobs.failed);
  jobBody.appendChild(progressRow({ label: '排队中', value: summary.jobs.queued, max: jobMax }));
  jobBody.appendChild(progressRow({ label: '执行中', value: summary.jobs.running, max: jobMax }));
  jobBody.appendChild(progressRow({ label: '失败', value: summary.jobs.failed, max: jobMax }));
  if (summary.jobs.failed > 0) {
    jobBody.appendChild(notice(`${summary.jobs.failed} 个任务失败，可在任务队列查看原因并重试。`, 'warn'));
  }
  rightColumn.appendChild(
    card({
      title: '后台任务',
      help: '所有外部操作（发现、抓取、发送、同步）都由后台任务执行，可查询状态与失败记录。',
      body: jobBody,
      actions: [button('任务队列', { variant: 'ghost', size: 'sm', onClick: () => navigate('/jobs') })],
    }),
  );

  const usageBody = el('div', 'stack');
  const usageTop = el('div', 'grid grid-2');
  usageTop.appendChild(statCard({ label: 'AI 执行（7 天）', value: formatCompact(summary.agents.runs7d), iconName: 'brain' }));
  usageTop.appendChild(statCard({ label: 'Token（7 天）', value: formatCompact(summary.agents.tokens7d), iconName: 'zap' }));
  usageBody.appendChild(usageTop);
  const donutItems = [
    { label: '企业', value: summary.companies.total, color: '#22d3ee' },
    { label: '联系人', value: summary.contacts.total, color: '#3b82f6' },
    { label: '草稿', value: summary.drafts.approved, color: '#a78bfa' },
  ];
  usageBody.appendChild(
    el('div', 'row', [
      donutChart(donutItems, { size: 116, centerValue: formatCompact(summary.contacts.withEmail), centerLabel: '有邮箱联系人' }),
      el('div', 'stack', [
        el('div', '', [badge(`活动 ${formatCompact(summary.campaigns.active)} 个进行中`, 'cyan')]),
        el('div', '', [badge(`今日发送 ${summary.sends.dailyUsed}/${summary.sends.dailyLimit || '—'}`, 'blue')]),
        el('div', '', [badge(`回复率 ${summary.sends.replyRate ? `${Math.min(100, Math.round(summary.sends.replyRate))}%` : '—'}`, 'green')]),
      ]),
    ]),
  );
  rightColumn.appendChild(card({ title: '资源与用量', help: 'AI 执行次数、Token 消耗与发送额度，用于控制成本。', body: usageBody }));

  if (unavailable) {
    rightColumn.appendChild(notice('仪表盘接口尚未返回数据（后端模块可能仍在开发中），页面已使用空数据展示。', 'info'));
  }
  void formatDateTime;
  void formatMoney;
  void statusBadge;
  void sectionTitle;
  void helpTip;
}

function normalize(input) {
  const source = input && typeof input === 'object' ? input : {};
  const merge = (key) => ({ ...EMPTY_SUMMARY[key], ...(source[key] && typeof source[key] === 'object' ? source[key] : {}) });
  return {
    companies: merge('companies'),
    contacts: merge('contacts'),
    drafts: merge('drafts'),
    campaigns: merge('campaigns'),
    inbox: merge('inbox'),
    deals: merge('deals'),
    sends: merge('sends'),
    agents: merge('agents'),
    jobs: merge('jobs'),
    trend: Array.isArray(source.trend) ? source.trend : [],
    funnel: Array.isArray(source.funnel) ? source.funnel : [],
    alerts: Array.isArray(source.alerts) ? source.alerts : [],
    recent: Array.isArray(source.recent) ? source.recent : [],
  };
}

void barChart;
