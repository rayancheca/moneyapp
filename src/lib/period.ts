/**
 * Spending-tab period model (ux-overhaul-plan §5.1). The period is URL state:
 * `?period=2026-07` (month) | `2026-Q3` (quarter) | `2026` (year), or a custom
 * `?from=…&to=…` window. Everything is 'YYYY-MM-DD' epoch-day math (dates.ts),
 * so the host timezone can never shift a boundary. Every Spending module
 * inherits one ResolvedPeriod, and its sub-buckets tile [from, to] exactly —
 * the sum of the bar-chart buckets always reconciles to the period total.
 */

import { addDays, compareDates, diffDays, isValidIsoDate, monthKey, periodBounds } from "./dates";
import { addMonths, monthLabel } from "./calendar-math";

export type PeriodGranularity = "day" | "week" | "month" | "quarter" | "year" | "custom";

export interface ResolvedPeriod {
  granularity: PeriodGranularity;
  /** canonical `?period=` value for month/quarter/year; null for custom */
  key: string | null;
  /** inclusive ISO start */
  from: string;
  /** inclusive ISO end */
  to: string;
  label: string;
  /** today ∈ [from, to] — the period is still in progress, so pace applies */
  isCurrent: boolean;
}

export interface PeriodParams {
  period?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface PeriodBucket {
  /** stable key for React + the chart axis */
  key: string;
  /** inclusive ISO start, clamped to the period */
  from: string;
  /** inclusive ISO end, clamped to the period */
  to: string;
  /** short axis label ("3" for a day, "Jul" for a month) */
  label: string;
}

const MONTH_ABBREVS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;
const YEAR_RE = /^(\d{4})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `W2026-07-13` — any in-week date normalizes to its Monday (weekStartsOn: monday) */
const WEEK_RE = /^W(\d{4}-\d{2}-\d{2})$/;

/** Longest span (days) a custom window buckets by DAY before switching to months. */
const CUSTOM_DAY_BUCKET_MAX = 45;

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

/** 1–4 for a 1–12 month. */
export function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

/** Inclusive bounds of quarter q (1–4) in year y. */
export function quarterBounds(year: number, quarter: number): { from: string; to: string } {
  const startMonth = (quarter - 1) * 3 + 1;
  const from = `${pad(year, 4)}-${pad(startMonth, 2)}-01`;
  const endMonthStart = `${pad(year, 4)}-${pad(startMonth + 2, 2)}-01`;
  return { from, to: periodBounds(endMonthStart, "monthly").end };
}

function monthShort(month: number): string {
  return MONTH_ABBREVS[month - 1]!;
}

/** "Jul 3 – Jul 20, 2026" (drops the redundant year/month where it repeats). */
function customLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  if (from === to) return `${monthShort(fm)} ${fd}, ${fy}`;
  const left = `${monthShort(fm)} ${fd}`;
  if (fy !== ty) return `${left}, ${fy} – ${monthShort(tm)} ${td}, ${ty}`;
  const right = fm === tm ? `${td}` : `${monthShort(tm)} ${td}`;
  return `${left} – ${right}, ${ty}`;
}

function monthPeriod(year: number, month: number, today: string): ResolvedPeriod {
  const key = `${pad(year, 4)}-${pad(month, 2)}`;
  const { start, end } = periodBounds(`${key}-01`, "monthly");
  return {
    granularity: "month",
    key,
    from: start,
    to: end,
    label: monthLabel(key),
    isCurrent: within(today, start, end),
  };
}

function quarterPeriod(year: number, quarter: number, today: string): ResolvedPeriod {
  const { from, to } = quarterBounds(year, quarter);
  return {
    granularity: "quarter",
    key: `${pad(year, 4)}-Q${quarter}`,
    from,
    to,
    label: `Q${quarter} ${year}`,
    isCurrent: within(today, from, to),
  };
}

function yearPeriod(year: number, today: string): ResolvedPeriod {
  const from = `${pad(year, 4)}-01-01`;
  const to = `${pad(year, 4)}-12-31`;
  return {
    granularity: "year",
    key: pad(year, 4),
    from,
    to,
    label: pad(year, 4),
    isCurrent: within(today, from, to),
  };
}

function within(day: string, from: string, to: string): boolean {
  return compareDates(day, from) >= 0 && compareDates(day, to) <= 0;
}

function dayPeriod(day: string, today: string): ResolvedPeriod {
  return {
    granularity: "day",
    key: day,
    from: day,
    to: day,
    label: customLabel(day, day),
    isCurrent: day === today,
  };
}

/** Monday→Sunday around ANY in-week anchor (periodBounds owns the week math). */
function weekPeriod(anchor: string, today: string): ResolvedPeriod {
  const { start, end } = periodBounds(anchor, "weekly");
  return {
    granularity: "week",
    key: `W${start}`,
    from: start,
    to: end,
    label: customLabel(start, end),
    isCurrent: within(today, start, end),
  };
}

/**
 * Resolve the raw URL params into a concrete period. A valid custom `from&to`
 * window wins; otherwise `period` is matched as month → quarter → year;
 * anything malformed falls back to the current month of `today`.
 */
export function resolvePeriod(params: PeriodParams, today: string): ResolvedPeriod {
  const { period, from, to } = params;

  if (from && to && isValidIsoDate(from) && isValidIsoDate(to) && compareDates(from, to) <= 0) {
    return { granularity: "custom", key: null, from, to, label: customLabel(from, to), isCurrent: within(today, from, to) };
  }

  if (period) {
    const m = MONTH_RE.exec(period);
    if (m) {
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) return monthPeriod(Number(m[1]), month, today);
    }
    const q = QUARTER_RE.exec(period);
    if (q) return quarterPeriod(Number(q[1]), Number(q[2]), today);
    const y = YEAR_RE.exec(period);
    if (y) return yearPeriod(Number(y[1]), today);
    const w = WEEK_RE.exec(period);
    if (w && isValidIsoDate(w[1]!)) return weekPeriod(w[1]!, today);
    if (DAY_RE.test(period) && isValidIsoDate(period)) return dayPeriod(period, today);
  }

  const [ty, tm] = monthKey(today).split("-").map(Number) as [number, number];
  return monthPeriod(ty, tm, today);
}

/** ‹ › paging within the same granularity. Returns fresh URL params. */
export function stepPeriodParams(period: ResolvedPeriod, delta: number): PeriodParams {
  switch (period.granularity) {
    case "day":
      return { period: addDays(period.key!, delta) };
    case "week":
      return { period: `W${addDays(period.from, delta * 7)}` };
    case "month":
      return { period: addMonths(period.key!, delta) };
    case "quarter": {
      const [y, q] = period.key!.split("-Q").map(Number) as [number, number];
      const total = y * 4 + (q - 1) + delta;
      const ny = Math.floor(total / 4);
      const nq = total - ny * 4 + 1;
      return { period: `${pad(ny, 4)}-Q${nq}` };
    }
    case "year":
      return { period: pad(Number(period.key) + delta, 4) };
    case "custom": {
      const span = diffDays(period.from, period.to) + 1;
      return { from: addDays(period.from, delta * span), to: addDays(period.to, delta * span) };
    }
  }
}

/**
 * Switch month ⇄ quarter ⇄ year, anchored on the period's start date so the
 * new period contains the old one's beginning. Custom windows anchor on `from`.
 */
export function switchGranularityParams(
  period: ResolvedPeriod,
  target: Exclude<PeriodGranularity, "custom">,
): PeriodParams {
  const [y, m] = period.from.split("-").map(Number) as [number, number, number];
  switch (target) {
    case "day":
      return { period: period.from };
    case "week":
      return { period: `W${periodBounds(period.from, "weekly").start}` };
    case "month":
      return { period: `${pad(y, 4)}-${pad(m, 2)}` };
    case "quarter":
      return { period: `${pad(y, 4)}-Q${quarterOfMonth(m)}` };
    case "year":
      return { period: pad(y, 4) };
  }
}

/** The reset target: TODAY's period at a granularity ("This week" → this week). */
export function currentPeriodParams(
  granularity: Exclude<PeriodGranularity, "custom">,
  today: string,
): PeriodParams {
  switch (granularity) {
    case "day":
      return { period: today };
    case "week":
      return { period: `W${periodBounds(today, "weekly").start}` };
    case "month":
      return { period: monthKey(today) };
    case "quarter": {
      const [y, m] = today.split("-").map(Number) as [number, number];
      return { period: `${pad(y, 4)}-Q${quarterOfMonth(m)}` };
    }
    case "year":
      return { period: today.slice(0, 4) };
  }
}

/** The reset link's label per granularity ("Today", "This week", …). */
export function currentPeriodLabel(granularity: Exclude<PeriodGranularity, "custom">): string {
  switch (granularity) {
    case "day":
      return "Today";
    case "week":
      return "This week";
    case "month":
      return "This month";
    case "quarter":
      return "This quarter";
    case "year":
      return "This year";
  }
}

function clamp(day: string, from: string, to: string): string {
  if (compareDates(day, from) < 0) return from;
  if (compareDates(day, to) > 0) return to;
  return day;
}

/**
 * The chart's granularity buckets, tiling [from, to] exactly (clamped, no gaps
 * or overlaps): a month buckets by DAY, quarter/year by MONTH, and a custom
 * window by day when short (≤45d) else by month.
 */
export function subBuckets(period: ResolvedPeriod): PeriodBucket[] {
  const byDay =
    period.granularity === "day" ||
    period.granularity === "week" ||
    period.granularity === "month" ||
    (period.granularity === "custom" && diffDays(period.from, period.to) + 1 <= CUSTOM_DAY_BUCKET_MAX);

  if (byDay) {
    const out: PeriodBucket[] = [];
    for (let iso = period.from; compareDates(iso, period.to) <= 0; iso = addDays(iso, 1)) {
      out.push({ key: iso, from: iso, to: iso, label: String(Number(iso.slice(8, 10))) });
    }
    return out;
  }

  // month buckets, clamped to the period
  const out: PeriodBucket[] = [];
  let cursor = monthKey(period.from);
  const lastMonth = monthKey(period.to);
  while (true) {
    const { start, end } = periodBounds(`${cursor}-01`, "monthly");
    const month = Number(cursor.slice(5, 7));
    out.push({
      key: cursor,
      from: clamp(start, period.from, period.to),
      to: clamp(end, period.from, period.to),
      label: monthShort(month),
    });
    if (cursor === lastMonth) break;
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/**
 * The month the day-heatmap opens on for a period: today's month when the
 * period is in progress, else the period's last (past) or first (future) month.
 */
export function heatmapInitialMonth(period: ResolvedPeriod, today: string): string {
  return monthKey(clamp(today, period.from, period.to));
}
