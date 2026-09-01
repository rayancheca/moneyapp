import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatDayShort, formatMonthYear } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { listAccounts } from "./accounts";
import { activeTxnsInRange, loadCategoryIndex, monthlySpending, spendingBucket, transactionsHref } from "./analytics";
import { SPEND_BASELINE_MONTHS } from "./committed";
import { ledgerOpens, observationFrontier } from "./observation-frontier";
import { MIN_OCCURRENCES } from "./recurring";

/**
 * What changed — which categories are running above or below their usual, and
 * over which month that can honestly be said.
 *
 * ## ⛔ Why this is NOT `categoryTrends`
 *
 * `categoryTrends` (analytics.ts) is the closest thing already in the tree and
 * it answers a subtly different question: raw month-over-month movement,
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
 * ⚠️ Not the same six months, though, and it cannot be: the runway averages the
 * six complete months before TODAY (Feb–Jul here, $8,093 a month) while this
 * averages the six before the COMPARED month (Jan–Jun, $7,188), because a month
 * cannot sit inside the baseline it is being measured against — it would damp
 * its own delta by a sixth. Two figures a reader could hear as one word, so
 * neither card says "usual" without saying which months it means, in the
 * sentence directly under the headline.
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

  const idx = loadCategoryIndex(db);
  const byAccount = new Map<string, Map<string, number>>();
  for (const txn of activeTxnsInRange(db, from, to)) {
    if (!spendingBucket(idx, txn)) continue;
    const perMonth = byAccount.get(txn.accountId) ?? new Map<string, number>();
    const m = monthKey(txn.postedOn);
    perMonth.set(m, (perMonth.get(m) ?? 0) - txn.amountCents);
    byAccount.set(txn.accountId, perMonth);
  }

  return { byMonth, byAccount };
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
  const oldestMonth = monthKey(addCalendarMonths(`${currentMonth}-01`, -(MAX_MONTHS_BEHIND + months)));
  const monthsLoaded = MAX_MONTHS_BEHIND + months + 1;
  const data = grid(db, `${oldestMonth}-01`, lastDayOf(currentMonth), monthsLoaded, today);

  const frontier = observationFrontier(db);
  const accountNames = new Map(listAccounts(db).map((a) => [a.id, a.name] as const));

  /*
   * Pick the month. Newest first, and the first one that clears wins — walking
   * FORWARD would report an older month while a newer one was available.
   */
  let month: string | null = null;
  let baselineKeys: string[] = [];
  let liveSpenders: string[] = [];
  for (let offset = 1; offset <= MAX_MONTHS_BEHIND; offset += 1) {
    const candidate = monthKey(addCalendarMonths(`${currentMonth}-01`, -offset));
    const keys: string[] = [];
    for (let i = months; i >= 1; i -= 1) keys.push(monthKey(addCalendarMonths(`${candidate}-01`, -i)));

    const live = [...data.byAccount.entries()]
      .filter(([, perMonth]) => keys.filter((k) => (perMonth.get(k) ?? 0) !== 0).length >= MIN_OCCURRENCES)
      .map(([accountId]) => accountId)
      /*
       * An account with no frontier at all is an INVESTMENT account, which
       * `observationFrontier` excludes on purpose — "imported through" is not a
       * fact about a balance marked to market. It must not be able to veto a
       * month it can never satisfy, so it is dropped rather than failing the
       * test below. Every ledger-bearing account with rows has a frontier by
       * construction: its own newest transaction.
       */
      .filter((accountId) => frontier.byAccount.has(accountId));

    const closes = lastDayOf(candidate);
    const allImported = live.every((accountId) => (frontier.byAccount.get(accountId) ?? "") >= closes);
    if (live.length > 0 && allImported) {
      month = candidate;
      baselineKeys = keys;
      liveSpenders = live;
      break;
    }
  }
  if (month === null) return null;

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

  const lagging: CoverageLag[] = liveSpenders
    .filter((accountId) => (frontier.byAccount.get(accountId) ?? "") < today)
    .map((accountId) => ({
      accountId,
      name: accountNames.get(accountId) ?? accountId,
      through: frontier.byAccount.get(accountId)!,
      throughLabel: formatDayShort(frontier.byAccount.get(accountId)!),
      sharePct: shareOf(accountId),
      shareLabel: `${Math.round(shareOf(accountId))}% of the usual`,
    }))
    .sort((a, b) => b.sharePct - a.sharePct || a.name.localeCompare(b.name));

  const currentMonthLabel = formatMonthYear(`${currentMonth}-01`);
  const laggingShare = lagging.reduce((sum, l) => sum + l.sharePct, 0);
  const earliestThrough = [...lagging].map((l) => l.through).sort().at(0);
  const currentMonthNote =
    lagging.length === 0
      ? `${currentMonthLabel} is still running, so it is not counted here — a part month set against whole months reads as a fall that has not happened.`
      : `${currentMonthLabel} is still running, and it is not fully imported either: ${Math.round(laggingShare)}% of your usual spending posts to ${lagging.length} ${plural(lagging.length, "account", "accounts")} the ledger has only been shown through ${earliestThrough === undefined ? "no day at all" : formatDayShort(earliestThrough)} at the earliest. A shortfall there would be missing statements, not less spending.`;

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
      `the mean of the ${months} complete months before it, ${formatMonthYear(`${baselineKeys[0]!}-01`)} to ${formatMonthYear(`${baselineKeys[baselineKeys.length - 1]!}-01`)}. Refunds are netted off both.`,

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
