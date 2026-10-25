/**
 * OWNER: lead. Neural speech synthesis for the local assistant.
 *
 * Uses the optional `edge-tts` Python package (Microsoft Edge natural voices).
 * It is intentionally optional: on hosts without Python/edge-tts the route
 * returns 503 and the browser falls back to speechSynthesis.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, validationError } from '../core/errors.mjs';
import { id } from '../core/ids.mjs';

const MAX_TEXT = 1200;
const TIMEOUT_MS = 20_000;
const PYTHON_BIN = process.env.ZHIRAI_TTS_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const VOICE = process.env.ZHIRAI_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new AppError('TTS_TIMEOUT', '语音合成超时', { status: 504 }));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `edge-tts exited with ${code}`));
    });
  });
}

export async function synthesize(text, { rate = 1.25 } = {}) {
  const content = String(text || '').trim();
  if (!content) throw validationError('语音文本不能为空');
  if (content.length > MAX_TEXT) throw validationError(`语音文本不能超过 ${MAX_TEXT} 字`);
  const numericRate = Number(rate);
  const safeRate = Number.isFinite(numericRate) ? Math.max(0.5, Math.min(2, numericRate)) : 1.25;
  const rateArg = `${safeRate >= 1 ? '+' : ''}${Math.round((safeRate - 1) * 100)}%`;
  const file = path.join(os.tmpdir(), `zhirai-tts-${id('tts')}.mp3`);
  try {
    await run(PYTHON_BIN, ['-m', 'edge_tts', '--voice', VOICE, '--rate', rateArg, '--text', content, '--write-media', file], TIMEOUT_MS);
    const buffer = fs.readFileSync(file);
    if (!buffer.length) throw new Error('empty audio');
    return { buffer, voice: VOICE };
  } catch (error) {
    throw new AppError('TTS_UNAVAILABLE', '自然语音暂不可用，已切换系统语音', {
      status: 503,
      details: { reason: String(error?.message || 'edge-tts failed').slice(0, 200) },
    });
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // temp file may not exist
    }
  }
}

export default { synthesize };
