/**
 * OWNER: t-worker. Minimal SMTP client (node:net / node:tls only).
 *
 * Supported flow:
 *   TCP connect -> (implicit TLS optional) -> EHLO -> STARTTLS (optional,
 *   advertised) -> EHLO -> AUTH PLAIN/LOGIN -> MAIL FROM -> RCPT TO... ->
 *   DATA -> QUIT.
 *
 * Security notes:
 *  - credentials never appear in logs: this module logs nothing itself, and the
 *    object returned to callers only contains addresses/response codes;
 *  - response codes are classified: 4xx => transient (retry later),
 *    5xx => permanent (do not retry, may be a hard bounce);
 *  - every command has a timeout; sockets are always closed in `finally`.
 *
 * Not verifying certificate chains is possible (`rejectUnauthorized:false`) but
 * is only intended for local test servers; production accounts keep the default.
 */
import net from 'node:net';
import tls from 'node:tls';

export const SMTP_DEFAULT_TIMEOUT_MS = 20_000;

export class SmtpError extends Error {
  constructor(message, { code = 'SMTP_ERROR', responseCode = null, transient = false, command = null } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.responseCode = responseCode;
    this.transient = transient;
    this.command = command;
  }
}

export function isTransientSmtpCode(code) {
  return Number(code) >= 400 && Number(code) < 500;
}

export function isPermanentSmtpCode(code) {
  return Number(code) >= 500 && Number(code) < 600;
}

function responseError(response, command) {
  const message = `SMTP ${command} 失败：${response.code} ${response.lines.join(' / ')}`.slice(0, 500);
  return new SmtpError(message, {
    code: isTransientSmtpCode(response.code) ? 'SMTP_TRANSIENT' : 'SMTP_PERMANENT',
    responseCode: response.code,
    transient: isTransientSmtpCode(response.code),
    command,
  });
}

/** Dot-stuffing for DATA payload, normalised to CRLF. */
export function dotStuff(message) {
  const text = Buffer.isBuffer(message) ? message.toString('utf8') : String(message ?? '');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const stuffed = normalized
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  return stuffed.endsWith('\r\n') ? stuffed : `${stuffed}\r\n`;
}

/** Parse one complete SMTP response from a buffer. Returns null if incomplete. */
export function parseSmtpResponse(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  // A response is only complete once its final line is terminated; otherwise a
  // partially received reply could be mistaken for a short one.
  if (!/\r?\n$/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  if (!lines.length) return null;
  const first = /^(\d{3})([ -])(.*)$/.exec(lines[0]);
  if (!first) return null;
  const code = Number(first[1]);
  const collected = [];
  let index = 0;
  while (index < lines.length) {
    const match = /^(\d{3})([ -])(.*)$/.exec(lines[index]);
    if (!match) break;
    collected.push(match[3]);
    if (match[2] === ' ') {
      const consumed = lines.slice(0, index + 1).join('\r\n');
      return { code, lines: collected, consumedBytes: Buffer.byteLength(consumed, 'utf8') };
    }
    index += 1;
  }
  if (code && lines.length && !lines[lines.length - 1]) return null;
  return null;
}

export class SmtpConnection {
  constructor({ host, port = 587, secure = false, timeoutMs = SMTP_DEFAULT_TIMEOUT_MS, servername = null, rejectUnauthorized = true } = {}) {
    this.host = host;
    this.port = port;
    this.secure = Boolean(secure);
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || SMTP_DEFAULT_TIMEOUT_MS);
    this.servername = servername || host;
    this.rejectUnauthorized = rejectUnauthorized !== false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.closed = false;
    this.failure = null;
    this.capabilities = { auth: [], starttls: false, lines: [] };
  }

  #attach(socket) {
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(this.timeoutMs);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    socket.on('timeout', () => {
      this.#fail(new SmtpError(`SMTP 连接超时（${this.timeoutMs}ms）`, { code: 'SMTP_TIMEOUT', transient: true }));
    });
    socket.on('error', (error) => {
      this.#fail(new SmtpError(`SMTP 连接错误：${String(error && error.message ? error.message : error).slice(0, 200)}`, { code: 'SMTP_NETWORK', transient: true }));
    });
    socket.on('close', () => {
      this.closed = true;
      if (this.waiting) {
        this.#fail(new SmtpError('SMTP 连接被服务器关闭', { code: 'SMTP_CLOSED', transient: true }));
      }
    });
  }

  #fail(error) {
    this.failure = error;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = null;
      reject(error);
    }
  }

  #drain() {
    if (!this.waiting) return;
    const parsed = parseSmtpResponse(this.buffer);
    if (!parsed) return;
    this.buffer = this.buffer.subarray(parsed.consumedBytes);
    // The consumed length in bytes may not include the trailing CRLF; resync by
    // stripping any remaining line ending prefix.
    while (this.buffer.length && (this.buffer[0] === 0x0a || this.buffer[0] === 0x0d)) {
      this.buffer = this.buffer.subarray(1);
    }
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve(parsed);
  }

  readResponse() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new SmtpError('SMTP 连接已关闭', { code: 'SMTP_CLOSED', transient: true }));
    const parsed = parseSmtpResponse(this.buffer);
    if (parsed) {
      this.buffer = this.buffer.subarray(parsed.consumedBytes);
      while (this.buffer.length && (this.buffer[0] === 0x0a || this.buffer[0] === 0x0d)) this.buffer = this.buffer.subarray(1);
      return Promise.resolve(parsed);
    }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  writeRaw(data) {
    if (!this.socket) throw new SmtpError('SMTP socket 未连接', { code: 'SMTP_NOT_CONNECTED' });
    this.socket.write(data);
  }

  /** Send one command line and await the response. */
  async command(line, { secret = false } = {}) {
    // `secret` exists only so call sites are explicit; the command is never logged.
    void secret;
    this.writeRaw(`${line}\r\n`);
    return this.readResponse();
  }

  async expect(line, allowedCodes, { secret = false } = {}) {
    const response = await this.command(line, { secret });
    if (!allowedCodes.includes(response.code)) throw responseError(response, secret ? '[redacted]' : line.split(' ')[0]);
    return response;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.servername, rejectUnauthorized: this.rejectUnauthorized })
        : net.connect({ host: this.host, port: this.port });
      const event = this.secure ? 'secureConnect' : 'connect';
      const onError = (error) => {
        socket.removeListener(event, onConnect);
        reject(new SmtpError(`无法连接 SMTP 服务器：${String(error && error.message ? error.message : error).slice(0, 200)}`, { code: 'SMTP_NETWORK', transient: true }));
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
    const greeting = await this.readResponse();
    if (greeting.code !== 220) throw responseError(greeting, 'greeting');
    return greeting;
  }

  async ehlo(identity = 'zhirai.local') {
    const response = await this.command(`EHLO ${identity}`);
    if (response.code === 250) {
      this.capabilities = parseEhlo(response.lines);
      return this.capabilities;
    }
    // Fallback to HELO for very old servers (no AUTH/STARTTLS possible).
    const helo = await this.expect(`HELO ${identity}`, [250]);
    this.capabilities = { auth: [], starttls: false, lines: [helo.lines.join(' ')] };
    return this.capabilities;
  }

  async startTls() {
    await this.expect('STARTTLS', [220]);
    this.buffer = Buffer.alloc(0);
    const rawSocket = this.socket;
    // Detach plain listeners before the TLS wrapper takes over the socket.
    rawSocket.removeAllListeners('data');
    rawSocket.removeAllListeners('error');
    rawSocket.removeAllListeners('close');
    rawSocket.removeAllListeners('timeout');
    await new Promise((resolve, reject) => {
      const secureSocket = tls.connect({
        socket: rawSocket,
        servername: this.servername,
        rejectUnauthorized: this.rejectUnauthorized,
      });
      const onError = (error) => {
        secureSocket.removeListener('secureConnect', onConnect);
        reject(new SmtpError(`STARTTLS 握手失败：${String(error && error.message ? error.message : error).slice(0, 200)}`, { code: 'SMTP_TLS', transient: true }));
      };
      const onConnect = () => {
        secureSocket.removeListener('error', onError);
        resolve();
      };
      secureSocket.once('error', onError);
      secureSocket.once('secureConnect', onConnect);
      this.#attach(secureSocket);
    });
    this.failure = null;
    return true;
  }

  async auth({ username, password, mechanisms = [] }) {
    if (!username) return { authenticated: false };
    const advertised = (mechanisms || []).map((item) => item.toUpperCase());
    try {
      if (advertised.includes('PLAIN') || advertised.length === 0) {
        const token = Buffer.from(`\u0000${username}\u0000${password ?? ''}`, 'utf8').toString('base64');
        const response = await this.command(`AUTH PLAIN ${token}`, { secret: true });
        if (response.code === 235) return { authenticated: true, mechanism: 'PLAIN' };
        if (response.code === 504 && advertised.includes('LOGIN')) return this.#authLogin(username, password);
        throw responseError(response, 'AUTH');
      }
      if (advertised.includes('LOGIN')) return this.#authLogin(username, password);
      throw new SmtpError('SMTP 服务器不支持 PLAIN/LOGIN 认证', { code: 'SMTP_AUTH_UNSUPPORTED' });
    } catch (error) {
      if (error instanceof SmtpError && error.responseCode === 535) {
        throw new SmtpError('SMTP 认证失败（用户名或密码不正确）', {
          code: 'SMTP_AUTH_FAILED',
          responseCode: 535,
          transient: false,
        });
      }
      throw error;
    }
  }

  async #authLogin(username, password) {
    const start = await this.expect('AUTH LOGIN', [334]);
    void start;
    await this.expect(Buffer.from(username, 'utf8').toString('base64'), [334], { secret: true });
    const response = await this.command(Buffer.from(password ?? '', 'utf8').toString('base64'), { secret: true });
    if (response.code !== 235) throw responseError(response, 'AUTH LOGIN');
    return { authenticated: true, mechanism: 'LOGIN' };
  }

  async quit() {
    try {
      if (!this.closed) await this.command('QUIT');
    } catch {
      // QUIT is best effort.
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

/** Parse EHLO response lines into capabilities. */
export function parseEhlo(lines) {
  const capabilities = { auth: [], starttls: false, lines: [], size: null };
  for (const line of lines) {
    const text = String(line || '').trim();
    if (!text) continue;
    capabilities.lines.push(text);
    const upper = text.toUpperCase();
    if (upper.startsWith('STARTTLS')) capabilities.starttls = true;
    if (upper.startsWith('AUTH')) {
      const mechanisms = text.split(/\s+/).slice(1).filter(Boolean);
      for (const mechanism of mechanisms) {
        if (!capabilities.auth.includes(mechanism.toUpperCase())) capabilities.auth.push(mechanism.toUpperCase());
      }
    }
    const size = /^SIZE\s+(\d+)/i.exec(text);
    if (size) capabilities.size = Number(size[1]);
  }
  return capabilities;
}

/** Extract a bare address from a string / `{address}`. */
export function addressOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase();
  return String(value.address || '').trim().toLowerCase();
}

/**
 * Deliver a pre-built RFC 5322 message.
 * @returns {Promise<{ok:boolean, accepted:string[], rejected:string[], response:object|null}>}
 */
export async function smtpSend({
  host,
  port = 587,
  secure = false,
  username = '',
  password = '',
  from,
  to,
  raw,
  timeoutMs = SMTP_DEFAULT_TIMEOUT_MS,
  servername = null,
  rejectUnauthorized = true,
  requireTls = false,
  heloName = 'zhirai.local',
  logger = null,
} = {}) {
  if (!host) throw new SmtpError('SMTP 主机未配置', { code: 'SMTP_NOT_CONFIGURED' });
  const recipients = (Array.isArray(to) ? to : [to]).map(addressOf).filter(Boolean);
  if (!recipients.length) throw new SmtpError('没有收件人', { code: 'SMTP_NO_RECIPIENTS' });
  const fromAddress = addressOf(from);
  if (!fromAddress) throw new SmtpError('发件人地址为空', { code: 'SMTP_NO_FROM' });
  const connection = new SmtpConnection({ host, port, secure, timeoutMs, servername, rejectUnauthorized });
  const accepted = [];
  const rejected = [];
  try {
    await connection.connect();
    let capabilities = await connection.ehlo(heloName);
    if (!secure) {
      if (capabilities.starttls) {
        await connection.startTls();
        capabilities = await connection.ehlo(heloName);
      } else if (requireTls) {
        throw new SmtpError('服务器未提供 STARTTLS，但要求加密传输', { code: 'SMTP_TLS_REQUIRED' });
      }
    }
    if (username) {
      await connection.auth({ username, password, mechanisms: capabilities.auth });
    }
    await connection.expect(`MAIL FROM:<${fromAddress}>`, [250]);
    for (const recipient of recipients) {
      const response = await connection.command(`RCPT TO:<${recipient}>`);
      if ([250, 251, 252].includes(response.code)) accepted.push(recipient);
      else rejected.push({ address: recipient, code: response.code, message: response.lines.join(' ') });
    }
    if (!accepted.length) {
      throw new SmtpError(`所有收件人被拒绝：${rejected.map((item) => item.address).join(', ')}`, {
        code: 'SMTP_ALL_RECIPIENTS_REJECTED',
        responseCode: rejected[0]?.code ?? null,
        transient: isTransientSmtpCode(rejected[0]?.code),
      });
    }
    await connection.expect('DATA', [354]);
    connection.writeRaw(`${dotStuff(raw)}.\r\n`);
    const delivered = await connection.readResponse();
    if (![250, 251].includes(delivered.code)) throw responseError(delivered, 'DATA');
    await connection.quit();
    return { ok: true, accepted, rejected, response: { code: delivered.code, message: delivered.lines.join(' ') } };
  } finally {
    connection.close();
    if (logger) {
      // Deliberately minimal: never includes credentials or message bodies.
      logger.debug?.('smtp transaction finished', { host, port, secure, acceptedCount: accepted.length, rejectedCount: rejected.length });
    }
  }
}

function pick(source, camel, snake, fallback = undefined) {
  if (!source || typeof source !== 'object') return fallback;
  if (source[camel] !== undefined && source[camel] !== null) return source[camel];
  if (source[snake] !== undefined && source[snake] !== null) return source[snake];
  return fallback;
}

/** Normalise an email-account row/public object into SMTP settings. */
export function resolveSmtpConfig(account = {}, secret = {}, extraConfig = {}) {
  const credentials = secret && typeof secret === 'object' ? secret : {};
  // t-crm's loadSendAccount() returns `config.smtp = { host, port, secure }`.
  const nested = extraConfig && typeof extraConfig === 'object' && extraConfig.smtp && typeof extraConfig.smtp === 'object'
    ? extraConfig.smtp
    : {};
  return {
    host: nested.host || pick(extraConfig, 'smtpHost', 'smtp_host') || pick(account, 'smtpHost', 'smtp_host', ''),
    port:
      Number(nested.port || pick(extraConfig, 'smtpPort', 'smtp_port') || pick(account, 'smtpPort', 'smtp_port', 587)) || 587,
    secure: nested.secure !== undefined ? Boolean(nested.secure) : Boolean(Number(pick(account, 'smtpSecure', 'smtp_secure', 1)) !== 0),
    username:
      credentials.username ||
      pick(extraConfig, 'username', 'username') ||
      pick(account, 'username', 'username', '') ||
      pick(account, 'address', 'address', ''),
    password:
      (typeof secret === 'string' ? secret : '') ||
      credentials.password ||
      credentials.smtpPassword ||
      credentials.smtp_password ||
      credentials.pass ||
      '',
    rejectUnauthorized: pick(extraConfig, 'rejectUnauthorized', 'reject_unauthorized', true) !== false,
  };
}

/**
 * Test SMTP connectivity/authentication without sending a message.
 * @returns {Promise<{ok:boolean, host:string, port:number, secure:boolean, auth:string|null, error?:string}>}
 */
export async function testSmtpConnection(account = {}, secret = {}, { config = {}, timeoutMs = 10_000 } = {}) {
  const smtp = resolveSmtpConfig(account, secret, config);
  const result = { ok: false, host: smtp.host, port: smtp.port, secure: smtp.secure, auth: null };
  if (!smtp.host) return { ...result, error: '未配置 SMTP 主机' };
  const connection = new SmtpConnection({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    timeoutMs,
    rejectUnauthorized: smtp.rejectUnauthorized,
  });
  try {
    await connection.connect();
    let capabilities = await connection.ehlo();
    if (!smtp.secure && capabilities.starttls) {
      await connection.startTls();
      capabilities = await connection.ehlo();
    }
    if (smtp.username) {
      const auth = await connection.auth({ username: smtp.username, password: smtp.password, mechanisms: capabilities.auth });
      result.auth = auth.mechanism || null;
    }
    await connection.quit();
    return { ...result, ok: true };
  } catch (error) {
    return { ...result, ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) };
  } finally {
    connection.close();
  }
}

export default {
  SmtpConnection,
  SmtpError,
  smtpSend,
  testSmtpConnection,
  parseSmtpResponse,
  parseEhlo,
  dotStuff,
  addressOf,
  resolveSmtpConfig,
  isTransientSmtpCode,
  isPermanentSmtpCode,
  SMTP_DEFAULT_TIMEOUT_MS,
};
