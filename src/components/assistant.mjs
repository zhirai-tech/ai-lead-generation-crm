/**
 * Floating assistant (v0.2).
 *
 * Collapsed state is a small animated orb that can be dragged anywhere. The orb
 * "speaks" (visual waveform) when the assistant answers. The panel can also be
 * dragged by its header and remembers both positions. This is still text-only:
 * full MCP tool execution arrives in the next iteration.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { confirmDialog, icon } from './ui.mjs';

const PAGES = [
  { test: /(企业发现|找客户|搜索客户)/, path: '/discovery', label: '企业发现', aliases: ['企业发现', '发现', '找客户', '搜索客户'] },
  { test: /(潜在客户|企业列表|客户列表)/, path: '/companies', label: '潜在客户', aliases: ['潜在客户', '客户', '企业', '公司', '企业列表', '客户列表'] },
  { test: /(联系人|通讯录)/, path: '/contacts', label: '联系人库', aliases: ['联系人', '联系人库', '通讯录'] },
  { test: /(产品模板|邮件模板|产品资料|产品)/, path: '/products', label: '产品资料', aliases: ['产品资料', '产品', '产品库', '产品模板', '邮件模板'] },
  { test: /(客户画像|ICP|画像)/i, path: '/icps', label: '客户画像', aliases: ['客户画像', '画像', 'ICP'] },
  { test: /(邮件草稿|草稿)/, path: '/drafts', label: '邮件草稿', aliases: ['邮件草稿', '草稿', '开发信'] },
  { test: /(发送审批|审批)/, path: '/approvals', label: '发送审批', aliases: ['发送审批', '审批', '待审批'] },
  { test: /(统一收件|收件箱|回复|未读)/, path: '/inbox', label: '统一收件', aliases: ['统一收件', '收件箱', '未读', '回复'] },
  { test: /(销售管道|商机|管道)/, path: '/deals', label: '销售管道', aliases: ['销售管道', '商机', '管道'] },
  { test: /(自动化)/, path: '/automation', label: '自动化流', aliases: ['自动化', '自动化流'] },
  { test: /(智能代理|Agent)/i, path: '/agents', label: '智能代理', aliases: ['智能代理', '代理', 'Agent'] },
  { test: /(任务队列|队列)/, path: '/jobs', label: '任务队列', aliases: ['任务队列', '任务', '队列'] },
  { test: /(系统设置|AI 模型|模型配置)/, path: '/settings?tab=ai', label: '系统设置 · AI 模型', aliases: ['系统设置', '设置', 'AI 模型', '模型配置'] },
  { test: /(全局总览|工作台|总览|仪表盘)/, path: '/dashboard', label: '全局总览', aliases: ['全局总览', '总览', '工作台', '仪表盘', '首页'] },
];

const PAGE_COMMAND = /(打开|进入|去|跳到|跳转到|切换到|查看|看看|显示|带我去|帮我打开)/;

const QUICK = [
  { label: '新话题', reset: true },
  { label: '平台检查', query: '检查平台状态' },
  { label: '待审批', path: '/approvals' },
  { label: '未读回复', path: '/inbox' },
  { label: '企业发现', path: '/discovery' },
  { label: '产品模板', path: '/products' },
];

const ORB_KEY = 'zhirai.assistant.orb';
const PANEL_KEY = 'zhirai.assistant.panel';
const VOICE_KEY = 'zhirai.assistant.voice';
const HISTORY_KEY = 'zhirai.assistant.history.v1';
const ORB_SIZE = 58;

const COUNTRY_CODES = {
  德国: 'DE', 法国: 'FR', 意大利: 'IT', 西班牙: 'ES', 荷兰: 'NL', 波兰: 'PL',
  英国: 'GB', 比利时: 'BE', 奥地利: 'AT', 瑞典: 'SE', 丹麦: 'DK', 捷克: 'CZ',
  匈牙利: 'HU', 葡萄牙: 'PT', 希腊: 'GR', 罗马尼亚: 'RO', 芬兰: 'FI', 爱尔兰: 'IE',
  瑞士: 'CH', 挪威: 'NO',
};
const EUROPE_CODES = Object.values(COUNTRY_CODES);
const PROVIDER_LABELS = {
  tavily: 'Tavily 全网搜索',
  browser: '本机浏览器搜索',
  brave: 'Brave 全网搜索',
  serper: 'Serper 全网搜索',
  osm: 'OpenStreetMap 真实企业',
};

const COMPANY_TYPES = [
  ['importer', /进口商|importer/i],
  ['distributor', /分销商|distributor/i],
  ['wholesaler', /批发商|wholesaler/i],
  ['manufacturer', /制造商|manufacturer/i],
  ['retailer', /零售商|retailer/i],
  ['dealer', /经销商|dealer/i],
  ['trader', /贸易商|trader/i],
  ['reseller', /代理商|reseller/i],
  ['aftermarket', /售后|aftermarket/i],
];

const PURCHASING_ROLES = [
  ['owner', /老板|拥有者|owner/i],
  ['ceo', /CEO|总经理|ceo/i],
  ['managing_director', /Managing Director/i],
  ['purchasing_manager', /采购经理|purchasing manager/i],
  ['procurement', /采购专员|procurement/i],
  ['sales_manager', /销售经理|sales manager/i],
  ['product_manager', /产品经理|product manager/i],
  ['technical_manager', /技术经理|technical manager/i],
];

function pageTextScore(text, alias) {
  const clean = (value) => String(value || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  const source = clean(text);
  const target = clean(alias);
  if (!source || !target) return 0;
  if (source.includes(target) || target.includes(source)) return 1;
  const sourceChars = new Set([...source]);
  let common = 0;
  for (const char of new Set([...target])) {
    if (sourceChars.has(char)) common += 1;
  }
  return common / Math.max(2, target.length);
}

function detectPage(text) {
  const raw = String(text || '');
  const hasCommand = PAGE_COMMAND.test(raw);
  if (!hasCommand) {
    // Short voice transcripts often omit the verb ("产品资料", "潜在客户").
    const bare = PAGES.find((page) => page.test.test(raw));
    if (bare && raw.length <= 14 && !/(怎么|如何|什么|为什么|哪|吗|介绍|教程|步骤)/.test(raw)) return bare;
    return null;
  }
  const exact = PAGES.find((page) => page.test.test(raw));
  if (exact) return exact;
  const target = raw
    .replace(PAGE_COMMAND, ' ')
    .replace(/页面|模块|一下|这个|那个|帮我|请|给我|的|到/g, ' ')
    .trim();
  if (target.length < 2) return null;
  let best = null;
  let bestScore = 0;
  for (const page of PAGES) {
    for (const alias of page.aliases || [page.label]) {
      const score = pageTextScore(target, alias);
      if (score > bestScore) {
        bestScore = score;
        best = page;
      }
    }
  }
  // Tolerate common speech-recognition substitutions (e.g. 潜在客户 → 潜在刻户).
  return bestScore >= 0.5 ? best : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readPosition(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) return value;
  } catch {
    // ignore malformed storage
  }
  return null;
}

function savePosition(key, position) {
  try {
    localStorage.setItem(key, JSON.stringify(position));
  } catch {
    // storage can be disabled; dragging still works for this session
  }
}

export function mountAssistant() {
  if (document.querySelector('.assistant-root')) return window.__zhiraiAssistant || null;

  const root = el('div', 'assistant-root');

  const fab = el('div', 'assistant-fab');
  fab.tabIndex = 0;
  fab.setAttribute('role', 'button');
  fab.title = '打开 ZHIRAI 助理（可拖动）';
  fab.setAttribute('aria-label', '打开 ZHIRAI 助理');
  const fabHalo = el('span', 'assistant-fab-halo');
  const orb = el('span', 'assistant-orb');
  orb.appendChild(icon('sparkles', 21));
  let orbIconName = 'sparkles';
  const fabStatus = el('span', 'assistant-fab-status hidden', '');
  const fabActions = el('div', 'assistant-fab-actions hidden');
  const fabHangup = el('button', 'assistant-fab-action hangup', '挂断');
  fabHangup.type = 'button';
  const fabDialog = el('button', 'assistant-fab-action', '打开对话框');
  fabDialog.type = 'button';
  append(fabActions, [fabHangup, fabDialog]);
  append(fab, [fabHalo, orb, fabStatus]);

  const callbar = el('div', 'assistant-mini hidden');
  const callHead = el('div', 'assistant-mini-head');
  const callStatus = el('span', 'assistant-callbar-status', '空闲');
  const callLog = el('div', 'assistant-mini-log');
  const callActions = el('div', 'assistant-mini-actions');
  const callMicBtn = el('button', 'assistant-callbar-btn mic', '收音中');
  callMicBtn.type = 'button';
  const callHangupBtn = el('button', 'assistant-callbar-btn hangup', '挂断');
  callHangupBtn.type = 'button';
  const callDialogBtn = el('button', 'assistant-callbar-btn', '展开对话');
  callDialogBtn.type = 'button';
  append(callHead, [callStatus]);
  const callInput = el('input', 'assistant-input assistant-mini-input');
  callInput.type = 'text';
  callInput.placeholder = '打字给助理…';
  callInput.autocomplete = 'off';
  const callSendBtn = el('button', 'assistant-send assistant-mini-send', '发送');
  callSendBtn.type = 'button';
  const callInputRow = el('div', 'assistant-mini-input-row');
  append(callInputRow, [callInput, callSendBtn]);
  append(callActions, [callMicBtn, callHangupBtn, callDialogBtn]);
  append(callbar, [callHead, callLog, callInputRow, callActions]);

  const actionStatus = el('div', 'assistant-action-status hidden');
  const actionStatusText = el('span', 'assistant-action-text', '');
  append(actionStatus, [actionStatusText]);
  let actionHideTimer = null;
  function showActionStatus(text, { busy = true, autoHide = 0 } = {}) {
    if (actionHideTimer) {
      clearTimeout(actionHideTimer);
      actionHideTimer = null;
    }
    actionStatusText.textContent = text;
    actionStatus.classList.remove('hidden');
    actionStatus.classList.toggle('busy', Boolean(busy));
    if (autoHide > 0) {
      actionHideTimer = setTimeout(() => {
        actionStatus.classList.add('hidden');
        actionHideTimer = null;
      }, autoHide);
    }
  }
  function hideActionStatus() {
    if (actionHideTimer) clearTimeout(actionHideTimer);
    actionHideTimer = null;
    actionStatus.classList.add('hidden');
  }

  const panel = el('section', 'assistant-panel hidden');
  panel.setAttribute('aria-label', 'ZHIRAI 悬浮助理');

  const head = el('div', 'assistant-head');
  head.title = '按住标题栏拖动窗口';
  const titleWrap = el('div', 'assistant-title');
  const grip = el('span', 'assistant-grip');
  grip.appendChild(icon('menu', 14));
  const title = el('b', '', 'ZHIRAI 助理');
  const badge = el('span', 'assistant-badge', '内测');
  const dragHint = el('span', 'assistant-drag-hint', '按住拖动');
  append(titleWrap, [grip, title, badge, dragHint]);
  const close = el('button', 'assistant-close');
  close.type = 'button';
  close.title = '收起助理';
  close.setAttribute('aria-label', '收起助理');
  close.appendChild(icon('close', 16));
  const voiceBtn = el('button', 'assistant-voice');
  voiceBtn.type = 'button';
  voiceBtn.title = '语音播报开关';
  voiceBtn.setAttribute('aria-label', '语音播报开关');
  const newTopicBtn = el('button', 'assistant-tool-btn');
  newTopicBtn.type = 'button';
  newTopicBtn.title = '新话题（清空当前上下文）';
  newTopicBtn.setAttribute('aria-label', '新话题');
  newTopicBtn.appendChild(icon('refresh', 15));
  append(head, [titleWrap, newTopicBtn, voiceBtn, close]);

  const body = el('div', 'assistant-body');
  const quick = el('div', 'assistant-quick');
  const activity = el('div', 'assistant-activity');
  const activityTitle = el('div', 'assistant-activity-title', '执行过程');
  const activityLog = el('div', 'assistant-activity-log');
  append(activity, [activityTitle, activityLog]);
  const messages = el('div', 'assistant-messages');
  const voiceView = el('div', 'assistant-voice-view hidden');
  const liveOrb = el('div', 'assistant-live-orb');
  liveOrb.tabIndex = 0;
  liveOrb.setAttribute('role', 'button');
  liveOrb.title = '点一下打断助理说话';
  liveOrb.setAttribute('aria-label', '打断助理说话');
  const liveOrbIcon = el('span', 'assistant-live-orb-core');
  liveOrbIcon.appendChild(icon('sparkles', 34));
  append(liveOrb, [liveOrbIcon]);
  const voiceStatus = el('div', 'assistant-voice-status', '点击开始语音对话');
  const voiceTranscript = el('div', 'assistant-voice-transcript', '');
  const voiceChat = el('div', 'assistant-voice-chat hidden');
  const voiceControls = el('div', 'assistant-voice-controls');
  const voiceMuteBtn = el('button', 'assistant-voice-control', '静音麦克风');
  voiceMuteBtn.type = 'button';
  const voiceInterruptBtn = el('button', 'assistant-voice-control', '打断');
  voiceInterruptBtn.type = 'button';
  const voiceEndBtn = el('button', 'assistant-voice-control hangup', '挂断');
  voiceEndBtn.type = 'button';
  const voiceChatBtn = el('button', 'assistant-voice-control', '打开对话框');
  voiceChatBtn.type = 'button';
  append(voiceControls, [voiceMuteBtn, voiceInterruptBtn, voiceEndBtn, voiceChatBtn]);
  append(voiceView, [liveOrb, voiceStatus, voiceTranscript, voiceChat, voiceControls]);
  const form = el('form', 'assistant-composer');
  const input = el('input', 'assistant-input');
  input.type = 'text';
  input.placeholder = '输入问题，或使用语音';
  input.autocomplete = 'off';
  const mic = el('button', 'assistant-mic');
  mic.type = 'button';
  mic.title = '语音输入（说一句转文字）';
  mic.setAttribute('aria-label', '语音输入');
  mic.appendChild(icon('mic', 16));
  const voiceModeBtn = el('button', 'assistant-mic assistant-talk');
  voiceModeBtn.type = 'button';
  voiceModeBtn.title = '语音对话（连续对话，像打电话）';
  voiceModeBtn.setAttribute('aria-label', '语音对话');
  voiceModeBtn.appendChild(icon('phone', 16));
  const send = el('button', 'assistant-send');
  send.type = 'submit';
  send.title = '发送';
  send.setAttribute('aria-label', '发送');
  send.appendChild(icon('send', 16));
  const agentToggle = el('button', 'assistant-tool-btn', 'Agent：关');
  agentToggle.type = 'button';
  agentToggle.title = '开启只读 Agent 模式（需要管理员启用 feature flag）';
  let agentMode = false;
  agentToggle.addEventListener('click', () => {
    agentMode = !agentMode;
    agentToggle.textContent = `Agent：${agentMode ? '开' : '关'}`;
    agentToggle.classList.toggle('active', agentMode);
    if (agentMode) {
      addMessage('assistant', 'Agent 模式已开启：只会调用只读工具，不会发送邮件或修改客户资料。');
    }
  });
  const hint = el('div', 'assistant-hint');
  const hintText = el('span', '', '麦克风=语音输入；电话=语音对话');
  const voiceState = el('span', 'assistant-voice-state', '晓晓');
  const voiceTest = el('button', 'assistant-test-voice', '试听声音');
  voiceTest.type = 'button';
  const stopSpeechBtn = el('button', 'assistant-test-voice', '停止朗读');
  stopSpeechBtn.type = 'button';
  append(hint, [hintText, voiceState, voiceTest, stopSpeechBtn]);
  append(form, [input, mic, voiceModeBtn, agentToggle, send]);
  append(body, [quick, activity, messages, voiceView, form, hint]);
  append(panel, [head, body]);
  append(root, [callbar, actionStatus, fab]);
  document.body.appendChild(root);

  const history = (() => {
    const fallback = [
      {
        role: 'assistant',
        content: '你好，我是 ZHIRAI 助理。现在可以回答平台用法、带你去对应页面。完整操作工具会在下一版接入。',
      },
    ];
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
      if (Array.isArray(saved) && saved.length) {
        const cleaned = saved
          .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
          .slice(-30)
          .map((item) => ({ role: item.role, content: item.content.slice(0, 4000) }));
        if (cleaned.length) return cleaned;
      }
    } catch {
      // fall through to the welcome message
    }
    return fallback;
  })();

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-30)));
    } catch {
      // storage can be disabled
    }
  }
  let busy = false;
  let speakTimer = null;
  let lastReplyAt = 0;
  let voiceEnabled = localStorage.getItem(VOICE_KEY) !== '0';
  let recognition = null;
  let listening = false;
  let currentAudio = null;
  let currentAudioUrl = null;
  let voiceMode = false;
  let listeningSource = 'dictation';
  let micMuted = false;
  let voiceBuffer = '';
  let voiceSilenceTimer = null;
  let voiceSent = false;
  let streamTimer = null;
  let bargeMonitor = null;
  let speechSeq = 0;
  let miniOpen = false;
  let miniHideTimer = null;
  let voiceVolume = (() => {
    const raw = localStorage.getItem('zhirai.assistant.volume');
    const stored = raw === null ? NaN : Number(raw);
    return Number.isFinite(stored) ? Math.max(0, Math.min(1, stored)) : 0.5;
  })();
  const voiceRate = 1.25;
  let orbPos = readPosition(ORB_KEY) || {
    x: window.innerWidth - ORB_SIZE - 22,
    y: window.innerHeight - ORB_SIZE - 22,
  };
  let panelPos = readPosition(PANEL_KEY);

  function applyOrbPosition() {
    const maxX = Math.max(8, window.innerWidth - ORB_SIZE - 8);
    const maxY = Math.max(8, window.innerHeight - ORB_SIZE - (voiceMode ? 86 : 8));
    orbPos = { x: clamp(orbPos.x, 8, maxX), y: clamp(orbPos.y, 8, maxY) };
    fab.style.left = `${Math.round(orbPos.x)}px`;
    fab.style.top = `${Math.round(orbPos.y)}px`;
  }

  function placePanel() {
    if (panel.classList.contains('hidden')) return;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    if (panelPos) {
      panelPos = { x: clamp(panelPos.x, 8, maxX), y: clamp(panelPos.y, 8, maxY) };
    } else {
      let x = orbPos.x + ORB_SIZE - rect.width;
      let y = orbPos.y - rect.height - 12;
      if (y < 8) y = orbPos.y + ORB_SIZE + 12;
      panelPos = { x: clamp(x, 8, maxX), y: clamp(y, 8, maxY) };
    }
    panel.style.left = `${Math.round(panelPos.x)}px`;
    panel.style.top = `${Math.round(panelPos.y)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function logStep(text) {
    if (!activityLog) return;
    const row = el('div', 'assistant-activity-line');
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    row.textContent = `${time}  ${String(text || '').slice(0, 220)}`;
    activityLog.appendChild(row);
    while (activityLog.childElementCount > 40) activityLog.removeChild(activityLog.firstElementChild);
    activityLog.scrollTop = activityLog.scrollHeight;
  }

  function renderMessages() {
    clear(messages);
    for (const message of history) {
      const row = el('div', `assistant-msg ${message.role}`);
      row.textContent = message.content;
      messages.appendChild(row);
    }
    scrollBottom();
  }

  function setSpeechVisual(active) {
    fab.classList.toggle('speaking', active);
    voiceView.classList.toggle('speaking', active);
    if (active) startBargeMonitor();
    else stopBargeMonitor();
    updateFabState();
  }

  function updateFabState() {
    const active = Boolean(voiceMode);
    const pageVisible = !panel.classList.contains('hidden') && panel.isConnected;
    const showMini = !pageVisible && miniOpen;
    fab.classList.toggle('voice-active', active);
    fab.classList.toggle('listening', active && listening);
    fab.classList.toggle('speaking', active && isSpeechPlaying());
    fabStatus.classList.toggle('hidden', !active);
    fabActions.classList.add('hidden');
    callbar.classList.toggle('hidden', !showMini);
    let status = '助手待命';
    if (!active) status = '助手待命';
    else if (micMuted) status = '麦克风已静音';
    else if (listening) status = '正在听…';
    else if (isSpeechPlaying()) status = '正在说…';
    else if (busy) status = '思考中…';
    fabStatus.textContent = status;
    const iconName = !active ? 'sparkles' : (listening || micMuted ? 'mic' : isSpeechPlaying() ? 'volume' : 'sparkles');
    if (orbIconName !== iconName) {
      orbIconName = iconName;
      clear(orb);
      orb.appendChild(icon(iconName, 21));
    }
    callStatus.textContent = active ? status : '空闲';
    callMicBtn.textContent = micMuted ? '已静音' : '收音中';
    callMicBtn.classList.toggle('muted', micMuted);
    if (showMini) {
      renderMiniLog();
      placeMini();
    }
    applyOrbPosition();
  }

  function renderMiniLog() {
    clear(callLog);
    const recent = history.slice(-3);
    if (!recent.length) {
      callLog.textContent = '还没有对话';
      return;
    }
    for (const message of recent) {
      const row = el('div', `assistant-mini-line ${message.role}`);
      row.textContent = `${message.role === 'user' ? '我' : '助理'}：${message.content.slice(0, 80)}`;
      callLog.appendChild(row);
    }
  }

  function placeMini() {
    if (callbar.classList.contains('hidden')) return;
    const width = Math.min(300, window.innerWidth - 16);
    callbar.style.width = `${width}px`;
    const rect = callbar.getBoundingClientRect();
    const left = clamp(orbPos.x + ORB_SIZE / 2 - width / 2, 8, Math.max(8, window.innerWidth - width - 8));
    let top = orbPos.y + ORB_SIZE + 28;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, orbPos.y - rect.height - 10);
    callbar.style.left = `${Math.round(left)}px`;
    callbar.style.top = `${Math.round(top)}px`;
    callbar.style.transform = 'none';
  }

  function isSpeechPlaying() {
    return Boolean(
      (currentAudio && !currentAudio.paused)
      || ('speechSynthesis' in window && window.speechSynthesis.speaking),
    );
  }

  function stopBargeMonitor() {
    if (!bargeMonitor) return;
    try {
      clearInterval(bargeMonitor.timer);
      for (const track of bargeMonitor.stream.getTracks()) track.stop();
      bargeMonitor.context.close();
    } catch {
      // already stopped
    }
    bargeMonitor = null;
  }

  async function startBargeMonitor() {
    if (!voiceMode || micMuted || bargeMonitor) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!voiceMode || !isSpeechPlaying()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let hotFrames = 0;
      const timer = setInterval(() => {
        if (!voiceMode || !isSpeechPlaying()) {
          stopBargeMonitor();
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) {
          const value = (data[index] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > 0.085) {
          hotFrames += 1;
          if (hotFrames >= 2) {
            stopBargeMonitor();
            interruptSpeech();
          }
        } else {
          hotFrames = 0;
        }
      }, 90);
      bargeMonitor = { stream, context, timer };
    } catch {
      bargeMonitor = null;
    }
  }

  function setSpeaking(duration = 2200) {
    setSpeechVisual(true);
    if (speakTimer) clearTimeout(speakTimer);
    speakTimer = setTimeout(() => {
      setSpeechVisual(false);
      speakTimer = null;
    }, duration);
  }

  function updateVoiceButton() {
    clear(voiceBtn);
    voiceBtn.appendChild(icon(voiceEnabled ? 'volume' : 'volumeOff', 16));
    voiceBtn.title = voiceEnabled ? '关闭语音播报' : '开启语音播报';
    voiceBtn.setAttribute('aria-label', voiceBtn.title);
    voiceBtn.setAttribute('aria-pressed', voiceEnabled ? 'true' : 'false');
    voiceBtn.classList.toggle('muted', !voiceEnabled);
    voiceState.textContent = voiceEnabled ? '晓晓' : '静音';
  }

  function stopAudio() {
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
      } catch {
        // ignore
      }
      currentAudio = null;
    }
    if (currentAudioUrl) {
      try {
        URL.revokeObjectURL(currentAudioUrl);
      } catch {
        // ignore
      }
      currentAudioUrl = null;
    }
    fab.classList.remove('speaking');
    voiceView.classList.remove('speaking');
    stopBargeMonitor();
    updateFabState();
  }

  function speakWithBrowser(text) {
    if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') {
      voiceState.textContent = '无语音';
      return false;
    }
    try {
      voiceState.textContent = '系统语音';
      const synth = window.speechSynthesis;
      synth.cancel();
      synth.resume?.();
      const utterance = new window.SpeechSynthesisUtterance(String(text));
      utterance.lang = 'zh-CN';
      utterance.rate = voiceRate;
      utterance.pitch = 1;
      utterance.volume = voiceVolume;
      const voices = synth.getVoices ? synth.getVoices() : [];
      const chinese = voices.find((voice) => /^zh[-_]CN/i.test(voice.lang))
        || voices.find((voice) => /^zh/i.test(voice.lang));
      if (chinese) utterance.voice = chinese;
      if (speakTimer) {
        clearTimeout(speakTimer);
        speakTimer = null;
      }
      utterance.onstart = () => {
        setSpeechVisual(true);
        if (voiceMode) voiceStatus.textContent = '正在说…（直接说话即可打断）';
      };
      utterance.onend = () => {
        setSpeechVisual(false);
        maybeResumeVoice();
      };
      utterance.onerror = () => {
        setSpeechVisual(false);
      };
      synth.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  async function speakReply(text) {
    if (!voiceEnabled || !text) return false;
    const seq = ++speechSeq;
    // A neural reply must never overlap a previous browser utterance.
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    stopAudio();
    // Prefer the neural Edge TTS route when the local Python helper is present.
    try {
      let csrf = '';
      for (const part of document.cookie.split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === 'zr_csrf') {
          csrf = decodeURIComponent(part.slice(index + 1).trim());
          break;
        }
      }
      const response = await fetch('/api/v1/assistant/tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ text: String(text).slice(0, 1200), rate: voiceRate }),
      });
      if (!response.ok) throw new Error(`tts ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error('empty audio');
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = voiceVolume;
      currentAudio = audio;
      currentAudioUrl = url;
      audio.onplay = () => {
        setSpeechVisual(true);
        if (voiceMode) voiceStatus.textContent = '正在说…（直接说话即可打断）';
      };
      audio.onended = () => {
        stopAudio();
        maybeResumeVoice();
      };
      audio.onerror = () => {
        stopAudio();
        maybeResumeVoice();
      };
      await audio.play();
      if (seq !== speechSeq) {
        try {
          audio.pause();
        } catch {
          // ignore
        }
        return false;
      }
      voiceState.textContent = '晓晓';
      return true;
    } catch {
      if (seq !== speechSeq) return false;
      stopAudio();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      // On a VPS without Python/edge-tts the server voice is unavailable.
      // Use the browser's built-in voice as an explicit fallback so the
      // assistant still speaks; the label makes it clear this is not Xiaoxiao.
      voiceState.textContent = '系统语音（备用）';
      if (voiceMode) voiceStatus.textContent = '自然语音不可用，使用系统语音';
      return speakWithBrowser(text);
    }
  }

  function setListening(active) {
    listening = Boolean(active);
    mic.classList.toggle('listening', listening);
    fab.classList.toggle('listening', listening);
    mic.title = listening ? '正在听，点击停止' : '点击说话';
    input.placeholder = listening ? '正在听，请说话…' : '输入问题，或使用语音';
    if (voiceMode) {
      voiceStatus.textContent = listening ? '正在听…' : (micMuted ? '麦克风已静音' : '等待下一句…');
    }
    updateFabState();
  }

  function clearVoiceSilenceTimer() {
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
  }

  function sendVoiceBuffer(instance) {
    if (voiceSent) return;
    const text = String(voiceBuffer || input.value || '').trim();
    if (!text) return;
    voiceSent = true;
    clearVoiceSilenceTimer();
    input.value = '';
    voiceBuffer = '';
    voiceTranscript.textContent = text;
    try {
      instance.stop();
    } catch {
      // recognition may already be stopped
    }
    void sendText(text, { fromVoice: listeningSource === 'voice' });
  }

  function createRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return null;
    const instance = new Recognition();
    instance.lang = 'zh-CN';
    instance.continuous = true;
    instance.interimResults = true;
    instance.onstart = () => {
      voiceBuffer = '';
      voiceSent = false;
      setListening(true);
    };
    instance.onend = () => {
      setListening(false);
      clearVoiceSilenceTimer();
      if (!voiceSent && (voiceBuffer.trim() || input.value.trim())) sendVoiceBuffer(instance);
    };
    instance.onerror = (event) => {
      clearVoiceSilenceTimer();
      setListening(false);
      const wasVoiceMode = voiceMode;
      if (voiceMode) exitVoiceMode();
      const reason = event && event.error;
      const messages = {
        'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试。',
        'no-speech': '没有听到声音，请靠近麦克风再说一次。',
        'audio-capture': '没有找到可用麦克风，请检查系统录音设备。',
        network: '语音识别网络不可用，请检查网络，或先输入文字。',
      };
      if (!wasVoiceMode) addMessage('assistant', messages[reason] || '语音识别失败，请稍后重试或先输入文字。');
    };
    instance.onresult = (event) => {
      // A final/late result may arrive after we already submitted the voice
      // buffer; it must not refill the input and create a duplicate send.
      if (voiceSent) return;
      let interim = '';
      let finalText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0] ? result[0].transcript : '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      if (finalText.trim()) voiceBuffer = `${voiceBuffer} ${finalText.trim()}`.trim();
      const display = `${voiceBuffer}${interim ? ` ${interim.trim()}` : ''}`.trim();
      if (display) {
        input.value = display;
        voiceTranscript.textContent = display;
        clearVoiceSilenceTimer();
        // A pause must be long enough for a normal sentence. The old 500 ms
        // value cut Chinese dictation off after roughly 20 characters.
        voiceSilenceTimer = setTimeout(() => sendVoiceBuffer(instance), 1300);
      }
    };
    return instance;
  }

  async function ensureMicrophone() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      addMessage(
        'assistant',
        '浏览器麦克风权限被拒绝。请点地址栏左侧的网站图标 → 麦克风 → 允许；或打开 chrome://settings/content/microphone，把 http://127.0.0.1:4173 设为允许，然后刷新页面。',
      );
      return false;
    }
  }

  function updateVoiceView() {
    body.classList.toggle('voice-mode', voiceMode);
    voiceView.classList.toggle('hidden', !voiceMode);
    voiceMuteBtn.textContent = micMuted ? '取消静音' : '静音麦克风';
    voiceMuteBtn.classList.toggle('muted', micMuted);
    voiceChatBtn.textContent = voiceChat.classList.contains('hidden') ? '打开对话框' : '收起对话框';
    updateFabState();
  }

  function renderVoiceChat() {
    clear(voiceChat);
    for (const message of history) {
      const row = el('div', `assistant-voice-chat-row ${message.role}`);
      row.textContent = `${message.role === 'user' ? '我' : '助理'}：${message.content}`;
      voiceChat.appendChild(row);
    }
    voiceChat.scrollTop = voiceChat.scrollHeight;
  }

  function interruptSpeech() {
    speechSeq += 1;
    const speaking = (currentAudio && !currentAudio.paused)
      || ('speechSynthesis' in window && window.speechSynthesis.speaking);
    if (!speaking) {
      if (voiceMode && !listening && !micMuted) void startListening({ auto: true, source: 'voice' });
      return;
    }
    stopAudio();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeechVisual(false);
    clearVoiceSilenceTimer();
    micMuted = false;
    voiceStatus.textContent = '正在听…';
    updateVoiceView();
    // Wait for the speaker tail to drain before opening the microphone again;
    // otherwise the assistant can recognise its own last words and repeat them.
    if (voiceMode && !listening) {
      setTimeout(() => {
        if (voiceMode && !listening && !micMuted) void startListening({ auto: true, source: 'voice' });
      }, 550);
    }
  }

  function maybeResumeVoice() {
    if (!voiceMode || micMuted || listening || busy) return;
    setTimeout(() => {
      if (voiceMode && !micMuted && !listening && !busy) {
        void startListening({ auto: true, source: 'voice' });
      }
    }, 500);
  }

  async function startListening({ auto = false, source = 'dictation' } = {}) {
    if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
      addMessage('assistant', '当前浏览器不支持语音识别。请使用 Chrome 或 Edge，或者先输入文字。');
      return;
    }
    if (listening || micMuted) return;
    listeningSource = source;
    voiceBuffer = '';
    voiceSent = false;
    clearVoiceSilenceTimer();
    if (!(await ensureMicrophone())) {
      if (voiceMode) exitVoiceMode();
      return;
    }
    recognition = recognition || createRecognition();
    if (!recognition) {
      addMessage('assistant', '语音识别初始化失败，请刷新页面后重试。');
      return;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    stopAudio();
    if (voiceMode) voiceStatus.textContent = '正在听…';
    try {
      recognition.start();
    } catch {
      addMessage('assistant', '语音识别启动失败，请稍后重试。');
    }
  }

  async function toggleMic() {
    if (listening) {
      recognition?.stop();
      setListening(false);
      return;
    }
    await startListening({ source: 'dictation' });
  }

  async function enterVoiceMode() {
    if (voiceMode) {
      if (panel.classList.contains('hidden')) openPanel();
      return;
    }
    if (!voiceMode) {
      if (!voiceEnabled) {
        voiceEnabled = true;
        try {
          localStorage.setItem(VOICE_KEY, '1');
        } catch {
          // storage can be disabled
        }
        updateVoiceButton();
      }
    }
    if (!(await ensureMicrophone())) return;
    voiceMode = true;
    micMuted = false;
    voiceTranscript.textContent = '';
    voiceChat.classList.add('hidden');
    renderVoiceChat();
    updateVoiceView();
    if (panel.classList.contains('hidden')) openPanel();
    await startListening({ auto: true, source: 'voice' });
  }

  function exitVoiceMode() {
    speechSeq += 1;
    miniOpen = false;
    voiceMode = false;
    micMuted = false;
    voiceSent = true;
    voiceBuffer = '';
    clearVoiceSilenceTimer();
    if (listening) recognition?.stop();
    setListening(false);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    stopAudio();
    voiceStatus.textContent = '点击开始语音对话';
    voiceTranscript.textContent = '';
    voiceChat.classList.add('hidden');
    updateVoiceView();
  }

  function addMessage(role, content) {
    history.push({ role, content });
    if (history.length > 20) history.splice(1, history.length - 20);
    saveHistory();
    if (role === 'assistant' && messages.isConnected && content.length > 36) {
      streamAssistantMessage(content);
    } else {
      renderMessages();
    }
    if (role === 'assistant') {
      lastReplyAt = Date.now();
      void speakReply(content).then((spoken) => {
        if (!spoken) {
          setSpeaking();
          setTimeout(maybeResumeVoice, 1200);
        }
      });
    }
    if (!voiceChat.classList.contains('hidden')) renderVoiceChat();
    if (!callbar.classList.contains('hidden')) renderMiniLog();
  }

  function streamAssistantMessage(content) {
    if (streamTimer) clearTimeout(streamTimer);
    const row = el('div', 'assistant-msg assistant streaming');
    messages.appendChild(row);
    scrollBottom();
    let index = 0;
    const step = Math.max(1, Math.ceil(content.length / 70));
    const tick = () => {
      index = Math.min(content.length, index + step);
      row.textContent = content.slice(0, index);
      scrollBottom();
      if (index < content.length) {
        streamTimer = setTimeout(tick, 18);
      } else {
        streamTimer = null;
        row.classList.remove('streaming');
        renderMessages();
      }
    };
    tick();
  }

  function openPanel() {
    miniOpen = false;
    if (!panel.classList.contains('page-mode')) {
      window.location.hash = '#/assistant';
      return;
    }
    panel.classList.remove('hidden');
    fab.classList.add('hidden');
    updateVoiceView();
    renderMessages();
    input.focus();
  }

  function attachPage(container) {
    if (!container) return;
    if (panel.parentNode !== container) container.appendChild(panel);
    panel.classList.add('page-mode');
    panel.classList.remove('hidden', 'expanded');
    fab.classList.add('hidden');
    updateVoiceView();
    renderMessages();
    updateVoiceButton();
  }

  function detachPage() {
    if (!panel.classList.contains('page-mode')) return;
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    if (voiceMode) {
      // Keep the live call running while the chat page collapses to the orb.
      // The orb shows listening/speaking status and its own hang-up/dialog
      // controls, so voice is no longer tied to the page lifecycle.
    } else {
      if (listening) recognition?.stop();
      setListening(false);
    }
    panel.remove();
    panel.classList.remove('page-mode');
    panel.classList.add('hidden');
    fab.classList.remove('hidden');
    applyOrbPosition();
    updateFabState();
  }

  function resetConversation() {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    if (listening) recognition?.stop();
    setListening(false);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    stopAudio();
    exitVoiceMode();
    history.length = 0;
    history.push({
      role: 'assistant',
      content: '已开始新话题。你可以重新描述要做什么，我不会再沿用上一个话题的上下文。',
    });
    saveHistory();
    input.value = '';
    renderMessages();
    if (!voiceChat.classList.contains('hidden')) renderVoiceChat();
  }

  function closePanel() {
    minimizePanel();
  }

  function minimizePanel() {
    if (panel.classList.contains('page-mode')) {
      window.location.hash = '#/dashboard';
      detachPage();
      return;
    }
    panel.classList.add('hidden');
    fab.classList.remove('hidden');
    applyOrbPosition();
    updateFabState();
    // If the user collapses right after a reply, let the orb "speak" the answer.
    const synthSpeaking = 'speechSynthesis' in window && window.speechSynthesis.speaking;
    const audioSpeaking = currentAudio && !currentAudio.paused;
    if (!synthSpeaking && !audioSpeaking && Date.now() - lastReplyAt < 8000) setSpeaking(1800);
  }

  function navigate(path, label) {
    window.location.hash = `#${path}`;
    addMessage('assistant', `已打开「${label}」。`);
    if (window.innerWidth <= 640) closePanel();
  }

  async function tryPlatformQuery(text) {
    const wantsApprovals = /(待审批|发送审批|审批)/.test(text);
    const wantsInbox = /(未读|新回复|未回复|收件箱|统一收件)/.test(text);
    const wantsOverview = /(检查平台|平台状态|整体情况|检查一下|概况)/.test(text);
    if (!wantsApprovals && !wantsInbox && !wantsOverview) return false;
    try {
      const requests = [];
      if (wantsApprovals || wantsOverview) requests.push(api.get('/api/v1/approvals/pending'));
      if (wantsInbox || wantsOverview) requests.push(api.get('/api/v1/inbox/threads?unread=1&pageSize=5'));
      const results = await Promise.all(requests);
      let approvals = null;
      let inbox = null;
      let index = 0;
      if (wantsApprovals || wantsOverview) {
        approvals = results[index++];
      }
      if (wantsInbox || wantsOverview) {
        inbox = results[index++];
      }
      const parts = [];
      if (wantsApprovals || wantsOverview) {
        const count = Number(approvals?.count ?? approvals?.total ?? 0);
        parts.push(`待审批 ${count} 封`);
      }
      if (wantsInbox || wantsOverview) {
        const count = Number(inbox?.total ?? inbox?.unread ?? (inbox?.items || []).length ?? 0);
        const latest = (inbox?.items || [])[0];
        parts.push(`未读回复 ${count} 条${latest ? `，最新来自 ${latest.companyName || latest.contactName || '客户'}` : ''}`);
      }
      addMessage('assistant', `平台当前：${parts.join('；')}。你可以说“打开发送审批”或“打开统一收件”查看。`);
      return true;
    } catch {
      return false;
    }
  }

  async function startDiscoveryFromText(text) {
    const clean = String(text || '').trim();
    const countries = [];
    for (const [label, code] of Object.entries(COUNTRY_CODES)) {
      if (clean.includes(label) && !countries.includes(code)) countries.push(code);
    }
    const europe = /欧洲|全欧洲|欧盟/.test(clean);
    const selectedCountries = europe ? [...EUROPE_CODES] : (countries.length ? countries : [...EUROPE_CODES]);
    const inferredIndustry = /汽配|汽车|autoparts?|automotive/i.test(clean)
      ? 'Automotive Aftermarket'
      : /建材|建筑|building material/i.test(clean)
        ? 'Building Materials'
        : 'General B2B';
    let provider = 'osm';
    try {
      const catalogue = await api.get('/api/v1/discovery/providers');
      const available = (catalogue?.items || []).filter((item) => item.isEnabled && item.implemented !== false);
      provider = available.find((item) => item.key === 'browser')?.key
        || available.find((item) => item.key === 'tavily')?.key
        || available.find((item) => item.key === 'brave')?.key
        || available.find((item) => item.key === 'serper')?.key
        || available.find((item) => item.key === 'osm')?.key
        || 'osm';
    } catch {
      provider = 'osm';
    }
    const keywords = clean
      .replace(/^(?:请|帮我|给我|麻烦)?(?:找|寻找|搜索|发现|查)(?:一下)?(?:客户|潜在客户|企业|公司)?[：:，,\s]*/i, '')
      .replace(/(?:德国|法国|意大利|西班牙|荷兰|波兰|英国|欧洲|全欧洲|欧盟|进口商|分销商|采购商|客户)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'B2B distributor';
    const confirmed = await confirmDialog({
      title: '联网发现真实企业',
      message: `数据源：${PROVIDER_LABELS[provider] || provider}\n国家：${europe ? '全欧洲' : selectedCountries.join(', ')}\n关键词：${keywords}\n最多：20 家\n\n确认后会在后台联网搜索，找到后自动进入「潜在客户」。`,
      confirmText: '开始搜索',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消企业发现。');
      hideActionStatus();
      return true;
    }
    addMessage('assistant', '正在联网搜索真实企业，请稍候…');
    logStep(`准备调用数据源：${PROVIDER_LABELS[provider] || provider}`);
    logStep(`目标国家：${selectedCountries.join(', ')}；关键词：${keywords}`);
    showActionStatus('正在启动企业发现任务…', { busy: true });
    try {
      const created = await api.post('/api/v1/assistant/tools/discovery.start', {
        keywords: keywords.split(/\s+/).filter(Boolean),
        countries: selectedCountries,
        maxResults: 20,
        industry: inferredIndustry,
        provider,
      });
      const runId = created?.run?.id || created?.id;
      if (!runId) throw new Error('发现任务没有返回 ID');
      let run = created?.run || created;
      logStep('发现任务已创建，后台 worker 已接单');
      showActionStatus('已开始联网搜索，正在等待结果…', { busy: true });
      let lastProgressMessage = '';
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        showActionStatus(`正在联网搜索真实企业… 已等待 ${attempt + 1} 秒`, { busy: true });
        try {
          const progressData = await api.get(`/api/v1/discovery/runs/${encodeURIComponent(runId)}/progress`);
          const progress = progressData?.progress;
          if (progress?.message && progress.message !== lastProgressMessage) {
            lastProgressMessage = progress.message;
            logStep(progress.message);
            showActionStatus(progress.message, { busy: progress.stage !== 'completed' });
          }
        } catch {
          // non-fatal; keep polling run status
        }
        const detail = await api.get(`/api/v1/discovery/runs/${encodeURIComponent(runId)}`);
        run = detail?.run || detail || run;
      }
      if (run.status === 'completed') {
        logStep(`发现完成：结果 ${run.resultCount || 0} 条，新建/恢复 ${run.companiesCreated || 0} 家`);
        addMessage('assistant', `联网发现完成：找到 ${run.resultCount || 0} 家真实企业，新建 ${run.companiesCreated || 0} 家。正在打开潜在客户。`);
        showActionStatus(`搜索完成：找到 ${run.resultCount || 0} 家真实企业，新建 ${run.companiesCreated || 0} 家`, { busy: false, autoHide: 15000 });
        setTimeout(() => navigate('/companies', '潜在客户'), 400);
      } else if (run.status === 'failed') {
        addMessage('assistant', `联网发现失败：${run.error || '数据源返回错误'}`);
        showActionStatus(`搜索失败：${run.error || '数据源返回错误'}`, { busy: false, autoHide: 6000 });
      } else {
        addMessage('assistant', '发现任务仍在后台运行，已打开任务队列，你可以稍后查看结果。');
        showActionStatus('搜索任务已提交，仍在后台运行', { busy: true });
        setTimeout(() => navigate('/jobs', '任务队列'), 400);
      }
    } catch (error) {
      addMessage('assistant', `联网发现失败：${error?.message || '接口错误'}`);
      showActionStatus(`搜索失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function approveDraftFromText(text) {
    let pending = [];
    try {
      const data = await api.get('/api/v1/approvals/pending?pageSize=5');
      pending = data?.items || [];
    } catch (error) {
      addMessage('assistant', `查询待审批草稿失败：${error?.message || '接口错误'}`);
      return true;
    }
    if (!pending.length) {
      addMessage('assistant', '当前没有待审批草稿。');
      return true;
    }
    const draft = pending[0];
    const confirmed = await confirmDialog({
      title: '批准开发信草稿',
      message: `主题：${draft.subject || '（无主题）'}\n企业：${draft.companyName || draft.companyId || '—'}\n\n确认批准后，草稿进入“已批准”，但仍不会自动发送。`,
      confirmText: '确认批准',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消批准。');
      return true;
    }
    try {
      showActionStatus('正在批准草稿…', { busy: true });
      await api.post('/api/v1/assistant/tools/draft.approve', { draftId: draft.id });
      addMessage('assistant', `已批准草稿「${draft.subject || draft.id}」。需要发送时再明确告诉我。`);
      showActionStatus(`草稿已批准：${draft.subject || draft.id}`, { busy: false, autoHide: 5000 });
      setTimeout(() => navigate('/approvals', '发送审批'), 400);
    } catch (error) {
      addMessage('assistant', `批准失败：${error?.message || '接口错误'}`);
      showActionStatus(`批准失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function sendDraftFromText(text) {
    let drafts = [];
    try {
      const data = await api.get('/api/v1/drafts?status=approved&pageSize=5');
      drafts = data?.items || [];
    } catch (error) {
      addMessage('assistant', `查询已批准草稿失败：${error?.message || '接口错误'}`);
      return true;
    }
    if (!drafts.length) {
      addMessage('assistant', '当前没有已批准、可进入发送队列的草稿。');
      return true;
    }
    const draft = drafts[0];
    const confirmed = await confirmDialog({
      title: '发送开发信',
      message: `主题：${draft.subject || '（无主题）'}\n企业：${draft.companyName || draft.companyId || '—'}\n\n注意：这会把草稿加入真实发送队列。发送窗口、每日限额、退订/抑制、人工接管和邮箱配置检查仍然生效。\n\n确认发送？`,
      confirmText: '确认发送',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消发送，没有进入队列。');
      return true;
    }
    try {
      showActionStatus('正在把草稿加入发送队列…', { busy: true });
      const result = await api.post('/api/v1/assistant/tools/draft.send', { draftId: draft.id });
      addMessage('assistant', `已把草稿「${draft.subject || draft.id}」加入发送队列（队列：${result?.queued ? '成功' : '未入队'}）。请到任务队列查看发送结果。`);
      showActionStatus(`草稿已加入发送队列：${draft.subject || draft.id}`, { busy: false, autoHide: 6000 });
      setTimeout(() => navigate('/jobs', '任务队列'), 400);
    } catch (error) {
      addMessage('assistant', `发送失败：${error?.message || '接口错误'}`);
      showActionStatus(`加入发送队列失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function createDraftForText(text) {
    const clean = String(text || '').trim();
    const match = clean.match(/(?:给|为)\s*([^，。,\.\n]{2,80}?)\s*(?:写|生成|起草|做)/)
      || clean.match(/(?:公司|企业)[：:]\s*([^，。,\.\n]{2,80})/);
    const companyName = match ? match[1].replace(/(?:公司|企业)$/, '').trim() : '';
    if (!companyName) {
      addMessage('assistant', '请告诉我是给哪家公司生成开发信，例如：“给 Nordvolt GmbH 写一封开发信”。');
      return true;
    }
    let companies = [];
    try {
      const data = await api.get(`/api/v1/companies?q=${encodeURIComponent(companyName)}&pageSize=5`);
      companies = data?.items || [];
    } catch (error) {
      addMessage('assistant', `查询企业失败：${error?.message || '接口错误'}`);
      return true;
    }
    if (!companies.length) {
      addMessage('assistant', `没有找到「${companyName}」。请先在企业发现或潜在客户中确认企业名称。`);
      return true;
    }
    const company = companies[0];
    const confirmed = await confirmDialog({
      title: '生成开发信草稿',
      message: `企业：${company.name}\n将使用该企业第一个带邮箱的联系人，生成一封开发信草稿。\n\n只生成草稿，不会发送；生成后你可以到「邮件草稿」检查或审批。`,
      confirmText: '确认生成',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消生成开发信。');
      return true;
    }
    showActionStatus('正在生成开发信草稿…', { busy: true });
    try {
      const result = await api.post('/api/v1/assistant/tools/draft.generate', {
        companyId: company.id,
        language: 'en',
      });
      const subject = result?.draft?.subject || '（无主题）';
      addMessage('assistant', `已为「${company.name}」生成开发信草稿：${subject}\n已放入邮件草稿，等待你审批，不会自动发送。`);
      showActionStatus(`开发信草稿已生成：${subject}`, { busy: false, autoHide: 6000 });
      setTimeout(() => navigate('/drafts', '邮件草稿'), 500);
    } catch (error) {
      addMessage('assistant', `生成开发信失败：${error?.message || '接口错误'}`);
      showActionStatus(`生成开发信失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function createProductFromText(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 10) {
      addMessage('assistant', '请多描述一点产品，例如名称、类别、MOQ、交期和认证。');
      return true;
    }
    let name = '';
    const named = clean.match(/(?:产品名称|名称)[：:]?[「"'“]?([^，。,\.\n」"”）)]{2,60})/);
    if (named) name = named[1].trim();
    if (!name) {
      const seed = clean
        .replace(/^(?:请|帮我|给我|麻烦)?(?:创建|新建|添加|做一个|生成)(?:一个)?(?:新的)?(?:产品|product)/i, '')
        .replace(/^[：:，,\s]+/, '')
        .trim();
      name = (seed.split(/[，。,.\n；;]/)[0] || '').trim().slice(0, 60)
        || `AI 创建产品 ${new Date().toLocaleDateString('zh-CN')}`;
    }
    const category = (clean.match(/(?:类别|分类|行业)[：:\s]*([^，。,\n；;]{2,60})/) || [])[1] || '';
    const moq = (clean.match(/(?:MOQ|起订量|最小起订量)[：:\s]*([^，。,\n；;]{1,40})/i) || [])[1] || '';
    const leadTime = (clean.match(/(?:交期|交货期|lead time)[：:\s]*([^，。,\n；;]{1,50})/i) || [])[1] || '';
    const certifications = (clean.match(/(?:认证|certifications?)[：:\s]*([^，。,\n；;]{2,100})/i) || [])[1] || '';
    const description = clean.slice(0, 4000);
    const summary = [
      `名称：${name}`,
      `类别：${category || '未指定'}`,
      `MOQ：${moq || '未指定'}`,
      `交期：${leadTime || '未指定'}`,
      `认证：${certifications || '未指定'}`,
      `描述：${description.slice(0, 160)}${description.length > 160 ? '…' : ''}`,
    ].join('\n');
    const confirmed = await confirmDialog({
      title: '创建产品资料',
      message: `${summary}\n\n确认后才会写入平台。`,
      confirmText: '确认创建',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消创建产品，没有写入任何数据。');
      return true;
    }
    showActionStatus('正在创建产品…', { busy: true });
    try {
      const created = await api.post('/api/v1/assistant/tools/product.create', {
        name,
        category,
        description,
        moq,
        leadTime,
        certifications: certifications ? certifications.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) : [],
        keywords: [],
        applications: [],
        status: 'active',
      });
      addMessage('assistant', `已创建产品「${created?.product?.name || name}」。正在打开产品资料页面。`);
      showActionStatus(`产品已创建：${created?.product?.name || name}`, { busy: false, autoHide: 5000 });
      setTimeout(() => navigate('/products', '产品资料'), 400);
    } catch (error) {
      addMessage('assistant', `创建产品失败：${error?.message || '接口错误'}`);
      showActionStatus(`创建产品失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function optimizeText(text) {
    const clean = String(text || '')
      .replace(/^(?:请|帮我|给我|麻烦)?(?:优化|润色|改写|精简)(?:一下|这段|这个|以下)?[：:，,\s]*/i, '')
      .trim();
    if (clean.length < 6) {
      addMessage('assistant', '把要优化的原文发给我，例如：“优化客户画像：德国汽配进口商，20–100 人，采购经理”。');
      return true;
    }
    try {
      showActionStatus('正在优化文案…', { busy: true });
      const result = await api.post('/api/v1/assistant/tools/copy.optimize', { text: clean, kind: '外贸文案/客户画像' });
      addMessage('assistant', `优化结果：\n\n${result?.text || clean}`);
      showActionStatus('文案优化完成', { busy: false, autoHide: 5000 });
    } catch (error) {
      addMessage('assistant', `文案优化失败：${error?.message || '接口错误'}`);
      showActionStatus(`文案优化失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function createIcpFromText(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 10) {
      addMessage('assistant', '请多描述一点客户画像，例如国家、企业类型、规模和采购角色。');
      return true;
    }
    let name = '';
    const named = clean.match(/(?:名为|叫做|名称是|名称为|名称)[：:]?[「"'“]?([^，。,\.\n」"”）)]{2,40})/);
    if (named) name = named[1].trim();
    if (!name) {
      const seed = clean
        .replace(/^(?:请|帮我|给我|麻烦)?(?:创建|新建|添加|建|做|加|生成)(?:一个|个)?(?:新的)?(?:客户画像|ICP|icp)/, '')
        .replace(/^[：:，,\s]+/, '')
        .trim();
      const afterColon = clean.split(/[：:]/)[1]?.trim() || '';
      const source = afterColon || seed;
      name = (source.split(/[，。,.\n；;]/)[0] || '').trim().slice(0, 40)
        || `AI 创建 ICP ${new Date().toLocaleDateString('zh-CN')}`;
    }
    const countries = [];
    for (const [label, code] of Object.entries(COUNTRY_CODES)) {
      if (clean.includes(label) && !countries.includes(code)) countries.push(code);
    }
    const targetCompanyTypes = COMPANY_TYPES.filter(([, pattern]) => pattern.test(clean)).map(([value]) => value);
    const targetRoles = PURCHASING_ROLES.filter(([, pattern]) => pattern.test(clean)).map(([value]) => value);
    const description = clean.slice(0, 4000);
    const summary = [
      `名称：${name}`,
      `国家：${countries.length ? countries.join(', ') : '未指定（全部市场）'}`,
      `企业类型：${targetCompanyTypes.length ? targetCompanyTypes.join(', ') : '未指定'}`,
      `采购角色：${targetRoles.length ? targetRoles.join(', ') : '未指定'}`,
      `描述：${description.slice(0, 160)}${description.length > 160 ? '…' : ''}`,
    ].join('\n');
    const confirmed = await confirmDialog({
      title: '创建客户画像 ICP',
      message: `${summary}\n\n确认后才会写入平台。`,
      confirmText: '确认创建',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消创建 ICP，没有写入任何数据。');
      return true;
    }
    showActionStatus('正在创建客户画像…', { busy: true });
    try {
      const created = await api.post('/api/v1/assistant/tools/icp.create', {
        name,
        description,
        targetCountries: countries,
        targetCompanyTypes,
        targetSizes: [],
        targetRoles,
        includeKeywords: [],
        excludeKeywords: [],
        minScore: 60,
        isActive: true,
      });
      addMessage('assistant', `已创建客户画像「${created?.icp?.name || created?.name || name}」。正在打开客户画像页面。`);
      showActionStatus(`客户画像已创建：${created?.icp?.name || created?.name || name}`, { busy: false, autoHide: 5000 });
      setTimeout(() => navigate('/icps', '客户画像'), 400);
    } catch (error) {
      addMessage('assistant', `创建 ICP 失败：${error?.message || '接口错误'}`);
      showActionStatus(`创建 ICP 失败：${error?.message || '接口错误'}`, { busy: false, autoHide: 6000 });
    }
    return true;
  }

  async function enrichExistingFromText() {
    addMessage('assistant', '正在读取潜在客户，准备补全详细资料…');
    logStep('读取潜在客户列表（分页）');
    let companies = [];
    let total = 0;
    try {
      for (let page = 1; page <= 8; page += 1) {
        const data = await api.get(`/api/v1/companies${queryString({ page, pageSize: 100 })}`);
        const items = data?.items || [];
        total = Number(data?.total || items.length);
        companies.push(...items);
        logStep(`已读取第 ${page} 页，累计 ${companies.length}/${total} 家`);
        if (companies.length >= total || !items.length) break;
      }
    } catch (error) {
      addMessage('assistant', `读取客户列表失败：${error?.message || '接口错误'}`);
      logStep(`读取失败：${error?.message || '接口错误'}`);
      return true;
    }
    const targets = companies.filter((company) => (company.leadStage || company.stage || company.status) === 'potential');
    if (!targets.length) {
      addMessage('assistant', `共读取 ${companies.length} 家企业，但没有找到“潜在客户”，请先确认客户列表。`);
      logStep('未找到潜在客户，任务结束');
      return true;
    }
    logStep(`找到 ${targets.length} 家潜在客户，准备提交补全`);
    addMessage('assistant', `找到 ${targets.length} 家潜在客户，准备补全邮箱、电话、地址和社交资料。`);
    const confirmed = await confirmDialog({
      title: '补全潜在客户资料',
      message: `将处理 ${targets.length} 家潜在客户的官网与联系方式。\n任务会进入后台队列，可在任务队列查看。`,
      confirmText: '开始补全',
      cancelText: '取消',
    });
    if (!confirmed) {
      addMessage('assistant', '已取消补全任务。');
      logStep('用户取消');
      return true;
    }
    let submitted = 0;
    const batchSize = 25;
    for (let index = 0; index < targets.length; index += batchSize) {
      const batch = targets.slice(index, index + batchSize);
      logStep(`提交第 ${Math.floor(index / batchSize) + 1} 批：${batch.length} 家`);
      try {
        await api.post('/api/v1/companies/bulk', { action: 'enrich', ids: batch.map((item) => item.id) });
        submitted += batch.length;
        logStep(`第 ${Math.floor(index / batchSize) + 1} 批已入队，累计 ${submitted} 家`);
        addMessage('assistant', `已提交 ${submitted}/${targets.length} 家补全任务，正在后台执行。`);
      } catch (error) {
        logStep(`第 ${Math.floor(index / batchSize) + 1} 批提交失败：${error?.message || '接口错误'}`);
        addMessage('assistant', `提交补全失败：${error?.message || '接口错误'}`);
      }
    }
    showActionStatus(`补全任务已提交：${submitted} 家`, { busy: false, autoHide: 12000 });
    addMessage('assistant', `补全任务已提交 ${submitted} 家。后台会依次读取官网、识别邮箱/电话/地址，可在「任务队列」查看进度。`);
    logStep('补全任务提交完成，等待 worker 执行');
    let lastDone = -1;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const jobsData = await api.get(`/api/v1/jobs${queryString({ pageSize: 100 })}`);
        const jobs = (jobsData?.items || []).filter((job) => job.type === 'company.enrich');
        const done = jobs.filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status)).length;
        if (done !== lastDone) {
          lastDone = done;
          logStep(`补全队列进度：${done}/${jobs.length || submitted} 已结束`);
          showActionStatus(`补全进度：${done}/${jobs.length || submitted}`, { busy: done < (jobs.length || submitted) });
        }
        if (done >= submitted) break;
      } catch {
        break;
      }
    }
    return true;
  }

  let activeAgentTaskId = null;
  let agentPollTimer = null;
  let lastAgentEventStep = 0;
  let lastAgentStatus = '';
  let restoringAgentTask = false;

  function stopAgentPolling() {
    if (agentPollTimer) {
      clearTimeout(agentPollTimer);
      agentPollTimer = null;
    }
  }

  function shortValue(value, limit = 360) {
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(value ?? {}); } catch { text = '[无法显示]'; }
    return String(text || '').replace(/\s+/g, ' ').slice(0, limit);
  }

  function renderAgentEvent(event) {
    const type = event.type;
    const output = event.output || {};
    if (type === 'model_decision') {
      const action = output.action || '未知';
      const target = output.tool ? ` → ${output.tool}` : '';
      logStep(`模型决策：${action}${target}${output.reason ? `；${shortValue(output.reason, 120)}` : ''}`);
      return;
    }
    if (type === 'tool_call') {
      logStep(`调用工具：${event.toolName}；参数 ${shortValue(event.input, 180)}`);
      return;
    }
    if (type === 'tool_result') {
      const label = event.status === 'error' ? '工具失败' : '工具结果';
      logStep(`${label}：${event.toolName}；${shortValue(output, 260)}`);
      return;
    }
    if (type === 'error') {
      logStep(`执行错误：${event.error || shortValue(output, 220)}`);
      return;
    }
    if (type === 'final_answer') {
      logStep(`任务完成：${shortValue(output.answer, 420)}`);
    }
  }

  function finishAgentTask(task) {
    stopAgentPolling();
    const terminal = ['completed', 'failed', 'cancelled'];
    if (!terminal.includes(task.status)) return;
    lastAgentStatus = task.status;
    if (task.status === 'completed') {
      const answer = task.result?.answer || 'Agent 任务完成。';
      const alreadyShown = history.some((message) => message.role === 'assistant' && String(message.content || '').trim() === String(answer).trim());
      if (!alreadyShown && !restoringAgentTask) addMessage('assistant', answer);
    } else if (task.status === 'failed') {
      if (!restoringAgentTask) addMessage('assistant', `Agent 任务失败：${task.error || '详见执行过程'}`);
    } else {
      if (!restoringAgentTask) addMessage('assistant', 'Agent 任务已取消。');
    }
    showActionStatus(`Agent 任务${task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : '已取消'}`, { busy: false, autoHide: 5000 });
    busy = false;
    send.disabled = false;
    input.focus();
  }

  async function pollAgentTask(taskId) {
    if (!taskId) return;
    try {
      const data = await api.get(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}/events?after=${lastAgentEventStep}&limit=100`);
      const events = data?.items || [];
      for (const event of events) {
        renderAgentEvent(event);
        lastAgentEventStep = Math.max(lastAgentEventStep, Number(event.stepNo || 0));
      }
      if (data?.task) {
        if (['completed', 'failed', 'cancelled'].includes(data.task.status)) {
          finishAgentTask(data.task);
          return;
        }
        showActionStatus(`Agent 正在执行：${data.task.status}`, { busy: true });
      }
      agentPollTimer = setTimeout(() => pollAgentTask(taskId), 1000);
    } catch (error) {
      logStep(`Agent 状态读取失败：${error?.message || '请求失败'}`);
      agentPollTimer = setTimeout(() => pollAgentTask(taskId), 3000);
    }
  }

  async function startAgentTask(text) {
    const goal = String(text || '').trim();
    if (!goal) return false;
    addMessage('user', goal);
    input.value = '';
    busy = true;
    send.disabled = true;
    lastAgentEventStep = 0;
    lastAgentStatus = '';
    try {
      const data = await api.post('/api/v1/agent/tasks', { goal });
      const task = data?.task;
      if (!task?.id) throw new Error('任务没有返回 ID');
      activeAgentTaskId = task.id;
      localStorage.setItem('zhirai.agentTaskId', task.id);
      clear(activityLog);
      logStep(`Agent 任务已创建：${task.id}`);
      addMessage('assistant', 'Agent 任务已创建，正在按真实工具结果逐步执行。');
      showActionStatus('Agent 任务已入队，等待 worker…', { busy: true });
      agentPollTimer = setTimeout(() => pollAgentTask(task.id), 500);
      return true;
    } catch (error) {
      busy = false;
      send.disabled = false;
      const message = error?.message || 'Agent 任务创建失败';
      addMessage('assistant', `Agent 任务创建失败：${message}`);
      showActionStatus('Agent 任务创建失败', { busy: false, autoHide: 5000 });
      return false;
    }
  }

  async function restoreAgentTask() {
    const taskId = localStorage.getItem('zhirai.agentTaskId');
    if (!taskId) return;
    activeAgentTaskId = taskId;
    lastAgentEventStep = 0;
    restoringAgentTask = true;
    try {
      await pollAgentTask(taskId);
    } catch {
      // A stale task id must not block normal chat.
      localStorage.removeItem('zhirai.agentTaskId');
      activeAgentTaskId = null;
    } finally {
      restoringAgentTask = false;
    }
  }

  async function sendText(raw, { fromVoice = false } = {}) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    if (agentMode) {
      await startAgentTask(text);
      return;
    }
    if (/(批准|通过|审核通过|同意|放行)/.test(text) && /(草稿|审批|开发信)/.test(text) && !/(怎么|如何|教程|步骤)/.test(text)) {
      await approveDraftFromText(text);
      return;
    }
    if (/(发送|发出|发出去|投递)/.test(text) && /(草稿|邮件|开发信)/.test(text) && !/(怎么|如何|教程|步骤|生成)/.test(text)) {
      await sendDraftFromText(text);
      return;
    }
    if (/(生成|写|起草|做|来).{0,8}(开发信|邮件|草稿)/.test(text) && !/(怎么|如何|教程|步骤)/.test(text)) {
      await createDraftForText(text);
      return;
    }
    if (/(创建|新建|添加|建|做|加|生成).{0,8}(产品|product)/i.test(text) && !/(ICP|客户画像)/.test(text) && !/(怎么|如何|教程|步骤)/.test(text)) {
      await createProductFromText(text);
      return;
    }
    if (/(创建|新建|添加|建|做|加|生成).{0,8}(ICP|客户画像|画像)/i.test(text) && !/(怎么|如何|教程|步骤)/.test(text)) {
      await createIcpFromText(text);
      return;
    }
    if (/(优化|润色|改写|精简)/.test(text) && !/(怎么|如何|教程|步骤)/.test(text)) {
      await optimizeText(text);
      return;
    }
    if (/(新话题|换个话题|重新开始|清空对话|从头开始)/.test(text)) {
      resetConversation();
      return;
    }
    if (fromVoice) voiceStatus.textContent = '正在思考…';
    addMessage('user', text);
    input.value = '';

    if (/(完善|补全|细化|详细资料|联系方式|资料整理)/.test(text)
      && /(客户|企业|潜在|资料)/.test(text)
      && !/(怎么|如何|教程|步骤)/.test(text)) {
      await enrichExistingFromText();
      return;
    }

    const wantsDiscovery = /(找|寻找|搜索|发现|查|开发).{0,8}(客户|潜在客户|企业|公司)/.test(text) && !/(怎么|如何|教程|步骤)/.test(text);
    if (wantsDiscovery && !PAGE_COMMAND.test(text)) {
      await startDiscoveryFromText(text);
      return;
    }

    const page = detectPage(text);
    if (page) {
      setTimeout(() => navigate(page.path, page.label), 120);
      return;
    }
    if (PAGE_COMMAND.test(text)) {
      addMessage('assistant', '我没听清要打开哪个页面。你是要打开：产品资料、潜在客户、客户画像、邮件草稿，还是联系人库？可以直接说“打开产品资料”。');
      return;
    }
    if (await tryPlatformQuery(text)) return;

    busy = true;
    send.disabled = true;
    const typing = el('div', 'assistant-msg assistant assistant-typing', '正在思考…');
    messages.appendChild(typing);
    scrollBottom();
    try {
      const data = await api.post('/api/v1/assistant/chat', {
        messages: history
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-10)
          .map((message) => ({ role: message.role, content: message.content })),
      });
      typing.remove();
      addMessage('assistant', data?.reply || '助理没有返回内容。');
    } catch (error) {
      typing.remove();
      addMessage('assistant', error?.message || '助理暂不可用，请稍后重试。');
    } finally {
      busy = false;
      send.disabled = false;
      input.focus();
    }
  }

  // ---------------------------------------------------------- orb dragging
  let orbDrag = null;
  let suppressOrbClick = false;
  fab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    orbDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: orbPos.x,
      originY: orbPos.y,
      moved: false,
    };
    fab.setPointerCapture?.(event.pointerId);
  });
  fab.addEventListener('pointermove', (event) => {
    if (!orbDrag || orbDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - orbDrag.startX;
    const dy = event.clientY - orbDrag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) orbDrag.moved = true;
    if (!orbDrag.moved) return;
    orbPos = { x: orbDrag.originX + dx, y: orbDrag.originY + dy };
    applyOrbPosition();
  });
  fab.addEventListener('pointerup', (event) => {
    if (!orbDrag || orbDrag.pointerId !== event.pointerId) return;
    const moved = orbDrag.moved;
    orbDrag = null;
    suppressOrbClick = moved;
    if (moved) savePosition(ORB_KEY, orbPos);
    else if (!voiceMode) openPanel();
  });
  fab.addEventListener('pointercancel', () => {
    orbDrag = null;
    suppressOrbClick = false;
  });
  fab.addEventListener('click', (event) => {
    event.preventDefault();
    if (suppressOrbClick) {
      suppressOrbClick = false;
      return;
    }
    if (voiceMode) {
      if (isSpeechPlaying()) {
        interruptSpeech();
      } else if (listening) {
        recognition?.stop();
        setListening(false);
        fabStatus.textContent = '已暂停';
      } else if (!micMuted) {
        void startListening({ auto: true, source: 'voice' });
      }
      return;
    }
    miniOpen = !miniOpen;
    updateFabState();
    if (miniOpen) {
      setTimeout(() => callInput.focus(), 30);
    }
  });
  fab.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fab.click();
    }
  });
  function scheduleMiniHide() {
    if (miniHideTimer) clearTimeout(miniHideTimer);
    miniHideTimer = setTimeout(() => {
      if (!callbar.matches(':hover')) {
        miniOpen = false;
        updateFabState();
      }
    }, 220);
  }
  fab.addEventListener('pointerenter', () => {
    if (!voiceMode) return;
    if (miniHideTimer) clearTimeout(miniHideTimer);
    if (panel.classList.contains('hidden') || !panel.isConnected) {
      miniOpen = true;
      updateFabState();
    }
  });
  fab.addEventListener('pointerleave', scheduleMiniHide);
  callbar.addEventListener('pointerenter', () => {
    if (miniHideTimer) clearTimeout(miniHideTimer);
  });
  callbar.addEventListener('pointerleave', scheduleMiniHide);

  const submitMiniInput = () => {
    const text = callInput.value.trim();
    if (!text) return;
    callInput.value = '';
    void sendText(text, { fromVoice: false });
  };
  callSendBtn.addEventListener('click', submitMiniInput);
  callInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitMiniInput();
    }
  });

  for (const button of [fabHangup, fabDialog]) {
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => event.stopPropagation());
  }
  fabHangup.addEventListener('click', () => {
    exitVoiceMode();
    updateFabState();
  });
  fabDialog.addEventListener('click', () => {
    openPanel();
  });

  // --------------------------------------------------------- panel dragging
  let panelDrag = null;
  head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.assistant-close, .assistant-voice')) return;
    const rect = panel.getBoundingClientRect();
    panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
    };
    head.setPointerCapture?.(event.pointerId);
  });
  head.addEventListener('pointermove', (event) => {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
    const rect = panel.getBoundingClientRect();
    panelPos = {
      x: panelDrag.originX + (event.clientX - panelDrag.startX),
      y: panelDrag.originY + (event.clientY - panelDrag.startY),
    };
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    panelPos = { x: clamp(panelPos.x, 8, maxX), y: clamp(panelPos.y, 8, maxY) };
    panel.style.left = `${Math.round(panelPos.x)}px`;
    panel.style.top = `${Math.round(panelPos.y)}px`;
  });
  head.addEventListener('pointerup', (event) => {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
    panelDrag = null;
    if (panelPos) savePosition(PANEL_KEY, panelPos);
  });
  head.addEventListener('pointercancel', () => {
    panelDrag = null;
  });

  for (const item of QUICK) {
    const chip = el('button', 'assistant-chip', item.label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      if (item.reset) resetConversation();
      else if (item.query) void sendText(item.query);
      else navigate(item.path, item.label);
    });
    quick.appendChild(chip);
  }

  close.addEventListener('click', closePanel);
  mic.addEventListener('click', () => {
    void toggleMic();
  });
  voiceTest.addEventListener('click', () => {
    if (!voiceEnabled) {
      voiceEnabled = true;
      try {
        localStorage.setItem(VOICE_KEY, '1');
      } catch {
        // storage can be disabled
      }
      updateVoiceButton();
    }
    const spoken = speakReply('你好，我是智睿助理。如果你听到这句话，说明语音播放正常。');
    Promise.resolve(spoken).then((ok) => {
      if (!ok) {
        addMessage('assistant', '当前浏览器没有可用的系统语音。请检查 Windows 是否安装中文语音，或换用 Chrome/Edge。');
      }
    });
  });
  newTopicBtn.addEventListener('click', () => {
    resetConversation();
    input.focus();
  });
  voiceModeBtn.addEventListener('click', () => {
    void enterVoiceMode();
  });
  voiceInterruptBtn.addEventListener('click', interruptSpeech);
  stopSpeechBtn.addEventListener('click', interruptSpeech);
  liveOrb.addEventListener('click', interruptSpeech);
  liveOrb.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    interruptSpeech();
  });
  voiceMuteBtn.addEventListener('click', () => {
    micMuted = !micMuted;
    if (micMuted) {
      voiceSent = true;
      clearVoiceSilenceTimer();
      stopBargeMonitor();
      if (listening) recognition?.stop();
      setListening(false);
      voiceStatus.textContent = '麦克风已静音';
    } else if (!busy && !listening) {
      voiceStatus.textContent = '正在听…';
      void startListening({ auto: true, source: 'voice' });
    }
    updateVoiceView();
  });
  callMicBtn.addEventListener('click', () => {
    if (!voiceMode) return;
    if (micMuted) {
      micMuted = false;
      voiceStatus.textContent = '正在听…';
      updateVoiceView();
      if (!listening && !busy) void startListening({ auto: true, source: 'voice' });
    } else {
      micMuted = true;
      voiceSent = true;
      clearVoiceSilenceTimer();
      stopBargeMonitor();
      if (listening) recognition?.stop();
      setListening(false);
      voiceStatus.textContent = '麦克风已静音';
      updateVoiceView();
    }
    updateFabState();
  });
  callHangupBtn.addEventListener('click', () => {
    exitVoiceMode();
    updateFabState();
  });
  callDialogBtn.addEventListener('click', () => openPanel());
  voiceEndBtn.addEventListener('click', () => {
    exitVoiceMode();
    input.focus();
  });
  voiceChatBtn.addEventListener('click', () => {
    const show = voiceChat.classList.contains('hidden');
    voiceChat.classList.toggle('hidden', !show);
    if (show) renderVoiceChat();
    updateVoiceView();
  });
  voiceBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    try {
      localStorage.setItem(VOICE_KEY, voiceEnabled ? '1' : '0');
    } catch {
      // storage can be disabled
    }
    updateVoiceButton();
    if (!voiceEnabled) {
      speechSeq += 1;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      stopAudio();
    } else {
      addMessage('assistant', '语音播报已开启，我会用晓晓自然语音朗读回复。');
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendText(input.value);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.classList.contains('hidden')) closePanel();
  });
  window.addEventListener('resize', () => {
    applyOrbPosition();
    if (!panel.classList.contains('hidden')) placePanel();
  });

  applyOrbPosition();
  updateVoiceButton();
  updateVoiceView();
  updateFabState();
  renderMessages();
  void restoreAgentTask();
  const controls = {
    open: openPanel,
    close: closePanel,
    toggle: () => (panel.classList.contains('hidden') ? openPanel() : closePanel()),
    speak: setSpeaking,
    attachPage,
    detachPage,
  };
  window.__zhiraiAssistant = controls;
  return controls;
}
