import { BUDGET_JARGON } from "./jargon";

/**
 * What a budget row's headline says, and what that reading means.
 *
 * Both come out of ONE branch on purpose. They were previously two independent
 * ternaries — the headline in `BudgetRow`, the definition beside it — and that
 * shape has already produced one defect in this file's history: a tooltip gated
 * on `remaining < 0` promised a today mark on a row whose headline was chosen by
 * `pace === "over"`, and the two disagree at exactly 100%. Selecting the words
 * and the explanation of the words together makes that class of drift
 * unrepresentable rather than merely fixed.
 *
 * Extracted from the component for the same reason `dayChangeLabel` was: the
 * e2e fixture's four budgets are one `over` and three `withheld`, and the suite
 * asserts `getByText(/On track/)` and `getByText(/Off pace/)` are BOTH absent.
 * So two of the four states below cannot render in any Playwright run, and a
 * component-level assertion would pass whether or not they were right. This
 * module is inside the 100%-coverage gate, which forces every branch to be
 * executed by a test that can actually see it.
 */

/** Structurally identical to `BudgetPace` in `services/budgets`, restated so
 *  `lib` keeps not importing from `services` (the idiom `section-notes` uses). */
export type BudgetPaceKind = "under" | "at-risk" | "over";

export interface BudgetVerdict {
  /** the headline text, verbatim */
  headline: string;
  /** the definition of that headline, from `BUDGET_JARGON` */
  explanation: string;
  /**
   * The fill covers the whole track, so the bar is no longer to scale and the
   * today mark is not drawn. Equivalent to `pace === "over"` and deliberately
   * NOT to `remaining < 0`: `computePace` turns over at `spent >= available`
   * while `remaining < 0` is strictly greater, and they disagree at exactly the
   * point where the bar first fills.
   */
  barIsFull: boolean;
  /** the verdict is withheld — the row states its coverage gap instead */
  withheld: boolean;
}

const LABEL: Record<BudgetPaceKind, string> = {
  under: "On track",
  "at-risk": "Off pace",
  over: "Over budget",
};

export interface BudgetVerdictInput {
  pace: BudgetPaceKind;
  /** spent ÷ available, UNCLAMPED — 1.08 is eight percent past the line */
  pct: number;
  /** days of this window the ledger has not covered */
  uncoveredDays: number;
}

export function budgetVerdict({ pace, pct, uncoveredDays }: BudgetVerdictInput): BudgetVerdict {
  if (pace === "over") {
    // The headline % must say WHAT it measures: 108% of a budget is "over BY
    // 8%", never "over budget · 108%", which reads as 108% over. Under one
    // percent is "<1" rather than a rounded "0", which would claim the line was
    // met exactly.
    const overPct = (pct - 1) * 100;
    return {
      headline: `Over budget by ${overPct < 1 ? "<1" : Math.round(overPct)}%`,
      explanation: BUDGET_JARGON.paceOver,
      barIsFull: true,
      withheld: false,
    };
  }

  /*
   * With days of this window still unimported, spent/pct/pace are LOWER BOUNDS,
   * not measurements — every figure can only rise when the statement lands. A
   * green "On track · 0% used" over an unimported month is the one failure mode
   * a budgeting tool cannot afford, so the verdict is withheld rather than
   * guessed. `over` is exempt above: already exceeding the budget on partial
   * data is a fact more data cannot undo.
   */
  if (uncoveredDays > 0) {
    return {
      headline: "Awaiting statements",
      explanation: BUDGET_JARGON.paceWithheld,
      barIsFull: false,
      withheld: true,
    };
  }

  return {
    headline: `${LABEL[pace]} · ${Math.round(pct * 100)}% used`,
    explanation: pace === "at-risk" ? BUDGET_JARGON.paceAtRisk : BUDGET_JARGON.paceUnder,
    barIsFull: false,
    withheld: false,
  };
}
