/**
 * Input validation and normalisation. All user-supplied values pass through
 * these helpers before reaching SQL or services.
 */
import { validationError } from './errors.mjs';

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63})$/i;
const COUNTRY_RE = /^[A-Z]{2}$/;

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isEmail(value) {
  return EMAIL_RE.test(normalizeEmail(value));
}

/** Normalise a domain or URL into a bare lowercase domain. Returns '' if invalid. */
export function normalizeDomain(value) {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^mailto:/, '');
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
    const url = new URL(text);
    let host = url.hostname.replace(/\.$/, '');
    host = host.replace(/^www\./, '');
    return DOMAIN_RE.test(host) ? host : '';
  } catch {
    return '';
  }
}

export function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').slice(0, 32);
}

export function slugify(value) {
  return normalizeName(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function asString(value, { required = false, min = 0, max = 20000, trim = true, label = '字段' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validationError(`${label}不能为空`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw validationError(`${label}必须是字符串`);
  }
  let text = String(value);
  if (trim) text = text.trim();
  if (required && !text) throw validationError(`${label}不能为空`);
  if (text.length < min) throw validationError(`${label}至少需要 ${min} 个字符`);
  if (text.length > max) throw validationError(`${label}不能超过 ${max} 个字符`);
  return text;
}

export function asEmail(value, { required = true, label = '邮箱' } = {}) {
  const text = normalizeEmail(asString(value, { required, max: 320, label }));
  if (text && !isEmail(text)) throw validationError(`${label}格式不正确`);
  return text;
}

export function asDomain(value, { required = false, label = '域名' } = {}) {
  const text = asString(value, { required, max: 500, label });
  if (!text) return '';
  const domain = normalizeDomain(text);
  if (!domain) throw validationError(`${label}格式不正确`);
  return domain;
}

export function asUrl(value, { required = false, label = 'URL', protocols = ['http:', 'https:'] } = {}) {
  const text = asString(value, { required, max: 2000, label });
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!protocols.includes(url.protocol)) throw new Error('protocol');
    return url.toString();
  } catch {
    throw validationError(`${label}格式不正确`);
  }
}

export function asInt(value, { required = false, min = -2147483648, max = 2147483647, fallback = 0, label = '数值' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError(`${label}不能为空`);
    return fallback;
  }
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || !Number.isInteger(number)) throw validationError(`${label}必须是整数`);
  if (number < min || number > max) throw validationError(`${label}必须在 ${min} 到 ${max} 之间`);
  return number;
}

export function asNumber(value, { required = false, min = -1e12, max = 1e12, fallback = 0, label = '数值' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError(`${label}不能为空`);
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw validationError(`${label}不在允许范围内`);
  return number;
}

export function asBool(value, { fallback = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

export function asEnum(value, values, { required = false, fallback = null, label = '状态' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError(`${label}不能为空`);
    return fallback;
  }
  const text = String(value);
  if (!values.includes(text)) throw validationError(`${label}不在允许范围内`);
  return text;
}

export function asArray(value, { required = false, max = 500, item = null, label = '列表' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validationError(`${label}不能为空`);
    return [];
  }
  if (!Array.isArray(value)) throw validationError(`${label}必须是数组`);
  if (value.length > max) throw validationError(`${label}最多 ${max} 项`);
  return item ? value.map(item) : value;
}

export function asCountry(value, { required = false, label = '国家' } = {}) {
  const text = asString(value, { required, max: 2, label }).toUpperCase();
  if (text && !COUNTRY_RE.test(text)) throw validationError(`${label}必须是两位国家代码`);
  return text;
}

export function asIsoDate(value, { required = false, label = '时间' } = {}) {
  const text = asString(value, { required, max: 40, label });
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw validationError(`${label}格式不正确`);
  return date.toISOString();
}

export function asObject(value, { required = false, label = '对象' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validationError(`${label}不能为空`);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw validationError(`${label}必须是对象`);
  return value;
}

/**
 * Validate a plain object against a compact schema.
 * Schema: { field: { type, required, ...options, default } }
 */
export function validateInput(input, schema) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [field, spec] of Object.entries(schema)) {
    const raw = source[field];
    const isMissing = raw === undefined || raw === null || raw === '';
    if (isMissing && spec.required) {
      throw validationError(`${spec.label || field}不能为空`, { field });
    }
    if (isMissing) {
      out[field] = spec.default !== undefined ? spec.default : spec.type === 'array' ? [] : spec.type === 'bool' ? false : null;
      continue;
    }
    const label = spec.label || field;
    switch (spec.type) {
      case 'string':
        out[field] = asString(raw, { ...spec, label });
        break;
      case 'email':
        out[field] = asEmail(raw, { ...spec, label });
        break;
      case 'domain':
        out[field] = asDomain(raw, { ...spec, label });
        break;
      case 'url':
        out[field] = asUrl(raw, { ...spec, label });
        break;
      case 'int':
        out[field] = asInt(raw, { ...spec, label });
        break;
      case 'number':
        out[field] = asNumber(raw, { ...spec, label });
        break;
      case 'bool':
        out[field] = asBool(raw, spec);
        break;
      case 'enum':
        out[field] = asEnum(raw, spec.values, { ...spec, label });
        break;
      case 'array':
        out[field] = asArray(raw, { ...spec, label });
        break;
      case 'country':
        out[field] = asCountry(raw, { ...spec, label });
        break;
      case 'date':
        out[field] = asIsoDate(raw, { ...spec, label });
        break;
      case 'object':
        out[field] = asObject(raw, { ...spec, label });
        break;
      default:
        out[field] = raw;
    }
  }
  return out;
}

export function parsePagination(query, { defaultPageSize = 25, maxPageSize = 100 } = {}) {
  const requestedPage = Number.parseInt(query.get('page') || '1', 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const requested = Number.parseInt(query.get('pageSize') || String(defaultPageSize), 10);
  const size = Number.isFinite(requested) ? requested : defaultPageSize;
  const pageSize = Math.min(maxPageSize, Math.max(1, size));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

export function parseSort(query, allowed, fallback) {
  const field = String(query.get('sort') || '');
  const dir = String(query.get('order') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (allowed[field]) return { column: allowed[field], direction: dir, key: field };
  return { column: allowed[fallback.key] || 'created_at', direction: fallback.direction || 'DESC', key: fallback.key };
}

export function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

export default {
  normalizeEmail,
  normalizeDomain,
  normalizeName,
  normalizePhone,
  slugify,
  isEmail,
  asString,
  asEmail,
  asDomain,
  asUrl,
  asInt,
  asNumber,
  asBool,
  asEnum,
  asArray,
  asCountry,
  asIsoDate,
  asObject,
  validateInput,
  parsePagination,
  parseSort,
  escapeLike,
};
