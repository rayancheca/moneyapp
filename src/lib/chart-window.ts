/**
 * The range/drag window → visible rows math, extracted from ScrubChart so the
 * chart and its table lens can never disagree about WHICH rows are on screen
 * (chart-parity pass 23). Before this, the slice lived in a private `useMemo`;
 * a table re-deriving it would drift on the fallback below — showing 0-1 rows
 * where the chart shows the whole history.
 *
 * The one subtle rule: a window that leaves fewer than TWO points falls back to
 * the entire series, so a pill or a hair-thin drag never lands on an empty
 * chart. That fallback is honest only if the caption knows it happened — hence
 * `windowedPoints`, which reports it, next to the plain `windowPoints`.
 *
 * Pure: no clock (today is passed in), no DOM, no sorting or deduping — the
 * caller's ascending order is preserved exactly.
 */

import { rangeStartDay, type ChartRange } from "./chart-range";
import { compareDates } from "./dates";

/** The minimum a window must retain to stand on its own (two points = a line). */
const MIN_WINDOW_POINTS = 2;

/** Any day-stamped series row. Generic so callers keep their own point shape. */
export interface DayStamped {
  day: string;
}

export interface DayWindow {
  start: string;
  end: string;
}

export interface WindowedResult<T> {
  /** the rows the chart actually draws */
  points: T[];
  /**
   * true when the requested window held fewer than two points and the FULL
   * series is being shown instead — the caller must not caption these rows
   * with the requested range, or it states a window it isn't showing.
   */
  fellBack: boolean;
}

/**
 * The rows visible for a range (or an explicit drag window, which takes
 * precedence), plus whether the <2-point fallback fired.
 *
 * A series shorter than two points is returned untouched with `fellBack: false`
 * — there is no window to fall back FROM, and the chart renders its
 * "not enough history" state rather than any window at all.
 */
export function windowedPoints<T extends DayStamped>(
  points: readonly T[],
  today: string,
  range: ChartRange,
  customWindow?: DayWindow | null,
): WindowedResult<T> {
  if (points.length < MIN_WINDOW_POINTS) return { points: points.slice(), fellBack: false };

  let windowed: T[];
  if (customWindow) {
    windowed = points.filter(
      (p) => compareDates(p.day, customWindow.start) >= 0 && compareDates(p.day, customWindow.end) <= 0,
    );
  } else {
    const start = rangeStartDay(range, today);
    // no lower bound for ALL; no upper bound ever (points past `today` stay)
    windowed = start ? points.filter((p) => compareDates(p.day, start) >= 0) : points.slice();
  }

  if (windowed.length >= MIN_WINDOW_POINTS) return { points: windowed, fellBack: false };
  return { points: points.slice(), fellBack: true };
}

/**
 * Whether any row is an ESTIMATED day — carried forward, or without full
 * coverage. The chart draws these dashed; a table of the same rows has to say
 * so in words or the numbers read as exact. `complete` is omitted entirely by
 * exact series (portfolio/holding price), so only an explicit `false` counts.
 */
export function hasEstimatedDay(points: readonly { complete?: boolean }[]): boolean {
  return points.some((p) => p.complete === false);
}

/** The visible rows alone — the chart's slice, for callers that don't caption. */
export function windowPoints<T extends DayStamped>(
  points: readonly T[],
  today: string,
  range: ChartRange,
  customWindow?: DayWindow | null,
): T[] {
  return windowedPoints(points, today, range, customWindow).points;
}
