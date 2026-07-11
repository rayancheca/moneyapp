/**
 * Deterministic 'YYYY-MM-DD' → display strings, built from fixed en-US name
 * arrays and epoch-day math (never Date/locale, which varies by host and can
 * shift a day across timezones). Mirrors calendar-math's philosophy so SSR and
 * the pinned e2e clock always agree.
 */

import { isoWeekday, toEpochDay } from "./dates";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
// isoWeekday: 0 = Monday … 6 = Sunday
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function parts(iso: string): { y: number; m: number; d: number } {
  toEpochDay(iso); // validates (throws DateParseError on malformed input)
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

/** "Jul 3" */
export function formatDayShort(iso: string): string {
  const { m, d } = parts(iso);
  return `${MONTHS_SHORT[m - 1]} ${d}`;
}

/** "Fri, Jul 3, 2026" */
export function formatDayLong(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${WEEKDAYS_SHORT[isoWeekday(iso)]}, ${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

/** "Jul 2026" */
export function formatMonthYear(iso: string): string {
  const { y, m } = parts(iso);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}
