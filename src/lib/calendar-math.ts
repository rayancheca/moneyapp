/**
 * Month-grid math for CalendarGrid. Same conventions as dates.ts: days are
 * "YYYY-MM-DD" ISO strings, months are "YYYY-MM" keys, and all arithmetic is
 * epoch-day based so the host timezone can never shift a cell.
 */

import { addDays, diffDays, isoWeekday } from "./dates";

export interface CalendarDay {
  iso: string;
  inMonth: boolean;
}

/** 0 = Sunday-start weeks, 1 = Monday-start weeks. */
export type WeekStart = 0 | 1;

export class MonthKeyParseError extends Error {
  constructor(input: string) {
    super(`Invalid month key: "${input}"`);
    this.name = "MonthKeyParseError";
  }
}

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

// Fixed en-US names — never Date/locale formatting, which varies by host.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_ABBREVS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

/** [year, month(1-12)] — throws MonthKeyParseError on anything else. */
function monthParts(monthKey: string): [number, number] {
  const m = MONTH_KEY_RE.exec(monthKey);
  if (!m) throw new MonthKeyParseError(monthKey);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new MonthKeyParseError(monthKey);
  return [year, month];
}

export function addMonths(monthKey: string, delta: number): string {
  const [year, month] = monthParts(monthKey);
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return `${pad(y, 4)}-${pad(m, 2)}`;
}

/** "July 2026" — built from the const name array, no Date locale surprises. */
export function monthLabel(monthKey: string): string {
  const [year, month] = monthParts(monthKey);
  // monthParts guarantees 1-12, so this lookup cannot miss
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

export function weekdayLabels(weekStartsOn: WeekStart): string[] {
  return [...WEEKDAY_ABBREVS.slice(weekStartsOn), ...WEEKDAY_ABBREVS.slice(0, weekStartsOn)];
}

/**
 * Complete weeks covering the month (4-6 rows of 7), leading/trailing
 * out-of-month days included so the grid is always rectangular.
 */
/**
 * How many days a month has, 28–31 — derived from the calendar rather than a
 * lookup table, so February's leap years need no special case.
 *
 * Exported because `monthMatrix` is the wrong shape for a caller that wants the
 * month as a LINE rather than as weeks: the recurring calendar's running-total
 * strip walks day 1 to day N on one axis, and counting the matrix's in-month
 * cells to recover N would be deriving the same fact a second way.
 */
export function daysInMonthOf(monthKey: string): number {
  const [year, month] = monthParts(monthKey);
  const key = `${pad(year, 4)}-${pad(month, 2)}`;
  return diffDays(`${key}-01`, `${addMonths(key, 1)}-01`);
}

export function monthMatrix(monthKey: string, weekStartsOn: WeekStart = 0): CalendarDay[][] {
  const [year, month] = monthParts(monthKey);
  const key = `${pad(year, 4)}-${pad(month, 2)}`;
  const first = `${key}-01`;
  // isoWeekday is Monday-based (0=Mon…6=Sun); shift to Sunday-based, then to
  // the chosen week start to find how many leading out-of-month cells pad row 1
  const sundayBased = (isoWeekday(first) + 1) % 7;
  const lead = (sundayBased - weekStartsOn + 7) % 7;
  const gridStart = addDays(first, -lead);
  const daysInMonth = diffDays(first, `${addMonths(key, 1)}-01`);
  const weekCount = Math.ceil((lead + daysInMonth) / 7);
  return Array.from({ length: weekCount }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const iso = addDays(gridStart, w * 7 + d);
      return { iso, inMonth: iso.slice(0, 7) === key };
    }),
  );
}
