/**
 * Financial dates are 'YYYY-MM-DD' strings, bank-local, no time component
 * (schema.md). All math is UTC-epoch-day based so the host timezone can
 * never shift a posting date. Weeks are ISO (Monday start); a transaction
 * belongs to the period containing posted_on, full stop.
 */

export type BudgetPeriod = "daily" | "weekly" | "monthly" | "annual";

export class DateParseError extends Error {
  constructor(input: string) {
    super(`Invalid ISO date: "${input}"`);
    this.name = "DateParseError";
  }
}

/**
 * PARSING IS THE HOT PATH. Every date comparison in the app funnels through
 * toEpochDay, and the in-flight layer alone runs ~900,000 of them per
 * forecast (one curve scan per transfer leg). The obvious implementation —
 * regex, then a `new Date(Date.UTC(...))` round-trip to reject 2026-02-30 —
 * cost 535ns a call and made date parsing 92.7% of the dashboard's CPU.
 * These read digits straight off the string and do the calendar arithmetic
 * by hand: no regex, no split, no Date allocation, no garbage.
 */

const ISO_LENGTH = 10;
const DASH = 45; // '-'
const ZERO = 48; // '0'
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `len` ASCII digits at `at` as a number; -1 when any char is not 0-9. */
function digitsAt(s: string, at: number, len: number): number {
  let n = 0;
  for (let i = at; i < at + len; i++) {
    const c = s.charCodeAt(i) - ZERO;
    if (c < 0) return -1;
    if (c > 9) return -1;
    n = n * 10 + c;
  }
  return n;
}

function isLeapYear(y: number): boolean {
  if (y % 4 !== 0) return false;
  if (y % 100 !== 0) return true;
  return y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2 && isLeapYear(y)) return 29;
  return DAYS_IN_MONTH[m - 1]!;
}

/**
 * Howard Hinnant's days_from_civil. Shifting the year to begin in March moves
 * the leap day to the very end, which turns day-of-year into a closed form
 * and makes the whole conversion branch-free integer arithmetic.
 */
function daysFromCivil(y: number, m: number, d: number): number {
  const shifted = m <= 2 ? y - 1 : y;
  const era = Math.floor(shifted / 400);
  const yoe = shifted - era * 400; // [0, 399]
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * The single place a date string is read. Returns the epoch day, or null when
 * `s` is not a real 'YYYY-MM-DD' calendar date — allocating nothing either way.
 */
function parseEpochDay(s: string): number | null {
  if (s.length !== ISO_LENGTH) return null;
  if (s.charCodeAt(4) !== DASH) return null;
  if (s.charCodeAt(7) !== DASH) return null;
  const y = digitsAt(s, 0, 4);
  // 0000-0099 have never been valid here: the old round-trip built them with
  // Date.UTC, which maps years 0-99 into 1900-1999, so its own equality check
  // rejected them. isValidIsoDate guards user input in five server actions,
  // so that boundary is load-bearing — it stays exactly where it was.
  if (y < 100) return null;
  const m = digitsAt(s, 5, 2);
  if (m < 1 || m > 12) return null;
  const d = digitsAt(s, 8, 2);
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

export function isValidIsoDate(s: string): boolean {
  return parseEpochDay(s) !== null;
}

function parts(s: string): [number, number, number] {
  if (parseEpochDay(s) === null) throw new DateParseError(s);
  return [digitsAt(s, 0, 4), digitsAt(s, 5, 2), digitsAt(s, 8, 2)];
}

const MS_PER_DAY = 86_400_000;

export function toEpochDay(s: string): number {
  const day = parseEpochDay(s);
  if (day === null) throw new DateParseError(s);
  return day;
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

/**
 * Today's date in the machine's local timezone (banks post in local days).
 * MONEYAPP_FAKE_TODAY (validated 'YYYY-MM-DD', ignored otherwise — never a
 * runtime throw) pins ONLY the zero-argument path, mirroring the
 * MONEYAPP_FAKE_PRICES idiom; an explicitly passed `now` always wins.
 *
 * SERVER-ONLY CONTRACT: never call todayIso() (or `new Date()` for a
 * rendering date) inside a 'use client' component. Next.js inlines only
 * NEXT_PUBLIC_* env vars into client bundles, so in the browser the
 * MONEYAPP_FAKE_TODAY branch is dead code and the real wall clock leaks
 * through — SSR (pinned) and hydration (real) disagree, e2e baselines drift
 * with the machine date. Clients receive dates as PROPS from a server
 * component (RSC serializes the pinned value as data across the boundary),
 * e.g. `<CalendarGrid today={todayIso()} …>` from the RSC parent.
 */
export function todayIso(now?: Date): string {
  if (now === undefined) {
    const fake = process.env.MONEYAPP_FAKE_TODAY;
    if (fake !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(fake)) return fake;
  }
  const clock = now ?? new Date();
  const y = clock.getFullYear().toString().padStart(4, "0");
  const m = (clock.getMonth() + 1).toString().padStart(2, "0");
  const d = clock.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}
