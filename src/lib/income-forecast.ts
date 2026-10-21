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

import { frontierDay, monthCount, type UnreadMonths } from "./committed";
import { monthWindowLabel } from "./format-date";
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
  /**
   * expected FULL-MONTH income, integer cents — never below zero from `projectOngoingIncome` (0 only for a net bucket
   * clawed back to nothing), below zero from `projectOngoingNetIncome` for a bucket netting money out
   */
  monthlyCents: number;
  /** how many trailing months carried income for this bucket — money out, for one netting out (the presence signal) */
  monthsPresent: number;
  /** 0..1 — lumpier histories read fainter (from projectTrailingAverage) */
  confidence: number;
  /** visible-math basis string */
  basis: string;
}

/** Default presence gate: income must appear in ≥ 2 of the trailing months to be "ongoing". */
export const MIN_INCOME_MONTHS_PRESENT = 2;

/**
 * Whether an income pace over `months` trailing months can project anything at all: no bucket comes in
 * `MIN_INCOME_MONTHS_PRESENT` of fewer months than that, so over them every income pace is $0.00 BY CONSTRUCTION, never
 * by measurement — and a pace of no measurement is withheld, never printed as a pace of nothing.
 *
 * ⛔ ONE PREDICATE for /recurring's band (`incomePaceWithheld`) and the pace row's sentence saying why
 * (`incomePaceNote`). 🔴 Review of 0795a2a: the band held Money in's pace back only where it had NO month, and on a
 * ledger opening Jul 1, at 2026-08-27 it read "Money in · Scheduled $2,000.00 (1 line) · Recent pace $0.00 (0 lines)",
 * drawn 100% scheduled, beside Money out's "Recent pace $64.52 (1 line)" over the same one July.
 */
export function incomePaceMeasurable(months: number): boolean {
  return months >= MIN_INCOME_MONTHS_PRESENT;
}

/**
 * What /recurring's pace row says where the income pace has too few months to measure (`incomePaceMeasurable`) —
 * "Money in has no recent pace yet: a kind of income counts toward it once it has come in 2 complete months, so a
 * one-off never does. Jul 2026 is the only complete month imported so far." — the months named where there are any.
 * Null where the pace has its months.
 *
 * ⚖️ Spending's one month IS averaged (it projects every bucket; you will keep buying groceries) and income's is not:
 * the presence gate is what keeps a tax refund or a deposit's return from extrapolating as pay. So on one young ledger
 * Money out can have a pace where Money in has none, and the band's "—" needs its own reason.
 *
 * ⚖️ His decision 71 (2026-10-13) cuts SPENDING's months at the day every account he spends from is read to, and not
 * Money in's. So where that day left Money in's months out of spending's (`spendUnread`, the spending pace's
 * `UnreadMonths`), they are named as Money in's, beside the day — "Jul 12 cuts spending's months, not Money in's, and
 * Jul 2026 is the only complete month Money in has so far." 🔴 Review of a7b1504: on a ledger opening Jul 1 whose Card
 * was read only to Jul 12, at 2026-08-27 the row read "Jul 2026 is left out: Jul 12 is the last day every account you
 * spend from has been imported through." and, one sentence later, "Jul 2026 is the only complete month imported so
 * far." — read to its 12th, then imported whole.
 */
export function incomePaceNote(monthKeys: readonly string[], spendUnread: UnreadMonths | null): string | null {
  if (incomePaceMeasurable(monthKeys.length)) return null;
  const gate =
    "Money in has no recent pace yet: a kind of income counts toward it once it has come in " +
    `${monthCount(MIN_INCOME_MONTHS_PRESENT, "complete")}, so a one-off never does.`;
  if (monthKeys.length === 0) return gate;
  const months = monthWindowLabel(monthKeys[0]!, monthKeys.at(-1)!);
  const only = monthKeys.length === 1 ? "is the only complete month" : "are the only complete months";
  const cut = spendUnread !== null && monthKeys.some((key) => spendUnread.months.includes(key));
  if (!cut) return `${gate} ${months} ${only} imported so far.`;
  const whose = `${frontierDay(spendUnread)} cuts spending's months, not Money in's`;
  return `${gate} ${whose}, and ${months} ${only} Money in has so far.`;
}

/**
 * Which income buckets represent ONGOING earnings, and how much per month. A
 * bucket present in fewer than `minMonthsPresent` trailing months is dropped as
 * a one-off (never projected). A month is present when it nets money IN, and
 * the trailing mean is floored at zero: a net bucket whose clawbacks outweigh
 * what it is paid is returned at 0, never below — the caller drops it. The
 * agent's pace reads `projectOngoingNetIncome`, which mirrors this for a bucket
 * netting money out.
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

/**
 * `projectOngoingIncome` for a NET bucket that can come to money OUT — the agent's, whose clawbacks net inside its
 * pace (owner decision 2026-10-06, §6A 45). A bucket netting money in, or to nothing, over the trailing months is
 * `projectOngoingIncome`'s, unchanged. One netting OUT is the same gate and mean, MIRRORED — present in
 * ≥ `minMonthsPresent` months as money out, at its trailing mean — and returned BELOW zero: a one-off clawback never
 * extrapolates, as a one-off credit never does.
 *
 * 🔴 Why it exists: a clawback reaches the pace without the credit it reverses whenever that credit is a live
 * schedule's (projected by FIXED, so not in the pace's rows). `projectOngoingIncome` dropped the bucket — no month
 * nets money in — and the clawback netted nowhere. How far below zero a projection may take a reading is the
 * caller's to say.
 */
export function projectOngoingNetIncome(
  buckets: readonly IncomeBucketTrailing[],
  minMonthsPresent: number = MIN_INCOME_MONTHS_PRESENT,
): OngoingIncomeEstimate[] {
  return buckets.flatMap((bucket) => {
    const sum = bucket.monthlyTotalsCents.reduce((a, b) => a + b, 0);
    if (sum >= 0) return projectOngoingIncome([bucket], minMonthsPresent);
    const mirrored = { label: bucket.label, monthlyTotalsCents: bucket.monthlyTotalsCents.map((c) => 0 - c) };
    return projectOngoingIncome([mirrored], minMonthsPresent).map((e) => ({
      ...e,
      monthlyCents: 0 - e.monthlyCents,
      basis: `${e.basis}, money out`,
    }));
  });
}
