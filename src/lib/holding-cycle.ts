/**
 * The tap-to-cycle metric on each holdings row (ux-overhaul-plan §6.3 [MO]):
 * a single day-change block that cycles day % → day $ → total P/L on tap. Pure
 * state machine so the cycling and labels are unit-tested; the row component
 * only renders the current metric.
 */

export const HOLDING_METRICS = ["dayPct", "dayDollar", "totalPl"] as const;
export type HoldingMetric = (typeof HOLDING_METRICS)[number];

/** Next metric in the cycle, wrapping back to the first. */
export function nextHoldingMetric(metric: HoldingMetric): HoldingMetric {
  const index = HOLDING_METRICS.indexOf(metric);
  return HOLDING_METRICS[(index + 1) % HOLDING_METRICS.length]!;
}

const METRIC_LABEL: Record<HoldingMetric, string> = {
  dayPct: "Day %",
  dayDollar: "Day change",
  totalPl: "Total P/L",
};

/** Column-header / a11y label for the currently shown metric. */
export function holdingMetricLabel(metric: HoldingMetric): string {
  return METRIC_LABEL[metric];
}
