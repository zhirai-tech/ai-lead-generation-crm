/**
 * Typed application errors. The HTTP layer turns these into safe JSON error
 * responses without leaking stack traces or database internals to clients.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details = undefined, expose = true, cause = undefined } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = expose;
    if (cause) this.cause = cause;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export const badRequest = (message = '请求参数不正确', details) =>
  new AppError('BAD_REQUEST', message, { status: 400, details });

export const validationError = (message = '数据校验失败', details) =>
  new AppError('VALIDATION_ERROR', message, { status: 422, details });

export const unauthorized = (message = '请先登录', details) =>
  new AppError('UNAUTHORIZED', message, { status: 401, details });

export const forbidden = (message = '没有执行该操作的权限', details) =>
  new AppError('FORBIDDEN', message, { status: 403, details });

export const notFound = (message = '资源不存在', details) =>
  new AppError('NOT_FOUND', message, { status: 404, details });

export const conflict = (message = '操作与当前状态冲突', details) =>
  new AppError('CONFLICT', message, { status: 409, details });

export const tooManyRequests = (message = '请求过于频繁，请稍后再试', details) =>
  new AppError('RATE_LIMITED', message, { status: 429, details });

export const internal = (message = '服务器内部错误', details) =>
  new AppError('INTERNAL_ERROR', message, { status: 500, details, expose: false });

export const notImplemented = (message = '功能尚未实现') =>
  new AppError('NOT_IMPLEMENTED', message, { status: 501 });

export function assert(condition, errorFactory) {
  if (!condition) throw typeof errorFactory === 'function' ? errorFactory() : errorFactory;
}

export function isAppError(error) {
  return error instanceof AppError;
}

export default {
  AppError,
  badRequest,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  internal,
  notImplemented,
  assert,
  isAppError,
};
