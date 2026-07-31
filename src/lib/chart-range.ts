/**
 * Range-pill windows for the ScrubChart (ux-overhaul-plan §6.3). Daily
 * granularity, stated honestly — the M/Y windows are trailing day counts (no
 * fake intraday, no calendar-month clamp edge cases), YTD is the calendar year.
 * Pure so the window math is unit-tested; the chart slices its points by the
 * returned start day.
 */

import { addDays } from "./dates";

/**
 * Shortest first. 1D and 1W were added 2026-07-31 on the owner's ask ("i also
 * need a week and day view").
 *
 * 1D is genuinely one TRAILING DAY on a daily series — yesterday and today, so
 * the chart draws the day's move as a single segment. That is the honest reading
 * of "day view" for a ledger with no intraday prices: it is the change since the
 * previous close, not a tick chart. If the series has not reached yesterday
 * (prices unrefreshed), the window holds too few points and the chart says so
 * rather than quietly widening — see ScrubChart's fell-back note.
 */
export const CHART_RANGES = ["1D", "1W", "1M", "3M", "YTD", "1Y", "ALL"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

/**
 * The pills a surface may offer when its series is DAILY by construction and no
 * intraday exists behind it.
 *
 * `1D` is dropped rather than left to fall back. On a daily series it can only
 * ever mean "yesterday and today" — a two-point segment that looks like a day
 * view, is captioned like a day view, and is not one. Net worth and account
 * balances come from `daily_balances`, and the money-flow Sankey aggregates
 * transactions by `posted_on`; none of the three has an instant to plot, and no
 * amount of fetching would give them one.
 *
 * Only /investments and a single holding keep `1D`, because only they are backed
 * by `price_intraday`. Derived from CHART_RANGES rather than restated so a new
 * range is offered everywhere by default — the surface that must opt OUT is the
 * exception, and exceptions should be the thing you have to write down.
 */
export const DAILY_SERIES_RANGES: readonly ChartRange[] = CHART_RANGES.filter((r) => r !== "1D");

const TRAILING_DAYS: Partial<Record<ChartRange, number>> = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "3M": 91,
  "1Y": 365,
};

/**
 * The inclusive lower-bound day for a range, or null for ALL (no lower bound).
 * Trailing windows count back from `today`; YTD anchors to Jan 1 of its year.
 */
export function rangeStartDay(range: ChartRange, today: string): string | null {
  if (range === "ALL") return null;
  if (range === "YTD") return `${today.slice(0, 4)}-01-01`;
  return addDays(today, -TRAILING_DAYS[range]!);
}

/** Human label for a range pill's accessible name / summary. */
const RANGE_LABEL: Record<ChartRange, string> = {
  "1D": "1 day",
  "1W": "1 week",
  "1M": "1 month",
  "3M": "3 months",
  YTD: "year to date",
  "1Y": "1 year",
  ALL: "all time",
};

export function rangeLabel(range: ChartRange): string {
  return RANGE_LABEL[range];
}
