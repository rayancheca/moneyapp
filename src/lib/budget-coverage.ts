import type { CategoryKind } from "@/db/schema/categories";
import { A_LOWER_BOUND, emptyPeriodReason } from "./empty-period";
import { formatDayShortIn } from "./format-date";

/**
 * What a budget row says about the days its figures stand on — the details
 * panel's fact, and the withheld row's sentence built from that same fact.
 *
 * 🔴 BOTH NAMED THE CATEGORY'S NEWEST ROW AS THE DAY SPENDING WAS IMPORTED
 * THROUGH. Measured on the real ledger 2026-09-15: Food read "spending imported
 * through Sep 12" and "no spending imported since Sep 12 · 3 days of this period
 * unaccounted", because its newest row was on Venture X, while Chase Sapphire
 * (44% of Food over the six months before) had been imported only through Sep 2
 * and Chase Checking through Aug 12. Twelve budgets named ten different days,
 * none of them about which accounts had been imported. The day is now
 * `importedThroughOn`, the earliest import frontier among the accounts the
 * category was spent from (`services/budgets`), and it is printed here once.
 *
 * ⛔ One function for both places, so the panel and the row cannot name two days
 * for one window.
 *
 * 🔴 THE DOCSTRING WAS RIGHT AND THE CODE DROPPED THREE WORDS (kept from
 * `BudgetRow`). The row rendered "· 2 days unaccounted" beside "no spending
 * imported since Aug 12", and on 2026-09-02 that pair invited a reader to
 * compute 21 days and find the card wrong about itself. `uncoveredDays` is
 * scoped to the BUDGET PERIOD, never to the gap since the import, and "of this
 * period" is what says so.
 *
 * ⚖️ CASH WALLETS ARE LEFT OUT — owner decision, 2026-09-15. A wallet is never
 * imported, so a category spent from one and from a card follows the card, and
 * a category spent ONLY from wallets has no import date and none is coming. That
 * row says so in plain words and counts no days as waiting for a statement.
 * `spentOnlyFromCashWallets` is the one test the row's sentence, its headline
 * (`budgetVerdict`) and the page note (`budgetSectionNotes`) all read, so they
 * cannot disagree about which rows are cash only.
 *
 * Statement lag is normal here (accounts land on different dates each month), so
 * all of this reads as a fact about coverage, never as an error.
 */
export interface BudgetCoverageInput {
  /** the day every account the category was spent from has been imported through, cash wallets left out; null when none has an import date */
  importedThroughOn: string | null;
  /** where the window of accounts the category was spent from opens */
  spentFromSince: string;
  /** how many accounts other than cash wallets the category was spent from in that window, including any with no import date */
  spentFromAccounts: number;
  /** how many cash wallets it was spent from in that window — never part of `importedThroughOn` */
  spentFromWallets: number;
  /** days of the graded period the ledger has not covered */
  uncoveredDays: number;
  /** the graded window: a day outside its year is printed with its year */
  bounds: { start: string };
  /**
   * The day `uncoveredDays` was counted against when the category has none of its own and is not cash only — the day
   * its page asks (`BorrowedDay`); absent or null otherwise, and never read then.
   */
  borrowedDay?: BorrowedDay | null;
  /**
   * What the window counts — the first word of its line (`countedFlow`). Absent, spending: every /budgets row, and
   * every total decision 72 graded first. ⚖️ A Received or Net page's total names its own (`countedFlow`).
   */
  counted?: CountedFlow;
  /**
   * The category the line is about, named, where it is printed under a sentence whose subject is something else — a
   * merchant page's share of it: "spending in Housing imported through Jul 31". Absent: the line sits under its own
   * category's figure (/budgets, the category page) and says "spending imported through …", "this category".
   *
   * 🔴 Measured on his ledger copy 2026-10-21 (review of fdcebdc, finding 3): IKEA's rank read "spending imported
   * through Oct 2, 2026 · 10 days of this period unaccounted" and, one line down over the same Oct 27, 2025 – Oct 12,
   * 2026, its share of Housing "spending imported through Jul 31, 2026 · 73 days of this period unaccounted" — two days
   * for one window, and nothing on the page said the second was Housing's. ⛔ The borrowed clause's words
   * (`borrowedDayClause`), which this one rule builds too.
   */
  namedFor?: string;
}

/** What a category's window counts, as its lines name it: "spending", "income", or "activity" for anything else. */
export type CountedFlow = "spending" | "income" | "activity";

/**
 * "income" — the noun a category's day is named by, from its kind: the owner's own flow (`categoryFlowLabel`), Spent,
 * Received, or a Net of anything else.
 *
 * ⚖️ Implied by his decision 72 (ruled by the orchestrator 2026-10-14: one window reads one way everywhere): a Received
 * or Net page's total is graded by its category's own day as a Spent total is, so its line's first word follows what
 * the page counts. ⛔ One noun for the line under the figure and for the page's empty state ("income in Salary is
 * imported through …", `lib/category-reach`) — two would name one day two ways on one page.
 */
export function countedFlow(kind: CategoryKind): CountedFlow {
  return kind === "expense" ? "spending" : kind === "income" ? "income" : "activity";
}

/**
 * What a total over a window read only in part IS, by what it counts: a Spent or a Received total is the lower bound
 * the empty state calls a zero (`A_LOWER_BOUND`), and a NET — "activity": a transfer, an investment, rewards,
 * Uncategorized — is neither, because it is a sum of both signs and the days still to import can move it either way.
 *
 * 🔴 Measured on his ledger copy 2026-10-21 (review of fdcebdc): `/categories/<Credit Card Payment>` for September,
 * +$3,411.58 — three card-side receipts whose paying legs are on accounts not read that far — said "so this total is a
 * lower bound rather than a measurement", and each leg still to import moves it toward $0.00; Internal Transfer's
 * -$2,000.00 (two out-legs whose in-legs are unread) moves the other way. 43 Net windows said it: transfer 26,
 * investment 8, rewards 5, Uncategorized 4.
 */
export function partReadTotal(counted: CountedFlow): string {
  return counted === "activity"
    ? "neither a measurement nor a bound: the days still to import can move it either way"
    : A_LOWER_BOUND;
}

/**
 * "spent only from" — how what is counted met the only accounts it touched, where none of them has an import day.
 * 🔴 On the pristine e2e fixture (today 2026-07-08) `/categories/<Dividends>` for 2026 to date — its rows on a brokerage
 * account no import dates — would have read "spent only from accounts with no import date" on a Received page.
 */
function onlyThrough(counted: CountedFlow): string {
  if (counted === "spending") return "spent only from";
  return counted === "income" ? "received only into" : "moved only through";
}

/** the facts a category's own day is read from — its ancestor's, where one is borrowed */
type CoverageFacts = Pick<
  BudgetCoverageInput,
  "importedThroughOn" | "spentFromSince" | "spentFromAccounts" | "spentFromWallets"
>;

/**
 * Whose day a category with no import day of its own is counted against: its page's (`services/budgets::
 * categoryReachFor`, ⚖️ §6A 49) — the nearest ANCESTOR that has one (an import day, or cash only), with that ancestor's
 * own facts, or else the LEDGER's day (null on an empty ledger).
 *
 * 🔴 The row counted against no day at all, so every elapsed day was "unaccounted" while the page one click away asked
 * the ancestor: on a copy of his ledger copy 2026-10-12, a budget on Travel › Hotels (none since March) read "Awaiting
 * statements · nothing imported for this category since Mar 1 · 2 days of this period unaccounted" under its page's
 * measured $0.00 — "Awaiting statements" for a statement no import could bring.
 */
export type BorrowedDay =
  | { whose: "ancestor"; name: string; coverage: CoverageFacts }
  | { whose: "ledger"; on: string | null };

/**
 * "spending in Fees imported through Aug 12" — whose day it is, in the page's words ("spending in Fees is imported
 * through …", "the ledger is imported through …"); an ancestor spent only from cash in its own row's. Null on an
 * empty ledger, which has no day to name. ⛔ An ancestor's clause is its own fact, named (`namedFor`): one rule
 * for naming a category's day wherever the line is not its own.
 */
function borrowedDayClause(
  borrowed: BorrowedDay,
  day: (iso: string) => string,
  periodStart: string,
  // an ancestor counts what its subtree counts — a subtree is one kind
  counted: CountedFlow,
): string | null {
  if (borrowed.whose === "ledger") return borrowed.on === null ? null : `the ledger imported through ${day(borrowed.on)}`;
  return budgetCoverageFact({ ...borrowed.coverage, bounds: { start: periodStart }, counted, namedFor: borrowed.name });
}

/**
 * Spent from a cash wallet in the window, and from no other account.
 *
 * ⚠️ Not "no import date": a category spent from nothing at all, or only from an
 * investment account, has none either, and neither is cash.
 */
export function spentOnlyFromCashWallets(
  input: Pick<BudgetCoverageInput, "spentFromAccounts" | "spentFromWallets">,
): boolean {
  return input.spentFromAccounts === 0 && input.spentFromWallets > 0;
}

/**
 * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): Spent and Left print "—" — Budget stays — where NOT ONE elapsed day of the
 * window has been read by the row's own day (`noDayRead`, the category headline's `emptyFigure` asked of the window
 * `uncoveredDays` is counted on) and not one row was found in it. The dashboard's pace tile and the category headline
 * already refuse "$0.00" there: "you have spent nothing" is a claim about a month nobody has looked at.
 *
 * 🔴 Measured on his ledger copy 2026-10-12: all 12 rows on /budgets and Housing's card on its category page read
 * "$0.00" spent and the whole plan left, over an October the accounts they are spent from were imported through Aug 12
 * or Sep 2 — under a headline on that page reading "—" for the same October.
 *
 * ⛔ A row found keeps the figures: a row is read through the EARLIEST of its accounts' days, so a fresher account's
 * charge can stand in a window that day has not reached, and the headline above the card prints its total. ⚖️ So does
 * a row spent only from cash wallets (2026-09-15): no import will ever read a wallet's day, and a dash would hide what
 * was typed for good.
 *
 * One test for the row's headline (`budgetVerdict`), the page note (`budgetSectionNotes`) and the page's proofs, so
 * they cannot disagree about which rows print a dash.
 */
export function spendUnread(
  input: Pick<BudgetCoverageInput, "spentFromAccounts" | "spentFromWallets"> & {
    /** not one elapsed day of the window has been read by the row's own day (`BudgetPaceStatus.noDayRead`) */
    noDayRead: boolean;
    /** the rows found in the window (`BudgetStatus.txnCount`) */
    txnCount: number;
  },
): boolean {
  return input.noDayRead && input.txnCount === 0 && !spentOnlyFromCashWallets(input);
}

/**
 * "spending imported through Sep 2".
 *
 * ⚠️ When no account has an import date, three different worlds, and only one of
 * them is "nothing imported": an investment account is priced rather than
 * imported (`observationFrontier` holds no day for it), so rows on one are
 * spending the ledger HAS, on an account nothing can say is up to date; and a
 * cash wallet holds what was typed into it, which no import will ever check.
 */
export function budgetCoverageFact(input: Omit<BudgetCoverageInput, "uncoveredDays">): string {
  const day = (iso: string): string => formatDayShortIn(iso, input.bounds.start);
  const counted = input.counted ?? "spending";
  const { namedFor } = input;
  if (input.importedThroughOn !== null) {
    return importedThroughFact(input.importedThroughOn, input.bounds.start, counted, namedFor);
  }
  // "Gifts & Donations spent only from …" where the line is not under its own category's figure
  const named = namedFor === undefined ? "" : `${namedFor} `;
  if (spentOnlyFromCashWallets(input)) {
    const wallets = input.spentFromWallets === 1 ? "a cash wallet" : "cash wallets";
    return `${named}${onlyThrough(counted)} ${wallets} since ${day(input.spentFromSince)}`;
  }
  const own =
    input.spentFromAccounts === 0
      ? `nothing imported for ${namedFor ?? "this category"} since ${day(input.spentFromSince)}`
      : `${named}${onlyThrough(counted)} accounts with no import date since ${day(input.spentFromSince)}`;
  // ⛔ the day the count was taken against is named beside it, or "7 days unaccounted" has no day to be counted from
  const borrowed = input.borrowedDay ? borrowedDayClause(input.borrowedDay, day, input.bounds.start, counted) : null;
  return borrowed === null ? own : `${own} · ${borrowed}`;
}

/**
 * "spending imported through Sep 2 · 13 days of this period unaccounted".
 *
 * ⚖️ A cash-only row counts no days: "15 days of this period unaccounted" would
 * promise a statement a wallet never issues. It says why instead — "spent only
 * from a cash wallet since Mar 1 — no statement will ever cover it".
 */
export function budgetCoverageSentence(input: BudgetCoverageInput): string {
  if (spentOnlyFromCashWallets(input)) {
    return `${budgetCoverageFact(input)} — no statement will ever cover ${input.spentFromWallets === 1 ? "it" : "them"}`;
  }
  return `${budgetCoverageFact(input)} · ${unaccountedDays(input.uncoveredDays)}`;
}

/**
 * "spending imported through Sep 2" — a named day, as the row names it; a day outside the period's year carries it.
 * ⚖️ Exported for decision 72's one-day windows: /spending's heatmap names the day a day past it is read through in
 * these words, the words under Where it went on the same page (`SpendHeatmap`'s `heatDayUnaccounted`). A Received or
 * Net page's line names what it counts instead (`countedFlow`) — "income imported through Sep 24" — and a category's
 * line under another subject's sentence names the category (`BudgetCoverageInput.namedFor`): "spending in Housing
 * imported through Jul 31".
 */
export function importedThroughFact(
  on: string,
  periodStart: string,
  counted: CountedFlow = "spending",
  namedFor?: string,
): string {
  const whose = namedFor === undefined ? counted : `${counted} in ${namedFor}`;
  return `${whose} imported through ${formatDayShortIn(on, periodStart)}`;
}

/**
 * ⚖️ Decisions 64 + 72 for a window of ALL his spending that is no total of its own — one cash-flow bucket, one heatmap
 * day: "spending imported through Aug 12" where the window holds NO spending row and not one of its elapsed days is read
 * by `readThrough` (`movers-card::spendingReadThrough`, the day every account he spends from is imported through — the
 * day the period's proof on the same page counts its unaccounted days from), or null where its Spent is a figure.
 *
 * §6A 64's dash, asked of the window and the day /budgets asks it of (`emptyPeriodReason`, clipped at today), past the
 * day only: a window the ledger has not reached at all, or that has not happened, says THAT (`unreachedKind`), and a
 * window with one day read is a lower bound with its figure. ⚖️ A ledger of cash wallets alone has no day a statement
 * could move (2026-09-15), so `readThrough` is null there and nothing waits.
 *
 * 🔴 Measured on his ledger copy 2026-10-13 (review of 2fce458): `/spending?period=2026-09`, all spending read through
 * Aug 12 and the ledger through Sep 24, tabled Sep 13 … Sep 22 "$0.00 $0.00 $0.00" and Sep 23 "Spent $0.00" beside its
 * $4,567.68 of pay, while the heatmap on the same page called those days "nothing found so far" — one card moved, one
 * did not. ⛔ One test for the table, the chart's hover, the heatmap's cells and its day sheet.
 */
export function spendingNotFoundFact(input: {
  from: string;
  to: string;
  today: string;
  ledgerOpens: string | null;
  /** `spendingReadThrough(db)` — null where no statement could move it (a ledger of cash wallets alone) */
  readThrough: string | null;
  /** the window's gross spending — a row found keeps the figure */
  spentCents: number;
}): string | null {
  const { from, to, today, ledgerOpens, readThrough, spentCents } = input;
  if (spentCents !== 0 || readThrough === null) return null;
  const reason = emptyPeriodReason({ from, to, today, ledgerOpens, ledgerReaches: readThrough });
  return reason.kind === "after-records" ? importedThroughFact(readThrough, from) : null;
}

/**
 * "nothing found so far — spending imported through Aug 12" — what a day with no spending found past that day says in
 * place of "$0.00": the heatmap's cell, the cash-flow chart's hover, the line under a day sheet's "—".
 */
export function nothingFoundSoFar(fact: string): string {
  return `nothing found so far — ${fact}`;
}

/**
 * "Nothing found so far — spending imported through Aug 12." — the same words as a card's whole empty sentence, where
 * a /spending card would otherwise claim an absence over the window ("No merchant spending in this period.").
 */
export function nothingFoundSoFarSentence(fact: string): string {
  const words = nothingFoundSoFar(fact);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/** "13 days of this period unaccounted" — scoped to the PERIOD, never to the gap since the import (see the top) */
function unaccountedDays(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"} of this period unaccounted`;
}

/**
 * "spending imported through Aug 12 · 30 days of this period unaccounted" — the row's sentence for a window read through
 * a NAMED day, for a total that has the day and none of a category's facts.
 *
 * ⚖️ His decision 72 (2026-10-13): a total over a window some of whose days are past its own read frontier reads
 * "partly read", with /budgets' line under its figure. /spending's total is read through `spendingCoverageThrough` —
 * the day every account he spends from has been imported through — and spent from no one category, so it asks for the
 * line here. ⛔ The row's own clauses (`importedThroughFact`, `unaccountedDays`), so the two cannot word one window two
 * ways: `budgetCoverageSentence` of a row with that day reads exactly this.
 */
export function readThroughSentence(on: string, uncoveredDays: number, bounds: { start: string }): string {
  return `${importedThroughFact(on, bounds.start)} · ${unaccountedDays(uncoveredDays)}`;
}
