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
 * Statement lag is normal here (accounts land on different dates each month), so
 * all of this reads as a fact about coverage, never as an error.
 */
export interface BudgetCoverageInput {
  /** the day every account the category was spent from has been imported through; null when none has an import date */
  importedThroughOn: string | null;
  /** where the window of accounts the category was spent from opens */
  spentFromSince: string;
  /** how many accounts the category was spent from in that window, including any with no import date */
  spentFromAccounts: number;
  /** days of the graded period the ledger has not covered */
  uncoveredDays: number;
  /** the graded window: a day outside its year is printed with its year */
  bounds: { start: string };
}

/**
 * "spending imported through Sep 2".
 *
 * ⚠️ When no account has an import date, two different worlds, and only one of
 * them is "nothing imported": an investment account is priced rather than
 * imported (`observationFrontier` holds no day for it), so rows on one are
 * spending the ledger HAS, on an account nothing can say is up to date.
 */
export function budgetCoverageFact(input: Omit<BudgetCoverageInput, "uncoveredDays">): string {
  const day = (iso: string): string => formatDayShortIn(iso, input.bounds.start);
  if (input.importedThroughOn !== null) return `spending imported through ${day(input.importedThroughOn)}`;
  return input.spentFromAccounts === 0
    ? `nothing imported for this category since ${day(input.spentFromSince)}`
    : `spent only from accounts with no import date since ${day(input.spentFromSince)}`;
}

/** "spending imported through Sep 2 · 13 days of this period unaccounted" */
export function budgetCoverageSentence(input: BudgetCoverageInput): string {
  const n = input.uncoveredDays;
  return `${budgetCoverageFact(input)} · ${n} ${n === 1 ? "day" : "days"} of this period unaccounted`;
}
