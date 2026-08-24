/**
 * How long the money lasts.
 *
 * Two horizons, published together because the owner asked for both on
 * 2026-08-24: what the current account covers, and what selling the portfolio
 * would add. Neither is allowed to stand in for the other — $3,121.59 of cash
 * and $107,126.39 of Robinhood answer different questions, and collapsing them
 * into one figure either alarms about money that exists or reassures with money
 * he would have to liquidate to spend.
 *
 * ⛔ **The outflow is TRUE SPEND, not the committed book.** Committed bills run
 * $3,211.04/month against a $4,537.00 income rate, so a runway built on them
 * divides by a negative burn and reports that the money never runs out. That is
 * arithmetically impeccable and false, which is the exact family of error pass
 * 62 shipped as "$0.14 expected income". The owner chose true spend knowing the
 * headline it produces. Do not re-scope this to committed outflows without
 * asking him again.
 *
 * Every figure and every word describing it comes out of ONE call, for the
 * reason `budgetVerdict` does: a headline chosen by one branch and an
 * explanation chosen by another have already drifted apart once in this
 * codebase.
 */

/**
 * The longest runway this module will name a number for.
 *
 * Past two years the inputs stop supporting the claim: the spend term is a mean
 * of six observed months and the income term is a levelled rate, and neither
 * carries month-level precision thirty months out. So a longer horizon is
 * reported as a bound rather than a date — the same refusal `magnitudeTiers`
 * makes when it caps magnification instead of scaling ten cents up beside
 * $70,291.75.
 */
export const RUNWAY_STATED_MONTHS_MAX = 24;

/** Mean Gregorian month. Used only to say a sub-month runway in days. */
const DAYS_PER_MONTH = 365.2425 / 12;

/** Below this many months a duration is said in days rather than months. */
const DAYS_BELOW_MONTHS = 1;
/** At or above this many months the decimal is dropped. */
const WHOLE_MONTHS_FROM = 10;

export interface RunwayInput {
  /** cash spendable today without selling anything */
  liquidCents: number;
  /** what liquidating the portfolio would add; negative (margin) adds nothing */
  investableCents: number;
  /** the income RATE per month — see `incomeBasis` */
  monthlyIncomeCents: number;
  /** measured total spend per month, positive magnitude */
  monthlySpendCents: number;
}

export type RunwayKind = "burning" | "covered";

export interface RunwayHorizon {
  /** the cash base this horizon spends down */
  cents: number;
  /**
   * Months of runway, true and UNCAPPED, or null when nothing is burning.
   * `label` is the publishable form; a caller printing this number directly
   * would undo the horizon cap `label` applies.
   */
  months: number | null;
  /** the publishable duration: "27 days", "2.5 months", "more than 2 years" */
  label: string;
  /** `label` gave a bound instead of a number — see RUNWAY_STATED_MONTHS_MAX */
  isBeyondHorizon: boolean;
}

export type RunwayAssumptionId = "liquid" | "spend" | "income" | "investments";

/** One input the answer rests on, for the card to list and make clickable. */
export interface RunwayAssumption {
  id: RunwayAssumptionId;
  label: string;
  cents: number;
}

export interface Runway {
  kind: RunwayKind;
  /** spend − income. Positive is burning; zero or less is covered. */
  netBurnCents: number;
  liquid: RunwayHorizon;
  withInvestments: RunwayHorizon;
  headline: string;
  explanation: string;
  assumptions: RunwayAssumption[];
}

/** How a duration is said, with precision proportional to its magnitude. */
function durationLabel(months: number): { label: string; isBeyondHorizon: boolean } {
  if (months <= 0) return { label: "none left", isBeyondHorizon: false };
  if (months >= RUNWAY_STATED_MONTHS_MAX) {
    return { label: "more than 2 years", isBeyondHorizon: true };
  }
  if (months < DAYS_BELOW_MONTHS) {
    const days = Math.round(months * DAYS_PER_MONTH);
    if (days < 1) return { label: "less than a day", isBeyondHorizon: false };
    return { label: `${days} ${days === 1 ? "day" : "days"}`, isBeyondHorizon: false };
  }
  const label =
    months >= WHOLE_MONTHS_FROM ? `${Math.round(months)} months` : `${months.toFixed(1)} months`;
  return { label, isBeyondHorizon: false };
}

function horizon(cents: number, netBurnCents: number): RunwayHorizon {
  if (netBurnCents <= 0) {
    return { cents, months: null, label: "not running down", isBeyondHorizon: false };
  }
  // Cash already gone is zero months, never a negative count of them.
  const months = cents <= 0 ? 0 : cents / netBurnCents;
  return { cents, months, ...durationLabel(months) };
}

export function runway(input: RunwayInput): Runway {
  const { liquidCents, monthlyIncomeCents, monthlySpendCents } = input;
  // Margin debt is representable but must never LENGTHEN the runway: selling a
  // portfolio you owe more than cannot fund a month of groceries.
  const investableCents = Math.max(0, input.investableCents);
  const netBurnCents = monthlySpendCents - monthlyIncomeCents;

  const liquid = horizon(liquidCents, netBurnCents);
  const withInvestments = horizon(liquidCents + investableCents, netBurnCents);

  const assumptions: RunwayAssumption[] = [
    { id: "liquid", label: "Cash you can spend today", cents: liquidCents },
    { id: "spend", label: "What you spend a month", cents: monthlySpendCents },
    { id: "income", label: "What you earn a month", cents: monthlyIncomeCents },
    { id: "investments", label: "What selling investments would add", cents: investableCents },
  ];

  if (netBurnCents <= 0) {
    return {
      kind: "covered",
      netBurnCents,
      liquid,
      withInvestments,
      headline: "Your income covers your spending",
      explanation:
        "You earn more than you spend each month, so this cash is not running down. " +
        "There is no date to count towards.",
      assumptions,
    };
  }

  return {
    kind: "burning",
    netBurnCents,
    liquid,
    withInvestments,
    headline: liquid.months === 0 ? "No cash left" : `${liquid.label} of cash`,
    explanation:
      "You spend more than you earn each month. This is how long the money lasts " +
      "if both keep up — it is arithmetic on what already happened, not a prediction.",
    assumptions,
  };
}
