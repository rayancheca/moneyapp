import {
  budgetCoverageSentence,
  spendIsAFloor,
  spendUnread,
  spentOnlyFromCashWallets,
  type BudgetCoverageInput,
} from "./budget-coverage";
import { BUDGET_JARGON } from "./jargon";
import {
  lineRiseCause,
  riseCannotUndoOver,
  rolloverMayRiseClause,
  type LineRiseCause,
  type RolloverRiseInput,
} from "./rollover-held-back";

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
  /**
   * The figures are floors (`lib/budget-coverage::spendIsAFloor`): days of the window are unread, and a statement still
   * to come can only add to what the row prints. A fact about the window, not a reading — so true of a withheld row
   * read in part and ⚖️ of an OVER one (default built, not asked, 2026-10-29), whose verdict stands. Either prints its
   * coverage sentence under the headline (`budgetCoverageLine`) and speaks its spend as "at least" what it shows — and
   * an over row how far past the line it is, too, unless that line can still rise (`lineMayRise`).
   */
  floors: boolean;
  /**
   * The line the row is graded against can still RISE (`lib/rollover-held-back::lineMayRise`): a closed period it rolls
   * over from can still bank more — one held back and still under its plan, or one read whole that subtracted a bill
   * that may have stopped, or both (`lineRiseCause`). A fact about the carry, not a reading. ⚖️ Where it is true
   * (default built, not asked, 2026-10-29) nothing past the line is a floor and no definition says a later import
   * cannot undo a reading: an over row's says what can still lift it (`OVER_LINE_MAY_RISE`, by its cause), a withheld
   * row read in part's too (`WITHHELD_LINE_MAY_RISE`), and the row's line says what can still roll over
   * (`budgetCoverageLine`). 🔴 This named one cause, held back, and one definition of each (review of 753bad2d, L63).
   * ⚖️ …save an over row whose line can rise by less than its over (`riseCannotUndoOver`, default built, not asked,
   * 2026-11-04): its definition is `paceOver`'s, and this stays true — its over is still spoken bare, and its line and
   * the page note still say what can roll over into it.
   */
  lineMayRise: boolean;
}

const LABEL: Record<BudgetPaceKind, string> = {
  under: "On track",
  "at-risk": "Off pace",
  over: "Over budget",
};

/**
 * ⚖️ default built, not asked (2026-10-29): where the line can still rise, each definition says what can still lift it
 * (`lineRiseCause`) — a closed period held back, a bill a period read whole subtracted that may have stopped, or both.
 * 🔴 Review of ca938320 (round 2): a September imported through Sep 30, its Meal Kit's card checked only through Aug
 * 31, can lift the line too — and "a closed period is not fully imported yet" is false of it.
 */
const OVER_LINE_MAY_RISE: Record<LineRiseCause, string> = {
  "held-back": BUDGET_JARGON.paceOverLineMayRise,
  bill: BUDGET_JARGON.paceOverBillMayStop,
  both: BUDGET_JARGON.paceOverHeldBackAndBill,
};
const WITHHELD_LINE_MAY_RISE: Record<LineRiseCause, string> = {
  "held-back": BUDGET_JARGON.paceWithheldLineMayRise,
  bill: BUDGET_JARGON.paceWithheldBillMayStop,
  both: BUDGET_JARGON.paceWithheldHeldBackAndBill,
};

export interface BudgetVerdictInput
  extends Pick<BudgetCoverageInput, "spentFromAccounts" | "spentFromWallets">,
    Pick<RolloverRiseInput, "rolloverMayAddCents" | "rolloverHeldBackUnderPlan" | "rolloverBillMayLapse"> {
  pace: BudgetPaceKind;
  /** spent ÷ available, UNCLAMPED — 1.08 is eight percent past the line */
  pct: number;
  /** available − spent — below 0, how far past the line the spend is: the row's "Over by" (`BudgetStatus`) */
  remainingCents: number;
  /** days of this window the ledger has not covered */
  uncoveredDays: number;
  /** not one elapsed day of this window read by the row's own day (`BudgetPaceStatus.noDayRead`) */
  noDayRead: boolean;
  /** the rows found in this window (`BudgetStatus.txnCount`) */
  txnCount: number;
}

/**
 * "at least $343.82" where a row's figure is a floor (`BudgetVerdict.floors`) — the dashboard tile's mark for one.
 *
 * ⛔ One mark for every reader of a row's figure printed apart from the line that says which days it stands on: the
 * bar's spoken sentence (`BudgetRow`) and ⚖️ the Deactivate confirmation (`budgetDeactivateLines`; default built, not
 * asked, 2026-10-30). 🔴 The confirmation printed the bare figure — Shopping's "Spent so far this period $343.82" over
 * an October read through Aug 12 on his ledger copy 2026-10-30, beside a bar speaking "at least $343.82" (review of
 * ca938320, L21).
 */
export function floorFigure(figure: string, floors: boolean): string {
  return floors ? `at least ${figure}` : figure;
}

/**
 * "108" — spent ÷ available as a whole percent of the line, rounded once: the bar's spoken "(108% of budget)"
 * (`BudgetRow`), a graded headline's "39% used", and the over headline's "by 8%", which is this less the line.
 *
 * 🔴 The over headline rounded (pct − 1) × 100 and the bar pct × 100 — two floats, rounded apart: on the e2e fixture
 * Housing's $2,150.00 of $2,000.00 read "Over budget by 7%" (7.4999…) beside a spoken "(108% of budget)" (review of
 * ca938320, L23), wherever spent ÷ available lands on a half percent. None of his 6 over rows did on his ledger copy
 * 2026-10-30 (155, 178, 3, 23, 1284 and 106 beside 255, 278, 103, 123, 1384 and 206).
 */
export function percentOfBudget(pct: number): number {
  return Math.round(pct * 100);
}

export function budgetVerdict(input: BudgetVerdictInput): BudgetVerdict {
  const { pace, pct } = input;
  const floors = spendIsAFloor(input);
  // what can still lift the line — null where it cannot rise (`lineMayRise`)
  const cause = lineRiseCause(input);
  const rises = cause !== null;
  if (pace === "over") {
    // The headline % must say WHAT it measures: 108% of a budget is "over BY
    // 8%", never "over budget · 108%", which reads as 108% over. Where the bar
    // reads 100% — less than half a percent past the line, as `percentOfBudget`
    // rounds it — it is "<1" rather than a rounded "0", which would claim the
    // line was met exactly; past that, the bar's percentage less the line, from
    // "1". ⛔ One rounding (`percentOfBudget`). 🔴 This said "under one percent
    // is '<1'" after that rounding made $2,014.00 of $2,000.00 "by 1%", beside
    // the bar's "(101% of budget)" (review of f25e0ba9, L97).
    const overPct = percentOfBudget(pct) - 100;
    return {
      headline: `Over budget by ${overPct < 1 ? "<1" : overPct}%`,
      /*
       * ⚖️ default built, not asked (2026-10-29): the verdict stands whatever the line can still do — his rule, an over
       * verdict is never withheld — but where the line can still rise "no later import can undo that" is false, and the
       * definition says what is true of the line as it stands. 🔴 Review of 48475ec4: Food, $30.00 rolling from Jul 1,
       * read "Over budget by 33%" in August with July held back at $0.00 — and an import later, "Awaiting statements".
       * ⚖️ default built, not asked (2026-11-04): …but where the most it can still rise is below the over, no later
       * import can undo it, and the definition says so again (`riseCannotUndoOver`).
       */
      explanation: cause === null || riseCannotUndoOver(input) ? BUDGET_JARGON.paceOver : OVER_LINE_MAY_RISE[cause],
      barIsFull: true,
      withheld: false,
      showsProjection: false,
      unread: false,
      /*
       * ⚖️ default built, not asked (2026-10-29): the verdict stands over unread days, and its figures are floors all
       * the same — the row carries the withheld row's line under it (`budgetCoverageLine`). 🔴 On his ledger copy
       * 2026-10-29 his 5 over budgets printed no line over an October read through Aug 12 or Oct 2.
       */
      floors,
      lineMayRise: rises,
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
      floors: false,
      lineMayRise: rises,
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
      floors: false,
      lineMayRise: rises,
    };
  }

  /*
   * With days of this window still unimported, spent/pct/pace are LOWER BOUNDS,
   * not measurements — every figure can only rise when the statement lands. A
   * green "On track · 0% used" over an unimported month is the one failure mode
   * a budgeting tool cannot afford, so the verdict is withheld rather than
   * guessed. `over` is exempt above: already exceeding the budget on partial
   * data is a fact more data cannot undo — though not how far (`floors`), nor past a line that can still rise
   * (`lineMayRise`, ⚖️ 2026-10-29), whose percentage below is no floor either. ⚠️ "Cannot undo" holds while each closed
   * period's day moves on: the category's first row on an account imported short of it moves it back, and a rolling
   * line can rise past the spend (`lineMayRise`'s ⚠️; L26: kept). 🔴 Said flatly here after that ⚠️ was written
   * (review of f25e0ba9, L96).
   * ⛔ The floor test itself (`spendIsAFloor`): past the two branches above it is `uncoveredDays > 0`.
   */
  if (floors) {
    return {
      headline: "Awaiting statements",
      explanation: cause === null ? BUDGET_JARGON.paceWithheld : WITHHELD_LINE_MAY_RISE[cause],
      barIsFull: false,
      withheld: true,
      /*
       * ⚖️ OWNER DECISION 2026-10-13 (decision 69): a window read in part prints no "Projected ≈" and draws its tail in
       * no pace colour, as the fully unread one already does (§6A 64) — a projection of floors is the reading this
       * branch withholds. The bills still to come keep their own "$X expected before <day>" line, a schedule.
       */
      showsProjection: false,
      unread: false,
      floors: true,
      lineMayRise: rises,
    };
  }

  return {
    headline: `${LABEL[pace]} · ${percentOfBudget(pct)}% used`,
    explanation: pace === "at-risk" ? BUDGET_JARGON.paceAtRisk : BUDGET_JARGON.paceUnder,
    barIsFull: false,
    withheld: false,
    showsProjection: true,
    unread: false,
    floors: false,
    lineMayRise: rises,
  };
}

/**
 * The line a budget row prints under its headline — the row's coverage sentence (`budgetCoverageSentence`) — or null:
 * wherever the verdict is withheld, and ⚖️ wherever the figures are floors (default built, not asked, 2026-10-29), so
 * an OVER row read in part says which days it stands on, as the withheld rows beside it do.
 *
 * ⛔ One rule for every surface that prints a budget row's verdict and figures: /budgets' row (`BudgetRow`) and the
 * category page's card (`categoryBudgetRef`). 🔴 Both printed the line only while the verdict was withheld: on his
 * ledger copy 2026-10-29 Shopping read "Over budget by 23%" over "Spent $343.82 · Budget $280.00 · Over by $63.82" on
 * /budgets, and "$343.82 of $280.00 · $63.82 over" on its page — October read through Aug 12 on both, said on neither.
 *
 * ⚖️ default built, not asked (2026-10-29): …and where the line itself can still rise (`lineMayRise`), what can still
 * roll over (`rolloverMayRiseClause`) after it — beside the two readings that lean on the line standing still, an over
 * verdict and figures that are floors; alone where an over row has no coverage sentence. 🔴 Review of 48475ec4: Food,
 * $30.00 rolling from Jul 1, read "Over budget by 33%" over "spending imported through Jun 30 · 11 days of this period
 * unaccounted" with July held back at $0.00 — and on the load after July's statement, $40.00 of $60.00.
 */
export function budgetCoverageLine(row: BudgetVerdictInput & BudgetCoverageInput & RolloverRiseInput): string | null {
  const verdict = budgetVerdict(row);
  const covered = verdict.withheld || verdict.floors ? budgetCoverageSentence(row) : null;
  const rises = row.pace === "over" || verdict.floors ? rolloverMayRiseClause(row) : null;
  const said = [covered, rises].filter((part): part is string => part !== null);
  return said.length === 0 ? null : said.join(" · ");
}
