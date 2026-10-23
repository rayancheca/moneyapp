import { cache } from "react";
import type { AppDatabase } from "@/db/client";
import { apportionPercents } from "@/lib/apportion";
import { readThroughSentence } from "@/lib/budget-coverage";
import { lastFullyReadMonth } from "@/lib/committed";
import { addCalendarMonths, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { daysNotImportedYet } from "@/lib/empty-period";
import { formatDayShort, formatMonthYear, monthWindowLabel } from "@/lib/format-date";
import { resolvePeriod, withPeriod } from "@/lib/period";
import { formatCents } from "@/lib/money";
import { listAccounts, outsidePortfolioCashAccountIds } from "./accounts";
import { activeTxnsInRange, loadCategoryIndex, monthlySpending, spendingBucket, transactionsHref } from "./analytics";
import { accountsAwaitingStatements } from "./cash-wallet-rule";
import { SPEND_BASELINE_MONTHS } from "./committed";
import {
  accountsThatDate,
  awaitedAmong,
  frontierForSeries,
  ledgerOpens,
  observationFrontier,
  type ObservationFrontier,
} from "./observation-frontier";
import type { PartlyRead } from "./provenance";
import { MIN_OCCURRENCES } from "./recurring";

/**
 * What changed — which categories are running above or below their usual, and
 * over which month that can honestly be said.
 *
 * ## ⛔ Why this is NOT `categoryTrends`
 *
 * `categoryTrends` (analytics.ts, removed 2026-10-22: nothing on screen called
 * it, and its 3-month mean read partly read months) was the closest thing then
 * in the tree, and it answered a subtly different question: raw month-over-month movement,
 * **including the running month**, against a trailing 3-month mean. That is the
 * right shape for a table on /spending, where the reader is looking at a grid of
 * months and can see for themselves that the last bar is half-built. It is the
 * wrong shape for a dashboard card, which states one number as a fact:
 * measured 2026-08-26 its `momDeltaCents` for Food is −$1,533 — August-so-far
 * minus July-whole — and nothing in its output says the two periods are not
 * comparable. It also knows nothing about import coverage, and its 3-month mean
 * is a third window on a screen that already publishes six.
 *
 * So everything BELOW it is reused and none of it is re-derived: the rows come
 * from `monthlySpending`, which is `activeTxnsInRange` + `spendingBucket` — the
 * same classifier, the same split expansion, the same netting. Only the choice
 * of WHICH months may be compared is new, and that choice is this module's
 * entire reason to exist.
 *
 * ## 🔴 The comparison, and why it is this one
 *
 * The current month is not compared. Three candidates were measured against the
 * real ledger on 2026-08-26 (`scripts/probe-movers.ts`), and the first two both
 * publish a fall that has not happened:
 *
 *  - **Aug 1–26 against whole prior months** — Food "−87%", Shopping "−85%",
 *    Travel and Cash & ATM "−100%". Twenty-six days measured against
 *    thirty-one-day averages; the shortfall is mostly the calendar.
 *  - **Aug 1–26 against days 1–26 of prior months** — the elapsed-days fix, and
 *    it barely moves: Food "−85%", Shopping "−87%". Because the missing days
 *    are not at the END of the month, they are missing from the ACCOUNTS.
 *    Chase Sapphire carries 16% of the spending and has not one August row;
 *    Discover stops on Aug 9; SoFi has no transaction since May. Not one day of
 *    August is covered by every account that spends.
 *  - **the newest COMPLETE month every spending account has been imported
 *    through** — 2026-07 here — against the mean of the `SPEND_BASELINE_MONTHS`
 *    complete months before it. This is what ships.
 *
 * That is the runway card's own convention ("this month is still running and is
 * not counted") and `SPEND_BASELINE_MONTHS`' own docstring, applied to a
 * comparison rather than to an average — and the window LENGTH is imported from
 * it rather than re-picked.
 *
 * ⚠️ Not the same six months, though, and it cannot be: the runway averages six
 * months ENDING at the compared one — since decision 71 the last month every
 * account you spend from is read through to its end, below (Feb–Jul here, $8,093
 * a month) — while this averages the six BEFORE it (Jan–Jun, $7,188), because a month
 * cannot sit inside the baseline it is being measured against — it would damp
 * its own delta by a sixth. Two figures a reader could hear as one word, so
 * neither card says "usual" without saying which months it means, in the
 * sentence directly under the headline.
 *
 * ⚖️ Since his decision 71 (2026-10-13) the runway's six END at the last month
 * every account you spend from is read through to its end (`baselineWindow`
 * over `spendingCoverageThrough`, below), not before today: on his ledger copy
 * that day Feb–Jul, while this card, which looks back `MAX_MONTHS_BEHIND`
 * months, found no month it could compare and drew nothing.
 *
 * ⚠️ The price of this choice is that the card is always talking about a month
 * that has closed, so it says which month, in words, above the numbers. A card
 * that reported August would be newer and wrong.
 *
 * ## 🔴 "Complete" is not enough — the month must have been LOOKED AT
 *
 * A month can be over and still be missing, because statements land weeks after
 * the period they cover. `observationFrontier` already answers "through which
 * day has the ledger been shown this account" — the weaker fact the recurring
 * calendar needed, and exactly the fact needed here — so the compared month is
 * the newest one every LIVE SPENDER has been imported past. On this ledger July
 * clears by a single day: SoFi's statement closes 2026-07-31.
 *
 * A **live spender** is an account with spending in at least `MIN_OCCURRENCES`
 * of the baseline months. The constant is imported rather than re-picked
 * because it is the same idea it always encodes — one observation is not a
 * habit — and the alternative was measured and is a trap: requiring EVERY
 * account with any spend at all to be current lets one dormant account veto the
 * card forever. SoFi Checking spent twice in six months and has had no
 * transaction since May; under the loose rule it would block every month after
 * July permanently. This is `frontierForSeries`' recorded lesson ("one dormant
 * account is enough to drag that floor back months") in a second place.
 *
 * ## ⛔ Refunds NET, they are not filtered
 *
 * Inherited, not re-decided: `monthlySpending` sums `−amountCents` over every
 * row the bucket admits, so an inflow inside an expense category reduces that
 * category's spend instead of being dropped. Pass 66 found twelve of them
 * understating spending by $487.50. A card about CHANGE is the worst place for
 * that bug — a refund landing in one month and not the next is a change all by
 * itself, and filtering would report it as a fall in purchasing.
 */

/**
 * How far back the compared month may sit before the card gives up.
 *
 * Two, and the reason is the statement calendar rather than taste: a statement
 * for month *m* arrives during month *m+1*, so on any given day the previous
 * month may legitimately not have landed yet — that is normal cadence, not a
 * defect (`docs`, and the ledger's own history: three of ten accounts were
 * mid-import on 2026-08-26). If the month before THAT is also unimported the
 * ledger is not being kept up, and a card headed "what changed" has nothing
 * recent enough to describe. It returns null rather than reporting spring.
 */
export const MAX_MONTHS_BEHIND = 2;

/**
 * How many movers the card lists.
 *
 * Five. This is a card on a dashboard, not the /spending table, and the
 * remainder is not dropped: everything below the cut is summed into one
 * `other` line so the rows still add up to the headline. A reader can always
 * check the arithmetic on the card itself.
 */
export const TOP_MOVERS = 5;

/**
 * ⛔ `Math.round(-0.4)` is `-0`, and `formatCents(-0)` renders "-$0.00".
 *
 * Every mean here divides a signed total (a category whose window is net
 * refunds has a NEGATIVE total) by a month count, so this is a live hazard
 * rather than a formality — and one that hides, because `-0 + 0 === 0` leaves
 * every sum correct while a single cell prints a minus sign it does not have.
 */
function cents(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/**
 * When the ledger itself begins.
 *
 * ⚠️ This is the same question `category-forecast`'s private
 * `earliestActiveTxnDate` ("the coverage floor") asks, and it is repeated here
 * only because that one is module-private and its file is in flight. Exporting
 * it and deleting this is a one-line follow-up.
 */
/** The last day of a month key — `periodBounds` owns the calendar, not this. */
function lastDayOf(month: string): string {
  return periodBounds(`${month}-01`, "monthly").end;
}

export interface MoverLine {
  /** null = the explicit Uncategorized bucket `spendingBucket` publishes */
  categoryId: string | null;
  categoryName: string;
  /** what went out in the compared month; positive, refunds netted */
  monthCents: number;
  /** the mean of the same category across the baseline months */
  usualMonthlyCents: number;
  /** month − usual; positive = spent MORE than usual */
  deltaCents: number;
  /**
   * The delta as a share of the usual.
   *
   * ⛔ Null unless the usual is strictly POSITIVE, and `> 0` is not `!== 0` by
   * accident. Zero would divide by zero and render "Infinity%"; a NEGATIVE
   * usual (a category that net-refunded across the baseline) is worse than
   * that, because it divides cleanly and comes out with the wrong SIGN — a rise
   * in spending printed as a fall.
   */
  pctOfUsual: number | null;
  /** the same figure as the card prints it, e.g. "+998%" — null when there is none */
  pctLabel: string | null;
  direction: "up" | "down";
  /** how many baseline months this category was spent in at all */
  monthsSeen: number;
  /**
   * Why this row's "usual" should not be leaned on — null when it is solid.
   *
   * `MIN_OCCURRENCES` is the app's own line between an anecdote and a pattern
   * and it is imported, not re-picked. It matters here: measured on the real
   * ledger, Education reads "$384 less than usual" off two spends in six
   * months, one of them a single $2,250 charge. That is lumpiness, not a
   * change in habit, and the row says so instead of being silently dropped —
   * dropping it would also hide the $2,250 in the month it lands.
   */
  thinNote: string | null;
  /** the drill-down that lists exactly the rows behind `monthCents` */
  href: string;
}

/** A live spender the ledger has not been shown through today. */
export interface CoverageLag {
  accountId: string;
  name: string;
  /** the day it has been imported through */
  through: string;
  /** the same day as the card prints it, e.g. "Aug 2" */
  throughLabel: string;
  /** its share of the baseline's spending, 0–100 */
  sharePct: number;
  /** the same share as the card prints it, e.g. "51% of the usual" */
  shareLabel: string;
}

export interface MoversCard {
  /** the compared month, e.g. "2026-07" */
  month: string;
  monthLabel: string;
  /**
   * `/spending` for the compared month — the drill-down contract for the card's
   * header link.
   *
   * 🔴 It was a bare `/spending`, which `resolvePeriod` resolves to the RUNNING
   * month, and this card is by construction almost never about the running
   * month. Measured on the owner's ledger 2026-09-15: the card read "$3,040.49
   * more than usual, in Jul 2026" and the link opened September 2026, where the
   * page refuses any comparison ("There is no comparison for September 2026
   * yet: Aug 12, 2026, the last day every account you spend from has been
   * imported through, comes before any of it."). `/spending?period=2026-07`
   * compares July against June whole.
   */
  spendingHref: string;
  /** the running month, which is deliberately NOT the compared one */
  currentMonthLabel: string;
  baselineMonths: number;
  baselineFromLabel: string;
  baselineToLabel: string;

  monthTotalCents: number;
  /** the usual month, as the sum of the per-category usuals the rows print */
  usualMonthlyCents: number;
  totalDeltaCents: number;
  totalPctOfUsual: number | null;

  /** "$3,053.25" — or "The same" when nothing moved */
  headline: string;
  headlineNoun: string;
  direction: "up" | "down" | "flat";
  /** what is being compared to what, in words, so the headline cannot be misread */
  summary: string;

  /** biggest money moves first, at most `TOP_MOVERS` of them */
  movers: MoverLine[];
  /** everything below the cut, so the rows still reconcile with the headline */
  otherCount: number;
  otherDeltaCents: number;
  otherNote: string | null;

  /** why the running month is not the compared one — always said out loud */
  currentMonthNote: string;
  /** live spenders behind today, largest share of the usual first */
  lagging: CoverageLag[];
  /** a live spender that was not in the ledger for whole baseline months */
  historyNote: string | null;
  today: string;
}

/** "+998%" / "-100%" — the card's only percentage format. */
function pctLabelOf(pct: number | null): string | null {
  if (pct === null) return null;
  const rounded = Math.round(pct);
  // an exact zero is not a rise; and -0 must never reach the label
  if (rounded === 0) return "0%";
  // ⚠️ an ASCII hyphen, not a typographic minus: this label sits inches from
  // `formatCentsSigned`'s "-$384.44" and two different minus glyphs in one row
  // read as two different kinds of number
  return rounded > 0 ? `+${rounded}%` : `-${Math.abs(rounded)}%`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A readable list: "Venture X", "Venture X and Discover", "A, B and C". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface Grid {
  /** month key → categoryId ("∅" for Uncategorized) → cents out */
  byMonth: Map<string, Map<string, { name: string; cents: number }>>;
  /** accountId → month key → cents out */
  byAccount: Map<string, Map<string, number>>;
}

/**
 * The two aggregations this card needs over one span.
 *
 * The category grid is `monthlySpending`'s, untouched — that function already
 * answers "per-month totals by top-level category" and re-deriving it here
 * would give the app two answers to one question. The account grid is a
 * question nothing publishes, so it is built here from `activeTxnsInRange` and
 * `spendingBucket`: the same rows and the SAME inclusion predicate, grouped by
 * a different key. Sharing the classifier is the point — an account could
 * otherwise be judged "live" off rows the spending totals do not count.
 */
function grid(db: AppDatabase, from: string, to: string, months: number, today: string): Grid {
  const byMonth = new Map<string, Map<string, { name: string; cents: number }>>();
  for (const cell of monthlySpending(db, { months, refDate: today })) {
    const row = byMonth.get(cell.month) ?? new Map<string, { name: string; cents: number }>();
    const key = cell.categoryId ?? "∅";
    const prior = row.get(key);
    row.set(key, { name: cell.categoryName, cents: (prior?.cents ?? 0) + cell.spentCents });
    byMonth.set(cell.month, row);
  }

  return { byMonth, byAccount: accountGrid(db, from, to) };
}

/** accountId → month key → cents out over [from, to] — the account half of `grid`, and its reason. */
function accountGrid(db: AppDatabase, from: string, to: string): Map<string, Map<string, number>> {
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const byAccount = new Map<string, Map<string, number>>();
  for (const txn of activeTxnsInRange(db, from, to)) {
    if (!spendingBucket(idx, agentsCash, txn)) continue;
    const perMonth = byAccount.get(txn.accountId) ?? new Map<string, number>();
    const m = monthKey(txn.postedOn);
    perMonth.set(m, (perMonth.get(m) ?? 0) - txn.amountCents);
    byAccount.set(txn.accountId, perMonth);
  }
  return byAccount;
}

/** What the card loads: wide enough for the furthest-back candidate's whole baseline (a habit's months, `Habit`). */
function loadedSpan(
  currentMonth: string,
  baselineMonths: number = SPEND_BASELINE_MONTHS,
): { from: string; to: string; months: number } {
  const oldestMonth = monthKey(addCalendarMonths(`${currentMonth}-01`, -(MAX_MONTHS_BEHIND + baselineMonths)));
  return { from: `${oldestMonth}-01`, to: lastDayOf(currentMonth), months: MAX_MONTHS_BEHIND + baselineMonths + 1 };
}

/**
 * The accounts you spend from HABITUALLY across a baseline — the card's "live
 * spenders": spending in at least `MIN_OCCURRENCES` of its months, and bearing
 * an import frontier. The module docstring carries why this set and not "every
 * account with any spend" (one dormant account would veto every month).
 *
 * ⛔ Exported because a SECOND surface needs exactly this set: /spending cuts
 * its comparisons at the day these accounts have all been imported through
 * (`spendingCoverageThrough`), and the dashboard names that same day. Two copies
 * of the filter would let the two pages name two different days.
 */
export function liveSpendersOver(
  byAccount: ReadonlyMap<string, ReadonlyMap<string, number>>,
  baselineKeys: readonly string[],
  frontier: ObservationFrontier,
): string[] {
  return habitualAccountsOver(byAccount, () => baselineKeys, frontier, MIN_OCCURRENCES);
}

/**
 * How a figure tells the accounts its rows come in on HABITUALLY from a dormant one (`habitualCoverage`): its rows in
 * at least `minMonths` of the `months` complete months before the month asked about.
 */
export interface Habit {
  /** how many complete months before a candidate month an account's habit is judged over */
  months: number;
  /** how many of those months must hold its rows */
  minMonths: number;
  /**
   * Who dates the day while no account holds the habit yet — a ledger too young for one: EVERY account (spending's: any
   * of them might be spent from) or only those the rows came in on and still coming in when last read (the income
   * pace's, `stillComingIn`: a card that never paid him cannot hold back his income at the pace)
   */
  beforeAHabit: "every account" | "its own accounts";
  /**
   * Who dates the day where none of the accounts that would is one a statement is still coming for — each archived or a
   * cash wallet (`datingAccountsOf`): every one of them all the same (spending's, `accountsThatDate`: an archived
   * account's own last day still says something true where nothing else could, and judged over the candidate's months
   * a closed account stops being a habit by itself), or none of them, and the calendar's months stand (the income
   * pace's: judged over its own months an earner never stops being one, so its last day would hold them back for good)
   */
  whenNoneIsAwaited: "every one of them" | "none of them";
  /**
   * Which months an account's habit is judged over where its imports stop short of the candidate's (`habitMonthsOf`):
   * the candidate's all the same (spending's — a month no import has read counts as one nothing came in), or its own:
   * as many, ending at the last month its own rows can speak for (`ownLastMonth`) — the income pace's
   */
  judgedOver: "the candidate's months" | "its own months";
  /**
   * Whose accounts date the day: the newest candidate every account dating it has been imported through, else the
   * newest (spending's — the month "What changed" compares, so /spending names that card's day), or the newest
   * complete month's, however an older one was read (the income pace's: it compares no month, and an earner habitual
   * in its latest months holds them back even where one before them was read through by others)
   */
  governedBy: "the compared month" | "the newest month";
}

/**
 * Spending's habit — the card's live spenders: spending in `MIN_OCCURRENCES` of the `SPEND_BASELINE_MONTHS` before the
 * compared month. ⚠️ A function, never a module constant: both numbers are imported along an import cycle
 * (`./committed` → budgets → forecast → read-in-full → here), and a constant built from them at load could read one
 * before its module had set it.
 *
 * ⚠️ Judged over the candidate's months and governed by the compared month, as it always was: the income pace's own
 * months and newest month (review of af84411) are not carried to spending's live spenders — /spending's cut, "What
 * changed", the year insights and every average — here. Nor its awaited earners alone (review of 0747432): with no
 * account it spends from left to read, an archived one's own last day still dates spending, /budgets' rule.
 */
function spendingHabit(): Habit {
  return {
    months: SPEND_BASELINE_MONTHS,
    minMonths: MIN_OCCURRENCES,
    beforeAHabit: "every account",
    whenNoneIsAwaited: "every one of them",
    judgedOver: "the candidate's months",
    governedBy: "the compared month",
  };
}

/** 'YYYY-MM' keys: the `count` months ending at `last`, oldest first. */
function monthKeysEndingAt(last: string, count: number): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) keys.push(monthKey(addCalendarMonths(`${last}-01`, -i)));
  return keys;
}

/**
 * The last month an account's own rows can speak for (`Habit.judgedOver` "its own months"): the last it has been read
 * through to the end of (`lastFullyReadMonth`), or the month of its newest row where that is later — a row in a month
 * read to its 20th still came in that month. After it, no import has said whether anything came in.
 *
 * 🔴 Review of af84411 (MEDIUM): the income pace's habit was asked of the calendar's months before each candidate,
 * whatever the account's own import day, so months nobody had read counted as months it earned nothing in. On a ledger
 * paying Savings $50.00 of Interest on the 28th of Jan–Jul, read through Jul 31, at 2026-11-23 Money in's months were
 * Aug–Oct with no sentence and no Interest line (present 0/3) — three months no import had read, averaged as $0.
 */
function ownLastMonth(through: string, perMonth: ReadonlyMap<string, number>): string {
  let last = lastFullyReadMonth(through);
  for (const [month, cents] of perMonth) if (cents !== 0 && month > last) last = month;
  return last;
}

/**
 * The months an account's habit is judged over at a candidate whose own are `keys` (`Habit.judgedOver`): those, or —
 * judged over its own, where its imports stop short of them — as many, ending at its own last month.
 */
function habitMonthsOf(
  habit: Habit,
  keys: readonly string[],
  through: string | undefined,
  perMonth: ReadonlyMap<string, number>,
): readonly string[] {
  if (habit.judgedOver === "the candidate's months" || through === undefined) return keys;
  const own = ownLastMonth(through, perMonth);
  // 'YYYY-MM' compares as text
  return own < keys.at(-1)! ? monthKeysEndingAt(own, keys.length) : keys;
}

/**
 * Before any habit (`Habit.beforeAHabit` "its own accounts"), the accounts the rows came in on that were still coming
 * in when last read: a row in the habit's `months` up to their own last month (`ownLastMonth`), bearing a frontier.
 * Read for that long since its last row, an account is not still earning; behind it, it is not known to have stopped.
 *
 * 🔴 Review of af84411 (MEDIUM): it was every account with a row in the span the candidates load, measured back from
 * TODAY — so an earner that stayed stale aged out of it. On his ledger copy, today moved: at 2027-03-23 Robinhood
 * Cash's Sep 9 rows had left the span, and Money in's pace read the calendar's Dec–Feb, its Dividends and Interest
 * gone.
 */
function stillComingIn(
  byAccount: ReadonlyMap<string, ReadonlyMap<string, number>>,
  frontier: ObservationFrontier,
  months: number,
): string[] {
  return [...byAccount.entries()]
    .filter(([accountId, perMonth]) => {
      const through = frontier.byAccount.get(accountId);
      if (through === undefined) return false;
      const from = monthKeysEndingAt(ownLastMonth(through, perMonth), months)[0]!;
      return [...perMonth].some(([month, cents]) => cents !== 0 && month >= from);
    })
    .map(([accountId]) => accountId);
}

/**
 * Of `accountIds`, the ones that date a habit's day (`Habit.whenNoneIsAwaited`): those a statement is still coming for
 * (`awaitedAmong`), and where none is, every one of them all the same (spending's, `accountsThatDate`) or none.
 *
 * 🔴 Review of 0747432 (MEDIUM): the income pace fell back to every one of them too, and its one habitual earner
 * archived or a cash wallet held Money in's months back for good — judged over its own months it never stops being a
 * habit, and its rows never leave the span the others' frontiers load (`habitRowsFrom`). `CandidateMonth`'s own rule
 * ("must not hold the month back for good"), and his decision 72's: "partly read" forever would be a claim no
 * statement could correct.
 */
function datingAccountsOf(
  habit: Habit,
  frontier: ObservationFrontier,
  accountIds: Iterable<string>,
  awaiting: ReadonlySet<string>,
): ReadonlySet<string> {
  return habit.whenNoneIsAwaited === "every one of them"
    ? accountsThatDate(frontier, accountIds, awaiting)
    : awaitedAmong(frontier, accountIds, awaiting);
}

/**
 * Where a habit's rows load from: the candidates' span (`loadedSpan`), or — judged over each account's own months —
 * back to the earliest of those among the accounts that date days (`datingAccountsOf` of every account: those a
 * statement is still coming for — for the income pace only ever those). ⚠️ So an archived account's old frontier never
 * stretches every read: it is judged over what the span holds, as it was before its own months were.
 */
function habitRowsFrom(
  spanFrom: string,
  frontier: ObservationFrontier,
  awaiting: ReadonlySet<string>,
  habit: Habit,
): string {
  if (habit.judgedOver === "the candidate's months") return spanFrom;
  let from = spanFrom;
  for (const accountId of datingAccountsOf(habit, frontier, frontier.byAccount.keys(), awaiting)) {
    const through = frontier.byAccount.get(accountId);
    if (through === undefined) continue;
    // its own months end no earlier than its last fully read one (`ownLastMonth`)
    const start = `${monthKeysEndingAt(lastFullyReadMonth(through), habit.months)[0]!}-01`;
    if (start < from) from = start;
  }
  return from;
}

/**
 * `liveSpendersOver` for any habit: the accounts with rows in at least `minMonths` of the months `keysOf` judges each
 * over (`habitMonthsOf`), bearing a frontier.
 */
function habitualAccountsOver(
  byAccount: ReadonlyMap<string, ReadonlyMap<string, number>>,
  keysOf: (accountId: string, perMonth: ReadonlyMap<string, number>) => readonly string[],
  frontier: ObservationFrontier,
  minMonths: number,
): string[] {
  return (
    [...byAccount.entries()]
      .filter(
        ([accountId, perMonth]) =>
          keysOf(accountId, perMonth).filter((k) => (perMonth.get(k) ?? 0) !== 0).length >= minMonths,
      )
      .map(([accountId]) => accountId)
      /*
       * An account with no frontier at all is an INVESTMENT account, which
       * `observationFrontier` excludes on purpose — "imported through" is not a
       * fact about a balance marked to market. It must not be able to veto a
       * month it can never satisfy, so it is dropped rather than failing the
       * test below. Every ledger-bearing account with rows has a frontier by
       * construction: its own newest transaction.
       */
      .filter((accountId) => frontier.byAccount.has(accountId))
  );
}

/** One month the card could compare, with its baseline and the accounts that spend habitually across it. */
interface CandidateMonth {
  month: string;
  /** months before the running one */
  offset: number;
  baselineKeys: string[];
  liveSpenders: string[];
  /**
   * Of `liveSpenders`, the ones that date the month: those a statement is still coming for, while one of them has a
   * day (`datingAccountsOf`; the income pace's, only ever those) — an archived account is never imported again, and
   * must not hold the month back for good
   */
  datingSpenders: string[];
  /** there are live spenders, and every one that dates the month has been imported through its last day */
  imported: boolean;
}

/**
 * The months within `MAX_MONTHS_BEHIND`, newest first. ⚠️ Spending's names (`liveSpenders`, `datingSpenders`) for any
 * habit's accounts: the income pace's are the accounts its rows come in on (`habitualCoverage`), each judged over its
 * own months (`habitMonthsOf`).
 */
function candidateMonths(
  byAccount: ReadonlyMap<string, ReadonlyMap<string, number>>,
  frontier: ObservationFrontier,
  currentMonth: string,
  // `accountsAwaitingStatements`
  awaiting: ReadonlySet<string>,
  habit: Habit = spendingHabit(),
): CandidateMonth[] {
  const out: CandidateMonth[] = [];
  for (let offset = 1; offset <= MAX_MONTHS_BEHIND; offset += 1) {
    const month = monthKey(addCalendarMonths(`${currentMonth}-01`, -offset));
    const baselineKeys = monthKeysEndingAt(monthKey(addCalendarMonths(`${month}-01`, -1)), habit.months);
    const keysOf = (accountId: string, perMonth: ReadonlyMap<string, number>) =>
      habitMonthsOf(habit, baselineKeys, frontier.byAccount.get(accountId), perMonth);
    const live = habitualAccountsOver(byAccount, keysOf, frontier, habit.minMonths);
    const dating = [...datingAccountsOf(habit, frontier, live, awaiting)];
    const closes = lastDayOf(month);
    const imported =
      dating.length > 0 && dating.every((accountId) => (frontier.byAccount.get(accountId) ?? "") >= closes);
    out.push({ month, offset, baselineKeys, liveSpenders: live, datingSpenders: dating, imported });
  }
  return out;
}

/**
 * The last day every account you spend from has been imported through — where
 * /spending cuts a comparison short (owner decision 2026-09-14).
 *
 * It is this card's live-spender set, taken at the month the card compares, so
 * the two pages name ONE day: on the real ledger 2026-09-14 that is Aug 12,
 * Chase Checking's, which the dashboard prints as "shown through Aug 12 at the
 * earliest". Measured alternatives, both rejected:
 *
 *  - every ledger account (what /summary used): Jul 31, because SoFi's
 *    statements end there though SoFi last spent in May — August refused outright;
 *  - the ledger's newest row (Sep 12): Sep 1–12 against Aug 1–12 still read
 *    Housing −$2,229.85, the rent sitting on an account with no September rows.
 *
 * When no candidate month clears, the newest candidate's live spenders govern.
 * When there are none at all — a ledger too young for anything to be a habit —
 * every account does, the earliest of them: with no habit to tell a dormant
 * account from a live one, none may be assumed current.
 *
 * ⚠️ Known gap, accepted by the owner: an account that spends rarely but holds a
 * large charge (Wells Fargo, the Aug rent, one spend month) is not a live
 * spender, so its lag does not cut. Today Chase Checking's Aug 12 hides it.
 *
 * `frontierForSeries` is the earliest frontier among a set of accounts, which is
 * exactly this question asked of a series' accounts; it is reused, not copied.
 *
 * ⚖️ Only the live spenders a statement is still coming for date it, while one of
 * them has a day — /budgets' rule (`accountsThatDate`, 2026-10-08). 🔴 Every live
 * spender dated it (review of e00e6b8): with Chase Checking archived, on a copy of
 * his ledger at 2026-11-20, every /budgets row had moved off Chase's Aug 12 while
 * this — and /spending, the year insights and "What changed" through it — still
 * named Aug 12, for an account no statement will ever come for.
 *
 * ⚡ MEMOISED FOR ONE SERVER RENDER (`react`'s `cache`, never a module-level Map — `observationFrontier`'s rule). Since
 * his decision 71 (2026-10-13) every card that quotes `baselineWindow` asks it too — six on one dashboard render — and
 * measured on his ledger copy that day one call costs 5.5ms once warm. A string or null, so nothing shared can be
 * mutated; callers pass `today`, so one render's calls share one key.
 */
export const spendingCoverageThrough = cache(function spendingCoverageThrough(
  db: AppDatabase,
  today: string = todayIso(),
): string | null {
  return habitualCoverage(db, today, spendingHabit(), (from, to) => accountGrid(db, from, to)).through;
});

/** The day a habit's accounts have all been imported through (`habitualCoverage`), and which accounts those are. */
export interface HabitualCoverage {
  /** the earliest import day among `accountIds`; null with none */
  through: string | null;
  /** the accounts that date it (`datingAccountsOf`), each bearing a frontier — the income pace names them */
  accountIds: ReadonlySet<string>;
}

/**
 * `spendingCoverageThrough`'s rule asked of ANY figure's rows (`rowsOver`: accountId → month → cents, over the span
 * the habit needs): the last day every account they come in on HABITUALLY (`Habit`) and a statement is still coming
 * for (`datingAccountsOf`) has been imported through, and those accounts. The candidate months, the accounts that date
 * it and the earliest of their days are spending's, unchanged — only which rows, how many months make a habit, whose
 * months each account is judged over, which candidate governs and whether, where none of them is still awaited, they
 * date it all the same (`Habit`).
 *
 * ⚖️ Default built, not asked (2026-10-23): his decision 71 carried to the income pace (`incomeCoverage`, in forecast),
 * whose habit is its own — the presence gate's two of the pace's three months before the month asked
 * (`MIN_INCOME_MONTHS_PRESENT`, `TRAILING_FULL_MONTHS`), each account judged over months it has been read for
 * (`ownLastMonth`), the newest month governing. 🔴 Measured on his ledger copy at 2026-10-23: by spending's six-month
 * habit, SoFi Savings — Interest in Mar, Apr and May, nothing since, read through Jul 31 — is live, and would hold
 * Money in's months back to May–Jul behind its Jul 31; by the income pace's own it is dormant, and Robinhood Cash's
 * Sep 9 dates them: Jun–Aug.
 */
export function habitualCoverage(
  db: AppDatabase,
  today: string,
  habit: Habit,
  rowsOver: (from: string, to: string) => ReadonlyMap<string, ReadonlyMap<string, number>>,
): HabitualCoverage {
  const currentMonth = monthKey(today);
  const frontier = observationFrontier(db);
  const awaiting = accountsAwaitingStatements(db);
  const span = loadedSpan(currentMonth, habit.months);
  const byAccount = rowsOver(habitRowsFrom(span.from, frontier, awaiting, habit), span.to);
  const candidates = candidateMonths(byAccount, frontier, currentMonth, awaiting, habit);
  const governing =
    habit.governedBy === "the compared month" ? (candidates.find((c) => c.imported) ?? candidates[0]) : candidates[0];
  const dating =
    governing !== undefined && governing.liveSpenders.length > 0
      ? governing.datingSpenders
      : // no habit to tell a dormant account from a live one: none of them may be assumed current
        datingAccountsOf(
          habit,
          frontier,
          habit.beforeAHabit === "every account"
            ? frontier.byAccount.keys()
            : stillComingIn(byAccount, frontier, habit.months),
          awaiting,
        );
  // `frontierForSeries` skips an account with no day; so does the set it is the day of
  const accountIds = new Set([...dating].filter((accountId) => frontier.byAccount.has(accountId)));
  return { through: frontierForSeries(frontier, accountIds), accountIds };
}

/**
 * ⚖️ His decision 72 (2026-10-13): the day a window of ALL his spending is read through — `spendingCoverageThrough` —
 * or null when no statement could ever move it: no account a statement is still coming for has an import day (an
 * empty ledger, or one of cash wallets alone), so the day `spendingCoverageThrough` falls back to is a wallet's newest
 * typed row. "Partly read" forever would be a claim no statement could correct (the /budgets rule, 2026-09-15).
 *
 * ⛔ One day for /spending: the period's proof counts its unaccounted days from it (`provenance::allSpendPartlyRead`),
 * and the heatmap on the same page reads its days against it (`SpendHeatmap`). 🔴 The heatmap was asked against the
 * ledger's newest row alone — on his ledger copy 2026-10-13 (review of 06c6bf3) Sep 13 … Sep 22 read "No spending or
 * income on this day." under "30 days of this period unaccounted".
 *
 * ⚡ MEMOISED FOR ONE SERVER RENDER (`react`'s `cache`, as `observationFrontier` — never a module-level Map). /spending
 * asks it for its heatmap and empty state, its period's proof, and its cash flow and the prior period's — every bucket
 * with no spending (decisions 64 + 72). Measured on his ledger copy 2026-10-13: 6.4ms a call; the page's own read, the
 * September and August cash flows and September's proof took 35.3ms asked outside a render, 14.7ms inside one.
 */
export const spendingReadThrough = cache(function spendingReadThrough(
  db: AppDatabase,
  today: string = todayIso(),
): string | null {
  const { byAccount } = observationFrontier(db);
  if (![...accountsAwaitingStatements(db)].some((id) => byAccount.has(id))) return null;
  return spendingCoverageThrough(db, today);
});

/**
 * ⚖️ His decision 72 (2026-10-13) for a window of ALL his spending: its elapsed days past `spendingReadThrough` and
 * /budgets' line for them ("spending imported through Aug 12 · 21 days of this period unaccounted"), or null where it
 * is read in full. 🔴 Measured on his ledger copy 2026-10-13: `/spending` for September chipped "adds up … 43 rows from
 * 3 documents" beside its own What moved naming Aug 12.
 *
 * ⚖️ CASH WALLETS ARE LEFT OUT (2026-09-15, the /budgets rule): with no account a statement is still coming for that
 * has an import day — an empty ledger, or one of cash wallets alone — `spendingReadThrough` is null, and nothing is
 * graded partly read: "partly read" forever would be a claim no statement could correct.
 *
 * ⛔ ONE COUNT FOR A WINDOW OF ALL SPENDING, wherever it is printed: /spending's period proof and its chip
 * (`provenance::allSpendProvenance`), the cash-flow readout's "at least" on the same page (`spendingProjection`), and
 * the dashboard's pace tile that links there and wears that proof as its chip (`dashboard::spendingPace`). 🔴 Measured
 * on his ledger copy 2026-10-21: the tile and the readout counted the days NO account had read — "7 days of October 2026
 * not imported yet", Venture X reaching Oct 14 — beside the proof's "21 days of this period unaccounted", Chase Checking
 * (Aug 12) and Wells Fargo (Sep 24) having read no day of October.
 */
export function allSpendPartlyRead(
  db: AppDatabase,
  from: string,
  to: string,
  today: string = todayIso(),
  // a caller that grades an empty window by the same day reads it once and hands it in (`allSpendProvenance`)
  through: string | null = spendingReadThrough(db, today),
): PartlyRead | null {
  if (through === null) return null;
  const n = daysNotImportedYet({ from, to, today, ledgerOpens: ledgerOpens(db), ledgerReaches: through });
  return n === 0 ? null : { uncoveredDays: n, line: readThroughSentence(through, n, { start: from }) };
}

/**
 * What changed this month — or rather, in the newest month that can be said to
 * have happened.
 *
 * Returns null when the ledger cannot answer, which is four different absences
 * and each one is a refusal rather than a zero:
 *
 *  - no month within `MAX_MONTHS_BEHIND` is both complete and imported through;
 *  - the ledger's own history opens after the baseline does, so the baseline
 *    months would be averaging imports that do not exist;
 *  - nothing was spent across the whole baseline, so there is no "usual";
 *  - nothing moved at all, in which case there is no card to draw.
 */
export function moversCard(db: AppDatabase, today: string = todayIso()): MoversCard | null {
  const currentMonth = monthKey(today);
  const months = SPEND_BASELINE_MONTHS;

  // load once, wide enough for the furthest-back candidate's whole baseline
  const span = loadedSpan(currentMonth);
  const data = grid(db, span.from, span.to, span.months, today);

  const frontier = observationFrontier(db);
  const accountNames = new Map(listAccounts(db).map((a) => [a.id, a.name] as const));

  /*
   * Pick the month. Newest first, and the first one that clears wins — walking
   * FORWARD would report an older month while a newer one was available.
   */
  const chosen = candidateMonths(data.byAccount, frontier, currentMonth, accountsAwaitingStatements(db)).find(
    (c) => c.imported,
  );
  if (chosen === undefined) return null;
  const { month, baselineKeys, liveSpenders, datingSpenders, offset: chosenOffset } = chosen;

  /*
   * The baseline must lie inside the ledger's own history, or its early months
   * are averaging imports that were never made — which deflates "usual" and
   * turns every category into a rise. A month with no spending is a real zero;
   * a month before the ledger begins is not a measurement at all.
   *
   * ⚠️ The floor is the earliest ACTIVE TRANSACTION, not the earliest month with
   * spending: two genuinely quiet months at the front of a long ledger are not
   * the same thing as a ledger that had not started, and the second reading
   * would blank this card over an ordinary quiet January.
   */
  const opens = ledgerOpens(db);
  if (opens === null || monthKey(opens) > baselineKeys[0]!) return null;

  // ── the rows ────────────────────────────────────────────────────────────
  const monthCells = data.byMonth.get(month) ?? new Map<string, { name: string; cents: number }>();
  const categoryKeys = new Set<string>([...monthCells.keys()]);
  const nameOf = new Map<string, string>();
  for (const [key, cell] of monthCells) nameOf.set(key, cell.name);
  for (const k of baselineKeys) {
    for (const [key, cell] of data.byMonth.get(k) ?? []) {
      categoryKeys.add(key);
      if (!nameOf.has(key)) nameOf.set(key, cell.name);
    }
  }

  const to = lastDayOf(month);
  const monthFrom = `${month}-01`;

  const all: MoverLine[] = [];
  let usualMonthlyCents = 0;
  let monthTotalCents = 0;
  for (const key of categoryKeys) {
    const name = nameOf.get(key) ?? key;
    const monthOut = monthCells.get(key)?.cents ?? 0;
    const perMonth = baselineKeys.map((k) => data.byMonth.get(k)?.get(key)?.cents ?? 0);
    /*
     * A baseline month with nothing in it is a ZERO, not a missing sample —
     * `spendBaseline`'s rule, and for its reason: dividing by "months that had
     * rows" lets a quiet month RAISE the average, which is the opposite of
     * what happened.
     */
    const usual = cents(perMonth.reduce((sum, c) => sum + c, 0) / months);
    const monthsSeen = perMonth.filter((c) => c !== 0).length;
    const delta = monthOut - usual;

    monthTotalCents += monthOut;
    usualMonthlyCents += usual;
    if (delta === 0) continue;

    const categoryId = key === "∅" ? null : key;
    const pctOfUsual = usual > 0 ? (delta / usual) * 100 : null;
    all.push({
      categoryId,
      categoryName: name,
      monthCents: monthOut,
      usualMonthlyCents: usual,
      deltaCents: delta,
      pctOfUsual,
      pctLabel: pctLabelOf(pctOfUsual),
      direction: delta > 0 ? "up" : "down",
      monthsSeen,
      thinNote:
        monthsSeen === 0
          ? `nothing in the ${months} months before`
          : monthsSeen < MIN_OCCURRENCES
            ? `only in ${monthsSeen} of the ${months} months before`
            : null,
      href: transactionsHref({ categoryId, from: monthFrom, to }),
    });
  }

  // no "usual" to compare against — every ratio below would be a division by
  // zero and every delta would just be this month restated
  if (usualMonthlyCents <= 0) return null;
  if (all.length === 0) return null;

  all.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || a.categoryName.localeCompare(b.categoryName));
  const movers = all.slice(0, TOP_MOVERS);
  const rest = all.slice(TOP_MOVERS);
  const otherDeltaCents = rest.reduce((sum, l) => sum + l.deltaCents, 0);

  /*
   * The total is the SUM of the rows, not `monthTotal − round(baseline/6)`.
   * Those differ by a few cents — fourteen rounded means do not add up to one
   * rounded mean — and of the two only this one lets the reader add the card up.
   */
  const totalDeltaCents = monthTotalCents - usualMonthlyCents;

  // ── coverage: why the running month is not this one ─────────────────────
  const baselineTotal = usualMonthlyCents * months;
  const shareOf = (accountId: string): number => {
    const perMonth = data.byAccount.get(accountId);
    const spent = baselineKeys.reduce((sum, k) => sum + (perMonth?.get(k) ?? 0), 0);
    // baselineTotal > 0 is guaranteed by the `usualMonthlyCents <= 0` return
    return (spent / baselineTotal) * 100;
  };

  // the accounts that dated the month, so the day it names is /spending's cut (`spendingCoverageThrough`)
  const laggingBase = datingSpenders
    .filter((accountId) => (frontier.byAccount.get(accountId) ?? "") < today)
    .map((accountId) => ({
      accountId,
      name: accountNames.get(accountId) ?? accountId,
      through: frontier.byAccount.get(accountId)!,
      throughLabel: formatDayShort(frontier.byAccount.get(accountId)!),
      sharePct: shareOf(accountId),
    }))
    .sort((a, b) => b.sharePct - a.sharePct || a.name.localeCompare(b.name));
  /*
   * ⛔ The rows are apportioned, never rounded one by one. Rounding each share
   * on its own made them add to 95 under a headline that rounded their true sum
   * to 94 — both honest, neither reconcilable. `lib/apportion` carries the
   * measurement. This file's own doctrine, forty lines up, is that the reader
   * must be able to add the card up.
   */
  const laggingWhole = apportionPercents(laggingBase.map((l) => l.sharePct));
  const lagging: CoverageLag[] = laggingBase.map((l, i) => ({
    ...l,
    shareLabel: `${laggingWhole[i]}% of the usual`,
  }));

  const currentMonthLabel = formatMonthYear(`${currentMonth}-01`);
  const earliestThrough = [...lagging].map((l) => l.through).sort().at(0);
  /*
   * 🔴 A two-month jump explained by a one-month reason. On 2026-09-03 the
   * dashboard read "Sep 2026 is still running, and it is not fully imported
   * either …" over figures for JULY: August cleared the calendar, failed the
   * import test, and was passed over in silence — the walk above skips any
   * number of complete months and only the running one was ever named. The
   * /spending panel's copy of this sentence names the skip; this one does too.
   */
  const skipped = Array.from({ length: Math.max(0, chosenOffset - 1) }, (_, i) =>
    formatMonthYear(`${monthKey(addCalendarMonths(`${currentMonth}-01`, -(i + 1)))}-01`),
  ).reverse();
  const skippedNote =
    skipped.length === 0
      ? ""
      : ` ${skipped.join(" and ")} ${skipped.length === 1 ? "is" : "are"} complete, but not every account you spend from has been imported through ${skipped.length === 1 ? "its" : "their"} last day — so these read ${formatMonthYear(`${month}-01`)} rather than ${skipped.at(-1)}.`;
  const currentMonthNote =
    (lagging.length === 0
      ? `${currentMonthLabel} is still running, so it is not counted here — a part month set against whole months reads as a fall that has not happened.`
      : `${currentMonthLabel} is still running, and it is not fully imported either: ${laggingWhole.reduce((sum, w) => sum + w, 0)}% of your usual spending posts to ${lagging.length} ${plural(lagging.length, "account", "accounts")} the ledger has only been shown through ${earliestThrough === undefined ? "no day at all" : formatDayShort(earliestThrough)} at the earliest. A shortfall there would be missing statements, not less spending.`) +
    skippedNote;

  /*
   * An account that joined the ledger PART WAY through the baseline drags its
   * own months down toward zero — the mirror of the lag above, at the other end
   * of the window. Only whole missing months are reported: an account that
   * arrived mid-month is short by days, which is a quibble, while one absent
   * for four of six months is the reason a category looks like it grew.
   */
  const historyGaps = liveSpenders
    .map((accountId) => {
      const perMonth = data.byAccount.get(accountId);
      const firstMonth = [...(perMonth?.keys() ?? [])].sort().at(0);
      const missing = firstMonth === undefined ? 0 : baselineKeys.filter((k) => k < firstMonth).length;
      return { name: accountNames.get(accountId) ?? accountId, missing };
    })
    .filter((a) => a.missing > 0)
    .sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name));
  const historyNote =
    historyGaps.length === 0
      ? null
      : `${nameList(historyGaps.map((a) => `${a.name} (${a.missing} of ${months})`))} ${plural(historyGaps.length, "was", "were")} not in the ledger for whole months of this average, so "usual" sits below what was really spent.`;

  const monthLabel = formatMonthYear(`${month}-01`);
  const direction = totalDeltaCents === 0 ? "flat" : totalDeltaCents > 0 ? "up" : "down";

  return {
    month,
    monthLabel,
    spendingHref: withPeriod("/spending", resolvePeriod({ period: month, from: null, to: null }, today)),
    currentMonthLabel,
    baselineMonths: months,
    baselineFromLabel: formatMonthYear(`${baselineKeys[0]!}-01`),
    baselineToLabel: formatMonthYear(`${baselineKeys[baselineKeys.length - 1]!}-01`),

    monthTotalCents,
    usualMonthlyCents,
    totalDeltaCents,
    totalPctOfUsual: (totalDeltaCents / usualMonthlyCents) * 100,

    headline: direction === "flat" ? "The same" : formatCents(Math.abs(totalDeltaCents)),
    headlineNoun:
      direction === "flat"
        ? `as usual, in ${monthLabel}`
        : `${direction === "up" ? "more" : "less"} than usual, in ${monthLabel}`,
    direction,
    summary:
      `${formatCents(monthTotalCents)} went out in ${monthLabel}, against a usual ${formatCents(usualMonthlyCents)} — ` +
      `the mean of the ${months} complete months before it, ${monthWindowLabel(baselineKeys[0]!, baselineKeys[baselineKeys.length - 1]!)}. Refunds are netted off both.`,

    movers,
    otherCount: rest.length,
    otherDeltaCents,
    otherNote:
      rest.length === 0
        ? null
        : `${rest.length} smaller ${plural(rest.length, "move", "moves")}, ${formatCents(Math.abs(otherDeltaCents))} ${otherDeltaCents >= 0 ? "more" : "less"} in total`,

    currentMonthNote,
    lagging,
    historyNote,
    today,
  };
}
