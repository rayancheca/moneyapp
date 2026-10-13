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
 * empty ledger, which has no day to name.
 */
function borrowedDayClause(borrowed: BorrowedDay, day: (iso: string) => string, periodStart: string): string | null {
  if (borrowed.whose === "ledger") return borrowed.on === null ? null : `the ledger imported through ${day(borrowed.on)}`;
  const { importedThroughOn } = borrowed.coverage;
  return importedThroughOn !== null
    ? `spending in ${borrowed.name} imported through ${day(importedThroughOn)}`
    : `${borrowed.name} ${budgetCoverageFact({ ...borrowed.coverage, bounds: { start: periodStart } })}`;
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
  if (input.importedThroughOn !== null) return `spending imported through ${day(input.importedThroughOn)}`;
  if (spentOnlyFromCashWallets(input)) {
    return `spent only from ${input.spentFromWallets === 1 ? "a cash wallet" : "cash wallets"} since ${day(input.spentFromSince)}`;
  }
  const own =
    input.spentFromAccounts === 0
      ? `nothing imported for this category since ${day(input.spentFromSince)}`
      : `spent only from accounts with no import date since ${day(input.spentFromSince)}`;
  // ⛔ the day the count was taken against is named beside it, or "7 days unaccounted" has no day to be counted from
  const borrowed = input.borrowedDay ? borrowedDayClause(input.borrowedDay, day, input.bounds.start) : null;
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
  const n = input.uncoveredDays;
  return `${budgetCoverageFact(input)} · ${n} ${n === 1 ? "day" : "days"} of this period unaccounted`;
}
