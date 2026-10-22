/**
 * Cryptography helpers implemented on top of node:crypto.
 *
 * - Password hashing: scrypt with per-password salt and constant-time compare.
 * - Credential storage: AES-256-GCM with a key derived (HKDF) from a local
 *   secret file; bound to a context string so ciphertext cannot be moved
 *   between workspaces/providers.
 * - Unsubscribe tokens: HMAC-signed, URL-safe, not guessable.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacSha256(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

export function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Load the local encryption secret, generating it on first boot. */
export function loadSecret(secretFile) {
  try {
    const existing = fs.readFileSync(secretFile);
    if (existing.length >= 32) return existing;
  } catch {
    // generate below
  }
  const secret = crypto.randomBytes(48);
  fs.mkdirSync(requireDirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

function requireDirname(file) {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return idx > 0 ? file.slice(0, idx) : '.';
}

function deriveKey(secret, label) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), `zhirai:${label}`, KEY_LEN));
}

/**
 * Encrypt a JSON-serialisable credential payload.
 * @returns {string} `v1.<context-hash>.<iv>.<tag>.<cipher>` (base64url parts)
 */
export function encryptCredential(secret, context, payload) {
  const key = deriveKey(secret, 'credential-v1');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`cred:${context}`, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', sha256Hex(`cred:${context}`).slice(0, 16), iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCredential(secret, context, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('invalid credential format');
  const key = deriveKey(secret, 'credential-v1');
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const data = Buffer.from(parts[4], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`cred:${context}`, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

/** HMAC-signed, URL-safe token (used for unsubscribe links). */
export function signToken(secret, payload, { expiresInDays = 365 } = {}) {
  const body = { ...payload, exp: Date.now() + expiresInDays * 86_400_000 };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = hmacSha256(deriveKey(secret, 'token-v1'), encoded).toString('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(secret, token) {
  try {
    const [encoded, sig] = String(token || '').split('.');
    if (!encoded || !sig) return null;
    const expected = hmacSha256(deriveKey(secret, 'token-v1'), encoded).toString('base64url');
    if (!timingSafeEqualString(sig, expected)) return null;
    const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!body || typeof body !== 'object') return null;
    if (body.exp && Date.now() > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

export function maskSecret(value) {
  const text = String(value || '');
  if (text.length <= 4) return '••••';
  return `${text.slice(0, 2)}••••${text.slice(-4)}`;
}

export default {
  randomToken,
  sha256Hex,
  hmacSha256,
  timingSafeEqualString,
  hashPassword,
  verifyPassword,
  loadSecret,
  encryptCredential,
  decryptCredential,
  signToken,
  verifyToken,
  maskSecret,
};
