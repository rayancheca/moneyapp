import { formatCentsSigned } from "@/lib/money";

/**
 * Month-over-month spending delta. Semantic direction is inverted vs cash
 * flow: MORE spending (positive delta) is the bad direction (negative tone),
 * LESS spending reads positive.
 */
export function SpendDelta({ cents }: { cents: number }) {
  const tone = cents > 0 ? "text-negative" : cents < 0 ? "text-positive" : "text-ink-muted";
  return <span className={`figures ${tone}`}>{formatCentsSigned(cents)}</span>;
}
