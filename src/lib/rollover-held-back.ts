import type { BudgetPeriodKind } from "@/db/schema/budgets";
import { ROLLOVER_SUBTRACTS } from "./arrears-reading";
import { monthLabel } from "./calendar-math";
import type { CategoryReach } from "./category-reach";
import type { PeriodBounds } from "./dates";
import { formatDayShortIn } from "./format-date";

/**
 * What a rolling budget's panel says about the closed periods its carry is waiting on.
 *
 * ⚖️ OWNER DECISION 2026-10-13 (decision 67): a CLOSED period with any day not yet read banks nothing until its
 * statements land (`services/budgets::carryInto`, its `heldBack`). 🔴 On his ledger copy 2026-10-12 September banked
 * $761.52 that no statement confirmed, under a panel that had ended "…, so a missing statement cannot bank itself as
 * savings" (8f9f408) — false, and cut (review of 8f9f408) until this made it true.
 *
 * ⛔ The rule is said once (`rolloverWaitsSentence`), by its own cause: it is the carry's hold, not the arrears'
 * subtraction (`lib/arrears-reading::ROLLOVER_SUBTRACTS`), that keeps a missing statement out of the carry.
 *
 * ⚠️ …and no further than it reaches. 🔴 The sentence ended flatly "…, so a missing statement cannot bank itself as
 * savings" — false of a statement missing on an account the category was never spent from (`categoryCoverage`'s
 * documented gap: "a FIRST charge on an account the category was never spent from in the window is not waited for"),
 * whose June banks (review of 73a743d; pinned in `budgets.test.ts`).
 */

/**
 * Whose day a rolling budget's closed periods are read through: what `services/budgets::carryInto` asked
 * (`categoryReachFor`, its category page's day) for the newest period it walked, or for the period now running when
 * none has closed. `whose` is the reach's own (`lib/category-reach::CategoryReach`); `ancestor` names the nearest
 * ancestor whose day it is where the category has none of its own, and is null where the day is its own or the
 * ledger's.
 */
export interface RolloverReadOn {
  whose: CategoryReach["whose"];
  ancestor: string | null;
}

/**
 * What a closed period banks — said by BOTH readers of the carry's rule: the rolling row's panel (`BudgetDetails`) and
 * its plan's proof (`services/provenance::budgetPlanProvenance`). One string, so neither can say what the carry does
 * not do.
 *
 * 🔴 The plan's proof said its own words, and kept them past decision 67: "this plan plus whatever you underspent in
 * closed periods" (10cd4f7, Aug 27). On his ledger copy 2026-10-21 Transport's popover said it over $85.99 left of
 * September's $227.95 plan and $0.00 carried, beside a panel saying "September 2026 is not fully imported, so nothing
 * rolls over from it yet" (review of 9249ae7).
 */
export const ROLLOVER_BANKS =
  "A period that came in under plan adds its leftover; one that went over adds nothing, and overspend is never " +
  `carried as a debt. ${ROLLOVER_SUBTRACTS}`;

/**
 * ⚖️ Decision 67, said of no one budget's day — the plan's proof's, which reads no carry (it would mean recomputing
 * `budgetStatuses`). The panel says the same rule of whose day its carry asked (`rolloverWaitsSentence`), and names the
 * periods it holds (`rolloverHeldBackSentence`, "…is not fully imported, so nothing rolls over from it yet").
 * ⚠️ True of a cash-only category too: its page reads it through today, so only a day before the ledger opens — one an
 * older statement would bring in — holds a closed period of it.
 */
export const ROLLOVER_HOLDS = "A closed period that is not fully imported adds nothing until its statements land.";

/** a category spent from no account in the window, or only from ones with no import day (priced investment accounts) */
const NO_ACCOUNT_OF_ITS_OWN = "With no account of its own to wait on,";
const NO_STATEMENT = "so a closed period waits for no statement — none will ever cover it.";
const ONE_OF_THEM = "so a missing statement on one of them cannot bank itself as savings.";

/** "the accounts Utilities has lately been spent from are imported through its last day" */
function accountsImported(whose: string): string {
  return `the accounts ${whose} has lately been spent from are imported through its last day`;
}

/**
 * The rule the carry's hold stands on, said of whose day it asked — the panel's last sentence.
 *
 * 🔴 It was ONE sentence for every rolling budget — "A period adds nothing until the accounts this category has lately
 * been spent from are imported through its last day, …" — while the carry asks the category page's day, which falls
 * back (review of 46b6e4b, measured on a copy of his ledger 2026-10-13): 7 of his expense categories without a budget
 * have no account of their own lately — Water/Gas and Mobile read Utilities' day, Hotels Travel's, Medical Health's,
 * Card Annual Fees and Interest Charges Fees', Gifts & Donations the ledger's Sep 24. A $100 rolling Gifts & Donations
 * budget from Jul 1 held September back under a sentence about accounts Gifts had never been spent from. All 9 of his
 * rolling budgets read their own accounts, and keep the sentence they had.
 *
 *  - its own accounts, or an ANCESTOR's (named): the earliest import day among them (`categoryCoverage`), so a
 *    statement missing on one of them holds the period.
 *  - the LEDGER's day (`ledgerReaches`): the newest day ANY account reaches — ⛔ so nothing is promised of a missing
 *    statement, which that day does not wait for.
 *  - ⚖️ spent only from cash wallets (2026-09-15), its own or the ancestor's: read through today — no statement is
 *    coming, as the row says ("— no statement will ever cover it").
 */
export function rolloverWaitsSentence(readOn: RolloverReadOn): string {
  const { whose, ancestor } = readOn;
  if (whose === "cash-only") {
    return ancestor === null
      ? `This category is spent only from cash wallets, ${NO_STATEMENT}`
      : `${NO_ACCOUNT_OF_ITS_OWN} this category is read as ${ancestor} is, spent only from cash wallets, ${NO_STATEMENT}`;
  }
  const ofThisCategory = `${NO_ACCOUNT_OF_ITS_OWN} a period of this category adds nothing until`;
  if (whose === "ledger") return `${ofThisCategory} the ledger is imported through its last day.`;
  return ancestor === null
    ? `A period adds nothing until ${accountsImported("this category")}, ${ONE_OF_THEM}`
    : `${ofThisCategory} ${accountsImported(ancestor)}, ${ONE_OF_THEM}`;
}

const PERIOD_NOUN: Record<BudgetPeriodKind, string> = {
  daily: "days",
  weekly: "weeks",
  monthly: "months",
  annual: "years",
};

/** "September 2026", "the week of Sep 28", "Sep 30", "2025" — a day from outside `reference`'s year says its year */
function periodName(p: PeriodBounds, period: BudgetPeriodKind, reference: string): string {
  if (period === "monthly") return monthLabel(p.start.slice(0, 7));
  if (period === "annual") return p.start.slice(0, 4);
  const day = formatDayShortIn(p.start, reference);
  return period === "weekly" ? `the week of ${day}` : day;
}

/**
 * "September 2026 is not fully imported, so nothing rolls over from it yet." — null when nothing is held back. Several
 * are named both, or counted between the first and the last ("3 months, July 2026 to September 2026, …"; days and
 * weeks by their days, "4 days, Oct 10 – Oct 13, …"). `reference` is the graded window's first day.
 */
export function rolloverHeldBackSentence(
  heldBack: readonly PeriodBounds[],
  period: BudgetPeriodKind,
  reference: string,
): string | null {
  if (heldBack.length === 0) return null;
  const first = heldBack[0]!;
  const last = heldBack[heldBack.length - 1]!;
  const one = heldBack.length === 1;
  const named = (p: PeriodBounds): string => periodName(p, period, reference);
  const span =
    period === "monthly" || period === "annual"
      ? `${named(first)} to ${named(last)}`
      : `${formatDayShortIn(first.start, reference)} – ${formatDayShortIn(last.end, reference)}`;
  const subject = one
    ? named(first)
    : heldBack.length === 2
      ? `${named(first)} and ${named(last)}`
      : `${heldBack.length} ${PERIOD_NOUN[period]}, ${span},`;
  const sentence = one
    ? `${subject} is not fully imported, so nothing rolls over from it yet.`
    : `${subject} are not fully imported, so nothing rolls over from them yet.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
