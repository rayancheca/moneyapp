import { formatCentsSigned } from "@/lib/money";

/**
 * A spending change against a prior window (a month, a quarter, a week … —
 * whichever the caller names beside it). Semantic direction is inverted vs cash
 * flow: MORE spending (positive delta) is the bad direction (negative tone),
 * LESS spending reads positive.
 */
export function SpendDelta({ cents }: { cents: number }) {
  const tone = cents > 0 ? "text-negative" : cents < 0 ? "text-positive" : "text-ink-muted";
  return <span className={`figures ${tone}`}>{formatCentsSigned(cents)}</span>;
}
