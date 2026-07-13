/**
 * Coverage-aware series split for the ScrubChart (ux-overhaul-plan §7.1). A net
 * worth or account-balance series carries a per-day honesty flag: a day is
 * `complete` (every account covered / an exact anchored·derived basis) or not
 * (partial coverage / carried·unverified). Exact days draw a solid line; the
 * rest draw dashed — the same convention the old NetWorthChart/BalanceChart used,
 * now folded into the reusable ScrubChart so one chart states coverage honestly.
 *
 * Pure (no DOM, no recharts) so the two-key split is unit-tested to 100%. The
 * split bridges every dashed run to its bounding solid points so the two lines
 * meet with no visual gap, while a genuine `null` value stays a hard break (no
 * data that day → the line must not lie across it).
 */

export interface CoveragePoint {
  day: string;
  /** cents; null = genuinely no data that day → a hard break in both lines */
  valueCents: number | null;
  /** false = partial/estimated day (dashed); defaults to true (solid) */
  complete?: boolean;
}

export interface CoverageSplitPoint {
  day: string;
  /** the raw value, for the scrub hairline / domain reference */
  v: number | null;
  /** solid (exact) line value, null where dashed or absent */
  solid: number | null;
  /** dashed (partial) line value, null where purely-solid or absent */
  soft: number | null;
}

function isIncomplete(p: CoveragePoint | undefined): boolean {
  return p !== undefined && p.valueCents !== null && p.complete === false;
}

/**
 * Splits points into a `solid` and a `soft` (dashed) series. A complete day is
 * solid; a partial day is dashed; a complete day *adjacent* to a partial day is
 * ALSO drawn on the dashed series so the dashed run bridges seamlessly to the
 * solid line on both sides (the shared boundary point overlaps in both). A null
 * value is a hard break in both lines and never bridges.
 */
export function splitCoverageSeries(points: readonly CoveragePoint[]): CoverageSplitPoint[] {
  return points.map((p, i) => {
    if (p.valueCents === null) {
      return { day: p.day, v: null, solid: null, soft: null };
    }
    const complete = p.complete !== false;
    const bridge = isIncomplete(points[i - 1]) || isIncomplete(points[i + 1]);
    return {
      day: p.day,
      v: p.valueCents,
      solid: complete ? p.valueCents : null,
      // partial points, and complete points that touch a partial run, ride the
      // dashed series so it connects end-to-end with the solid line
      soft: !complete || bridge ? p.valueCents : null,
    };
  });
}

/** True when any point is a partial/estimated day — the dashed line is needed. */
export function hasPartialCoverage(points: readonly CoveragePoint[]): boolean {
  return points.some((p) => p.valueCents !== null && p.complete === false);
}

// ── Vivid net-worth series (dashboard §7.1) ──────────────────────────
//
// The vivid chart drops the dashed `soft` line entirely: it draws ONE continuous
// lit accent line across the whole window and instead marks the estimated early
// history with a calm shaded band + boundary. To do that the fill must vanish
// before coverage began while the stroke stays unbroken — so we shape a two-key
// series where `fillValue` is null before the boundary and `lineValue` is null
// only on genuine no-data days.

export interface ChartSeriesPoint {
  day: string;
  /** the continuous stroke value; null ONLY on a real no-data day (hard break) */
  lineValue: number | null;
  /** the gradient-fill value; null before the coverage boundary (estimated zone) */
  fillValue: number | null;
}

/** First day whose coverage is complete (every account covered); null if none. */
export function firstCompleteDay(points: readonly CoveragePoint[]): string | null {
  for (const p of points) {
    if (p.valueCents !== null && p.complete !== false) return p.day;
  }
  return null;
}

/**
 * Shapes a net-worth slice into the vivid two-key series. The stroke is
 * continuous (`lineValue` = value everywhere, `null` only where data is truly
 * absent); the fill is present on `complete` days ONLY, so any estimated day —
 * a leading pre-coverage span, an interior gap between manual anchors, or a
 * partial tail — carries no area and reads as estimated. Coverage is per-day and
 * NOT guaranteed monotonic, so the fill is gated on each point's own `complete`
 * flag rather than a single boundary. Pure, unit-testable to 100%.
 */
export function netWorthChartSeries(points: readonly CoveragePoint[]): ChartSeriesPoint[] {
  return points.map((p) => ({
    day: p.day,
    lineValue: p.valueCents,
    fillValue: p.valueCents !== null && p.complete !== false ? p.valueCents : null,
  }));
}
