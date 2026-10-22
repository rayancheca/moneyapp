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

import { monthLabel } from "@/lib/calendar-math";
import { endingOthersClause, type EndingLead } from "@/lib/committed";
import { ONE_CHARGE_WORD } from "@/lib/one-charge";
import { dayWindowLabel } from "@/lib/period";

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

/**
 * The sentence under the car card that says when its monthly figure stops
 * being true — about the commitment whose end it dates.
 *
 * 🔴 It read "Insurance is evidenced through Nov 11, 2026" on the owner's
 * dashboard 2026-09-15: the earliest end date of any car series, under a
 * hard-coded word. The earliest was a one-payment $72.74 balance; the premium
 * runs to Jan 11, 2027, which is what the runway card two tiles away said.
 *
 * ⛔ THE LINE THAT STOPS THE MONTHLY FIGURE — `heaviestMonthEnding` — and NOT
 * the runway card's lead. This sentence first borrowed that one (`endingLead`,
 * the line that lowers the RATE most), and a review built the book where the
 * two differ (2026-09-15): a lease ending Feb 15, 2027 beside a policy whose
 * last premium is Nov 11, 2026 printed "Car lease stops … evidenced through
 * Feb 15, 2027" over a monthly figure holding the premium. The caller computes
 * `ending` once and publishes its date as `evidencedThrough` too, so the
 * sentence and that field cannot disagree; `endingOthersClause` is shared, so
 * the count is spelled as the runway spells it. Null when nothing billed in the
 * monthly figure stops inside the horizon — an end date past it, or a line that
 * bills outside the heaviest month, does not stop that figure.
 *
 * ⚖️ A ONE CHARGE that dates the figure (§6A 56, `heaviestMonthEnding`) is said as the charge it is — "charges once on
 * Nov 11, 2026", its own page's words — and the commitments that do stop are counted in a sentence of their own, never
 * as "others" of it. 🔴 With Car insurance ended it read "Car insurance — Nov 11 balance … stops inside the next 12
 * months — evidenced through Nov 11, 2026, with no renewal in the ledger" beside a runway naming nothing (copies of his
 * ledger 2026-10-13, review of 89f235d).
 */
export function carEvidenceCaption(ending: EndingLead | null, months: number): string | null {
  if (ending === null) return null;
  const day = dayWindowLabel(ending.endsOn, ending.endsOn);
  /*
   * 🔴 "…the monthly figure above holds that charge, so it stops being what you pay after that date" implied it was
   * what he paid BEFORE it: with Car insurance ended and the balance on Dec 11, the card read $767.78 over a November
   * that bills the lease alone, $695.04 (a copy of his ledger 2026-10-21; review of 5b19be6). The figure is the month
   * the charge falls in (`heaviestMonth`, which `heaviestMonthEnding` dates), and it says that month.
   */
  if (ending.lead.oneCharge) {
    return (
      `${ending.lead.name} charges ${ONE_CHARGE_WORD} on ${day} — the monthly figure above is what ` +
      `${monthLabel(ending.endsOn.slice(0, 7))} bills with that charge in it, not what a month without it costs.` +
      commitmentsStopping(ending.othersStopping ?? [], months)
    );
  }
  return (
    `${ending.lead.name} stops inside the next ${months} months — evidenced through ` +
    `${day}, with no renewal in the ledger${endingOthersClause(ending.others)} — ` +
    `so the monthly figure above stops being what you pay after that date.`
  );
}

/**
 * " Car insurance stops inside the next 12 months — evidenced through Jan 11, 2027, with no renewal in the ledger." —
 * the commitments that stop beside a one charge, none of them it, each named with its day, in the dated sentence's
 * words. 🔴 It counted them ("One commitment stops …"), naming neither the commitment nor its day (review of 5b19be6).
 */
function commitmentsStopping(stopping: readonly { name: string; on: string }[], months: number): string {
  if (stopping.length === 0) return "";
  const names = LIST.format(stopping.map((s) => s.name));
  const days = LIST.format(stopping.map((s) => dayWindowLabel(s.on, s.on)));
  const stop = stopping.length === 1 ? "stops" : "stop";
  const evidenced = `evidenced through ${days}, with no renewal in the ledger`;
  return ` ${names} ${stop} inside the next ${months} months — ${evidenced}.`;
}

/** "A and B", "A, B, and C" */
const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
