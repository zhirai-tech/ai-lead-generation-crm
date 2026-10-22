/**
 * Sortable, prefixed identifiers (ULID-compatible layout, implemented here so
 * the project carries no third-party dependency).
 *
 *   id('cmp') -> cmp_01JABCDEFG...
 *
 * 48 bits of millisecond time followed by 80 bits of randomness, encoded with
 * Crockford base32. Monotonic within the same millisecond.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom = null;

function encodeTime(time) {
  let out = '';
  let value = time;
  for (let i = 0; i < 10; i += 1) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ENCODING[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ENCODING[(value << (5 - bits)) & 31];
  return out.slice(0, 16);
}

function bumpRandom(bytes) {
  const next = Buffer.from(bytes);
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i] < 255) {
      next[i] += 1;
      return next;
    }
    next[i] = 0;
  }
  return randomBytes(10);
}

/** Generate a new ULID string. */
export function ulid() {
  const now = Date.now();
  if (now === lastTime && lastRandom) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomBytes(10);
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

/** Generate a prefixed identifier, e.g. `id('job')` -> `job_01...`. */
export function id(prefix) {
  const value = ulid();
  return prefix ? `${prefix}_${value}` : value;
}

export function isId(value, prefix) {
  if (typeof value !== 'string') return false;
  if (prefix) return value.startsWith(`${prefix}_`) && value.length > prefix.length + 2;
  return value.length > 4;
}

export default { ulid, id, isId };
