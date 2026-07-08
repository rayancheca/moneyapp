/**
 * Financial dates are 'YYYY-MM-DD' strings, bank-local, no time component
 * (schema.md). All math is UTC-epoch-day based so the host timezone can
 * never shift a posting date. Weeks are ISO (Monday start); a transaction
 * belongs to the period containing posted_on, full stop.
 */

export type BudgetPeriod = "daily" | "weekly" | "monthly" | "annual";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateParseError extends Error {
  constructor(input: string) {
    super(`Invalid ISO date: "${input}"`);
    this.name = "DateParseError";
  }
}

export function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function parts(s: string): [number, number, number] {
  if (!isValidIsoDate(s)) throw new DateParseError(s);
  const [y, m, d] = s.split("-");
  return [Number(y), Number(m), Number(d)];
}

const MS_PER_DAY = 86_400_000;

export function toEpochDay(s: string): number {
  const [y, m, d] = parts(s);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

export function fromEpochDay(day: number): string {
  const date = new Date(day * MS_PER_DAY);
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(s: string, n: number): string {
  return fromEpochDay(toEpochDay(s) + n);
}

/** b − a in days. */
export function diffDays(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDates(a: string, b: string): number {
  return toEpochDay(a) - toEpochDay(b);
}

/** 0 = Monday … 6 = Sunday (ISO). */
export function isoWeekday(s: string): number {
  // epoch day 0 = 1970-01-01, a Thursday (ISO index 3)
  return (((toEpochDay(s) + 3) % 7) + 7) % 7;
}

export interface PeriodBounds {
  /** inclusive */
  start: string;
  /** inclusive */
  end: string;
}

export function periodBounds(date: string, period: BudgetPeriod): PeriodBounds {
  const [y, m] = parts(date);
  switch (period) {
    case "daily":
      return { start: date, end: date };
    case "weekly": {
      const start = addDays(date, -isoWeekday(date));
      return { start, end: addDays(start, 6) };
    }
    case "monthly": {
      const start = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
      const nextMonth = m === 12 ? `${(y + 1).toString().padStart(4, "0")}-01-01` : `${y.toString().padStart(4, "0")}-${(m + 1).toString().padStart(2, "0")}-01`;
      return { start, end: addDays(nextMonth, -1) };
    }
    case "annual":
      return { start: `${y.toString().padStart(4, "0")}-01-01`, end: `${y.toString().padStart(4, "0")}-12-31` };
  }
}

/** 'YYYY-MM' bucket key. */
export function monthKey(date: string): string {
  const [y, m] = parts(date);
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}`;
}

/** Today's date in the machine's local timezone (banks post in local days). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear().toString().padStart(4, "0");
  const m = (now.getMonth() + 1).toString().padStart(2, "0");
  const d = now.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}
