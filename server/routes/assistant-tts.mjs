/** OWNER: lead. Neural speech route (optional local Python edge-tts). */
import * as tts from '../services/tts.mjs';

const SPEAK = {
  auth: 'required',
  capability: 'data.read',
  rateLimit: { windowMs: 60_000, max: 20 },
  maxBodyBytes: 20_000,
};

export function mount(router) {
  router.post(
    '/api/v1/assistant/tts',
    async (ctx) => {
      const { buffer } = await tts.synthesize(ctx.body?.text, { rate: ctx.body?.rate });
      ctx.header('Content-Type', 'audio/mpeg');
      ctx.header('Content-Length', String(buffer.length));
      ctx.header('Cache-Control', 'no-store');
      ctx.res.writeHead(200, ctx._headers);
      ctx.res.end(buffer);
      return undefined;
    },
    SPEAK,
  );
}

export default { mount };
