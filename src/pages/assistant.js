/**
 * Dedicated AI assistant page (v0.4).
 *
 * Only two states exist now:
 *   1. collapsed: one floating orb on normal pages;
 *   2. dedicated page: the same conversation UI attached directly to this page.
 *
 * Clicking the orb navigates here. Any action that opens another platform page
 * (e.g. "打开全局总览") destroys this page and leaves only the orb again.
 */
export const meta = {
  title: 'AI 助理',
  help: '专属对话页面。对话历史、长期记忆、语音输入和语音通话都在这里；点击悬浮球进入，打开其他页面时自动收起为球。',
};

export function render(root) {
  const host = root || document.querySelector('.view');
  if (!host) return;
  host.classList.add('assistant-page-host');
  const attach = () => {
    if (window.__zhiraiAssistant?.attachPage) {
      window.__zhiraiAssistant.attachPage(host);
    } else {
      setTimeout(attach, 80);
    }
  };
  attach();
}

export function destroy() {
  document.querySelector('.assistant-page-host')?.classList.remove('assistant-page-host');
  window.__zhiraiAssistant?.detachPage?.();
}

export default { meta, render, destroy };
