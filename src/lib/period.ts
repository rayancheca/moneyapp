/**
 * Spending-tab period model (ux-overhaul-plan §5.1). The period is URL state:
 * `?period=2026-07` (month) | `2026-Q3` (quarter) | `2026` (year), or a custom
 * `?from=…&to=…` window. Everything is 'YYYY-MM-DD' epoch-day math (dates.ts),
 * so the host timezone can never shift a boundary. Every Spending module
 * inherits one ResolvedPeriod, and its sub-buckets tile [from, to] exactly —
 * the sum of the bar-chart buckets always reconciles to the period total.
 */

import { addCalendarMonths, addDays, compareDates, diffDays, isValidIsoDate, monthKey, periodBounds } from "./dates";
import { addMonths, monthLabel } from "./calendar-math";

export type PeriodGranularity = "day" | "week" | "month" | "quarter" | "year" | "ytd" | "all" | "custom";

/**
 * The `?period=` values for the two ANCHORED ranges. Unlike day…year they do
 * not repeat — both end at today — so they page by shifting their own span,
 * the way a custom window does.
 */
const YTD_KEY = "YTD";
const ALL_KEY = "ALL";

/**
 * Where "All time" starts when the caller does not say. Only a surface with
 * database access knows the ledger's real first day, so it passes it in;
 * everything else gets a floor early enough to contain any real history and
 * late enough not to draw decades of empty axis.
 */
export const ALL_TIME_FLOOR = "2020-01-01";

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
/**
 * A window named by its own two ends — "Feb 7, 2026", "Feb 16 – 17, 2026",
 * "Sep 20, 2022 – Jul 6, 2026".
 *
 * 🔴 Exported because a SECOND surface needed it and built its own instead.
 * `merchant-insights` labelled a merchant's span by MONTH when both ends fell
 * in one, so a merchant seen on a single day was measured over that day and
 * captioned with the month around it. Measured on the owner's ledger
 * 2026-09-10: of the 66 merchant pages carrying a share sentence, **28 collapse
 * a single day into a month label and 44 overstate the month's share by 2× or
 * more.** "Empire City Entertainment Bar is 100.0% of what you spent on
 * Entertainment in Feb 2026" is one purchase on Feb 7; of February it is 1.6%.
 *
 * ⛔ The label describes the WINDOW MEASURED, never a container the window
 * happens to fit inside. That is the whole rule, and it is why this collapses
 * only what is genuinely redundant — the repeated year, the repeated month —
 * and never a day.
 */
export function dayWindowLabel(from: string, to: string): string {
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
    label: dayWindowLabel(day, day),
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
    label: dayWindowLabel(start, end),
    isCurrent: within(today, start, end),
  };
}

/**
 * Resolve the raw URL params into a concrete period. A valid custom `from&to`
 * window wins; otherwise `period` is matched as month → quarter → year;
 * anything malformed falls back to the current month of `today`.
 */
export function resolvePeriod(
  params: PeriodParams,
  today: string,
  /** the ledger's own first day — only "All time" uses it */
  earliest: string = ALL_TIME_FLOOR,
): ResolvedPeriod {
  const { period, from, to } = params;

  if (from && to && isValidIsoDate(from) && isValidIsoDate(to) && compareDates(from, to) <= 0) {
    return { granularity: "custom", key: null, from, to, label: dayWindowLabel(from, to), isCurrent: within(today, from, to) };
  }

  if (period === YTD_KEY) {
    return {
      granularity: "ytd",
      key: YTD_KEY,
      from: `${today.slice(0, 4)}-01-01`,
      to: today,
      label: `${today.slice(0, 4)} to date`,
      // always in progress: the window ends today by definition, so pace applies
      isCurrent: true,
    };
  }

  if (period === ALL_KEY) {
    // a floor later than today would invert the range; the ledger cannot start
    // in the future, but a bad `earliest` must not produce from > to
    const start = compareDates(earliest, today) <= 0 ? earliest : today;
    return { granularity: "all", key: ALL_KEY, from: start, to: today, label: "All time", isCurrent: true };
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
    case "ytd": {
      /*
       * The useful comparison is the SAME window a year earlier ("2025 to
       * date"), not the previous N days.
       *
       * 🔴 The end used to be spliced as `${y}${period.to.slice(4)}`, which on
       * a leap day builds the string "2027-02-29" — not a date. `resolvePeriod`
       * rejects it and falls back to the CURRENT MONTH, so a reader asking for
       * the prior year to date silently gets four weeks instead. Stepping by
       * calendar months clamps instead of fabricating, and gets 2024-02-29 back
       * four years later, which splicing also could not do.
       */
      const y = Number(period.from.slice(0, 4)) + delta;
      return { from: `${pad(y, 4)}-01-01`, to: addCalendarMonths(period.to, delta * 12) };
    }
    case "all":
    case "custom": {
      // "all" shifts by its own span like a custom window: the window before
      // the ledger began is genuinely empty, which is what a prior-period
      // comparison should find
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
    // both anchored ranges end at TODAY, so there is nothing of the old period
    // to carry over — switching into them always lands on the live window
    case "ytd":
      return { period: YTD_KEY };
    case "all":
      return { period: ALL_KEY };
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
    case "ytd":
      return { period: YTD_KEY };
    case "all":
      return { period: ALL_KEY };
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
    case "ytd":
      return "Year to date";
    case "all":
      return "All time";
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
  // a window spanning more than one calendar year repeats every month name, so
  // "Aug" alone would label four different Augusts identically down one column
  const multiYear = period.from.slice(0, 4) !== period.to.slice(0, 4);
  while (true) {
    const { start, end } = periodBounds(`${cursor}-01`, "monthly");
    const month = Number(cursor.slice(5, 7));
    const from = clamp(start, period.from, period.to);
    const to = clamp(end, period.from, period.to);
    const whole = from === start && to === end;
    out.push({
      key: cursor,
      from,
      to,
      label: whole
        ? multiYear
          ? `${monthShort(month)} '${cursor.slice(2, 4)}`
          : monthShort(month)
        : partialMonthLabel(from, to, multiYear),
    });
    if (cursor === lastMonth) break;
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/**
 * A month bucket CLAMPED to part of its month, named by the days it holds.
 *
 * 🔴 It was named by the whole month. The bucket's `from`/`to` are clamped to
 * the period — the docstring above says so and `period.test.ts` pinned it —
 * and only the LABEL kept the container's name, which is the same error one
 * level down from a merchant's share captioned with the month around it.
 * Measured 2026-09-10: `?period=YTD` draws nine bars and the last, reading
 * "Sep", holds ten days; `?period=ALL` clamps at both ends, its first bar
 * reading "Aug '22" over six days of it. A custom `from=2026-06-15` window's
 * first bar read "Jun" over half a June. Every one of them is a bar a reader
 * compares against eleven whole months beside it.
 *
 * ⛔ Compact rather than `dayWindowLabel`'s prose form: this is an axis tick,
 * and `chart-axis.ts` already writes months short for the same reason. The
 * year rides along only where the window repeats month names, exactly as the
 * whole-month label does — a partial bucket must stay as distinguishable as
 * the bucket it replaces.
 */
function partialMonthLabel(from: string, to: string, withYear: boolean): string {
  const month = monthShort(Number(from.slice(5, 7)));
  const first = Number(from.slice(8, 10));
  const last = Number(to.slice(8, 10));
  const days = first === last ? `${first}` : `${first}–${last}`;
  return withYear ? `${month} ${days} '${from.slice(2, 4)}` : `${month} ${days}`;
}

/**
 * The month the day-heatmap opens on for a period: today's month when the
 * period is in progress, else the period's last (past) or first (future) month.
 */
export function heatmapInitialMonth(period: ResolvedPeriod, today: string): string {
  return monthKey(clamp(today, period.from, period.to));
}
