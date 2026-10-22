/**
 * OWNER: t-worker. Minimal IMAP4rev1 client for inbox sync (node:tls only).
 *
 * Flow: TLS connect -> LOGIN -> SELECT INBOX -> UID SEARCH (UNSEEN / SINCE) ->
 * UID FETCH (UID INTERNALDATE ENVELOPE BODY.PEEK[]) -> LOGOUT.
 *
 * The payload is read with BODY.PEEK[] (never marks messages as read) and parsed
 * by the in-house MIME parser; ENVELOPE is requested for compatibility with
 * servers that expect it but headers are always parsed from the raw message so
 * that encoded subjects / address lists are decoded correctly.
 *
 * Limits: at most IMAP_MAX_MESSAGES (50) messages per sync. Credentials are
 * never logged or returned.
 */
import net from 'node:net';
import tls from 'node:tls';
import { normalizeInboundMessage, parseMimeMessage } from './mime.mjs';

export const IMAP_DEFAULT_TIMEOUT_MS = 25_000;
export const IMAP_MAX_MESSAGES = 50;

export class ImapError extends Error {
  constructor(message, { code = 'IMAP_ERROR', transient = false } = {}) {
    super(message);
    this.name = 'ImapError';
    this.code = code;
    this.transient = transient;
  }
}

export function escapeImapString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}

/** Parse an IMAP INTERNALDATE (`22-Oct-2026 21:00:00 +0200`) into ISO UTC. */
export function parseImapDate(value) {
  const text = String(value || '').trim();
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(text);
  if (!match) {
    const fallback = new Date(text);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[match[2][0].toUpperCase() + match[2].slice(1).toLowerCase()];
  if (month === undefined) return null;
  const offsetSign = match[7] === '-' ? -1 : 1;
  const offsetMinutes = offsetSign * (Number(match[8]) * 60 + Number(match[9]));
  const utc = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  return new Date(utc - offsetMinutes * 60_000).toISOString();
}

/**
 * Parse a `UID SEARCH` response.
 * @returns {number[]} UIDs ascending
 */
export function parseSearchResponse(lines) {
  const uids = [];
  for (const entry of lines) {
    const line = typeof entry === 'string' ? entry : entry.line;
    const match = /^\* SEARCH\b(.*)$/i.exec(String(line || '').trim());
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      const uid = Number(token);
      if (Number.isInteger(uid) && uid > 0) uids.push(uid);
    }
  }
  return [...new Set(uids)].sort((a, b) => a - b);
}

/**
 * Group FETCH response entries into message envelopes.
 * Entries are `{line, literal}` in wire order; every `* n FETCH` line starts a
 * new group, literals attach to the current group. Parsing headers from the raw
 * literal avoids fragile ENVELOPE/parenthesis balancing.
 */
export function parseFetchResponse(entries) {
  const groups = [];
  let current = null;
  for (const entry of entries) {
    if (/^\*\s+\d+\s+FETCH\b/i.test(entry.line)) {
      current = { lines: [], literals: [] };
      groups.push(current);
    }
    if (!current) continue;
    current.lines.push(entry.line);
    if (entry.literal) current.literals.push(entry.literal);
  }
  const messages = [];
  for (const group of groups) {
    const text = group.lines.join('\n');
    const uidMatch = /\bUID\s+(\d+)/i.exec(text);
    const dateMatch = /\bINTERNALDATE\s+"([^"]+)"/i.exec(text);
    const raw = group.literals[group.literals.length - 1];
    if (!raw) continue;
    const parsed = parseMimeMessage(raw);
    const normalized = normalizeInboundMessage({
      headers: parsed.headers,
      text: parsed.text,
      html: parsed.html,
      uid: uidMatch ? Number(uidMatch[1]) : null,
      internalDate: dateMatch ? parseImapDate(dateMatch[1]) : null,
    });
    messages.push(normalized);
  }
  return messages;
}

export class ImapConnection {
  constructor({ host, port = 993, secure = true, timeoutMs = IMAP_DEFAULT_TIMEOUT_MS, servername = null, rejectUnauthorized = true } = {}) {
    this.host = host;
    this.port = port;
    this.secure = Boolean(secure);
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || IMAP_DEFAULT_TIMEOUT_MS);
    this.servername = servername || host;
    this.rejectUnauthorized = rejectUnauthorized !== false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.closed = false;
    this.failure = null;
    this.tagCounter = 0;
  }

  #attach(socket) {
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(this.timeoutMs);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    socket.on('timeout', () => this.#fail(new ImapError('IMAP 连接超时', { code: 'IMAP_TIMEOUT', transient: true })));
    socket.on('error', (error) =>
      this.#fail(new ImapError(`IMAP 连接错误：${String(error && error.message ? error.message : error).slice(0, 200)}`, { code: 'IMAP_NETWORK', transient: true })),
    );
    socket.on('close', () => {
      this.closed = true;
      if (this.waiting) this.#fail(new ImapError('IMAP 连接被服务器关闭', { code: 'IMAP_CLOSED', transient: true }));
    });
  }

  #fail(error) {
    this.failure = error;
    if (this.waiting) {
      const { reject, parse } = this.waiting;
      void parse;
      this.waiting = null;
      reject(error);
    }
  }

  #drain() {
    if (!this.waiting) return;
    const parsed = this.waiting.parse();
    if (!parsed) return;
    this.buffer = this.buffer.subarray(parsed.consumed);
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve(parsed.value);
  }

  /**
   * Incremental line + literal reader. Completes when a tagged response line is
   * seen (or when `tagless` is true: on the first complete line).
   */
  #parseUntil(tag, { tagless = false } = {}) {
    const entries = [];
    let offset = 0;
    while (true) {
      const lineEnd = this.buffer.indexOf('\r\n', offset);
      if (lineEnd < 0) {
        // Some servers use bare LF for lines.
        const lfEnd = this.buffer.indexOf('\n', offset);
        if (lfEnd < 0) return null;
        const line = this.buffer.toString('utf8', offset, lfEnd);
        offset = lfEnd + 1;
        entries.push({ line, literal: null });
        if (tagless) return { value: { entries }, consumed: offset };
        const handled = this.#checkTag(line, tag, entries);
        if (handled) return { value: { entries, status: handled.status }, consumed: offset };
        continue;
      }
      const line = this.buffer.toString('utf8', offset, lineEnd);
      offset = lineEnd + 2;
      const literalMatch = /\{(\d+)\}$/.exec(line);
      if (literalMatch) {
        const size = Number(literalMatch[1]);
        if (this.buffer.length < offset + size) return null;
        const literal = this.buffer.subarray(offset, offset + size);
        offset += size;
        entries.push({ line, literal });
        // A CRLF follows the literal; consume it lazily on the next iteration.
        continue;
      }
      entries.push({ line, literal: null });
      if (tagless) return { value: { entries }, consumed: offset };
      const handled = this.#checkTag(line, tag, entries);
      if (handled) return { value: { entries, status: handled.status }, consumed: offset };
    }
  }

  #checkTag(line, tag, entries) {
    const match = /^(\S+)\s+(OK|NO|BAD)\b(.*)$/i.exec(String(line || '').trim());
    if (!match) return null;
    if (match[1].toUpperCase() !== String(tag).toUpperCase()) return null;
    void entries;
    return { status: match[2].toUpperCase(), text: match[3] };
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.servername, rejectUnauthorized: this.rejectUnauthorized })
        : net.connect({ host: this.host, port: this.port });
      const event = this.secure ? 'secureConnect' : 'connect';
      const onError = (error) => {
        socket.removeListener(event, onConnect);
        reject(new ImapError(`无法连接 IMAP 服务器：${String(error && error.message ? error.message : error).slice(0, 200)}`, { code: 'IMAP_NETWORK', transient: true }));
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        resolve();
      };
      socket.once('error', onError);
      socket.once(event, onConnect);
      this.#attach(socket);
    });
    this.failure = null;
    const greeting = await this.#readTagless();
    const first = greeting.entries[0]?.line || '';
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(first)) {
      throw new ImapError(`IMAP 服务器拒绝连接：${first.slice(0, 200)}`, { code: 'IMAP_GREETING' });
    }
    return { greeting: first, preAuth: /PREAUTH/i.test(first) };
  }

  #readTagless() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new ImapError('IMAP 连接已关闭', { code: 'IMAP_CLOSED', transient: true }));
    const parsed = this.#parseUntil('', { tagless: true });
    if (parsed) {
      this.buffer = this.buffer.subarray(parsed.consumed);
      return Promise.resolve(parsed.value);
    }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, parse: () => this.#parseUntil('', { tagless: true }) };
    });
  }

  async #send(tag, line) {
    if (!this.socket) throw new ImapError('IMAP socket 未连接', { code: 'IMAP_NOT_CONNECTED' });
    return new Promise((resolve, reject) => {
      const parse = () => {
        const parsed = this.#parseUntil(tag);
        if (!parsed) return null;
        return parsed;
      };
      const parsed = parse();
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.consumed);
        resolve(parsed.value);
        return;
      }
      this.waiting = { resolve, reject, parse };
      this.socket.write(`${tag} ${line}\r\n`);
    });
  }

  async login(username, password) {
    const tag = `z${++this.tagCounter}`;
    let response;
    try {
      response = await this.#send(tag, `LOGIN ${escapeImapString(username)} ${escapeImapString(password)}`);
    } catch (error) {
      if (error instanceof ImapError) throw error;
      throw new ImapError('IMAP 登录失败', { code: 'IMAP_LOGIN_FAILED' });
    }
    if (response.status !== 'OK') {
      throw new ImapError('IMAP 登录失败（请检查账号密码或授权码）', { code: 'IMAP_LOGIN_FAILED' });
    }
    return true;
  }

  async select(mailbox = 'INBOX') {
    const tag = `z${++this.tagCounter}`;
    const response = await this.#send(tag, `SELECT ${escapeImapString(mailbox)}`);
    if (response.status !== 'OK') {
      throw new ImapError(`无法打开邮箱 ${mailbox}`, { code: 'IMAP_SELECT_FAILED' });
    }
    const exists = /^\*\s+(\d+)\s+EXISTS/im.exec(response.entries.map((entry) => entry.line).join('\n'));
    return { exists: exists ? Number(exists[1]) : 0, entries: response.entries };
  }

  async searchUids({ unseen = true, since = null, limit = IMAP_MAX_MESSAGES } = {}) {
    const criteria = [];
    if (unseen) criteria.push('UNSEEN');
    if (since) criteria.push(`SINCE ${formatImapSearchDate(since)}`);
    if (!criteria.length) criteria.push('ALL');
    const tag = `z${++this.tagCounter}`;
    const response = await this.#send(tag, `UID SEARCH ${criteria.join(' ')}`);
    if (response.status !== 'OK') throw new ImapError('IMAP 搜索失败', { code: 'IMAP_SEARCH_FAILED' });
    const uids = parseSearchResponse(response.entries);
    const max = Math.max(1, Math.min(IMAP_MAX_MESSAGES, Number(limit) || IMAP_MAX_MESSAGES));
    return uids.slice(-max);
  }

  async fetchMessages(uids) {
    if (!uids || !uids.length) return [];
    const tag = `z${++this.tagCounter}`;
    const response = await this.#send(tag, `UID FETCH ${uids.join(',')} (UID INTERNALDATE ENVELOPE BODY.PEEK[])`);
    if (response.status !== 'OK') throw new ImapError('IMAP 拉取邮件失败', { code: 'IMAP_FETCH_FAILED' });
    return parseFetchResponse(response.entries);
  }

  async logout() {
    try {
      if (this.socket && !this.closed) {
        const tag = `z${++this.tagCounter}`;
        this.socket.write(`${tag} LOGOUT\r\n`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    } catch {
      // best effort
    }
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.closed = true;
  }
}

export function formatImapSearchDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ImapError('搜索日期不合法', { code: 'IMAP_INVALID_DATE' });
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.getUTCDate()).padStart(2, '0')}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function pick(source, camel, snake, fallback = undefined) {
  if (!source || typeof source !== 'object') return fallback;
  if (source[camel] !== undefined && source[camel] !== null) return source[camel];
  if (source[snake] !== undefined && source[snake] !== null) return source[snake];
  return fallback;
}

export function resolveImapConfig(account = {}, secret = {}, extraConfig = {}) {
  const credentials = secret && typeof secret === 'object' ? secret : {};
  // t-crm's loadSendAccount() returns `config.imap = { host, port, secure }`.
  const nested = extraConfig && typeof extraConfig === 'object' && extraConfig.imap && typeof extraConfig.imap === 'object'
    ? extraConfig.imap
    : {};
  return {
    host: nested.host || pick(extraConfig, 'imapHost', 'imap_host') || pick(account, 'imapHost', 'imap_host', ''),
    port: Number(nested.port || pick(extraConfig, 'imapPort', 'imap_port') || pick(account, 'imapPort', 'imap_port', 993)) || 993,
    secure: nested.secure !== undefined ? Boolean(nested.secure) : Boolean(Number(pick(account, 'imapSecure', 'imap_secure', 1)) !== 0),
    username:
      credentials.username ||
      pick(extraConfig, 'username', 'username') ||
      pick(account, 'username', 'username', '') ||
      pick(account, 'address', 'address', ''),
    password:
      (typeof secret === 'string' ? secret : '') ||
      credentials.password ||
      credentials.imapPassword ||
      credentials.imap_password ||
      credentials.pass ||
      '',
    rejectUnauthorized: pick(extraConfig, 'rejectUnauthorized', 'reject_unauthorized', true) !== false,
  };
}

/**
 * Fetch recent inbox messages.
 * @returns {Promise<{messages:Array, uids:number[], exists:number}>}
 */
export async function imapFetchMessages({
  host,
  port = 993,
  secure = true,
  username = '',
  password = '',
  mailbox = 'INBOX',
  unseen = false,
  since = null,
  limit = IMAP_MAX_MESSAGES,
  markSeen = false,
  timeoutMs = IMAP_DEFAULT_TIMEOUT_MS,
  servername = null,
  rejectUnauthorized = true,
  logger = null,
} = {}) {
  if (!host) throw new ImapError('IMAP 主机未配置', { code: 'IMAP_NOT_CONFIGURED' });
  const connection = new ImapConnection({ host, port, secure, timeoutMs, servername, rejectUnauthorized });
  try {
    await connection.connect();
    await connection.login(username, password);
    const selected = await connection.select(mailbox);
    // BODY.PEEK[] never marks messages as read; `markSeen` is intentionally not
    // implemented with BODY[] because inbox sync must not change recipient state.
    void markSeen;
    const uids = await connection.searchUids({ unseen, since, limit: Math.min(IMAP_MAX_MESSAGES, limit) });
    const messages = await connection.fetchMessages(uids);
    return { messages, uids, exists: selected.exists };
  } finally {
    await connection.logout();
    connection.close();
    if (logger) logger.debug?.('imap sync finished', { host, port, secure, messageCount: undefined });
  }
}

/** Test IMAP connectivity/authentication (no message payload downloaded). */
export async function testImapConnection(account = {}, secret = {}, { config = {}, timeoutMs = 10_000 } = {}) {
  const imap = resolveImapConfig(account, secret, config);
  const result = { ok: false, host: imap.host, port: imap.port, secure: imap.secure, exists: 0 };
  if (!imap.host) return { ...result, error: '未配置 IMAP 主机' };
  const connection = new ImapConnection({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    timeoutMs,
    rejectUnauthorized: imap.rejectUnauthorized,
  });
  try {
    await connection.connect();
    await connection.login(imap.username, imap.password);
    const selected = await connection.select('INBOX');
    await connection.logout();
    return { ...result, ok: true, exists: selected.exists };
  } catch (error) {
    return { ...result, ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) };
  } finally {
    connection.close();
  }
}

export default {
  ImapConnection,
  ImapError,
  imapFetchMessages,
  testImapConnection,
  parseFetchResponse,
  parseSearchResponse,
  parseImapDate,
  formatImapSearchDate,
  resolveImapConfig,
  escapeImapString,
  IMAP_MAX_MESSAGES,
};
