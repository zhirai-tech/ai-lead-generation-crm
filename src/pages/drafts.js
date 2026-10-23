/**
 * Email drafts + human approval page (OWNER: t-front-outreach).
 *
 * Two modes share the module:
 *  - `ctx.mode === 'approvals'` → "发送审批" (default filter: pending_approval)
 *  - otherwise → "邮件草稿"
 *
 * Safety rules enforced in the UI (the server is still the only authority):
 *  - a draft can only be sent after it was approved by a human;
 *  - approve / send / batch-approve always confirm and show server rejections;
 *  - the drawer exposes the AI guard/quality/rationale so the reviewer keeps
 *    the evidence ("AI 建议，需人工确认").
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { formatDateTime, formatNumber, relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  checkbox,
  confirmDialog,
  copyButton,
  dataTable,
  emptyState,
  field,
  helpTip,
  input,
  kvList,
  loadingBlock,
  notice,
  openDrawer,
  openModal,
  pageHeader,
  pagination,
  searchInput,
  sectionTitle,
  select,
  statCard,
  statusBadge,
  textarea,
  timeline,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '邮件草稿与审批',
  help: 'AI 生成的开发信草稿默认必须经过人工审批才能进入发送队列。审批与发送都以服务端校验为准，前端只负责提交与展示结果。',
};

const API = '/api/v1';
const PAGE_SIZE = 20;

const LANGUAGES = [
  ['en', '英语'],
  ['de', '德语'],
  ['fr', '法语'],
  ['es', '西班牙语'],
  ['it', '意大利语'],
  ['nl', '荷兰语'],
  ['pl', '波兰语'],
  ['cs', '捷克语'],
  ['sv', '瑞典语'],
  ['da', '丹麦语'],
];

const DRAFT_STATUS_LABELS = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  scheduled: '已排期',
  sent: '已发送',
  failed: '发送失败',
  discarded: '已丢弃',
};

const APPROVABLE_STATUSES = ['draft', 'pending_approval', 'rejected'];
const EDITABLE_STATUSES = ['draft', 'pending_approval', 'rejected'];
const SENDABLE_CAMPAIGN_STATUSES = ['active'];

function languageLabel(code) {
  const found = LANGUAGES.find(([value]) => value === code);
  return found ? found[1] : code || '—';
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

async function safeGet(path) {
  try {
    return await api.get(path);
  } catch {
    return null;
  }
}

function jsonBlock(value, emptyText = '暂无数据') {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  if (isEmpty) return el('div', 'page-outreach-json-empty', emptyText);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return el('pre', 'page-json', text);
}

let disposed = false;
let cleanup = [];
const overlays = new Set();

function showModal(options) {
  const handle = openModal(options);
  if (handle.modal && handle.modal.parentElement) overlays.add(handle.modal.parentElement);
  return handle;
}

function showDrawer(options) {
  const handle = openDrawer(options);
  if (handle.drawer && handle.drawer.parentElement) overlays.add(handle.drawer.parentElement);
  return handle;
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
  for (const node of overlays) {
    try {
      node.remove();
    } catch {
      // ignore
    }
  }
  overlays.clear();
}

/** Normalise the `/drafts/:id` payload (contract + flat fallbacks). */
function normalizeDetail(data, fallback) {
  const root = data && typeof data === 'object' ? data : {};
  const draft = root.draft && typeof root.draft === 'object' ? root.draft : root.id ? root : fallback || {};
  return {
    draft,
    guard: root.guard !== undefined ? root.guard : draft.guard || {},
    quality: root.quality !== undefined ? root.quality : draft.quality || {},
    attachments: Array.isArray(root.attachments) ? root.attachments : Array.isArray(draft.attachments) ? draft.attachments : [],
    company: root.company || draft.company || null,
    contact: root.contact || draft.contact || null,
    campaign: root.campaign || draft.campaign || (draft.campaignName ? { name: draft.campaignName } : null),
    step: root.step || draft.step || null,
    product: root.product || draft.product || null,
    icp: root.icp || draft.icp || null,
    score: root.score || null,
    history: Array.isArray(root.history) ? root.history : [],
    automationState: root.automationState || draft.automationState || null,
    suppression: root.suppression || draft.suppression || { suppressed: false, matches: [] },
  };
}

function showSendBlocked(error) {
  const body = el('div', 'stack');
  body.appendChild(notice(errorMessage(error), 'danger'));
  if (error && error.code) body.appendChild(kvList([{ label: '错误码', value: error.code }]));
  if (error && error.details) body.appendChild(jsonBlock(error.details));
  body.appendChild(
    el('div', 'muted', '发送前的安全校验由服务端执行：审批状态、抑制名单、自动化状态、活动状态、发送窗口与限额。'),
  );
  showModal({ title: '发送被阻止', body, size: 'sm', actions: [{ label: '知道了', variant: 'primary' }] });
}

// ------------------------------------------------------------- draft drawer
function openDraftDrawer(row, { reloadList, reloadApprovals, mode }) {
  const bodyHost = el('div', 'stack');
  const writable = can('drafts.approve');
  let detail = null;
  let subjectControl = null;
  let bodyControl = null;
  let languageControl = null;
  let drawerHandle = null;

  async function loadDetail() {
    clear(bodyHost);
    bodyHost.appendChild(loadingBlock('正在加载草稿…'));
    const data = await safeGet(`${API}/drafts/${encodeURIComponent(row.id)}`);
    if (disposed) return;
    detail = normalizeDetail(data, row);
    renderDetail();
  }

  function renderDetail() {
    const draft = detail.draft;
    clear(bodyHost);
    const editable = EDITABLE_STATUSES.includes(draft.status);
    const campaignStatus = detail.campaign && detail.campaign.status ? detail.campaign.status : null;
    const automationState = detail.automationState && detail.automationState.state ? detail.automationState.state : null;
    const suppressed = Boolean(detail.suppression && detail.suppression.suppressed);

    // ---------------------------------------------------------- safety alerts
    if (suppressed) {
      bodyHost.appendChild(
        notice('该收件人（邮箱或域名）已在禁止联系名单中，服务端会阻止发送。', 'danger'),
      );
    }
    if (automationState && !['AUTOMATION_ACTIVE', 'NEEDS_HUMAN_REVIEW'].includes(automationState)) {
      bodyHost.appendChild(
        notice(`该客户自动化状态为「${automationState}」，AI 不会自动回复或跟进，发送会被服务端拒绝。`, 'warn'),
      );
    }
    if (campaignStatus && !SENDABLE_CAMPAIGN_STATUSES.includes(campaignStatus)) {
      bodyHost.appendChild(
        notice(
          campaignStatus === 'paused'
            ? '来源活动已暂停，请先恢复活动后再发送（人工发送同样会被拒绝）。'
            : '来源活动未启用，请先启用活动后再发送。',
          'warn',
        ),
      );
    }
    if (draft.status === 'rejected' && draft.rejectionReason) {
      bodyHost.appendChild(notice(`已驳回：${draft.rejectionReason}`, 'warn'));
    }

    // ------------------------------------------------------------- summary
    const contact = detail.contact || {};
    const company = detail.company || {};
    const summary = kvList([
      { label: '企业', value: company.name || draft.companyName || '—' },
      { label: '联系人', value: contact.fullName || draft.contactName || '—' },
      { label: '邮箱', value: contact.email || draft.contactEmail || '—' },
      { label: '职位', value: contact.title || draft.contactTitle || '—' },
      {
        label: '来源活动',
        value: detail.campaign && detail.campaign.name ? detail.campaign.name : draft.campaignName || '—',
      },
      {
        label: '当前步骤',
        value: detail.step ? `步骤 ${detail.step.stepNo ?? '—'} · ${detail.step.name || ''}` : '—',
      },
      { label: '产品', value: detail.product && detail.product.name ? detail.product.name : '—' },
      { label: '更新时间', value: formatDateTime(draft.updatedAt || draft.createdAt) },
    ]);
    bodyHost.appendChild(
      card({
        title: '收件人与来源',
        actions: [statusBadge(draft.status, 'draft')],
        body: summary,
      }),
    );

    // ---------------------------------------------------------- editor card
    subjectControl = input({ value: draft.subject || '', placeholder: '邮件主题' });
    bodyControl = textarea({ value: draft.bodyText || '', rows: 14, className: 'textarea draft-editor' });
    languageControl = select({
      value: draft.language || 'en',
      options: LANGUAGES.map(([value, label]) => ({ value, label: `${label}（${value}）` })),
    });
    if (!editable) {
      subjectControl.disabled = true;
      bodyControl.disabled = true;
      languageControl.disabled = true;
    }
    const editorHead = el('div', 'row page-outreach-editor-head');
    append(editorHead, [
      badge('AI 建议，需人工确认', 'purple', { dot: true }),
      el('span', 'grow'),
      badge(languageLabel(draft.language), 'blue'),
    ]);
    const editorBody = el('div', 'composer');
    append(editorBody, [
      editorHead,
      field('主题', subjectControl, { required: true }),
      field('正文', bodyControl, { help: '可直接编辑。保存后审批与发送使用服务端保存的内容；产品认证、价格与案例不得编造。' }),
      field('语言', languageControl, { help: '语言只影响行文，不会改变已确认的产品事实。' }),
      editable ? el('div', 'muted', '修改后请先「保存」，再提交审批或发送。') : notice('当前状态不可编辑（已批准/已排期/已发送）。', 'info'),
    ]);
    bodyHost.appendChild(card({ title: '主题与正文', body: editorBody }));

    // ---------------------------------------------------------- attachments
    if (detail.attachments.length) {
      const attachmentsBody = el('div', 'stack');
      for (const attachment of detail.attachments) {
        const absoluteUrl = attachment.publicUrl
          ? new URL(attachment.publicUrl, window.location.origin).href
          : '';
        const info = el('div', 'stack');
        append(info, [
          el('b', '', attachment.filename || '产品资料.pdf'),
          el('span', 'muted', `${Math.max(1, Math.round((Number(attachment.sizeBytes) || 0) / 1024))} KB · 发送时作为附件附带${absoluteUrl ? '，链接写入邮件正文' : ''}`),
        ]);
        const actions = el('div', 'row');
        if (absoluteUrl) {
          actions.appendChild(
            button('打开链接', {
              variant: 'ghost',
              size: 'sm',
              iconName: 'external',
              onClick: () => window.open(absoluteUrl, '_blank', 'noopener,noreferrer'),
            }),
          );
          actions.appendChild(copyButton(absoluteUrl, '复制链接'));
        }
        const row = el('div', 'row-between');
        append(row, [info, actions]);
        attachmentsBody.appendChild(row);
      }
      bodyHost.appendChild(
        card({
          title: '邮件附件',
          help: '产品 PDF 会在发送时作为附件，并把可公开访问的签名链接写入邮件正文。链接在有效期内可被收件人打开，请勿放入敏感资料。',
          body: attachmentsBody,
        }),
      );
    }

    // --------------------------------------------------- AI evidence (guard)
    const evidenceGrid = el('div', 'page-outreach-evidence');
    evidenceGrid.appendChild(
      card({
        title: '合规检查',
        help: '服务端保存的 guard_json：记录发送前必须满足的合规条件（退订、身份披露、事实约束等）。',
        body: jsonBlock(detail.guard, '暂无合规检查记录'),
      }),
    );
    evidenceGrid.appendChild(
      card({
        title: '质量检查',
        help: '服务端保存的 quality_json：AI 生成时的自检结果与建议。仅作参考，人工判断优先。',
        body: jsonBlock(detail.quality, '暂无质量检查记录'),
      }),
    );
    bodyHost.appendChild(evidenceGrid);

    if (detail.history.length) {
      bodyHost.appendChild(
        card({
          title: '往来与生成历史',
          help: '该客户的近期邮件、草稿与销售活动，用于判断上下文；原始邮件内容保留，便于追溯。',
          body: timeline(
            detail.history.slice(0, 20).map((item) => ({
              title: `${item.kind === 'message' ? (item.direction === 'inbound' ? '客户来信' : '外发邮件') : item.kind === 'draft' ? '草稿' : '销售活动'} · ${item.title || ''}`,
              time: item.at,
              body: truncate(item.preview || '', 220),
              accent: item.kind === 'message' && item.direction === 'inbound',
            })),
          ),
        }),
      );
    }

    // ------------------------------------------------------------- actions
    const canApprove = APPROVABLE_STATUSES.includes(draft.status) && writable;
    const canSend = draft.status === 'approved' && writable;
    const canRegenerate = !['sent', 'scheduled'].includes(draft.status) && editable && writable;

    const actions = [];
    if (canRegenerate) {
      actions.push({
        label: '重新生成',
        onClick: async (done) => {
          const ok = await confirmDialog({
            title: '重新生成草稿',
            message: '重新生成会覆盖当前主题与正文，并重新提交审批。确认继续？',
            confirmText: '重新生成',
          });
          if (!ok) return;
          try {
            await api.post(`${API}/drafts/${encodeURIComponent(draft.id)}/generate`, {});
            toast('已重新生成，请复核内容', 'success');
            done();
            reloadList();
            reloadApprovals();
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        },
      });
    }
    if (editable && writable) {
      actions.push({
        label: '保存',
        onClick: async () => {
          const subject = String(subjectControl.value || '').trim();
          const bodyText = String(bodyControl.value || '');
          if (!subject) {
            toast('主题不能为空', 'warning');
            subjectControl.focus();
            return;
          }
          if (bodyText.trim().length < 20) {
            toast('正文过短，至少 20 个字符', 'warning');
            bodyControl.focus();
            return;
          }
          try {
            await api.patch(`${API}/drafts/${encodeURIComponent(draft.id)}`, {
              subject,
              bodyText,
              language: languageControl.value || 'en',
            });
            toast('草稿已保存', 'success');
            loadDetail();
            reloadList();
            reloadApprovals();
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        },
      });
    }
    if (canApprove) {
      actions.push({
        label: '驳回',
        variant: 'danger',
        onClick: (done) => {
          done();
          openRejectModal(draft, { onDone: () => {
            loadDetail();
            reloadList();
            reloadApprovals();
          } });
        },
      });
      actions.push({
        label: '批准',
        variant: 'primary',
        onClick: async () => {
          try {
            await api.post(`${API}/drafts/${encodeURIComponent(draft.id)}/approve`, {});
            toast('草稿已批准，可加入发送队列', 'success');
            loadDetail();
            reloadList();
            reloadApprovals();
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        },
      });
    }
    if (canSend) {
      actions.push({
        label: '加入发送队列',
        variant: 'primary',
        onClick: async () => {
          if (campaignStatus && !SENDABLE_CAMPAIGN_STATUSES.includes(campaignStatus)) {
            showSendBlocked({
              code: 'CAMPAIGN_NOT_ACTIVE',
              message:
                campaignStatus === 'paused'
                  ? '活动已暂停，请先恢复活动后再发送。'
                  : '来源活动未启用，不能发送该草稿。',
            });
            return;
          }
          if (suppressed) {
            showSendBlocked({ code: 'RECIPIENT_SUPPRESSED', message: '收件人在禁止联系名单中，不能发送。' });
            return;
          }
          const ok = await confirmDialog({
            title: '加入发送队列',
            message: `确认将「${draft.subject || '未命名草稿'}」发送给 ${
              (detail.contact && detail.contact.email) || draft.contactEmail || '该联系人'
            }？服务端会再次校验审批、抑制名单、自动化状态、活动状态、发送窗口与限额。`,
            confirmText: '确认发送',
          });
          if (!ok) return;
          try {
            const result = await api.post(`${API}/drafts/${encodeURIComponent(draft.id)}/send`, {});
            if (result && result.queueError) {
              toast(`已排队，但任务队列返回：${result.queueError}`, 'warning');
            } else {
              toast('已加入发送队列', 'success');
            }
            loadDetail();
            reloadList();
            reloadApprovals();
          } catch (error) {
            showSendBlocked(error);
          }
        },
      });
    }
    actions.push({ label: '关闭', onClick: (done) => done() });
    if (drawerHandle) drawerHandle.close();
    drawerHandle = showDrawer({
      title: `草稿详情 · ${draft.subject || '未命名草稿'}`,
      body: bodyHost,
      actions,
    });
    void mode;
  }

  drawerHandle = showDrawer({
    title: `草稿详情 · ${row.subject || '未命名草稿'}`,
    body: bodyHost,
    actions: [{ label: '关闭' }],
  });
  loadDetail();
}

// ---------------------------------------------------------------- reject modal
function openRejectModal(draft, { onDone }) {
  const reasonControl = textarea({
    value: '',
    rows: 4,
    placeholder: '写明驳回原因，例如：措辞过于推销 / 产品参数不确定 / 客户行业不匹配',
  });
  const body = el('div', 'stack', [
    notice('驳回后草稿状态变为「已驳回」，可修改后重新提交审批。', 'info'),
    field('驳回原因', reasonControl, { required: true, help: '驳回原因会写入审计记录，便于团队复盘。' }),
  ]);
  let submitting = false;
  const dialog = showModal({
    title: '驳回草稿',
    body,
    size: 'sm',
    actions: [
      { label: '取消' },
      {
        label: '确认驳回',
        variant: 'danger',
        onClick: async (done) => {
          if (submitting) return;
          const reason = String(reasonControl.value || '').trim();
          if (!reason) {
            toast('请填写驳回原因', 'warning');
            reasonControl.focus();
            return;
          }
          submitting = true;
          try {
            await api.post(`${API}/drafts/${encodeURIComponent(draft.id)}/reject`, { reason });
            toast('草稿已驳回', 'success');
            done();
            onDone();
          } catch (error) {
            toast(errorMessage(error), 'error');
          } finally {
            submitting = false;
          }
        },
      },
    ],
  });
  void dialog;
  setTimeout(() => reasonControl.focus(), 40);
}

// --------------------------------------------------------------------- page
export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  cleanup = [];
  const approvalsMode = Boolean(ctx && ctx.mode === 'approvals');
  const writable = can('drafts.approve');

  const state = {
    page: 1,
    pageSize: PAGE_SIZE,
    q: '',
    status: approvalsMode ? 'pending_approval' : '',
    selected: new Set(),
    pendingCount: null,
  };

  const statHost = el('div', 'page-outreach-stat-row');
  const tableHost = el('div');
  const pagerHost = el('div', 'page-outreach-pager');
  const batchBar = el('div', 'page-batch hidden');
  let searchTimer = null;
  let listTotal = 0;

  function errorState(message) {
    return el('div', 'page-state', [
      notice(`草稿列表加载失败：${message}`, 'danger'),
      el('div', 'row', [button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: loadList })]),
    ]);
  }

  function emptyPanel() {
    const filtered = Boolean(state.q || state.status);
    if (filtered) {
      return emptyState({
        iconName: 'search',
        title: approvalsMode ? '没有待审批草稿' : '没有匹配的草稿',
        description: approvalsMode ? '所有待审批草稿都已处理。可以切换到「邮件草稿」查看全部记录。' : '尝试调整关键词或状态筛选。',
        action: button('查看全部草稿', {
          size: 'sm',
          onClick: () => {
            if (approvalsMode) navigate('/drafts');
            else {
              state.q = '';
              state.status = '';
              state.page = 1;
              loadList();
            }
          },
        }),
      });
    }
    const actions = el('div', 'row page-empty-actions');
    append(actions, [
      button('去创建活动', { variant: 'primary', size: 'sm', iconName: 'plus', onClick: () => navigate('/campaigns') }),
      button('查看待审批', { variant: 'outline', size: 'sm', iconName: 'checkSquare', onClick: () => navigate('/approvals') }),
    ]);
    return emptyState({
      iconName: approvalsMode ? 'checkSquare' : 'mail',
      title: approvalsMode ? '暂无待审批草稿' : '还没有邮件草稿',
      description: '草稿来自活动的发送序列：先创建活动、加入目标企业，系统会按步骤生成个性化开发信草稿并等待人工审批。',
      action: actions,
    });
  }

  function renderStats() {
    clear(statHost);
    const pending = state.pendingCount === null ? '—' : formatNumber(state.pendingCount);
    const pendingCard = statCard({
      label: '待审批草稿',
      value: pending,
      hint: '点击筛选待审批',
      iconName: 'checkSquare',
      help: '所有等待人工审批的草稿数量。默认人工审批开启，未审批的草稿不会被发送。',
    });
    pendingCard.classList.add('page-outreach-clickable');
    pendingCard.addEventListener('click', () => {
      state.status = 'pending_approval';
      state.page = 1;
      statusSelect.value = 'pending_approval';
      loadList();
    });
    const totalCard = statCard({
      label: approvalsMode ? '审批视图记录' : '当前筛选记录',
      value: formatNumber(listTotal),
      hint: approvalsMode ? '默认展示待审批' : '按筛选条件统计',
      iconName: 'mail',
    });
    append(statHost, [pendingCard, totalCard]);
  }

  function toggleSelection(id, checked) {
    if (checked) state.selected.add(id);
    else state.selected.delete(id);
    updateBatchBar();
  }

  function updateBatchBar() {
    const count = state.selected.size;
    batchBar.classList.toggle('hidden', count === 0);
    clear(batchBar);
    if (!count) return;
    append(batchBar, [
      el('span', 'page-batch-count', `已选 ${count} 封草稿`),
      el('span', 'grow'),
      button('全选本页', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          for (const row of currentRows) {
            if (APPROVABLE_STATUSES.includes(row.status)) state.selected.add(row.id);
          }
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
      button('批量批准', {
        size: 'sm',
        variant: 'primary',
        iconName: 'check',
        disabled: !writable,
        onClick: batchApprove,
      }),
    ]);
  }

  let currentRows = [];

  async function batchApprove() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: '批量批准草稿',
      message: `确认批准选中的 ${ids.length} 封草稿？批准后它们会进入可发送状态，发送仍需手动触发，并经过服务端安全校验。`,
      confirmText: '确认批准',
    });
    if (!ok) return;
    try {
      const result = await api.post(`${API}/drafts/batch-approve`, { ids });
      const approved = Array.isArray(result && result.approved) ? result.approved.length : ids.length;
      const failed = Array.isArray(result && result.failed) ? result.failed : [];
      if (failed.length) {
        toast(`已批准 ${approved} 封，${failed.length} 封失败：${failed[0].message || failed[0].code || ''}`, 'warning');
      } else {
        toast(`已批准 ${approved} 封草稿`, 'success');
      }
      state.selected.clear();
      updateBatchBar();
      loadList();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function approveOne(row) {
    try {
      await api.post(`${API}/drafts/${encodeURIComponent(row.id)}/approve`, {});
      toast('草稿已批准', 'success');
      loadList();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function sendOne(row) {
    const ok = await confirmDialog({
      title: '加入发送队列',
      message: `确认发送「${row.subject || '未命名草稿'}」给 ${row.contactName || row.contactEmail || '该联系人'}？服务端会再次校验审批状态、抑制名单、自动化状态、活动状态、发送窗口与限额。`,
      confirmText: '确认发送',
    });
    if (!ok) return;
    try {
      const result = await api.post(`${API}/drafts/${encodeURIComponent(row.id)}/send`, {});
      if (result && result.queueError) toast(`已排队，但任务队列返回：${result.queueError}`, 'warning');
      else toast('已加入发送队列', 'success');
      loadList();
    } catch (error) {
      const campaignStatus = row.campaignStatus || (row.campaign && row.campaign.status);
      if (campaignStatus && campaignStatus !== 'active') {
        showSendBlocked({ code: 'CAMPAIGN_NOT_ACTIVE', message: '活动已暂停或未启用，请先恢复活动后再发送。' });
      } else {
        showSendBlocked(error);
      }
    }
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
        key: 'contact',
        label: '联系人 / 企业',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [el('div', 'cell-main', row.contactName || row.contactEmail || '未知联系人')]);
          append(wrap, [el('div', 'cell-sub', row.companyName || row.companyDomain || '—')]);
          return wrap;
        },
      },
      {
        key: 'subject',
        label: '主题',
        render: (row) => {
          const wrap = el('div', '');
          append(wrap, [el('div', 'cell-main', truncate(row.subject || '（无主题）', 60))]);
          append(wrap, [el('div', 'cell-sub', truncate(String(row.bodyText || '').replace(/\s+/g, ' '), 54))]);
          return wrap;
        },
      },
      { key: 'language', label: '语言', render: (row) => badge(languageLabel(row.language), 'blue') },
      { key: 'status', label: '状态', render: (row) => statusBadge(row.status, 'draft') },
      {
        key: 'campaign',
        label: '来源活动',
        render: (row) => el('span', 'muted', row.campaignName || (row.campaign && row.campaign.name) || '—'),
      },
      {
        key: 'updatedAt',
        label: '更新时间',
        render: (row) => el('span', 'muted', relativeTime(row.updatedAt || row.createdAt)),
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
              onClick: () => openDraftDrawer(row, { reloadList: loadList, reloadApprovals: loadApprovals, mode: ctx && ctx.mode }),
            }),
          ]);
          if (APPROVABLE_STATUSES.includes(row.status)) {
            append(wrap, [
              button('批准', {
                size: 'sm',
                variant: 'ghost',
                iconName: 'check',
                disabled: !writable,
                onClick: () => approveOne(row),
              }),
            ]);
          }
          if (row.status === 'approved') {
            append(wrap, [
              button('发送', {
                size: 'sm',
                variant: 'ghost',
                iconName: 'send',
                disabled: !writable,
                onClick: () => sendOne(row),
              }),
            ]);
          }
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
        rows: currentRows,
        empty: emptyPanel(),
        onRowClick: (row) =>
          openDraftDrawer(row, { reloadList: loadList, reloadApprovals: loadApprovals, mode: ctx && ctx.mode }),
      }),
    );
  }

  async function loadApprovals() {
    const data = await safeGet(`${API}/approvals/pending${queryString({ pageSize: 1 })}`);
    if (disposed) return;
    if (data && typeof data === 'object') {
      const count = Number(data.count !== undefined ? data.count : Array.isArray(data.items) ? data.items.length : 0);
      state.pendingCount = Number.isFinite(count) ? count : 0;
    } else if (data === null) {
      state.pendingCount = null;
    }
    renderStats();
  }

  async function loadList() {
    if (disposed) return;
    clear(tableHost);
    tableHost.appendChild(dataTable({ columns: columns(), rows: [], loading: true }));
    clear(pagerHost);
    try {
      const data = await api.get(
        `${API}/drafts${queryString({ page: state.page, pageSize: state.pageSize, status: state.status, search: state.q })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      const serverPage = Number(data && data.page);
      if (Number.isFinite(serverPage) && serverPage > 0) state.page = serverPage;
      currentRows = items;
      listTotal = total;
      // Drop selections that are no longer approvable / visible.
      const visible = new Set(items.filter((item) => APPROVABLE_STATUSES.includes(item.status)).map((item) => item.id));
      for (const id of [...state.selected]) if (!visible.has(id)) state.selected.delete(id);
      renderRows();
      updateBatchBar();
      renderStats();
      if (total > 0) {
        clear(pagerHost);
        pagerHost.appendChild(
          pagination({
            page: state.page,
            pageSize: state.pageSize,
            total,
            onChange: (nextPage) => {
              state.page = Math.max(1, Number(nextPage) || 1);
              loadList();
            },
          }),
        );
      }
    } catch (error) {
      if (disposed) return;
      clear(tableHost);
      tableHost.appendChild(errorState(errorMessage(error)));
      clear(pagerHost);
    }
  }

  const searchNode = searchInput({
    placeholder: '搜索主题 / 联系人 / 企业…',
    value: '',
    onInput: (value) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = String(value || '').trim();
        state.page = 1;
        loadList();
      }, 300);
    },
  });
  cleanup.push(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  const statusSelect = select({
    value: state.status,
    options: Object.entries(DRAFT_STATUS_LABELS).map(([value, label]) => ({ value, label })),
    placeholder: '全部状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      loadList();
    },
  });

  append(root, [
    pageHeader({
      title: approvalsMode ? '发送审批' : '邮件草稿',
      help: approvalsMode
        ? '逐封审核 AI 生成的开发信：查看原始邮件与依据，修改后批准或驳回。默认人工审批，未批准的草稿不会发送。'
        : '所有 AI 生成的开发信草稿。草稿必须经过人工审批才能进入发送队列，发送前还有服务端安全校验。',
      actions: [
        button('刷新', {
          iconName: 'refresh',
          onClick: () => {
            loadList();
            loadApprovals();
          },
        }),
        approvalsMode
          ? button('全部草稿', { iconName: 'mail', onClick: () => navigate('/drafts') })
          : button('去审批', { variant: 'primary', iconName: 'checkSquare', onClick: () => navigate('/approvals') }),
      ],
    }),
    statHost,
    toolbar(
      searchNode,
      statusSelect,
      el('span', 'grow'),
      helpTip('「批准」只改变草稿状态；真正发送需要再次点击发送，且服务端会复核审批、抑制名单、自动化状态、活动与限额。'),
    ),
    batchBar,
    tableHost,
    pagerHost,
  ]);

  await Promise.all([loadApprovals(), loadList()]);
}
