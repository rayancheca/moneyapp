import { diffDays } from "./dates";
import { formatDayShort, MONTHS_SHORT } from "./format-date";

/**
 * Axis math for the net-worth chart (dashboard §7.1). Pure so the "always a good
 * graph" guarantees are unit-tested: a nice-number y-scale that frames any window
 * cleanly, adaptive x-ticks on real calendar boundaries, compact money labels,
 * and the window's peak/trough. The chart owns rendering; this owns the numbers.
 */

// ── Y axis: nice-number linear scale ─────────────────────────────────

export interface LinearTicks {
  /** [lo, hi] rounded out to the tick step — the recharts YAxis domain */
  domain: [number, number];
  /** evenly-spaced round tick values across the domain */
  ticks: number[];
}

/**
 * The 1/2/2.5/5/10 "nice" step at or above a rough spacing (Heckbert). The sole
 * caller (`niceLinearTicks`) guarantees a finite `rough > 0` — it guards
 * non-finite input and synthesizes a band for a flat window before dividing.
 */
function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / magnitude; // 1..10
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * A nice-number y-scale covering [min, max] with ~targetCount round ticks. The
 * domain is rounded OUT to the step, so the line never clips and the ticks are
 * always clean round values — a flat window (min == max) gets a synthesized band
 * so it renders as a centered line rather than a divide-by-zero. Frames the data
 * range (not forced to zero): net worth is about change, and a $92k–$94k window
 * must show its $2k of movement, not a flat line pinned under a $0 axis.
 */
export function niceLinearTicks(min: number, max: number, targetCount = 5): LinearTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [0, 1], ticks: [0, 1] };
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    const band = Math.max(1, Math.abs(lo) * 0.05);
    lo -= band;
    hi += band;
  }
  const count = Math.max(2, targetCount);
  const step = niceStep((hi - lo) / (count - 1));
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin, i = 0; v <= niceMax + step * 1e-6 && i < 200; v += step, i += 1) {
    ticks.push(Math.round(v));
  }
  return { domain: [Math.round(niceMin), Math.round(niceMax)], ticks };
}

// ── X axis: adaptive calendar ticks ──────────────────────────────────

export interface DateTick {
  day: string;
  label: string;
}

const DAY_STEPS = [1, 2, 3, 7, 14] as const;
const MONTH_STEPS = [1, 2, 3, 6, 12] as const;

/** Smallest step from `steps` at or above `rough` (largest if none reaches it). */
function pickStep(rough: number, steps: readonly number[]): number {
  for (const s of steps) if (s >= rough) return s;
  return steps[steps.length - 1]!;
}

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

function monthStartOnOrAfter(day: string): string {
  const [y, m, d] = ymd(day);
  if (d === 1) return day;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

function addMonths(monthStart: string, step: number): string {
  const [y, m] = ymd(monthStart);
  const total = (y * 12 + (m - 1)) + step;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/** "Jul" or, with the year, "Jul ’25". */
function monthLabel(day: string, withYear: boolean): string {
  const [y, m] = ymd(day);
  const base = MONTHS_SHORT[m - 1]!;
  return withYear ? `${base} ’${String(y).slice(2)}` : base;
}

/**
 * ~targetCount x-axis ticks on real calendar boundaries, adapting to the window
 * span: day boundaries under ~6 weeks ("Jul 8"), otherwise month boundaries
 * ("Jul", or "Jul ’25" once the window crosses a year). Every returned day is a
 * boundary that exists in a daily series, so recharts places the tick exactly.
 * Falls back to the endpoints when a window is too short to hold a boundary.
 */
export function dateAxisTicks(days: readonly string[], targetCount = 5): DateTick[] {
  if (days.length === 0) return [];
  if (days.length <= 2) return days.map((day) => ({ day, label: formatDayShort(day) }));

  const first = days[0]!;
  const last = days[days.length - 1]!;
  const span = diffDays(first, last);
  const slots = Math.max(1, targetCount);
  // strictly interior so a boundary that coincides with the window's first/last
  // day never sits at the plot edge (where its label clips) — the endpoints are
  // already conveyed by the header + From/To inputs
  const inWindow = (d: string) => d > first && d < last;

  if (span <= 45) {
    // day granularity — sample the actual points at a nice day step
    const step = pickStep(span / slots, DAY_STEPS);
    const out: DateTick[] = [];
    let lastIdx = -1;
    for (let i = 0; i < days.length; i += step) {
      out.push({ day: days[i]!, label: formatDayShort(days[i]!) });
      lastIdx = i;
    }
    const endIdx = days.length - 1;
    if (lastIdx !== endIdx) {
      // anchor the last point; if the final stride tick would crowd it (within
      // half a step), drop that neighbor so the two labels don't overlap
      if (endIdx - lastIdx < step / 2) out.pop();
      out.push({ day: last, label: formatDayShort(last) });
    }
    return out;
  }

  // month granularity — month-start boundaries within the window. Stamp the year
  // sparingly: on the first tick when the window spans more than one calendar year,
  // then only where the year actually changes. Dense monthly windows read
  // "Jan ’25, Feb, … Jan ’26" instead of repeating the year on every label, and
  // sparse multi-year windows stay unambiguous without the clutter.
  const multiYear = ymd(first)[0] !== ymd(last)[0];
  const monthStep = pickStep(span / 30 / slots, MONTH_STEPS);
  const out: DateTick[] = [];
  let prevYear: number | null = null;
  for (let cursor = monthStartOnOrAfter(first); cursor <= last; cursor = addMonths(cursor, monthStep)) {
    if (!inWindow(cursor)) continue;
    const year = ymd(cursor)[0];
    const showYear = (multiYear && prevYear === null) || (prevYear !== null && year !== prevYear);
    out.push({ day: cursor, label: monthLabel(cursor, showYear) });
    prevYear = year;
  }
  // a short window that straddles no month-start (or just one) reads better with
  // its real endpoints than a lone interior tick
  if (out.length < 2) return [first, last].map((day) => ({ day, label: formatDayShort(day) }));
  return out;
}

// ── Money labels + window extremes ───────────────────────────────────

/** Compact axis money: "$0", "$94k", "$120k", "$1.2M". */
export function compactMoney(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? "-" : "";
  const abs = Math.abs(dollars);
  const trim = (n: number): string => (n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export interface Extreme {
  day: string;
  cents: number;
}

export interface WindowExtremes {
  min: Extreme;
  max: Extreme;
}

/**
 * The peak and trough of a window (first occurrence on ties), ignoring null
 * (no-data) points. Null when nothing is chartable.
 */
export function windowExtremes(
  points: readonly { day: string; valueCents: number | null }[],
): WindowExtremes | null {
  let min: Extreme | null = null;
  let max: Extreme | null = null;
  for (const p of points) {
    if (p.valueCents === null) continue;
    if (min === null || p.valueCents < min.cents) min = { day: p.day, cents: p.valueCents };
    if (max === null || p.valueCents > max.cents) max = { day: p.day, cents: p.valueCents };
  }
  return min && max ? { min, max } : null;
}
