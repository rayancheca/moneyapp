import { upfrontCarLeftOut } from "./committed";
import type { IncomeBasisKind } from "./income-basis";
import { formatCents } from "./money";

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
  /**
   * Positive magnitude owed on credit cards.
   *
   * SUBTRACTED from the cash base, and visibly. This is spending from months
   * already past that has not been settled, so nothing else in the arithmetic
   * carries it: the spend term is a rate for FUTURE months, and the committed
   * book holds recurring series only. Measured 2026-08-24 it is $925.61 against
   * $3,121.59 of cash — eight days of a twenty-seven-day answer, which is too
   * much of the headline to leave out.
   */
  cardDebtCents: number;
  /**
   * Credit balances on cards — the part of `cardDebtCents` that is a NET. A
   * card the bank owes you on makes "what you owe on cards" smaller than what
   * you owe the other banks, and the line should say so: $842.89 read as a debt
   * on 2026-09-03 while two cards owed $925.61 between them. Default 0.
   */
  cardCreditCents?: number;
  /** what liquidating the portfolio would add; negative (margin) adds nothing */
  investableCents: number;
  /** the income figure per month — see `incomeBasis`, and `incomeBasisKind` below */
  monthlyIncomeCents: number;
  /**
   * WHICH of `incomeBasis`' three arithmetics produced `monthlyIncomeCents`.
   *
   * 🔴 Without it this module wrote one sentence for all three and asserted the
   * opposite of what it had divided by. A five-week lump pushes `postedCents`
   * past the levelled rate, `incomeBasis` switches to kind "banked", and the
   * card went on saying "the earning is a rate from your confirmed pay rather
   * than what has landed" — while the tooltip mounted on that very row said
   * "Income that has already arrived in this window". The figure is chosen in
   * one place and must be DESCRIBED by the branch that chose it, exactly as
   * `budgetVerdict` and `incomeBasis` each write their own words.
   *
   * Defaults to "levelled", the only kind that existed when this was written
   * and the one every existing caller passing nothing already meant.
   */
  incomeBasisKind?: IncomeBasisKind;
  /** measured total spend per month, positive magnitude */
  monthlySpendCents: number;
  /**
   * The car's up-front money the spend term LEFT OUT of the months it measured (`SpendBaseline.upfrontCarCents`, owner
   * decision 2026-10-07, §6A 51): handed over once, so no part of a monthly rate. Read only to say so when it is all
   * those months hold. Default 0.
   */
  upfrontCarCents?: number;
}

/**
 * `unknown` is a verdict WITHHELD, not a third arithmetic.
 *
 * Zero measured spending makes `spend <= income` true, so without this the
 * covered branch would tell somebody whose ledger holds balances and no
 * transactions that their income covers their spending. It knows nothing of the
 * sort. Pass 43 shipped the same shape once — ten budgets read green `0% used`
 * because the month held a single transaction — and `budgetVerdict` has carried
 * a `withheld` state ever since.
 */
export type RunwayKind = "burning" | "covered" | "unknown";

export interface RunwayHorizon {
  /** the cash base this horizon spends down, cards already netted off */
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

export type RunwayAssumptionId = "liquid" | "cards" | "spend" | "income" | "investments";

/** One input the answer rests on, for the card to list and make clickable. */
export interface RunwayAssumption {
  id: RunwayAssumptionId;
  label: string;
  cents: number;
}

export interface Runway {
  kind: RunwayKind;
  /** `liquidCents − cardDebtCents`: what the headline horizon actually spends */
  netCashCents: number;
  /** spend − income. Positive is burning; zero or less is covered. */
  netBurnCents: number;
  liquid: RunwayHorizon;
  withInvestments: RunwayHorizon;
  headline: string;
  explanation: string;
  assumptions: RunwayAssumption[];
}

/**
 * What the income term IS, said three ways because it is three things.
 *
 * ⛔ One entry per `IncomeBasisKind`, and the row label lives here too. "What
 * you earn a month" over a five-week catch-up deposit is the same lie as the
 * explanation's, printed on the line the figure sits on.
 *
 * ⚠️ The "levelled" wording is byte-identical to the single sentence this
 * module used to publish for every kind: it is the only one that was ever true,
 * it is the live one on the owner's ledger in an ordinary month, and changing
 * it would churn pixels for no reading.
 */
const INCOME_TERM: Record<IncomeBasisKind, { label: string; burning: string; covered: string }> = {
  levelled: {
    label: "What you earn a month",
    burning:
      "the earning is a rate from your confirmed pay rather than what has landed, so this holds only for as long as both do.",
    covered:
      "You earn more than you spend each month, so this cash is not running down. There is no date to count towards.",
  },
  banked: {
    label: "Income that has landed this window",
    burning:
      "the earning is income that has already landed in this window, lump payments and catch-ups included — a measurement of one window and not a rate, so a quieter window shortens this.",
    covered:
      "What has already landed in this window comes to more than you spend in a month, so this cash is not running down. That figure is one window's arrivals, lump payments and catch-ups included, and not a rate — the date to count towards comes back if the next window brings in less.",
  },
  calendar: {
    label: "Income expected this window",
    burning:
      "the earning is what this window has brought in plus the pay still due before it ends, and not a rate, so it moves with the calendar.",
    covered:
      "What this window has brought in plus the pay still due before it ends comes to more than you spend in a month, so this cash is not running down. That is this window's arithmetic and not a rate — it moves with the calendar.",
  },
};

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

function horizon(cents: number, netBurnCents: number, measured: boolean): RunwayHorizon {
  if (!measured) {
    return { cents, months: null, label: "not yet measured", isBeyondHorizon: false };
  }
  if (netBurnCents <= 0) {
    return { cents, months: null, label: "not running down", isBeyondHorizon: false };
  }
  // Cash already gone is zero months, never a negative count of them.
  const months = cents <= 0 ? 0 : cents / netBurnCents;
  return { cents, months, ...durationLabel(months) };
}

export function runway(input: RunwayInput): Runway {
  const { liquidCents, cardDebtCents, monthlyIncomeCents, monthlySpendCents } = input;
  // Margin debt is representable but must never LENGTHEN the runway: selling a
  // portfolio you owe more than cannot fund a month of groceries.
  const investableCents = Math.max(0, input.investableCents);
  const term = INCOME_TERM[input.incomeBasisKind ?? "levelled"];
  const netBurnCents = monthlySpendCents - monthlyIncomeCents;
  const netCashCents = liquidCents - cardDebtCents;
  /*
   * Exactly zero is "nothing has been measured"; anything else — including a
   * NEGATIVE total, a window of net refunds — is a real measurement to reason
   * from. Six closed months summing to precisely zero is not something a ledger
   * with transactions in it does.
   */
  const measured = monthlySpendCents !== 0;

  const liquid = horizon(netCashCents, netBurnCents, measured);
  const withInvestments = horizon(netCashCents + investableCents, netBurnCents, measured);

  const assumptions: RunwayAssumption[] = [
    { id: "liquid", label: "Cash you can spend today", cents: liquidCents },
    {
      id: "cards",
      label:
        (input.cardCreditCents ?? 0) > 0
          ? `Less what you owe on cards, net of ${formatCents(input.cardCreditCents!)} in credit`
          : "Less what you owe on cards",
      cents: cardDebtCents,
    },
    { id: "spend", label: "What you spend a month", cents: monthlySpendCents },
    { id: "income", label: term.label, cents: monthlyIncomeCents },
    { id: "investments", label: "What selling investments would add", cents: investableCents },
  ];

  if (!measured) {
    /*
     * 🔴 "Nothing has been spent" was false when the car's up-front money was all the months held: the spend term
     * leaves it out (§6A 51), so it reads $0.00 over months the caption beneath says $6,100.00 was left out of. Still
     * withheld — money handed over once is no rate — but said in the caption's own words (`upfrontCarLeftOut`). A net
     * REFUND of it is money back, not spending, so the plain sentence stays true there.
     */
    const upfront = input.upfrontCarCents ?? 0;
    const spentUpfront = upfront > 0 ? upfrontCarLeftOut(upfront) : null;
    return {
      kind: "unknown",
      netCashCents,
      netBurnCents,
      liquid,
      withInvestments,
      headline: "Not enough spending to measure",
      explanation:
        spentUpfront === null
          ? "Nothing has been spent in the months counted below, so there is no rate to " +
            "measure a runway against. This fills in once a month of spending is imported."
          : `Apart from ${spentUpfront}, nothing has been spent in the months counted below, so there is no rate to ` +
            "measure a runway against. This fills in once a month of other spending is imported.",
      assumptions,
    };
  }

  if (netBurnCents <= 0) {
    return {
      kind: "covered",
      netCashCents,
      netBurnCents,
      liquid,
      withInvestments,
      headline: "Your income covers your spending",
      explanation: term.covered,
      assumptions,
    };
  }

  return {
    kind: "burning",
    netCashCents,
    netBurnCents,
    liquid,
    withInvestments,
    headline: liquid.months === 0 ? "No cash left" : `${liquid.label} of cash`,
    /*
     * ⛔ The two terms are NOT the same kind of thing, and saying they are was
     * the first version of this sentence. Spending is measured from closed
     * months; earning is a levelled RATE from confirmed pay, and on this ledger
     * the posted figure runs well below it — eleven paydays were silent when
     * pass 60 measured. Describing both as "what already happened" quietly
     * lent the rate the authority of a measurement.
     *
     * 🔴 And the earning half is now written by the BASIS that produced it
     * (`INCOME_TERM`). One sentence for three arithmetics denied the card's own
     * tooltip the day a five-week lump switched the basis to "banked".
     */
    explanation:
      "You spend more than you earn each month. The spending is measured from months " +
      `already closed; ${term.burning}`,
    assumptions,
  };
}
