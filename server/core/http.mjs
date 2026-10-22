/**
 * Minimal, self-contained HTTP framework: routing, request parsing, auth
 * resolution, CSRF/origin checks, rate limiting, static files and JSON errors.
 *
 * The app is same-origin only. There is no CORS surface and no API route is
 * reachable from another origin with a browser session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, badRequest, forbidden, notFound, tooManyRequests } from './errors.mjs';
import { resolveApiKey, resolveSession, roleCan, verifyCsrf } from './auth.mjs';
import { consume as rateConsume } from './rate-limit.mjs';
import { nowIso } from './time.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const PUBLIC_STATIC_ROOTS = new Set(['src', 'assets', 'admin']);
const PUBLIC_STATIC_FILES = new Set(['index.html', 'favicon.ico', 'robots.txt', 'manifest.webmanifest']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const { regex, keys } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler, options });
    return this;
  }

  get(pattern, handler, options) {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }

  put(pattern, handler, options) {
    return this.add('PUT', pattern, handler, options);
  }

  patch(pattern, handler, options) {
    return this.add('PATCH', pattern, handler, options);
  }

  delete(pattern, handler, options) {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method, pathname) {
    const upper = method.toUpperCase();
    let pathMatched = false;
    for (const route of this.routes) {
      const matched = route.regex.exec(pathname);
      if (!matched) continue;
      pathMatched = true;
      if (route.method !== upper) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(matched[index + 1] || '');
      });
      return { route, params };
    }
    return { route: null, methodMismatch: pathMatched };
  }
}

function compilePattern(pattern) {
  const keys = [];
  const segments = pattern.split('/').filter((segment, index) => index > 0 || segment !== '');
  const source = segments
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') return '(.*)';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${source}/?$`), keys };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limitBytes) {
        finished = true;
        reject(new AppError('PAYLOAD_TOO_LARGE', '请求内容过大', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

function parseBody(buffer, contentType) {
  if (!buffer || buffer.length === 0) return null;
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const text = buffer.toString('utf8');
  if (type === 'application/json' || type.endsWith('+json') || type === '') {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw badRequest('请求体不是合法 JSON');
    }
  }
  if (type === 'text/csv' || type === 'text/plain') return text;
  if (type === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(text));
  }
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', `不支持的请求内容类型：${type}`, { status: 415 });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function appendSetCookie(headers, cookie) {
  if (!headers['Set-Cookie']) headers['Set-Cookie'] = [];
  headers['Set-Cookie'].push(cookie);
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function isIndexRequest(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

function isPublicApiPath(pathname) {
  return (
    pathname === '/api/v1/health' ||
    pathname === '/api/v1/auth/setup' ||
    pathname === '/api/v1/auth/login' ||
    pathname === '/api/v1/auth/status' ||
    pathname.startsWith('/api/v1/public/')
  );
}

export function createApp({ router, config, logger, db }) {
  return async function handle(req, res) {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';
    const headers = {};
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers[key] = value;
    Object.assign(res, {});

    const ctx = {
      req,
      res,
      db,
      config,
      logger,
      requestId,
      method,
      pathname,
      url,
      query: url.searchParams,
      params: {},
      body: null,
      rawBody: null,
      cookies: parseCookies(req.headers.cookie),
      ip: clientIp(req, config.trustProxy),
      userAgent: req.headers['user-agent'] || null,
      origin: new URL(config.publicBaseUrl).origin,
      user: null,
      workspace: null,
      membership: null,
      authType: null,
      now: nowIso(),
      _status: 200,
      _headers: headers,
      _responded: false,
    };

    ctx.header = (name, value) => {
      ctx._headers[name] = value;
    };
    ctx.setCookie = (name, value, options) => appendSetCookie(ctx._headers, buildCookie(name, value, options));
    ctx.clearCookie = (name) => appendSetCookie(ctx._headers, buildCookie(name, '', { maxAge: 0, httpOnly: true }));
    ctx.setAuthCookies = (token, csrfToken, expiresAt) => {
      const secure = config.publicBaseUrl.startsWith('https://');
      const maxAge = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      ctx.setCookie(config.cookies.session, token, { httpOnly: true, secure, sameSite: 'Lax', maxAge });
      ctx.setCookie(config.cookies.csrf, csrfToken, { httpOnly: false, secure, sameSite: 'Lax', maxAge });
    };
    ctx.clearAuthCookies = () => {
      ctx.clearCookie(config.cookies.session);
      ctx.clearCookie(config.cookies.csrf);
    };
    ctx.ok = (data = null, status = 200) => {
      ctx._status = status;
      return sendJson(res, status, { ok: true, data }, ctx._headers);
    };
    ctx.json = (data, status = 200) => {
      ctx._status = status;
      return sendJson(res, status, data, ctx._headers);
    };
    ctx.redirect = (location, status = 302) => {
      if (res.writableEnded) return;
      res.writeHead(status, { Location: location, ...ctx._headers });
      res.end();
      ctx._status = status;
    };
    ctx.fail = (error) => {
      const appError = error instanceof AppError ? error : null;
      const status = appError?.status || 500;
      ctx._status = status;
      const payload = {
        ok: false,
        error: appError
          ? appError.toJSON()
          : { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后再试' },
      };
      sendJson(res, status, payload, ctx._headers);
    };
    ctx.sendFile = (filePath, { downloadName = null, contentType = 'application/octet-stream' } = {}) => {
      const stat = fs.statSync(filePath);
      const filename = String(downloadName || path.basename(filePath)).replace(/["\\\r\n]/g, '_');
      res.writeHead(200, {
        ...ctx._headers,
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      ctx._status = 200;
      fs.createReadStream(filePath).pipe(res);
    };
    ctx.requireUser = () => {
      if (!ctx.user) throw new AppError('UNAUTHORIZED', '请先登录', { status: 401 });
      return ctx.user;
    };
    ctx.requireCapability = (capability) => {
      ctx.requireUser();
      if (!roleCan(ctx.membership?.role, capability)) {
        throw new AppError('FORBIDDEN', '当前角色没有该操作权限', { status: 403 });
      }
    };
    ctx.requireWorkspace = () => {
      ctx.requireUser();
      if (!ctx.workspace) throw new AppError('FORBIDDEN', '当前账号未关联工作空间', { status: 403 });
      return ctx.workspace;
    };

    // --- Authenticate -------------------------------------------------------
    try {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
      if (bearer) {
        const apiAuth = resolveApiKey(bearer[1].trim());
        if (apiAuth) applyAuth(ctx, apiAuth);
      }
      if (!ctx.user) {
        const sessionAuth = resolveSession(ctx.cookies[config.cookies.session]);
        if (sessionAuth) applyAuth(ctx, sessionAuth);
      }
    } catch (error) {
      logger.error('auth resolution failed', { error, requestId });
    }

    // --- Route matching -----------------------------------------------------
    const { route, params, methodMismatch } = router.match(method, pathname);
    if (!route) {
      if (pathname.startsWith('/api/')) {
        const error = methodMismatch ? new AppError('METHOD_NOT_ALLOWED', '请求方法不被支持', { status: 405 }) : notFound('接口不存在');
        return ctx.fail(error);
      }
      if (method !== 'GET' && method !== 'HEAD') return ctx.fail(notFound());
      return serveStatic(req, res, pathname, config, headers);
    }
    ctx.params = params;

    try {
      // --- Same-origin / CSRF checks ---------------------------------------
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      const isPublic = isPublicApiPath(pathname);
      if (mutating && !isPublic && route.options.csrf !== false) {
        const origin = req.headers.origin;
        if (origin) {
          const expectedHost = config.trustProxy ? req.headers['x-forwarded-host'] || req.headers.host : req.headers.host;
          let originHost = '';
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = '';
          }
          if (expectedHost && originHost !== expectedHost) {
            throw new AppError('CSRF_FAILED', '请求来源不被信任', { status: 403 });
          }
        }
        if (ctx.authType === 'session' && !verifyCsrf({ type: 'session', session: { csrfHash: ctx.authCsrfHash } }, req.headers['x-csrf-token'])) {
          throw new AppError('CSRF_FAILED', 'CSRF 校验失败，请刷新页面后重试', { status: 403 });
        }
      }

      // --- Auth requirements ------------------------------------------------
      if (route.options.auth === 'required' && !ctx.user) {
        throw new AppError('UNAUTHORIZED', '请先登录', { status: 401 });
      }
      if (route.options.capability && !roleCan(ctx.membership?.role, route.options.capability)) {
        throw new AppError('FORBIDDEN', '当前角色没有该操作权限', { status: 403 });
      }

      // --- Rate limit -------------------------------------------------------
      if (route.options.rateLimit) {
        const bucketKey = `${route.pattern}:${ctx.ip}`;
        const result = rateConsume(bucketKey, route.options.rateLimit);
        if (!result.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
          throw tooManyRequests();
        }
      }

      // --- Body -------------------------------------------------------------
      if (mutating) {
        const length = Number(req.headers['content-length'] || 0);
        const limit = route.options.maxBodyBytes || 1_500_000;
        if (length > limit) throw new AppError('PAYLOAD_TOO_LARGE', '请求内容过大', { status: 413 });
        const buffer = await readBody(req, limit);
        ctx.rawBody = buffer;
        const contentType = req.headers['content-type'] || '';
        ctx.body = parseBody(buffer, contentType);
      }

      const result = await route.handler(ctx);
      if (!res.writableEnded && result !== undefined) {
        return ctx.ok(result);
      }
      return result;
    } catch (error) {
      const isExpected = error instanceof AppError;
      const status = isExpected ? error.status : 500;
      if (!isExpected || status >= 500) {
        logger.error('request failed', {
          requestId,
          method,
          path: pathname,
          status,
          error: isExpected ? { code: error.code, message: error.message } : error,
        });
      }
      return ctx.fail(isExpected ? error : new AppError('INTERNAL_ERROR', '服务器内部错误，请稍后再试', { status: 500 }));
    } finally {
      logger.debug('request', {
        requestId,
        method,
        path: pathname,
        status: ctx._status,
        ms: Date.now() - startedAt,
        ip: ctx.ip,
        user: ctx.user?.id || null,
      });
    }
  };
}

function applyAuth(ctx, auth) {
  ctx.user = auth.user;
  ctx.workspace = auth.workspace;
  ctx.membership = auth.membership;
  ctx.authType = auth.type;
  ctx.authCsrfHash = auth.session?.csrfHash || null;
  ctx.apiKeyId = auth.apiKeyId || null;
}

function serveStatic(req, res, pathname, config, securityHeaders) {
  let relative;
  if (isIndexRequest(pathname)) relative = 'index.html';
  else if (pathname === '/admin' || pathname === '/admin/') relative = 'admin/index.html';
  else if (pathname === '/favicon.ico') relative = 'assets/brand/favicon.ico';
  else if (pathname === '/manifest.webmanifest') relative = 'manifest.webmanifest';
  else {
    const clean = pathname.replace(/^\/+/, '');
    const root = clean.split('/')[0];
    if (!PUBLIC_STATIC_ROOTS.has(root)) {
      // SPA fallback: unknown non-file routes render the app shell
      if (path.extname(pathname)) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '资源不存在' } }, securityHeaders);
      relative = 'index.html';
    } else {
      relative = clean;
    }
  }

  const rootDir = config.rootDir;
  const filePath = path.resolve(rootDir, relative);
  const normalizedRoot = path.resolve(rootDir);
  if (!filePath.startsWith(normalizedRoot + path.sep) && filePath !== path.join(normalizedRoot, 'index.html')) {
    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '资源不存在' } }, securityHeaders);
  }
  if (relative.includes('..') || relative.startsWith('server/') || relative.startsWith('docs/')) {
    return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '禁止访问' } }, securityHeaders);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    if (!path.extname(pathname)) {
      const shell = path.join(rootDir, 'index.html');
      return serveFile(req, res, shell, securityHeaders);
    }
    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '资源不存在' } }, securityHeaders);
  }
  return serveFile(req, res, filePath, securityHeaders);
}

function serveFile(req, res, filePath, securityHeaders) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const isHtml = ext === '.html';
  const cacheControl = isHtml ? 'no-store' : ext === '.png' || ext === '.ico' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache';
  res.writeHead(200, {
    ...securityHeaders,
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'Last-Modified': stat.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

export { sendJson, parseCookies, buildCookie };
