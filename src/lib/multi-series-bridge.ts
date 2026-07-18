import { inFlightDeltaByDay, type InFlightAdjustment } from "./in-flight";
import type { DashboardSeries, DashboardSeriesPoint } from "./multi-series";

/**
 * In-flight corrections for the dashboard's multi-series view modes
 * (docs/inflight-dips.md × multi-series.ts). Which rollups a float applies to
 * is the CALLER's law (service): money in the air is the user's ASSET, so the
 * combined and assets rollups bridge; the liabilities-owed rollup and
 * per-account lines never do (an individual ledger honestly dipped).
 *
 * Only covered days are corrected — a null day means "no shown account covers
 * this day", and inventing a value there would fabricate coverage, not bridge
 * a float. Completeness flags are preserved untouched.
 */

export interface BridgedSeriesPoint extends DashboardSeriesPoint {
  /** signed correction applied to this day (0 = untouched) — the scrub mark */
  inTransitCents: number;
}

export interface BridgedDashboardSeries extends Omit<DashboardSeries, "points"> {
  points: BridgedSeriesPoint[];
}

export function bridgeDashboardSeries(
  series: DashboardSeries,
  adjustments: readonly InFlightAdjustment[],
): BridgedDashboardSeries {
  const deltas = inFlightDeltaByDay(
    series.points.map((p) => p.day),
    adjustments,
  );
  return {
    ...series,
    points: series.points.map((p) => {
      const delta = p.valueCents === null ? 0 : (deltas.get(p.day) ?? 0);
      return {
        ...p,
        valueCents: p.valueCents === null ? null : p.valueCents + delta,
        inTransitCents: delta,
      };
    }),
  };
}
