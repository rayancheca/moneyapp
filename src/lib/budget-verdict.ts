import { spendUnread, spentOnlyFromCashWallets, type BudgetCoverageInput } from "./budget-coverage";
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
 * asserts `getByText(/On track/)` and `getByText(/Off pace/)` are BOTH absent,
 * and no cash wallet exists while /budgets is visited (the wallet specs run
 * after `zz-budgets`). So three of the five states below cannot render in any
 * Playwright run, and a component-level assertion would pass whether or not they
 * were right — four of six since §6A 64's dash, which no fixture row reaches
 * (every one of the four has a day of July read). This
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
  /**
   * The row may say where spending is HEADING beside the headline: the
   * "Projected ≈" figure, and the pace colour on the dashed tail of recurring
   * still expected. Chosen by the same branch as the headline, because a
   * figure the row gated on `pace` alone printed "Projected ≈ $56.36" in the
   * warning colour beside "Cash only", whose definition says no such reading is
   * offered.
   *
   * False for `over` (its reading is measured rather than a forecast, and its
   * full bar leaves the tail no room), for "Cash only", for §6A 64's dash, and
   * ⚖️ for a window read in part (decision 69, 2026-10-13): true only for the two
   * graded readings, "On track" and "Off pace".
   */
  showsProjection: boolean;
  /**
   * ⚖️ §6A 64 (2026-10-12): not one elapsed day of the window read and not one row found in it — Spent and Left print
   * "—", the plan stands, and the bar carries no measured value (`lib/budget-coverage::spendUnread`). Always withheld.
   */
  unread: boolean;
}

const LABEL: Record<BudgetPaceKind, string> = {
  under: "On track",
  "at-risk": "Off pace",
  over: "Over budget",
};

export interface BudgetVerdictInput extends Pick<BudgetCoverageInput, "spentFromAccounts" | "spentFromWallets"> {
  pace: BudgetPaceKind;
  /** spent ÷ available, UNCLAMPED — 1.08 is eight percent past the line */
  pct: number;
  /** days of this window the ledger has not covered */
  uncoveredDays: number;
  /** not one elapsed day of this window read by the row's own day (`BudgetPaceStatus.noDayRead`) */
  noDayRead: boolean;
  /** the rows found in this window (`BudgetStatus.txnCount`) */
  txnCount: number;
}

export function budgetVerdict(input: BudgetVerdictInput): BudgetVerdict {
  const { pace, pct, uncoveredDays } = input;
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
      showsProjection: false,
      unread: false,
    };
  }

  /*
   * ⚖️ OWNER DECISION, 2026-09-15: a category spent only from cash wallets makes
   * no pace claim. Wallets are left out of the import frontier, so there is no
   * day for its figures to be measured through and no statement coming to give
   * one: "Awaiting statements" would promise something that never arrives, and a
   * graded reading would treat the typed rows as all of it. Ahead of the
   * coverage gate because no day count changes that — and behind `over`, for that
   * branch's own reason: cash already past the line is recorded spending.
   */
  if (spentOnlyFromCashWallets(input)) {
    return {
      headline: "Cash only",
      explanation: BUDGET_JARGON.paceCashOnly,
      barIsFull: false,
      withheld: true,
      showsProjection: false,
      unread: false,
    };
  }

  /*
   * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): not one elapsed day read and nothing found, so there is no figure to give
   * a floor of — the dashboard's pace tile and the category headline's dash (`lib/empty-period::emptyFigure`). The
   * row's headline is the withheld one; its definition names only what the row still draws. Ahead of the day count
   * because the headline must be withheld wherever the figures are: a window that has not opened (unreachable from the
   * app, which stamps a budget's start with today) counts no days and would otherwise be graded under a dash.
   */
  if (spendUnread(input)) {
    return {
      headline: "Awaiting statements",
      explanation: BUDGET_JARGON.paceUnread,
      barIsFull: false,
      withheld: true,
      /*
       * ⚖️ §6A 64 named the dashboard's pace tile, whose dash withholds "$0.00 projected" with "$0.00 spent" — and the
       * projection is `projectSpend` over the very $0.00 this row will not print. 🔴 Review of 6f217a7: kept, it read
       * "Projected ≈ $2,291.21" in amber beside "Spent —" and "Left —" on his ledger copy 2026-10-12 (Housing; the rent
       * unread), Transport's dashed tail amber across the bar, under a definition saying no reading is offered.
       */
      showsProjection: false,
      unread: true,
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
      /*
       * ⚖️ OWNER DECISION 2026-10-13 (decision 69): a window read in part prints no "Projected ≈" and draws its tail in
       * no pace colour, as the fully unread one already does (§6A 64) — a projection of floors is the reading this
       * branch withholds. The bills still to come keep their own "$X expected before <day>" line, a schedule.
       */
      showsProjection: false,
      unread: false,
    };
  }

  return {
    headline: `${LABEL[pace]} · ${Math.round(pct * 100)}% used`,
    explanation: pace === "at-risk" ? BUDGET_JARGON.paceAtRisk : BUDGET_JARGON.paceUnder,
    barIsFull: false,
    withheld: false,
    showsProjection: true,
    unread: false,
  };
}
