/**
 * API client. Same-origin only; mutating requests include the CSRF token from
 * the readable `zr_csrf` cookie. 401 responses trigger the session-expired hook.
 */
export class ApiError extends Error {
  constructor({ code = 'ERROR', message = '请求失败', status = 0, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

function cookie(name) {
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

async function request(method, path, { body = undefined, headers = {}, envelope = true, signal = null } = {}) {
  const requestHeaders = { Accept: 'application/json', ...headers };
  const upper = method.toUpperCase();
  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(upper)) {
    const token = cookie('zr_csrf');
    if (token) requestHeaders['X-CSRF-Token'] = token;
  }
  let response;
  try {
    response = await fetch(path, {
      method: upper,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: signal || undefined,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError({ code: 'NETWORK_ERROR', message: '网络连接失败，请检查服务是否运行', status: 0 });
  }
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  let payload = null;
  if (isJson) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    payload = await response.text();
  }
  if (response.status === 401) {
    unauthorizedHandler?.();
  }
  if (!response.ok || (envelope && payload && payload.ok === false)) {
    const error = payload && payload.ok === false ? payload.error : null;
    throw new ApiError({
      code: error?.code || `HTTP_${response.status}`,
      message: error?.message || (response.status === 401 ? '登录已过期，请重新登录' : `请求失败（${response.status}）`),
      status: response.status,
      details: error?.details || null,
    });
  }
  if (!isJson) return payload;
  return envelope ? payload.data : payload;
}

export const api = {
  request,
  get: (path, options) => request('GET', path, options),
  post: (path, body, options = {}) => request('POST', path, { ...options, body }),
  patch: (path, body, options = {}) => request('PATCH', path, { ...options, body }),
  put: (path, body, options = {}) => request('PUT', path, { ...options, body }),
  delete: (path, options) => request('DELETE', path, options),
};

export function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default api;
