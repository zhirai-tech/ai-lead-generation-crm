/**
 * Unified inbox (OWNER: t-front-outreach).
 *
 * Left: conversation list (search / all-unread-high-intent / thread status).
 * Right: thread detail — messages, AI classification card (label, confidence,
 * evidence, rationale, suggested reply; always marked "AI 建议，需人工确认"),
 * manual correction, human reply and human takeover / resume.
 *
 * The AI never sends anything from this screen: replies are human-authored and
 * every dangerous action (takeover, unsubscribe correction) is confirmed.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { can } from '../app/state.mjs';
import { formatDateTime, relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  card,
  checkbox,
  confirmDialog,
  emptyState,
  field,
  helpTip,
  iconButton,
  input,
  loadingBlock,
  mailBody,
  notice,
  openModal,
  pageHeader,
  pagination,
  searchInput,
  segmented,
  select,
  statusBadge,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';

export const meta = {
  title: '统一收件箱',
  help: '客户回复与 AI 分类建议的集中视图。AI 分类只是建议，必须人工确认；接管后 AI 不再自动回复或跟进。',
};

const API = '/api/v1';
const PAGE_SIZE = 20;

const THREAD_STATUS = {
  open: ['处理中', 'blue'],
  waiting: ['等待回复', 'yellow'],
  replied: ['已回复', 'green'],
  closed: ['已关闭', 'gray'],
  archived: ['已归档', 'gray'],
};

const INTENT_OPTIONS = [
  ['positive_interest', '正面合作意向'],
  ['price_inquiry', '询价'],
  ['quote_request', '索要报价'],
  ['sample_request', '索取样品'],
  ['technical_question', '技术问题'],
  ['follow_up_needed', '需要进一步联系'],
  ['no_need_now', '暂时无需求'],
  ['rejection', '明确拒绝'],
  ['unsubscribe', '退订'],
  ['auto_reply', '自动回复'],
  ['unknown', '无法判断'],
];

const SENDABLE_STATES = ['AUTOMATION_ACTIVE', 'NEEDS_HUMAN_REVIEW'];
const RESUMABLE_STATES = ['HUMAN_TAKEOVER', 'PAUSED', 'NEEDS_HUMAN_REVIEW'];

function threadBadge(status) {
  const [label, tone] = THREAD_STATUS[status] || [status || '未知', 'gray'];
  return badge(label, tone, { dot: true });
}

function intentLabel(label) {
  const found = INTENT_OPTIONS.find(([value]) => value === label);
  return found ? found[1] : label || '未分类';
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

function normalizeThreadDetail(data) {
  const root = data && typeof data === 'object' ? data : {};
  return {
    thread: root.thread || root,
    messages: Array.isArray(root.messages) ? root.messages : [],
    classification: root.classification || null,
    company: root.company || null,
    contact: root.contact || null,
    suggestedReply: root.suggestedReply || (root.classification && root.classification.suggestedReply) || '',
    automationState: root.automationState || null,
  };
}

function confidencePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scaled = number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

let disposed = false;
let cleanup = [];
const overlays = new Set();

function showModal(options) {
  const handle = openModal(options);
  if (handle.modal && handle.modal.parentElement) overlays.add(handle.modal.parentElement);
  return handle;
}

export function destroy() {
  disposed = true;
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // ignore
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

// --------------------------------------------------------------------- page
export async function render(root) {
  clear(root);
  disposed = false;
  cleanup = [];

  const state = {
    view: 'all',
    status: '',
    q: '',
    page: 1,
    pageSize: PAGE_SIZE,
    activeId: null,
    threads: [],
    total: 0,
    automation: null,
  };

  let searchTimer = null;
  let listToken = 0;
  const listHost = el('div', 'inbox-list');
  const detailHost = el('div', 'inbox-detail page-outreach-inbox-detail');
  const pagerHost = el('div', 'page-outreach-pager');
  const layout = el('div', 'inbox-layout');
  append(layout, [listHost, detailHost]);

  function showDetailPlaceholder() {
    clear(detailHost);
    detailHost.appendChild(
      emptyState({
        iconName: 'inbox',
        title: '选择左侧会话查看详情',
        description: 'AI 分类、建议回复与人工接管操作都在详情里完成。',
      }),
    );
  }

  function renderList() {
    clear(listHost);
    if (!state.threads.length) {
      listHost.appendChild(
        emptyState({
          iconName: 'inbox',
          title: state.view === 'high' ? '暂无高意向会话' : '暂无对话',
          description:
            state.view === 'high'
              ? '当客户回复被识别为正面意向、询价、报价或样品需求时会出现在这里。'
              : '发送开发信并同步收件箱后，客户回复会出现在这里。',
          action: button('去创建活动', { variant: 'primary', size: 'sm', iconName: 'mail', onClick: () => navigate('/campaigns') }),
        }),
      );
      return;
    }
    for (const thread of state.threads) {
      const item = el('button', `inbox-item${thread.id === state.activeId ? ' active' : ''}`);
      item.type = 'button';
      item.appendChild(
        el('div', 'inbox-sender', [
          el('span', 'truncate', thread.companyName || thread.contactName || thread.contactEmail || '未知客户'),
          el('span', 'inbox-time', relativeTime(thread.lastMessageAt || thread.updatedAt)),
        ]),
      );
      item.appendChild(el('div', 'inbox-subject', thread.subject || '（无主题）'));
      const snippet = thread.lastMessagePreview || thread.lastBody || '';
      item.appendChild(el('div', 'inbox-snippet', snippet ? truncate(String(snippet).replace(/\s+/g, ' '), 90) : '—'));
      const metaRow = el('div', 'page-outreach-inbox-meta');
      if (thread.unreadCount > 0) {
        append(metaRow, [el('span', 'page-outreach-unread-dot')]);
      }
      if (thread.classification || thread.latestLabel) {
        append(metaRow, [statusBadge(thread.classification || thread.latestLabel, 'intent')]);
      }
      if (thread.unreadCount > 0) append(metaRow, [badge(`${thread.unreadCount} 封未读`, 'yellow')]);
      if (metaRow.childNodes.length) item.appendChild(metaRow);
      item.addEventListener('click', () => selectThread(thread));
      listHost.appendChild(item);
    }
  }

  async function loadThreads() {
    const token = ++listToken;
    clear(listHost);
    listHost.appendChild(loadingBlock('正在加载会话…'));
    let path;
    if (state.view === 'high') {
      path = `${API}/inbox/high-intent${queryString({ page: state.page, pageSize: state.pageSize, search: state.q })}`;
    } else {
      path = `${API}/inbox/threads${queryString({
        page: state.page,
        pageSize: state.pageSize,
        unread: state.view === 'unread' ? 1 : undefined,
        status: state.status,
        search: state.q,
      })}`;
    }
    let data = null;
    try {
      data = await api.get(path);
    } catch (error) {
      if (disposed || token !== listToken) return;
      clear(listHost);
      listHost.appendChild(
        el('div', 'page-state', [
          notice(`会话列表加载失败：${errorMessage(error)}`, 'danger'),
          button('重试', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: loadThreads }),
        ]),
      );
      clear(pagerHost);
      return;
    }
    if (disposed || token !== listToken) return;
    const { items, total } = unwrapList(data);
    const serverPage = Number(data && data.page);
    if (Number.isFinite(serverPage) && serverPage > 0) state.page = serverPage;
    state.threads = items;
    state.total = total;
    renderList();
    renderPager();
    if (state.activeId && items.some((item) => item.id === state.activeId)) {
      await loadDetail(state.activeId);
    } else if (!state.activeId && items.length && window.innerWidth > 900) {
      // On wide screens auto-open the first conversation to save a click.
      await selectThread(items[0]);
    }
  }

  function renderPager() {
    clear(pagerHost);
    if (state.view === 'high' || state.total <= state.pageSize) return;
    pagerHost.appendChild(
      pagination({
        page: state.page,
        pageSize: state.pageSize,
        total: state.total,
        onChange: (nextPage) => {
          state.page = Math.max(1, Number(nextPage) || 1);
          loadThreads();
        },
      }),
    );
  }

  async function selectThread(thread) {
    state.activeId = thread.id;
    state.automation = null;
    renderList();
    await loadDetail(thread.id);
    // Opening a conversation is the user's confirmation that they have read it.
    // Mark it read automatically so the list does not keep an obsolete unread badge.
    if (thread.unreadCount > 0) {
      void autoMarkRead(thread);
    }
  }

  async function autoMarkRead(thread) {
    try {
      await api.post(`${API}/inbox/threads/${encodeURIComponent(thread.id)}/read`, {});
      thread.unreadCount = 0;
      const current = state.threads.find((item) => item.id === thread.id);
      if (current) current.unreadCount = 0;
      renderList();
    } catch {
      // Read state is cosmetic; never block opening a conversation on it.
    }
  }

  async function loadDetail(threadId) {
    clear(detailHost);
    detailHost.appendChild(loadingBlock('正在加载会话详情…'));
    const data = await safeGet(`${API}/inbox/threads/${encodeURIComponent(threadId)}`);
    if (disposed) return;
    if (!data) {
      clear(detailHost);
      detailHost.appendChild(
        el('div', 'page-state', [
          notice('会话详情接口暂不可用，请稍后重试。', 'danger'),
          button('重试', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: () => loadDetail(threadId) }),
        ]),
      );
      return;
    }
    const detail = normalizeThreadDetail(data);
    const companyId = (detail.company && detail.company.id) || (detail.thread && detail.thread.companyId) || null;
    if (companyId) {
      const automation = await safeGet(`${API}/automation/${encodeURIComponent(companyId)}`);
      if (!disposed) state.automation = automation && typeof automation === 'object' ? automation : null;
    } else {
      state.automation = null;
    }
    if (disposed) return;
    renderDetail(detail);
  }

  function renderDetail(detail) {
    const thread = detail.thread || {};
    const company = detail.company || {};
    const contact = detail.contact || {};
    const automation = state.automation || detail.automationState || null;
    const automationState = automation && automation.state ? automation.state : null;
    const companyId = company.id || thread.companyId || automation?.companyId || null;
    const canManageAutomation = can('automation.manage');
    const canReply = can('data.write');
    const classification = detail.classification || null;

    clear(detailHost);

    // ------------------------------------------------------------------ head
    const head = el('div', 'inbox-detail-head');
    const headTop = el('div', 'row-between');
    const titleWrap = el('div', 'page-outreach-inbox-title');
    append(titleWrap, [
      el('b', '', company.name || thread.companyName || '未知企业'),
      el('div', 'muted', `${contact.fullName || thread.contactName || '—'} · ${contact.email || thread.contactEmail || '无邮箱'}`),
    ]);
    append(headTop, [
      titleWrap,
      el('div', 'row', [
        iconButton('refresh', { title: '刷新', onClick: () => loadDetail(thread.id) }),
        iconButton('close', { title: '关闭会话详情', onClick: () => {
          state.activeId = null;
          renderList();
          showDetailPlaceholder();
        } }),
      ]),
    ]);
    const headMeta = el('div', 'page-outreach-inbox-head-meta');
    append(headMeta, [
      threadBadge(thread.status),
      thread.classification ? statusBadge(thread.classification, 'intent') : null,
      automationState ? statusBadge(automationState, 'automation') : null,
      thread.subject ? el('span', 'muted', `主题：${thread.subject}`) : null,
    ]);
    append(head, [headTop, headMeta]);

    const headActions = el('div', 'row page-outreach-inbox-actions');
    append(headActions, [
      button('标记已读', {
        size: 'sm',
        variant: 'outline',
        iconName: 'check',
        onClick: () => markRead(thread.id),
      }),
      companyId
        ? button('查看企业', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'building',
            onClick: () => navigate(`/companies/${encodeURIComponent(companyId)}`),
          })
        : null,
      companyId && automationState && SENDABLE_STATES.includes(automationState) && canManageAutomation
        ? button('人工接管', {
            size: 'sm',
            variant: 'danger',
            iconName: 'lock',
            onClick: () => takeover(companyId),
          })
        : null,
      companyId && automationState && RESUMABLE_STATES.includes(automationState) && canManageAutomation
        ? button('恢复自动化', {
            size: 'sm',
            variant: 'primary',
            iconName: 'play',
            onClick: () => resume(companyId),
          })
        : null,
    ]);
    head.appendChild(headActions);
    detailHost.appendChild(head);

    if (automationState && !SENDABLE_STATES.includes(automationState)) {
      detailHost.appendChild(
        notice(
          automationState === 'DO_NOT_CONTACT'
            ? '该客户处于「禁止联系」状态：AI 与人工都不会自动发送，恢复自动化需先由管理员/拥有者删除抑制记录。'
            : '已人工接管：AI 暂停自动回复与自动跟进，回复需要你手动发送。',
          'warn',
        ),
      );
    }

    // -------------------------------------------------------------- messages
    const scroll = el('div', 'inbox-thread-scroll');
    if (!detail.messages.length) {
      scroll.appendChild(emptyState({ iconName: 'message', title: '该会话还没有邮件', description: '同步收件箱后这里会显示原始往来邮件。' }));
    } else {
      for (const message of detail.messages) {
        const outbound = message.direction === 'outbound';
        const bubble = el('div', `message-bubble${outbound ? ' outbound' : ''}`);
        const meta = el('div', 'message-meta');
        append(meta, [
          el('span', '', `${outbound ? '我方发送' : '客户来信'} · ${message.fromName || message.fromAddress || ''}`),
          el('span', '', formatDateTime(message.receivedAt || message.sentAt || message.createdAt)),
        ]);
        bubble.appendChild(meta);
        if (message.subject) bubble.appendChild(el('div', 'page-outreach-inbox-subject', message.subject));
        bubble.appendChild(mailBody(message.bodyText || message.body || '（正文为空）'));
        scroll.appendChild(bubble);
      }
    }
    detailHost.appendChild(scroll);

    // -------------------------------------------------------- classification
    const classBody = el('div', 'stack');
    const aiBadge = badge('AI 建议，需人工确认', 'purple', { dot: true });
    if (classification) {
      const confidence = confidencePercent(classification.confidence);
      const header = el('div', 'row page-outreach-inbox-class-head');
      append(header, [
        statusBadge(classification.label, 'intent'),
        confidence === null ? null : badge(`置信度 ${confidence}%`, confidence >= 70 ? 'green' : confidence >= 40 ? 'yellow' : 'red'),
        badge(classification.status === 'user_corrected' ? '已人工修正' : 'AI 原始建议', classification.status === 'user_corrected' ? 'cyan' : 'gray'),
        aiBadge,
      ]);
      classBody.appendChild(header);
      if (classification.intentScore !== undefined && classification.intentScore !== null) {
        classBody.appendChild(el('div', 'muted', `意向分：${classification.intentScore} / 100（仅作参考）`));
      }
      classBody.appendChild(el('div', 'muted', '判断依据（原始邮件摘录）：'));
      const evidence = Array.isArray(classification.evidence) ? classification.evidence : [];
      if (!evidence.length) {
        classBody.appendChild(el('div', 'muted', '暂无依据摘录'));
      } else {
        const list = el('ul', 'page-outreach-evidence-list');
        for (const item of evidence.slice(0, 10)) {
          list.appendChild(el('li', '', typeof item === 'string' ? item : JSON.stringify(item)));
        }
        classBody.appendChild(list);
      }
      classBody.appendChild(el('div', 'muted', '判断理由：'));
      classBody.appendChild(el('div', 'page-outreach-rationale', classification.rationale || '（AI 未给出理由）'));
      if (classification.suggestedReply || detail.suggestedReply) {
        classBody.appendChild(el('div', 'muted', '建议回复（草稿，需人工修改后再发送）：'));
        const suggested = el('div', 'page-outreach-suggested', classification.suggestedReply || detail.suggestedReply);
        classBody.appendChild(suggested);
        classBody.appendChild(
          button('复制建议回复到回复框', {
            size: 'sm',
            variant: 'outline',
            iconName: 'copy',
            onClick: () => {
              const composer = detailHost.querySelector('textarea');
              if (composer) {
                composer.value = classification.suggestedReply || detail.suggestedReply || '';
                composer.focus();
                toast('已填入回复框，请核对后发送', 'info');
              }
            },
          }),
        );
      }
    } else {
      classBody.appendChild(el('div', 'row', [badge('尚未分类', 'gray'), helpTip('收到的客户回复由后台分类任务生成建议；未分类时仍可人工回复。')]));
    }
    detailHost.appendChild(card({ title: 'AI 分类建议', body: classBody }));

    // ------------------------------------------------------ manual correction
    const correctionLabel = select({
      value: classification ? classification.label : 'unknown',
      options: INTENT_OPTIONS.map(([value, label]) => ({ value, label })),
    });
    const correctionNote = input({ placeholder: '修正原因（可选，会写入审计记录）' });
    const correctionRow = el('div', 'page-outreach-correction');
    append(correctionRow, [
      field('正确分类', correctionLabel, { help: '人工修正会保留 AI 原始建议，并追加一条 user_corrected 记录。' }),
      field('原因', correctionNote),
    ]);
    const correctionBody = el('div', 'stack');
    correctionBody.appendChild(correctionRow);
    correctionBody.appendChild(
      el('div', 'row', [
        button('保存人工修正', {
          variant: 'outline',
          iconName: 'edit',
          onClick: () => saveClassification(thread.id, correctionLabel.value, correctionNote.value),
        }),
        helpTip('若改为「退订」，系统会写入抑制名单并置为禁止联系，需要二次确认。'),
      ]),
    );
    detailHost.appendChild(card({ title: '人工修正分类', body: correctionBody }));

    // --------------------------------------------------------------- reply
    const replyControl = textarea({ rows: 6, placeholder: '输入回复内容…（人工回复由你发送）' });
    const replyBody = el('div', 'composer');
    replyBody.appendChild(replyControl);
    replyBody.appendChild(
      el('div', 'row-between', [
        el('div', 'muted', `发送给：${contact.email || thread.contactEmail || '该联系人'}`),
        el('div', 'row', [
          helpTip('人工回复会作为已审批草稿进入发送队列，仍受抑制名单与自动化状态限制。'),
          button('发送回复', {
            variant: 'primary',
            iconName: 'send',
            disabled: !canReply,
            onClick: () => sendReply(thread.id, replyControl),
          }),
        ]),
      ]),
    );
    detailHost.appendChild(card({ title: '人工回复', body: replyBody }));

    if (!canReply) detailHost.appendChild(notice('当前角色只有只读权限，不能回复客户。', 'info'));
  }

  async function markRead(threadId) {
    try {
      await api.post(`${API}/inbox/threads/${encodeURIComponent(threadId)}/read`, {});
      const thread = state.threads.find((item) => item.id === threadId);
      if (thread) thread.unreadCount = 0;
      renderList();
      toast('已标记为已读', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function saveClassification(threadId, label, note) {
    if (!label) {
      toast('请选择分类', 'warning');
      return;
    }
    if (label === 'unsubscribe') {
      const ok = await confirmDialog({
        title: '标记为退订',
        message: '将客户分类修正为「退订」会写入禁止联系名单，并把客户置为「禁止联系」，AI 与人工都不会再自动发送。确认继续？',
        confirmText: '确认退订',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.post(`${API}/inbox/threads/${encodeURIComponent(threadId)}/classification`, {
        label,
        status: 'user_corrected',
        note: String(note || '').trim() || null,
      });
      toast('分类已修正', 'success');
      await loadDetail(threadId);
      await loadThreads();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function sendReply(threadId, control) {
    const bodyText = String(control.value || '').trim();
    if (!bodyText) {
      toast('回复内容不能为空', 'warning');
      control.focus();
      return;
    }
    const ok = await confirmDialog({
      title: '发送人工回复',
      message: '确认发送这封人工回复？发送前仍会检查抑制名单与客户自动化状态；接管状态下 AI 不会继续跟进。',
      confirmText: '确认发送',
    });
    if (!ok) return;
    try {
      await api.post(`${API}/inbox/threads/${encodeURIComponent(threadId)}/reply`, { bodyText });
      toast('回复已加入发送队列', 'success');
      await loadDetail(threadId);
      await loadThreads();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function takeover(companyId) {
    const ok = await confirmDialog({
      title: '人工接管客户',
      message: '接管后 AI 将立即停止自动回复与自动跟进，并取消该客户未发送的跟进任务。确认接管？',
      confirmText: '确认接管',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`${API}/automation/${encodeURIComponent(companyId)}/takeover`, { reason: '收件箱人工接管' });
      toast('已人工接管，AI 已停止自动跟进', 'success');
      if (state.activeId) await loadDetail(state.activeId);
      await loadThreads();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function resume(companyId) {
    const ok = await confirmDialog({
      title: '恢复自动化',
      message: '恢复后 AI 会重新按规则自动回复与跟进该客户。确认恢复？',
      confirmText: '确认恢复',
    });
    if (!ok) return;
    try {
      await api.post(`${API}/automation/${encodeURIComponent(companyId)}/resume`, { reason: '收件箱恢复自动化' });
      toast('已恢复自动化', 'success');
      if (state.activeId) await loadDetail(state.activeId);
      await loadThreads();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const searchNode = searchInput({
    placeholder: '搜索主题 / 企业 / 邮箱…',
    value: '',
    onInput: (value) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = String(value || '').trim();
        state.page = 1;
        loadThreads();
      }, 300);
    },
  });
  cleanup.push(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  const scopeSegmented = segmented({
    value: state.view,
    items: [
      { value: 'all', label: '全部' },
      { value: 'unread', label: '未读' },
      { value: 'high', label: '高意向' },
    ],
    onChange: (value) => {
      state.view = value;
      state.page = 1;
      loadThreads();
    },
  });

  const statusSelect = select({
    value: '',
    options: Object.entries(THREAD_STATUS).map(([value, entry]) => ({ value, label: entry[0] })),
    placeholder: '全部会话状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      loadThreads();
    },
  });

  append(root, [
    pageHeader({
      title: meta.title,
      help: meta.help,
      actions: [
        button('刷新', {
          iconName: 'refresh',
          onClick: () => {
            loadThreads();
            if (state.activeId) loadDetail(state.activeId);
          },
        }),
        button('自动化与接管', { iconName: 'shield', onClick: () => navigate('/automation') }),
      ],
    }),
    toolbar(
      searchNode,
      scopeSegmented,
      statusSelect,
      el('span', 'grow'),
      helpTip('高意向筛选来自 AI 分类（正面意向、询价、报价、样品）；分类可人工修正，原始邮件与依据始终保留。'),
    ),
    layout,
    pagerHost,
  ]);

  showDetailPlaceholder();
  await loadThreads();
}
