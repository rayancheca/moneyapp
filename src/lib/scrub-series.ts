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
