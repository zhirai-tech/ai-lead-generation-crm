/** Time helpers. Stored timestamps are ISO-8601 UTC strings (sortable in SQLite). */

export function nowIso() {
  return new Date().toISOString();
}

export function toIso(value = Date.now()) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function addMs(ms, from = Date.now()) {
  return new Date(from + ms).toISOString();
}

export function addMinutes(minutes, from = Date.now()) {
  return addMs(minutes * 60_000, from);
}

export function addHours(hours, from = Date.now()) {
  return addMs(hours * 3_600_000, from);
}

export function addDays(days, from = Date.now()) {
  return addMs(days * 86_400_000, from);
}

export function isPast(iso, now = Date.now()) {
  if (!iso) return false;
  return new Date(iso).getTime() <= now;
}

export function isBefore(a, b) {
  return new Date(a).getTime() < new Date(b).getTime();
}

/** UTC day key, `2026-10-22`. */
export function dayKey(value = Date.now()) {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

/** Local time parts for a given IANA timezone (used by send windows). */
export function zonedParts(value = Date.now(), timeZone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hourCycle: 'h23',
    });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: days[parts.weekday] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export default { nowIso, toIso, addMs, addMinutes, addHours, addDays, isPast, isBefore, dayKey, zonedParts, formatDurationMs };
