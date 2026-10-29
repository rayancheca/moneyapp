import type { BudgetPeriodKind } from "@/db/schema/budgets";
import { ROLLOVER_SUBTRACTS } from "./arrears-reading";
import { monthLabel } from "./calendar-math";
import { budgetCoverageFact } from "./budget-coverage";
import type { CategoryCoverageFacts, CategoryReach } from "./category-reach";
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
export type RolloverReadOn =
  | { whose: Exclude<CategoryReach["whose"], "cash-only">; ancestor: string | null }
  | {
      whose: "cash-only";
      ancestor: string | null;
      /**
       * The facts the row's Grading line is worded from (`budgetCoverageFact`, the ancestor's where the day is
       * borrowed): how many wallets, and since when — so the panel says "a cash wallet since Apr 1" as the row beside
       * it does. ⛔ Required of a cash-only day, and on no other: 🔴 optional, a cash-only day without it was worded
       * "spent only from a cash wallet since <the graded window's first day>" — one wallet, and a day no read produced
       * (`?? { spentFromSince: reference, spentFromWallets: 1 }`; unreachable, `carryInto` always set it; batch 6
       * review, #23).
       */
      cash: Pick<CategoryCoverageFacts, "spentFromSince" | "spentFromWallets">;
    };

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

/**
 * What carries — said by the hover and the toast both, so the period that leaves the money is the one that must be
 * fully imported. 🔴 The hover said "…carries into the next period once that period is fully imported" (0c5c893): the
 * nearest period to "that" is the next one, still running — read so, a carry waits for the period now open, where
 * decision 67 holds the CLOSED one. It hovered over all 9 of his rolling rows, 7 of them holding September back (his
 * ledger copy 2026-10-29; batch 6 review, #21). The toast never had it.
 */
const LEFT_BY_A_FULL_PERIOD = "a fully imported period leaves unspent";

/**
 * The Roll over button's hover — the setting, said with decision 67's hold, the third reader of the rule beside the
 * panel and the plan's proof. 🔴 It hovered "Unspent budget carries into the next period" on every rolling row, over
 * Cash & ATM, Fees and Transport's $0.00 carried from a September not fully imported (his ledger copy 2026-10-21; review
 * of 44d0104).
 */
export function rolloverToggleTitle(on: boolean): string {
  return on
    ? `What ${LEFT_BY_A_FULL_PERIOD} carries into the next period`
    : "Unspent budget is forgotten at the end of each period";
}

/** …and its toast, of the category it was turned on or off for, in the hover's words */
export function rolloverToggleToast(categoryPath: string, on: boolean): string {
  return on
    ? `${categoryPath} now carries forward what ${LEFT_BY_A_FULL_PERIOD}`
    : `${categoryPath} resets each period`;
}

/** a category spent from no account in the window, or only from ones with no import day (priced investment accounts) */
const NO_ACCOUNT_OF_ITS_OWN = "With no account of its own to wait on,";
/**
 * A cash-only day is read through today, so only a day before the ledger opens — one an older statement would bring
 * in — holds a closed period back (`ROLLOVER_HOLDS`'s ⚠️). 🔴 It said "— none will ever cover it." under "April 2026 is
 * not fully imported, so nothing rolls over from it yet" of a budget opening before the ledger's first row (review of
 * 44d0104).
 */
const NO_STATEMENT = "a closed period waits for no statement";
const BEFORE_THE_RECORDS = "only a day before your records begin holds one back";
const ONE_OF_THEM = "so a missing statement on one of them cannot bank itself as savings.";

/**
 * The day a closed period waits for, whoever's day it is read on — its own accounts', an ancestor's or the ledger's.
 * 🔴 "through its last day" after "the accounts Utilities…" read as Utilities' last day (review of 9249ae7), and stayed
 * where a category waits on its own accounts, "…the accounts this category has lately been spent from are imported
 * through its last day" — this category's day as readily as the period's, on the branch all 9 of his rolling rows show
 * (his ledger copy 2026-10-29; batch 6 review, #20). One phrasing.
 */
const THROUGH_THAT_PERIODS_LAST_DAY = "imported through that period's last day";

/** "the accounts Utilities has lately been spent from are imported through that period's last day" */
function accountsImported(whose: string): string {
  return `the accounts ${whose} has lately been spent from are ${THROUGH_THAT_PERIODS_LAST_DAY}`;
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
 * rolling budgets read their own accounts, and keep that sentence — through that period's last day now, not its.
 *
 *  - its own accounts, or an ANCESTOR's (named): the earliest import day among them (`categoryCoverage`), so a
 *    statement missing on one of them holds the period.
 *  - the LEDGER's day (`ledgerReaches`): the newest day ANY account reaches — ⛔ so nothing is promised of a missing
 *    statement, which that day does not wait for.
 *  - ⚖️ spent only from cash wallets (2026-09-15), its own or the ancestor's: read through today — no statement is
 *    coming, as the row says ("— no statement will ever cover it"), and only the days before the ledger opens can hold
 *    a period back. In the row's own words (`budgetCoverageFact`): "spent only from a cash wallet since Apr 1" — 🔴 it
 *    said "cash wallets" of his one wallet, with no window, and the ancestor's version read as a broken clause
 *    ("…read as Travel is, spent only from cash wallets, so…"; review of 9249ae7).
 *
 * `reference` is the graded window's first day: a day outside its year carries the year, as on the row.
 */
export function rolloverWaitsSentence(readOn: RolloverReadOn, reference: string): string {
  const { ancestor } = readOn;
  if (readOn.whose === "cash-only") {
    const facts = { importedThroughOn: null, spentFromAccounts: 0, bounds: { start: reference } };
    const spent = budgetCoverageFact({ ...facts, ...readOn.cash, namedFor: ancestor ?? undefined });
    return ancestor === null
      ? `This category has been ${spent}, so ${NO_STATEMENT} — ${BEFORE_THE_RECORDS}.`
      : `${NO_ACCOUNT_OF_ITS_OWN} this category is read as ${ancestor} is — ${spent} — so ${NO_STATEMENT}; ` +
          `${BEFORE_THE_RECORDS}.`;
  }
  const ofThisCategory = `${NO_ACCOUNT_OF_ITS_OWN} a period of this category adds nothing until`;
  if (readOn.whose === "ledger") return `${ofThisCategory} the ledger is ${THROUGH_THAT_PERIODS_LAST_DAY}.`;
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
 * "September 2026", "July 2026 and August 2026", "3 months, July 2026 to September 2026," — the periods held back
 * (never none), named both or counted between the first and the last, days and weeks by their days ("4 days, Oct 10 –
 * Oct 13,"). ⛔ One naming for the panel's sentence (`rolloverHeldBackSentence`) and the row's clause
 * (`rolloverMayRiseClause`), so the two cannot name one wait two ways.
 */
function heldBackNamed(heldBack: readonly PeriodBounds[], period: BudgetPeriodKind, reference: string): string {
  const first = heldBack[0]!;
  const last = heldBack[heldBack.length - 1]!;
  const named = (p: PeriodBounds): string => periodName(p, period, reference);
  const span =
    period === "monthly" || period === "annual"
      ? `${named(first)} to ${named(last)}`
      : `${formatDayShortIn(first.start, reference)} – ${formatDayShortIn(last.end, reference)}`;
  if (heldBack.length === 1) return named(first);
  if (heldBack.length === 2) return `${named(first)} and ${named(last)}`;
  return `${heldBack.length} ${PERIOD_NOUN[period]}, ${span},`;
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
  const subject = heldBackNamed(heldBack, period, reference);
  const sentence =
    heldBack.length === 1
      ? `${subject} is not fully imported, so nothing rolls over from it yet.`
      : `${subject} are not fully imported, so nothing rolls over from them yet.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** What a rolling row's line can still do: the carry's facts (`services/budgets::BudgetStatus`). */
export interface RolloverRiseInput {
  /** the most the periods held back can still add to the carry as they are read (`BudgetStatus.rolloverMayAddCents`) */
  rolloverMayAddCents: number;
  /** those periods, oldest first (`BudgetStatus.rolloverHeldBack`) */
  rolloverHeldBack: readonly PeriodBounds[];
  budget: { period: BudgetPeriodKind };
  /** the graded window: a day outside its year is printed with its year */
  bounds: { start: string };
}

/**
 * The line this row is graded against — its plan and what has rolled over — can still RISE: a closed period held back
 * (decision 67) can still bank as its statements land, at any step of the order they can land in, on its plan less the
 * spend found in it so far — never less a bill due in it, which may yet lapse (`services/budgets::RolloverCarry`'s
 * `mayAddCents`).
 *
 * ⚖️ default built, not asked (2026-10-29): wherever it can, nothing measured against the line is a floor — how far
 * past it an over row is, a withheld row's percentage — and no reading says a later import cannot undo it; the over
 * verdict itself stands (his rule: never withheld). 🔴 Review of 48475ec4: Food, $30.00 a month rolling from Jul 1,
 * spoke "over budget by at least $10.00" in August while July, held back with $0.00 of it found, could still bank
 * $30.00 — and on the load after July's statement read $40.00 of $60.00 ($30.00 rolled over), no Food added anywhere.
 * 🔴 Review of 4cd38494: it answered false where the line could rise — an older period able to bank while a newer one
 * past its plan waits; a cancelled bill's overdue held against the period it lapses in — and so let the note's "so
 * each is over by at least what it shows", a withheld row's "the percentage can only rise" and `paceOver`'s "no later
 * import can undo that" stand.
 *
 * ⛔ One test for the row's verdict and definition (`budgetVerdict`), its line and spoken sentence
 * (`budgetCoverageLine`, `BudgetRow`), the category page's card and the page note (`budgetSectionNotes`).
 */
export function lineMayRise(row: Pick<RolloverRiseInput, "rolloverMayAddCents">): boolean {
  return row.rolloverMayAddCents > 0;
}

/**
 * "more can still roll over from September 2026 once it is fully imported" — what a row whose line can still rise
 * (`lineMayRise`) says beside the readings that lean on the line standing still (`budgetCoverageLine`); null where it
 * cannot, or no period is named to wait on. In the toggle's words — what is left unspent carries over once a period is
 * fully imported (`rolloverToggleTitle`) — and the panel's naming of what it holds (`rolloverHeldBackSentence`).
 * ⚠️ It names every period held back, as the panel does, though one already past its plan adds nothing.
 */
export function rolloverMayRiseClause(row: RolloverRiseInput): string | null {
  const held = row.rolloverHeldBack;
  if (!lineMayRise(row) || held.length === 0) return null;
  const named = heldBackNamed(held, row.budget.period, row.bounds.start);
  return `more can still roll over from ${named} once ${held.length === 1 ? "it is" : "they are"} fully imported`;
}
