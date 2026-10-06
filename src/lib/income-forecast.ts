/**
 * Ongoing-income projection — the pure honesty layer that lets the current-month
 * forecast project VARIABLE income (a cash job, tutoring, interest), not just
 * recurring income *series*. Mirrors spending's `variableComponents` (trailing
 * average) but with two income-specific honesty rules, because income behaves
 * differently from spending:
 *
 *   1. PRESENCE GATE — a bucket must post income in ≥ `minMonthsPresent` of the
 *      trailing months to count as ONGOING. Spending projects every bucket
 *      (you'll keep buying groceries), but income is littered with ONE-OFFS —
 *      a tax refund, a financial-aid disbursement, a security-deposit return —
 *      that appear once and must NOT extrapolate forward as if they were a salary.
 *   2. NO UPWARD TREND — spending's `(newest − oldest)/2` trend nudge is wrong
 *      for income: a recent income spike is far more likely a one-off than a
 *      ramp, so we take the plain trailing mean (applyTrend:false) and never
 *      promise more income than the history supports.
 *
 * Everything here is DB-free and clock-free (callers pass the trailing totals);
 * the confidence + mean math is delegated to `projectTrailingAverage` so there
 * is exactly one trailing-average engine in the codebase.
 */

import { projectTrailingAverage } from "./projection";

/** A per-income-bucket trailing history (one entry per full trailing month, oldest → newest). */
export interface IncomeBucketTrailing {
  /** the income subcategory name (e.g. "Salary", "Tutoring", "Interest") */
  label: string;
  /**
   * income posted per trailing full month, oldest → newest, integer cents — NET for the agent's bucket, whose
   * clawbacks net inside it (owner decision 2026-10-06, §6A 45), so a month can be zero or below
   */
  monthlyTotalsCents: readonly number[];
}

/** A projected ongoing-income component (full-month estimate; the caller scales to the remaining window). */
export interface OngoingIncomeEstimate {
  label: string;
  /** expected FULL-MONTH income, integer cents, never below zero (0 only for a net bucket clawed back to nothing) */
  monthlyCents: number;
  /** how many trailing months carried income for this bucket (the presence signal) */
  monthsPresent: number;
  /** 0..1 — lumpier histories read fainter (from projectTrailingAverage) */
  confidence: number;
  /** visible-math basis string */
  basis: string;
}

/** Default presence gate: income must appear in ≥ 2 of the trailing months to be "ongoing". */
export const MIN_INCOME_MONTHS_PRESENT = 2;

/**
 * Which income buckets represent ONGOING earnings, and how much per month. A
 * bucket present in fewer than `minMonthsPresent` trailing months is dropped as
 * a one-off (never projected). A month is present when it nets money IN, and
 * the trailing mean is floored at zero: a net bucket whose clawbacks outweigh
 * what it is paid is returned at 0, never below — the caller drops it.
 */
export function projectOngoingIncome(
  buckets: readonly IncomeBucketTrailing[],
  minMonthsPresent: number = MIN_INCOME_MONTHS_PRESENT,
): OngoingIncomeEstimate[] {
  const out: OngoingIncomeEstimate[] = [];
  for (const bucket of buckets) {
    const monthsPresent = bucket.monthlyTotalsCents.filter((c) => c > 0).length;
    if (monthsPresent < minMonthsPresent) continue;
    const projection = projectTrailingAverage({
      trailingTotalsCents: bucket.monthlyTotalsCents,
      applyTrend: false,
    });
    out.push({
      label: bucket.label,
      monthlyCents: projection.expectedTotalCents,
      monthsPresent,
      confidence: projection.confidence,
      basis: `${projection.basis}, present ${monthsPresent}/${bucket.monthlyTotalsCents.length} mo`,
    });
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents || a.label.localeCompare(b.label));
}
