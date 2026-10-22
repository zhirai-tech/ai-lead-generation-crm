/**
 * Authentication screens: first-run setup, login, and the public unsubscribe
 * confirmation page. No session data is trusted before the server confirms it.
 */
import { append, el, clear } from '../utils/dom.mjs';
import { api } from './api.mjs';
import { setSession } from './state.mjs';
import { button, field, helpTip, icon, input, notice, toast } from '../components/ui.mjs';

const BRAND_FOOTER = 'Powered by 智睿 · Build Ideas Into Reality · © 2026 智睿科技 保留所有权利。';

function brandSide({ title = '把欧洲买家变成你的客户', description = '' } = {}) {
  const side = el('aside', 'auth-side');
  const brand = el('div', 'auth-brand');
  const logo = el('img', '');
  logo.src = '/assets/brand/app-icons/icon-512.png';
  logo.alt = 'ZHIRAI';
  const text = el('span', '');
  append(text, [el('div', 'name', 'ZHIRAI'), el('div', 'sub', '欧洲 B2B AI 外贸获客平台')]);
  append(brand, [logo, text]);

  const hero = el('div', 'auth-hero');
  const heading = el('h2', '', '');
  const highlight = el('em', '', 'AI');
  heading.append('让 ', highlight, ' 帮你找到对的欧洲买家');
  append(hero, [heading, el('p', '', description || '企业发现、可解释的客户评估、个性化开发信、统一收件箱与销售管道 —— 在一个自托管工作台里完成。')]);

  const points = el('div', 'auth-points');
  const items = [
    ['多源企业发现', '公开网站 / CSV / 可配置数据源'],
    ['可解释评分', '事实、推断与未知信息分开记录'],
    ['审批后发送', '默认人工审批，限额与时间窗'],
    ['接管即停', '人工接管后自动任务立即停止'],
  ];
  for (const [title, textValue] of items) {
    const point = el('div', 'auth-point');
    append(point, [el('b', '', title), el('span', '', textValue)]);
    points.appendChild(point);
  }
  append(hero, [points]);

  const footer = el('div', 'auth-side-footer', BRAND_FOOTER);
  append(side, [brand, hero, footer]);
  return side;
}

function authLayout(panel) {
  const screen = el('div', 'auth-screen');
  const side = brandSide();
  const panelWrap = el('div', 'auth-panel');
  panelWrap.appendChild(panel);
  append(screen, [side, panelWrap]);
  return screen;
}

function authFooter() {
  return el('div', 'auth-footer', [el('span', '', 'ZHIRAI · 智睿科技 · 独立开发者'), el('span', '', 'v1.0.0')]);
}

function passwordField(label, { autocomplete = 'new-password', help = null } = {}) {
  const inputNode = input({ type: 'password', autocomplete });
  return { wrap: field(label, inputNode, { required: true, help }), input: inputNode };
}

export function renderSetup(container, { onDone } = {}) {
  clear(container);
  const card = el('div', 'auth-card');
  const form = el('form', 'auth-form');
  const workspaceInput = input({ placeholder: '例如：智睿欧洲事业部' });
  const nameInput = input({ placeholder: '你的称呼' });
  const emailInput = input({ type: 'email', placeholder: 'you@company.com', autocomplete: 'email' });
  const password = passwordField('登录密码', { help: '至少 10 位，必须同时包含字母和数字。密码只保存加密哈希。' });
  const confirm = passwordField('确认密码');
  const errorBox = el('div', 'auth-error hidden');
  const submit = button('创建并进入工作台', { variant: 'primary', size: 'lg', block: true, type: 'submit' });

  append(form, [
    field('工作空间名称', workspaceInput, { required: true, help: '工作空间用于隔离企业、联系人、邮件与凭据。以后可创建更多成员。' }),
    field('你的姓名', nameInput, { required: true }),
    field('登录邮箱', emailInput, { required: true }),
    password.wrap,
    confirm.wrap,
    errorBox,
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    if (password.input.value !== confirm.input.value) {
      errorBox.textContent = '两次输入的密码不一致';
      errorBox.classList.remove('hidden');
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在创建…';
    try {
      const data = await api.post('/api/v1/auth/setup', {
        workspaceName: workspaceInput.value.trim(),
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        password: password.input.value,
      });
      setSession(data);
      onDone?.(data);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
      submit.disabled = false;
      submit.textContent = '创建并进入工作台';
    }
  });

  const heading = el('h1', '', '初始化你的工作台');
  const lead = el('p', 'lead', '这是首次启动。创建管理员账号后即可开始导入产品与寻找客户。');
  append(card, [heading, lead, form, authFooter()]);
  container.appendChild(authLayout(card));
}

export function renderLogin(container, { onDone } = {}) {
  clear(container);
  const card = el('div', 'auth-card');
  const form = el('form', 'auth-form');
  const emailInput = input({ type: 'email', placeholder: 'you@company.com', autocomplete: 'username' });
  const passwordInput = input({ type: 'password', autocomplete: 'current-password', placeholder: '请输入密码' });
  const errorBox = el('div', 'auth-error hidden');
  const submit = button('登录工作台', { variant: 'primary', size: 'lg', block: true, type: 'submit' });

  append(form, [
    field('邮箱', emailInput, { required: true }),
    field('密码', passwordInput, { required: true }),
    errorBox,
    submit,
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = '正在登录…';
    try {
      const data = await api.post('/api/v1/auth/login', { email: emailInput.value.trim(), password: passwordInput.value });
      setSession(data);
      onDone?.(data);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
      submit.disabled = false;
      submit.textContent = '登录工作台';
    }
  });

  append(card, [
    el('h1', '', '欢迎回来'),
    el('p', 'lead', '登录后继续管理你的欧洲 B2B 获客工作。'),
    form,
    authFooter(),
  ]);
  container.appendChild(authLayout(card));
}

export async function renderUnsubscribe(container, token) {
  clear(container);
  const screen = el('div', 'public-screen');
  const card = el('div', 'unsub-card');
  const logo = el('img', 'brand-mark');
  logo.src = '/assets/brand/app-icons/icon-512.png';
  logo.alt = 'ZHIRAI';
  const title = el('h1', '', '退订邮件');
  const description = el('p', '', '正在读取退订信息…');
  const actionSlot = el('div', '');
  const footer = el('div', 'unsub-foot', BRAND_FOOTER);
  append(card, [logo, title, description, actionSlot, footer]);
  screen.appendChild(card);
  container.appendChild(screen);

  try {
    const preview = await api.get(`/api/v1/public/unsubscribe/${encodeURIComponent(token)}`);
    description.textContent = preview.alreadyUnsubscribed
      ? `该邮箱（${preview.email}）已经退订，不会再收到 ${preview.workspaceName} 的开发信。`
      : `确认将 ${preview.email} 从 ${preview.workspaceName} 的联系人名单中移除，之后不会再收到任何开发信。`;
    if (!preview.alreadyUnsubscribed) {
      const submit = button('确认退订', {
        variant: 'primary',
        size: 'lg',
        onClick: async () => {
          submit.disabled = true;
          submit.textContent = '正在处理…';
          try {
            await api.post(`/api/v1/public/unsubscribe/${encodeURIComponent(token)}`);
            description.textContent = '已完成退订。我们不会再向你发送开发信。';
            clear(actionSlot);
          } catch (error) {
            toast(error.message, 'error');
            submit.disabled = false;
            submit.textContent = '确认退订';
          }
        },
      });
      actionSlot.appendChild(submit);
    }
  } catch (error) {
    description.textContent = error.message;
    actionSlot.appendChild(notice('如果链接已失效，请直接回复任意一封开发信说明退订意愿。', 'warn'));
  }
}

export function renderPasswordChange(container, { onDone } = {}) {
  clear(container);
  const card = el('div', 'auth-card');
  const form = el('form', 'auth-form');
  const current = passwordField('当前密码', { autocomplete: 'current-password' });
  const next = passwordField('新密码', { help: '至少 10 位，必须同时包含字母和数字。修改后所有会话将失效。' });
  const confirm = passwordField('确认新密码');
  const errorBox = el('div', 'auth-error hidden');
  const submit = button('保存并重新登录', { variant: 'primary', size: 'lg', block: true, type: 'submit' });
  append(form, [current.wrap, next.wrap, confirm.wrap, errorBox, submit]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (next.input.value !== confirm.input.value) {
      errorBox.textContent = '两次输入的新密码不一致';
      errorBox.classList.remove('hidden');
      return;
    }
    submit.disabled = true;
    try {
      await api.post('/api/v1/auth/password', { currentPassword: current.input.value, newPassword: next.input.value });
      onDone?.();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
      submit.disabled = false;
    }
  });
  append(card, [el('h1', '', '修改密码'), el('p', 'lead', '为了账号安全，请设置新的登录密码。'), form, authFooter()]);
  container.appendChild(authLayout(card));
}

export { BRAND_FOOTER };
