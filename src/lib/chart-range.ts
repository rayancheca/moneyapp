/**
 * Range-pill windows for the ScrubChart (ux-overhaul-plan §6.3). Daily
 * granularity, stated honestly — the M/Y windows are trailing day counts (no
 * fake intraday, no calendar-month clamp edge cases), YTD is the calendar year.
 * Pure so the window math is unit-tested; the chart slices its points by the
 * returned start day.
 */

import { addDays } from "./dates";

export const CHART_RANGES = ["1M", "3M", "YTD", "1Y", "ALL"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

const TRAILING_DAYS: Partial<Record<ChartRange, number>> = {
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
  "1M": "1 month",
  "3M": "3 months",
  YTD: "year to date",
  "1Y": "1 year",
  ALL: "all time",
};

export function rangeLabel(range: ChartRange): string {
  return RANGE_LABEL[range];
}
