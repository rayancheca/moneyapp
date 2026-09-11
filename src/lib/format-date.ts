/**
 * Deterministic 'YYYY-MM-DD' → display strings, built from fixed en-US name
 * arrays and epoch-day math (never Date/locale, which varies by host and can
 * shift a day across timezones). Mirrors calendar-math's philosophy so SSR and
 * the pinned e2e clock always agree.
 */

import { isoWeekday, toEpochDay } from "./dates";

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
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

/**
 * "Aug 9" inside `reference`'s own year, "Sep 18, 2024" outside it.
 *
 * 🔴 `formatDayShort` never prints a year, so a date from another year reads as
 * THIS year's. Measured on the owner's dashboard 2026-09-02, the cards card
 * printed **"2 charges, latest Sep 18 — 714 days ago"** — the charge is from
 * September 2024, and the bare "Sep 18" reads as a day sixteen days in the
 * FUTURE, in a sentence that simultaneously calls it two years old. The two
 * halves of one phrase disagreed.
 *
 * ⛔ It takes a reference day rather than calling `todayIso()`: a formatter that
 * reads the clock cannot be used from a client component, and the surfaces that
 * need this are the ones that already have `today` in hand to compute the age
 * they print beside it. One clock, passed down — the rule this codebase already
 * follows for `dayChangeLabel`.
 */
export function formatDayShortIn(iso: string, reference: string): string {
  const year = parts(iso).y;
  return year === parts(reference).y ? formatDayShort(iso) : `${formatDayShort(iso)}, ${year}`;
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

/**
 * A window of whole MONTHS in a sentence: "Mar 2026 to Aug 2026", and just
 * "Mar 2026" when both ends are the same month. Takes month KEYS (`YYYY-MM`),
 * the form the cards carry.
 *
 * 🔴 The dashboard named ONE window two ways, on one screen. The runway,
 * eating-out and subscriptions cards printed the raw key — "Spending averaged
 * over 6 complete months, **2026-03 to 2026-08**" — while the fees and
 * transfers cards beside them, over the identical window, read "**Mar 2026 to
 * Aug 2026**". Measured 2026-09-11 by rendering all 197 routes and grepping
 * their prose for machine values: three sentences, all on `/`.
 *
 * ⛔ This is the spelling the correct siblings already used, not a new one, and
 * `fees-card` reads it too so there is a second caller keeping it honest.
 */
export function monthWindowLabel(fromMonth: string, toMonth: string): string {
  const from = formatMonthYear(`${fromMonth}-01`);
  return fromMonth === toMonth ? from : `${from} to ${formatMonthYear(`${toMonth}-01`)}`;
}
