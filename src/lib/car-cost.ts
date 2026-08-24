/**
 * What the car actually costs, per month and as a share of everything.
 *
 * 🔴 **Forecast from commitments, not from measured running costs — because
 * there are none.** Measured 2026-08-24: the Car category holds three rows, all
 * in August 2026, all of them the act of buying the car rather than running it,
 * and the first lease payment is not until 2026-09-11. A "post-car spend"
 * average over that data would be an average of a down payment.
 *
 * So the monthly figure is the registered lease and insurance, the money already
 * handed over is amortised and shown SEPARATELY, and the date the insurance
 * evidence runs out is published rather than assumed past.
 */

export interface CarCostInput {
  /** the horizon the committed total spans, in whole months */
  months: number;
  /** total committed car money across the horizon, positive magnitude */
  committedCents: number;
  /**
   * The recurring monthly car cost — lease plus insurance while it runs.
   *
   * Deliberately NOT `committedCents / months`: insurance stops five payments
   * into a twelve-month horizon, so the average ($710.51) and the monthly bill
   * ($921.38) are different true numbers answering different questions. Passing
   * both in stops this module from picking one and calling it the other.
   */
  committedMonthlyCents: number;
  /** money already handed over: down payment, dealer, first premium */
  upfrontCents: number;
  /** the term the upfront money buys — the lease length, in whole months */
  upfrontAmortisedOverMonths: number;
  /** measured monthly spend on everything, before the car */
  baselineMonthlySpendCents: number;
  /** last day the commitment is evidenced for; null = open-ended */
  evidencedThrough: string | null;
}

export interface CarCost {
  months: number;
  /** total committed car money across the horizon */
  committedCents: number;
  /** the recurring monthly bill: lease + insurance while it runs */
  monthlyCents: number;
  /** money already handed over */
  upfrontCents: number;
  /**
   * The term `upfrontCents` is spread across, echoed back so no caller has to
   * re-derive it. The card printed `months * 2` before this field existed —
   * correct only because a twelve-month horizon and a twenty-four-month lease
   * happen to be in that ratio, and silently wrong the moment either changed.
   */
  upfrontAmortisedOverMonths: number;
  /** that money spread across the term it buys */
  upfrontMonthlyCents: number;
  /** `monthlyCents + upfrontMonthlyCents` */
  allInMonthlyCents: number;
  /** measured baseline spend plus the recurring car bill */
  projectedMonthlySpendCents: number;
  /** `monthlyCents` as a percentage of `projectedMonthlySpendCents` */
  sharePct: number;
  /** measured baseline spend plus the all-in car cost */
  allInProjectedMonthlySpendCents: number;
  /** `allInMonthlyCents` as a percentage of `allInProjectedMonthlySpendCents` */
  allInSharePct: number;
  /** last day the commitment is evidenced for; null = open-ended */
  evidencedThrough: string | null;
}

/**
 * A part over the whole it belongs to.
 *
 * Clamped into [0, 100] on purpose. The whole here is `baseline + part`, so a
 * negative baseline — a month of net refunds — would otherwise make a part
 * larger than its own total and publish a car costing 340% of spending. Zero
 * over zero is zero, never NaN: a card printing "NaN%" is worse than one
 * printing nothing.
 */
function share(partCents: number, wholeCents: number): number {
  if (partCents <= 0) return 0;
  if (wholeCents <= partCents) return 100;
  return (partCents / wholeCents) * 100;
}

export function carCost(input: CarCostInput): CarCost {
  const { months, upfrontAmortisedOverMonths } = input;
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`carCost: months must be a positive integer, got ${months}`);
  }
  if (!Number.isInteger(upfrontAmortisedOverMonths) || upfrontAmortisedOverMonths < 1) {
    throw new RangeError(
      `carCost: upfrontAmortisedOverMonths must be a positive integer, got ${upfrontAmortisedOverMonths}`,
    );
  }

  const monthlyCents = input.committedMonthlyCents;
  const upfrontMonthlyCents = Math.round(input.upfrontCents / upfrontAmortisedOverMonths);
  const allInMonthlyCents = monthlyCents + upfrontMonthlyCents;

  const projectedMonthlySpendCents = input.baselineMonthlySpendCents + monthlyCents;
  const allInProjectedMonthlySpendCents = input.baselineMonthlySpendCents + allInMonthlyCents;

  return {
    months,
    committedCents: input.committedCents,
    monthlyCents,
    upfrontCents: input.upfrontCents,
    upfrontAmortisedOverMonths,
    upfrontMonthlyCents,
    allInMonthlyCents,
    projectedMonthlySpendCents,
    sharePct: share(monthlyCents, projectedMonthlySpendCents),
    allInProjectedMonthlySpendCents,
    allInSharePct: share(allInMonthlyCents, allInProjectedMonthlySpendCents),
    evidencedThrough: input.evidencedThrough,
  };
}
