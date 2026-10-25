/** OWNER: lead. Floating assistant chat + memory routes. */
import * as assistant from '../services/assistant.mjs';

const CHAT = {
  auth: 'required',
  capability: 'data.read',
  rateLimit: { windowMs: 60_000, max: 20 },
};
const READ = { auth: 'required', capability: 'data.read' };
const WRITE = {
  auth: 'required',
  capability: 'data.write',
  rateLimit: { windowMs: 60_000, max: 30 },
};

export function mount(router) {
  router.post(
    '/api/v1/assistant/chat',
    async (ctx) => assistant.chat(ctx.workspace.id, ctx.body || {}, { userId: ctx.user?.id || null }),
    CHAT,
  );

  router.get(
    '/api/v1/assistant/memories',
    async (ctx) => ({ items: assistant.listMemories(ctx.workspace.id, ctx.user?.id || null) }),
    READ,
  );

  router.post(
    '/api/v1/assistant/memories',
    async (ctx) =>
      assistant.remember(ctx.workspace.id, ctx.user?.id || null, ctx.body?.content, {
        kind: ctx.body?.kind,
        source: 'ui',
      }),
    WRITE,
  );

  router.delete(
    '/api/v1/assistant/memories/:id',
    async (ctx) => assistant.deleteMemory(ctx.workspace.id, ctx.user?.id || null, ctx.params.id),
    WRITE,
  );
}

export default { mount };
