/** Formatting helpers for dates, numbers, money and text. */

const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const DATETIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_FORMAT.format(date);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATETIME_FORMAT.format(date);
}

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return TIME_FORMAT.format(date);
}

export function relativeTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units = [
    [60_000, '秒', 1000],
    [3_600_000, '分钟', 60_000],
    [86_400_000, '小时', 3_600_000],
    [2_592_000_000, '天', 86_400_000],
    [31_536_000_000, '个月', 2_592_000_000],
  ];
  if (abs < 60_000) return '刚刚';
  for (let index = 1; index < units.length; index += 1) {
    const [limit, label, divisor] = units[index];
    if (abs < limit) {
      const count = Math.floor(abs / divisor);
      return future ? `${count} ${label}后` : `${count} ${label}前`;
    }
  }
  const years = Math.floor(abs / 31_536_000_000);
  return future ? `${years} 年后` : `${years} 年前`;
}

export function formatNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (Math.abs(number) >= 10_000) return `${(number / 1000).toFixed(1)}k`;
  return formatNumber(number);
}

export function formatMoney(value, currency = 'EUR') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(number);
  } catch {
    return `${formatNumber(number)} ${currency}`;
  }
}

export function formatPercent(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  return `${(number * 100).toFixed(digits)}%`;
}

export function truncate(value, length = 80) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function initials(name) {
  const clean = String(name || '').trim();
  if (!clean) return '?';
  if (/[A-Za-z]/.test(clean)) {
    return clean
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();
  }
  return clean.slice(0, 1);
}

export function domainOf(url) {
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

export function plural(value, word) {
  return `${formatNumber(value)} ${word}`;
}

export function countryName(code) {
  if (!code) return '';
  try {
    const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    return names.of(String(code).toUpperCase()) || code;
  } catch {
    return code;
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export default {
  formatDate,
  formatDateTime,
  formatTime,
  relativeTime,
  formatNumber,
  formatCompact,
  formatMoney,
  formatPercent,
  truncate,
  initials,
  domainOf,
  plural,
  countryName,
  escapeHtml,
};
