/**
 * Structured logger. Writes human-readable lines to stdout and optionally a
 * rolling application log. Sensitive keys are redacted before output.
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[deep]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, code: value.code, stack: value.stack };
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 400) return `${value.slice(0, 400)}…`;
  return value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger({ level = 'info', file = null, name = 'app' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch {
      stream = null;
    }
  }

  function emit(levelName, message, meta) {
    if ((LEVELS[levelName] ?? 20) < threshold) return;
    const entry = {
      t: new Date().toISOString(),
      level: levelName,
      name,
      msg: typeof message === 'string' ? message : safeStringify(message),
    };
    if (meta !== undefined) {
      const redacted = redact(meta);
      if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
        Object.assign(entry, redacted);
      } else {
        entry.meta = redacted;
      }
    }
    const line = safeStringify(entry);
    if (stream) stream.write(`${line}\n`);
    if (levelName === 'error') console.error(line);
    else if (levelName === 'warn') console.warn(line);
    else console.log(line);
  }

  const logger = {
    level,
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child(context = {}) {
      return createLogger({ level, file: null, name }).withContext
        ? logger.withContext(context)
        : wrapChild(context);
    },
    withContext(context) {
      return wrapChild(context);
    },
    close() {
      if (stream) stream.end();
    },
  };

  function wrapChild(context) {
    const child = {};
    for (const key of ['debug', 'info', 'warn', 'error']) {
      child[key] = (message, meta) => emit(key, message, { ...context, ...(meta && typeof meta === 'object' ? meta : { meta }) });
    }
    child.child = (extra) => wrapChild({ ...context, ...extra });
    return child;
  }

  return logger;
}

export const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

export default logger;
