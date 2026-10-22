/**
 * OWNER: t-worker. Handler-level error type (kept in its own module so handler
 * files do not need a circular import back into the registry).
 */
export class JobError extends Error {
  constructor(message, { retryable = true, code = 'JOB_ERROR', retryDelayMs = null, cause = undefined } = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.retryable = retryable;
    if (Number.isFinite(retryDelayMs)) this.retryDelayMs = Math.max(0, retryDelayMs);
    if (cause) this.cause = cause;
  }
}

export function requirePayloadField(payload, field) {
  const value = payload && payload[field];
  if (!value || typeof value !== 'string') {
    throw new JobError(`任务缺少必填参数 ${field}`, { retryable: false, code: 'JOB_INVALID_PAYLOAD' });
  }
  return value;
}

export default { JobError, requirePayloadField };
