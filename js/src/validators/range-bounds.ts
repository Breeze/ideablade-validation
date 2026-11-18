/**
 * Resolves range bounds used by the `range`, `dateRange` and `numericRange` validators.
 *
 * Supported bound values:
 * - numbers, or numeric strings (`"10"`)
 * - `Date` instances and ISO / parseable date strings (`"2024-01-31"`, `"01/31/2024"`)
 * - relative dates: `now`, `today`, `now-18y`, `today+30d`, `now+2h` — units: y (years), M (months),
 *   w (weeks), d (days), h (hours), m (minutes). A missing unit means years (`now-18` = 18 years ago).
 * - relative years: `year`, `year+1`, `year-5` → a number (the calendar year)
 */
const RELATIVE = /^\s*(now|today)\s*(?:([+-])\s*(\d+)\s*([yMwdhm])?)?\s*$/i;
const RELATIVE_YEAR = /^\s*year\s*(?:([+-])\s*(\d+))?\s*$/i;
const MAX_YEARS = 150;

export function resolveBound(bound: unknown, now: Date = new Date()): number | Date | string | undefined {
  if (bound == null || bound === '') {
    return undefined;
  }
  if (typeof bound === 'number' || bound instanceof Date) {
    return bound;
  }
  if (typeof bound !== 'string') {
    return undefined;
  }
  const trimmed = bound.trim();
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }

  const year = RELATIVE_YEAR.exec(trimmed);
  if (year) {
    const offset = year[2] ? Math.min(Number(year[2]), MAX_YEARS) : 0;
    return now.getFullYear() + (year[1] === '-' ? -offset : offset);
  }

  const rel = RELATIVE.exec(trimmed);
  if (rel) {
    const base = new Date(now.getTime());
    if (rel[1].toLowerCase() === 'today') {
      base.setHours(0, 0, 0, 0);
    }
    if (rel[2]) {
      const sign = rel[2] === '-' ? -1 : 1;
      const unit = rel[4] ?? 'y';
      const amount = unit === 'y' ? Math.min(Number(rel[3]), MAX_YEARS) : Number(rel[3]);
      addToDate(base, sign * amount, unit);
    }
    return base;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? trimmed : new Date(parsed);
}

function addToDate(date: Date, amount: number, unit: string): void {
  switch (unit) {
    case 'y':
      date.setFullYear(date.getFullYear() + amount);
      break;
    case 'M':
      date.setMonth(date.getMonth() + amount);
      break;
    case 'w':
      date.setDate(date.getDate() + amount * 7);
      break;
    case 'd':
      date.setDate(date.getDate() + amount);
      break;
    case 'h':
      date.setHours(date.getHours() + amount);
      break;
    case 'm':
      date.setMinutes(date.getMinutes() + amount);
      break;
    case 'Y':
    case 'D':
    case 'H':
    case 'W':
      addToDate(date, amount, unit.toLowerCase());
      break;
  }
}

/** Converts a value to something comparable with the given bound (Date → epoch ms, otherwise number). */
export function toComparable(value: unknown, likeBound: unknown): number | undefined {
  if (likeBound instanceof Date) {
    const d = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
    const t = d?.getTime();
    return t === undefined || Number.isNaN(t) ? undefined : t;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, '').trim());
    return value.trim() === '' || Number.isNaN(n) ? undefined : n;
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) ? undefined : value;
  }
  return undefined;
}

/** Formats a resolved bound for messages. */
export function formatBound(bound: unknown, format?: (d: Date) => string): string {
  if (bound instanceof Date) {
    return format ? format(bound) : bound.toLocaleDateString();
  }
  return bound == null ? '' : String(bound);
}
