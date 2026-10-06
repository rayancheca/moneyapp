import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, addDays, compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { forecastSplit } from "@/lib/forecast-split";
import { projectOngoingIncome } from "@/lib/income-forecast";
import { trailingPace } from "@/lib/projection";
import { formatDayShortIn } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { seriesIsIncomeOrSpending } from "@/lib/series-kind";
import { allocationsFor } from "@/lib/transaction-splits";
import { accountLiquidity, cashPosition, listAccountOptions, outsidePortfolioCashAccountIds } from "./accounts";
import {
  agentsCostBucket,
  agentsSeriesBands,
  isAgentsIncomeCategoryRow,
  isAgentsIncomeSeries,
  isIncome,
  loadCategoryIndex,
  spendingBucket,
  type AgentsBand,
} from "./analytics";
import { latestBalances } from "./derivation";
import { latestBridgedNetWorthCents } from "./in-flight";
import {
  projectOccurrences,
  seriesStaleness,
  toProjectable,
  type SeriesOccurrence,
  type SeriesStaleness,
  lapsedSeriesShouldStopForecasting,
  seriesHasLapsed,
} from "./recurring";
import { overdueForSeries, unbankedIncomeForSeries, unbankedIncomeTotals, type UnbankedIncomeTotals } from "./arrears";
import { stillToCome } from "./payday-settlement";
import { activeSplitsInRange } from "./transaction-splits";
import { linkIsNotRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

/**
 * Current-month forecast (master-plan Phase 6) — every number traceable:
 * the components array IS the math, and it sums exactly to the totals.
 *
 * FIXED: each live (detected|confirmed) series projects every remaining
 * occurrence in the month. Transfer-kind series are excluded — the analytics
 * semantics are authoritative (transfers are never income or spending), and
 * counting both legs would double-book cash that never leaves the household.
 * `lib/series-kind::seriesIsIncomeOrSpending` is that rule's one home, shared
 * with the /recurring strip and footer printed under this card's net and the
 * Upcoming tab's 30-day net.
 * A series whose evidence has gone stale still projects and carries its
 * `staleness` for the UI to show: dropping it would quietly delete real
 * income (the owner's weekly cash job lags on deposits), and including it
 * unmarked would quietly assert a dead subscription is alive.
 *
 * VARIABLE: per top-level expense bucket, trailing average of the last 3
 * FULL months of active expense spending excluding the rows a recurring series
 * owns (`linkIsNotRecurring` — a DISMISSED series owns none), plus a trend
 * adjustment capped at one typical (median) month and floored at
 * zero, scaled by remaining days / days in month. The pace itself is
 * `projection.ts::trailingPace` — shared with /spending and /budgets, so one
 * category cannot be projected two ways. Uncategorized negative amounts form an
 * explicit "Uncategorized" bucket — never hidden. Which rows are spending is
 * `spendingBucket`'s to say, and no row on the agent's cash is (owner decisions
 * 2026-10-02 and 2026-10-05, its unfiled money out too): the agent's costs
 * project apart, for EOM net worth alone.
 */

const TRAILING_FULL_MONTHS = 3;

/** One category allocation of a trailing transaction (a split part, or a whole row). */
interface TrailingAllocation {
  postedOn: string;
  amountCents: number;
  categoryId: string | null;
  /** the row's account — a split part posts where its row does */
  accountId: string;
}

/** What one forecast reads ONCE, and every month of its chain shares. */
interface ForecastReads {
  /** `seriesIdsNotDrawnAsRecurring` */
  notDrawn: ReadonlySet<string>;
  /** `accountsOutsideCash` */
  outside: ReadonlySet<string>;
  /**
   * `outsidePortfolioCashAccountIds` — the agent's cash, whose income is not his (`isIncome`) and whose costs are not
   * his spending (`spendingBucket`)
   */
  agentsCash: ReadonlySet<string>;
  /** `agentsSeriesBands` — every schedule on the agent's cash, and the band its money is named by */
  agentsSeries: ReadonlyMap<string, AgentsBand>;
}

/**
 * The accounts that nothing posted to moves month-end cash: every one
 * `accountLiquidity` calls `investable`.
 *
 * ⚖️ Owner decision 2026-09-15 (3): Robinhood Cash and Robinhood Agentic are
 * what selling investments would add, not month-end cash. `cashPosition` took
 * their BALANCES out of it — and the flows stayed in. A dividend paid into
 * Robinhood Cash does not reach the account he spends from, and a withdrawal
 * fee charged to it does not leave one; every trailing Dividends and Interest
 * row on his ledger posts there.
 *
 * ⛔ NOT "spendable accounts only". A card is `owed`, and groceries on it leave
 * cash the day the card is paid — the forecast never projected the payment, a
 * transfer, so the purchase IS the outflow. A row or series with no account
 * reads as cash, as every one did before.
 */
function accountsOutsideCash(db: AppDatabase): ReadonlySet<string> {
  const outside = new Set<string>();
  for (const [accountId, liquidity] of accountLiquidity(db)) {
    if (liquidity === "investable") outside.add(accountId);
  }
  return outside;
}

/**
 * The lines one builder adds to a month, and what month-end cash counts of them.
 *
 * The lines themselves are unchanged by where they post: a dividend is income
 * and a brokerage fee is spending, the math table sums them into the net, and
 * EOM net worth counts them. Only EOM cash leaves out what `outside` accounts
 * carry — `cashCents` is the same lines built over everything else, not a
 * share of theirs, because a trailing pace is not linear in its rows.
 */
interface ForecastLeg {
  components: ForecastComponent[];
  /** these lines as the rows and series on accounts NOT in `ForecastReads.outside` project them */
  cashCents: number;
  /** the outside accounts whose rows or series made `cashCents` differ from the lines' sum */
  outsideAccountIds: ReadonlySet<string>;
  /**
   * What this leg projects the AGENT'S cash is paid, by the rule that projects his (`MonthForecast.agentsIncome`) —
   * net of a scheduled clawback its category files with it (`agentsSeriesBand`, owner decision 2026-10-06, §6A 43), so
   * a schedule can take it below zero. The pace leg's nets its posted clawbacks too (`isAgentsIncomeCategoryRow`, owner
   * decision 2026-10-06, §6A 45), where his pace's is his money in only (`isIncome`).
   *
   * ⚖️ Owner decision 2026-09-28: not his income (`isIncome`), so it is no line — not in Income, not in the net —
   * and not cash he can spend, so never EOM cash either. Net worth holds the agent's money, so EOM net worth adds it,
   * as the bridge names the agent's rows on a band of their own.
   */
  agentsCents: number;
  /**
   * What this leg projects the AGENT'S cash pays, net-worth-signed, by the rules that project his spending — the pace,
   * the schedule and its arrears (`MonthForecast.agentsCosts`) — net of a scheduled refund its category files with them
   * (`agentsSeriesBand`, owner decision 2026-10-06), so a schedule can take it above zero.
   *
   * ⚖️ Owner decision 2026-10-02 (§6A 34): not his spending (`spendingBucket`), so it is no line — not in Spending,
   * not in the net — and never EOM cash. Net worth pays the agent's costs, so EOM net worth subtracts it, as the bridge
   * names the agent's costs on a band of their own.
   */
  agentsCostCents: number;
}

/**
 * Non-recurring active transactions over [from,to], exploded into per-category
 * allocations so the trailing spend/income forecasts count each split part in
 * its own category. Shared by variableComponents and variableIncomeComponents.
 *
 * A row a live series owns is excluded — it forecasts via FIXED — and so is one
 * an ENDED series owns: that bill stopped, and its history is not a pace.
 *
 * 🔴 NOT "every row with a link". A row linked to a DISMISSED series was
 * excluded too, by `isNull(recurringSeriesId)`, while the fixed leg projects
 * only live series — so it was counted in NEITHER. The owner dismissed those
 * series because they are not recurring ("i just go eat there often"); on the
 * real ledger 2026-09-14 that was 17 rows, $242.72 of June–August spend
 * (YA-FIT, PURA VIDA, a non-Chase ATM) left out of the trailing BASE that
 * September's pace is built from. The projection itself moved far less —
 * projected spending −$6,641.66 → −$6,666.33, i.e. $24.67 — because the base is
 * a three-month average plus a trend, prorated to the 17 days left; and Weed's
 * line FELL (−$8.49 → −$3.06), since its $57.50 posted in June, the oldest
 * trailing month, and steepens the downward trend.
 * `linkIsNotRecurring` asks `seriesDrawsAsRecurring`, not the link.
 *
 * `notDrawn` is read once per forecast by the exported entry points: it cannot
 * change inside one call, and a page 24 months ahead reaches this function 50
 * times (measured 2026-09-14: 245 statements, where 195 ran before the read).
 */
function nonRecurringAllocations(
  db: AppDatabase,
  from: string,
  to: string,
  notDrawn: ReadonlySet<string>,
): TrailingAllocation[] {
  const rows = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        linkIsNotRecurring(notDrawn),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  const splits = activeSplitsInRange(db, from, to);
  const out: TrailingAllocation[] = [];
  for (const r of rows) {
    for (const a of allocationsFor(r.categoryId, r.amountCents, splits.get(r.id) ?? [])) {
      out.push({ postedOn: r.postedOn, amountCents: a.amountCents, categoryId: a.categoryId, accountId: r.accountId });
    }
  }
  return out;
}

export interface ForecastComponent {
  label: string;
  kind: "fixed" | "variable";
  /** net-worth-signed: income positive, spending negative */
  cents: number;
  detail: string;
  /**
   * Fixed components only: how old the series' evidence is. Present on every
   * fixed component (fresh ones included, with isStale false) so the UI never
   * has to guess whether "no staleness" means "fresh" or "not measured".
   * Variable components have no series behind them and carry none.
   */
  staleness?: SeriesStaleness;
}

/**
 * Which month a projection is ABOUT, and how to read it.
 *
 * - `current` — the running month: what has already happened plus what remains.
 * - `future`  — a whole month still ahead, projected end to end.
 *
 * A PAST month has no third value on purpose: `forecastForMonth` returns null
 * for one. A month that has finished is not a forecast, and dressing what
 * actually posted up as a projection would be the app claiming to predict
 * something it can simply read.
 */
export type ForecastBasis = "current" | "future";

/** One internally consistent reading of a month: net === income + spend. */
export interface ForecastTotals {
  incomeCents: number;
  spendCents: number;
  netCents: number;
  eomCashCents: number;
  eomNetWorthCents: number;
}

export interface MonthForecast {
  today: string;
  /** the month this projects, `YYYY-MM` */
  monthKey: string;
  basis: ForecastBasis;
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  /** today through month end, inclusive */
  remainingDays: number;
  projectedIncomeCents: number;
  projectedSpendCents: number;
  projectedNetCents: number;
  projectedEomCashCents: number;
  projectedEomNetWorthCents: number;
  /**
   * The SCHEDULE alone: money the owner has agreed to pay and pay the deposits
   * he is due, with no trailing pace in it at all.
   *
   * ⛔ This is the headline the card shows, at the owner's instruction and over
   * my stated objection — recorded here because a future reader will otherwise
   * "fix" it back. His words: *"projected income is 1047*4 a month. projected
   * spend is the actual monthlies i have you so around 3.5k"*. For September
   * 2026 that is **+$4,188.00** and **−$3,567.60**, netting **+$620.40**.
   *
   * ⭐ It is also the figure the calendar strip DIRECTLY BELOW the card has been
   * printing all along — "as scheduled +$620.40" — so before this change the two
   * halves of one screen disagreed about the same month by $7,417.48, and the
   * one the eye lands on first was the one with the pace baked in.
   *
   * ⚠️ What it is NOT: a prediction of his balance. Groceries, petrol and
   * restaurants are real money leaving a real account, and they are not in this
   * number. `projected*Cents` above still carries them, the card still shows
   * them on their own row, and `eomCashCents` here is what the month ends at IF
   * nothing discretionary happens — which is never. Read the two together or
   * neither.
   */
  committed: ForecastTotals;
  components: ForecastComponent[];
  /**
   * Paydays that already passed this month with nothing banked against them —
   * REPORTED, never projected.
   *
   * 🔴 The reason the card needs it. Spending's arrears ARE a component
   * (`arrearsComponents`) and income's deliberately are not, for the reason
   * `fixedComponents` argues at length: cash pay that never reaches a bank
   * cannot be counted as arriving. So the schedule the strip below the card
   * draws and the schedule the card sums are two different sets of days.
   *
   * Measured 2026-09-04, the day after a Thursday payday: the card read
   * "PROJECTED NET -$426.60" over a month strip on the same screen reading
   * "as scheduled +$620.40" — $1,047.00 apart, and the class comment on
   * `committed` says in so many words that the whole point of that headline was
   * to stop those two halves disagreeing.
   */
  unbankedIncome: UnbankedIncomeTotals;
  /**
   * What each reading's EOM cash leaves out: the lines that post to accounts
   * outside cash (`accountsOutsideCash`). The nets and EOM net worth keep them,
   * so for the running month
   *
   *     projectedEomCashCents  === cash today + projectedNetCents − netCents
   *     committed.eomCashCents === cash today + committed.netCents − committedNetCents
   *
   * and a future month's figures chain every month through it, as its EOM cash
   * does.
   *
   * 🔴 Why the card needs it. Measured on the owner's ledger 2026-09-15, every
   * trailing Dividends and Interest row posts to Robinhood Cash, so the pace
   * row's EOM cash leaves out what the headline's does not — and the two EOM
   * cash figures stop differing by exactly the difference of the two nets.
   */
  outsideCash: OutsideCash;
  /**
   * What the AGENT'S cash is projected to be paid — by the series and the pace that project his: a schedule its
   * category names the agent's income, or an unfiled one bringing money in (`agentsSeriesBand`) — which each reading's
   * EOM net worth counts and its Income and Net do not. Net-worth-signed, and NET: a scheduled debit filed in an income
   * category — a clawback — lowers it, as the bridge nets the row it becomes inside "Agent's income" (owner decision
   * 2026-10-06, §6A 43). So it can be below zero: a reading whose clawbacks come to more than the agent is paid nets
   * negative, and the card's note says so (`AgentsIncomeNote`).
   *
   * ⚖️ Owner decision 2026-10-06 (§6A 45): …and so does the pace, a posted clawback no live schedule owns — none
   * detected, or one he dismissed, whose rows fall to the pace — by the bridge's rule (`isAgentsIncomeCategoryRow`).
   * 🔴 The pace's half was the agent's CREDITS only: $4.00 paid and $3.00 clawed back each month was +$1.00 on the
   * bridge and +$4.00 a month at "your recent pace", in EOM net worth too. ⛔ His pace is still his money in only
   * (`isIncome`). ❓ A pace bucket netting to zero or below projects nothing rather than below zero
   * (`projectOngoingIncome`) — pinned, not decided (`agents-credit-by-category.test.ts`).
   *
   * ⚖️ Owner decision 2026-09-28 (§6A 27): not his income (`isIncome`, `isAgentsIncomeSeries`); and net worth holds
   * the agent's money, which is why the bridge names it on a band of its own. So for the running month
   *
   *     projectedEomNetWorthCents  === net worth today + projectedNetCents + agentsIncome.netCents
   *     committed.eomNetWorthCents === net worth today + committed.netCents + agentsIncome.committedNetCents
   *
   * and a future month chains it as it chains the nets. Never in EOM cash: it is not money he can spend.
   */
  agentsIncome: AgentsIncome;
  /**
   * What the AGENT'S cash is projected to PAY — by the series and the pace that project his spending — which each
   * reading's EOM net worth counts and its Spending and Net do not. Net-worth-signed, and NET: a scheduled credit filed
   * in an expense category — a refund of the agent's fee — nets inside it, as the bridge nets the row it becomes
   * inside "Agent's costs" (`agentsSeriesBand`, owner decision 2026-10-06, §6A 39). So it can be above zero: a reading
   * whose refunds come to more than its fees nets to a credit, and the card's note says so (`AgentsCostsNote`).
   *
   * ⚖️ Owner decision 2026-10-02 (§6A 34): not his spending (`spendingBucket`); and net worth pays it, which is why the
   * bridge names it on a band of its own. So for the running month
   *
   *     projectedEomNetWorthCents  === net worth today + projectedNetCents + agentsIncome.netCents + agentsCosts.netCents
   *     committed.eomNetWorthCents === net worth today + committed.netCents
   *                                    + agentsIncome.committedNetCents + agentsCosts.committedNetCents
   *
   * and a future month chains it as it chains the nets. Never in EOM cash: it is not money he spends.
   */
  agentsCosts: AgentsCosts;
}

export interface AgentsIncome {
  /** net-worth-signed, what the full reading's EOM net worth adds to its net (chained through a future month) */
  netCents: number;
  /** the same, for the committed reading */
  committedNetCents: number;
}

/** `AgentsIncome`'s mirror: what the agent's cash is projected to pay, net-worth-signed and net of its refunds. */
export interface AgentsCosts {
  /** what the full reading's EOM net worth adds to its net (chained through a future month) */
  netCents: number;
  /** the same, for the committed reading */
  committedNetCents: number;
}

export interface OutsideCash {
  /** net-worth-signed, of the full reading's net (chained through a future month) */
  netCents: number;
  /** net-worth-signed, of the committed reading's net (chained the same way) */
  committedNetCents: number;
  /** the accounts those lines post to, in THE account order */
  accountNames: string[];
}

interface MonthWindow {
  start: string;
  end: string;
  key: string;
}

/** The last N full calendar months before the month containing `today`. */
export function trailingFullMonths(today: string, count: number): MonthWindow[] {
  const windows: MonthWindow[] = [];
  let cursorStart = periodBounds(today, "monthly").start;
  for (let i = 0; i < count; i++) {
    const prevEnd = addDays(cursorStart, -1);
    const bounds = periodBounds(prevEnd, "monthly");
    windows.unshift({ start: bounds.start, end: bounds.end, key: monthKey(prevEnd) });
    cursorStart = bounds.start;
  }
  return windows; // oldest → newest
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: "weekly",
  biweekly: "biweekly",
  semimonthly: "semimonthly",
  monthly: "monthly",
  quarterly: "quarterly",
  annual: "annual",
};

/**
 * ⚠️ `today` and `from` are different things and both are needed.
 *
 * `from` bounds the OCCURRENCE window — for the running month that is today,
 * and for a future month it is that month's first day. `today` is what
 * staleness is measured against, and staleness is a fact about now: a series
 * last seen 87 days ago is 87 days stale whether you are looking at September
 * or at next June. Passing the window start to `seriesStaleness` would make
 * every commitment look fresher the further ahead you paged.
 */
function fixedComponents(
  db: AppDatabase,
  today: string,
  from: string,
  monthEnd: string,
  { outside, agentsSeries }: ForecastReads,
): ForecastLeg {
  // status only — staleness is disclosed per component, never used to exclude
  const live = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();

  const components: { component: ForecastComponent; firstDate: string }[] = [];
  let cashCents = 0;
  let agentsCents = 0;
  let agentsCostCents = 0;
  const outsideAccountIds = new Set<string>();
  for (const series of live) {
    if (!seriesIsIncomeOrSpending(series.kind)) continue;
    /*
     * ⛔ A series that STOPPED CHARGING is not a forecast, and this was the one
     * surface that had not been told.
     *
     * `budgets.ts` and `recurring-calendar.ts` both skip lapsed series already;
     * the forecast did not, so the three disagreed about which commitments are
     * alive. On the owner's own ledger that put **$1,779.49 a month** of a
     * previous landlord (`DIRECT PAYMENT HOFFMAN LL`, last charged 2026-01-08)
     * into every future month alongside his current rent, plus three 2024-era
     * subscriptions that have not charged in over two years.
     *
     * ⚠️ NOT the staleness bar, and the difference is the whole point.
     * `LAPSED_MISS_LIMIT` is 3 cycles where staleness is 1.5, and it exists
     * because those two decisions cost opposite things: dropping a bill whose
     * statement is a fortnight late is how rent once vanished from the runway
     * for being ONE DAY over. Three missed cycles is not a late statement.
     *
     * Staleness itself is still only DISCLOSED, never used to exclude — the
     * "N series are running late — still projected" note is the same as ever.
     *
     * ⛔ **MONEY-OUT ONLY**, which `LAPSED_MISS_LIMIT`'s own docstring says and
     * I did not read carefully enough the first time. Applying it to everything
     * dropped `Cash job (weekly pay)` — the owner's ONLY income series, whose
     * deposits have not been imported since July — and the September projection
     * fell from $4,233.69 of income to **$45.69**. That is not a forecast, it is
     * a false alarm.
     *
     * The asymmetry is real and it is the whole reason for the rule. A dead
     * outflow that keeps projecting overstates what you owe, which is
     * conservative. A live inflow dropped for want of an IMPORT understates what
     * you earn, and there is a whole disclosure elsewhere in this app
     * (cash-earnings) built on the fact that his pay arrives as cash and reaches
     * the ledger late or not at all. An income series going quiet is evidence
     * about the IMPORTS, not about the job.
     *
     * ⛔ Money-out is `lapsedSeriesShouldStopForecasting(kind)`, NOT the sign of
     * the amount, and this line used to test the sign. Four other callers —
     * `subscriptions-card`, `recurring-insights`, `recurring-calendar` and
     * `upcomingOccurrences` — already ask that function; this was a fifth
     * phrasing of a rule that has one home, which is the exact shape of the
     * defect that left a previous landlord in the forecast for seven months
     * while two of three callers already knew better.
     *
     * The two phrasings agree on every series in the ledger today — measured
     * 2026-08-31, all eighteen live ones have a sign matching their kind — so
     * this changes no published figure. They come apart where it costs most: an
     * `income` series whose stored amount is negative is DELETED by the sign
     * test and kept by the kind test, and that is the $4,233.69 → $45.69
     * collapse arriving by a different door.
     */
    if (lapsedSeriesShouldStopForecasting(series.kind) && seriesHasLapsed(series, today)) continue;
    // forecast reads user overrides first (§4.4): amount, cadence, next-expected
    const staleness = seriesStaleness(series, today);
    /*
     * ⚖️ A payday a deposit has already paid down is not still to come. ⛔ The
     * same double count `incomeExpectation` used to publish, arriving by the
     * forecast's door: a lump that posts BEFORE the payday it covers is in the
     * bank balance this projection starts from, and projecting the payday on top
     * of it adds the money twice. Settle backwards is his decision of 2026-09-28
     * and `services/payday-settlement` is its one home — `stillToCome` is its
     * reading for every surface that looks ahead, never a second spelling.
     *
     * ⚠️ The lookup is taken per SERIES, not per occurrence: pass 31's measured
     * lesson is that per-row query building was 44% of this app's CPU.
     */
    const occurrences: SeriesOccurrence[] = stillToCome(
      db,
      series,
      projectOccurrences(toProjectable(series, staleness), from, monthEnd),
      today,
    );
    if (occurrences.length === 0) continue;
    const perOccurrence = occurrences[0]!.amountCents;
    const cents = occurrences.length * perOccurrence;
    /*
     * ⚖️ What the agent's cash pays is not his bill (owner decision 2026-10-02), nor what it is paid his income (owner
     * decision 2026-09-28): the agent's Gold fee and its interest are no line of his — not "Projected spending" or
     * "Projected income", not the net — and go to EOM net worth alone, by the same walk. 🔴 On a fixture, its month-end
     * $0.04 was "Projected income" on the headline — and so pay still to come in the dashboard's "free to spend".
     *
     * ⚖️ Each under the band its CATEGORY names, as the bridge names the row it becomes (`agentsSeriesBand`, owner
     * decision 2026-10-06, §6A 39): a monthly refund of the Gold fee, filed in Fees, nets inside the agent's costs —
     * which can then net to a credit — and its interest is its income, net of a clawback filed in Interest, which can
     * then net below zero (§6A 43). EOM net worth adds both, so it does not move.
     * 🔴 Asked by kind alone, an unfiled monthly credit filed "other" was a cost of +$3.00; asked by sign alone, a
     * refund filed in Fees was "Agent's income" here while the bridge netted the posted one inside "Agent's costs".
     */
    const band = agentsSeries.get(series.id);
    if (band === "agentCosts") {
      agentsCostCents += cents;
      continue;
    }
    if (band === "agentIncome") {
      agentsCents += cents;
      continue;
    }
    // still his bill, and still in the net — but one charged to an account
    // outside cash does not come out of EOM cash (`accountsOutsideCash`)
    if (series.accountId !== null && outside.has(series.accountId)) outsideAccountIds.add(series.accountId);
    else cashCents += cents;
    components.push({
      firstDate: occurrences[0]!.date,
      component: {
        label: series.name,
        kind: "fixed",
        cents,
        /* ⛔ a raw ISO date mid-sentence. The tooltip on this same row says
           "since Jul 5, 2026" and the list below it "Sep 11"; this cell said
           "2026-09-11". 10 of 24 rows carried one. */
        detail: `${occurrences.length} × ${formatCents(perOccurrence)} (${CADENCE_LABEL[series.cadence] ?? series.cadence}), next ${formatDayShortIn(occurrences[0]!.date, today)}`,
        staleness,
      },
    });
  }
  return {
    components: components
      .sort((a, b) => compareDates(a.firstDate, b.firstDate) || a.component.label.localeCompare(b.component.label))
      .map((c) => c.component),
    cashCents,
    outsideAccountIds,
    agentsCents,
    agentsCostCents,
  };
}

/**
 * ARREARS — what came due EARLIER THIS MONTH and that no posting covers.
 *
 * 🔴 Found by reading the running app on 2026-09-02, and it was a hole rather
 * than a decision: this module contained no notion of arrears at all. The fixed
 * leg of the running month opens on `today`, and the variable leg excludes
 * every row a recurring series owns (`linkIsNotRecurring`, so the pace cannot
 * double-count a bill). A bill that came due on the 1st and never posted was
 * therefore in NEITHER, and it left the projection entirely — measured on the
 * real ledger, September's projected spending was missing $2,291.21 of rent and
 * rent utilities, and EOM cash was overstated by exactly that. The same app
 * published the same $2,291.21 twice on other screens: `/budgets` as "due by
 * today and no import has covered them yet", and the runway card as "came due
 * earlier this month and never posted".
 *
 * It is wrong in both worlds, which is why it is not a judgement call. If the
 * bill has not been paid, it will be, and the month owes it. If it HAS been
 * paid but the statement has not been imported, then the cash balance this
 * projection starts from predates the payment — so the money still has to come
 * out of EOM cash.
 *
 * ⛔ THE TWO LEGS ABUT, NEVER OVERLAP. Forward is `[today, monthEnd]`; arrears
 * closes the day BEFORE today. A bill due today and unposted is not late — it
 * is DUE, and the forward leg already owns it. This is the same edge
 * `committedBook` pins, stated the same way, so the two cannot disagree about
 * the one day a month where they meet.
 *
 * ⛔ MONEY-OUT ONLY. `overdueForSeries` keeps only negative occurrences, which
 * is the same asymmetry `fixedComponents` argues at length: a payday that came
 * and went without a deposit is evidence about the IMPORTS, and projecting it
 * as still-to-come would inflate EOM cash on a ledger whose owner is paid in
 * cash.
 */
function arrearsComponents(
  db: AppDatabase,
  today: string,
  monthStart: string,
  { outside, agentsSeries }: ForecastReads,
): ForecastLeg {
  // every live series the forecast would project; `overdueForSeries` applies the
  // money-out and lapsed rules itself, and transfers are never spending here
  const live = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all()
    .filter((s) => seriesIsIncomeOrSpending(s.kind));
  const byId = new Map(live.map((s) => [s.id, s]));
  const late = overdueForSeries(db, new Set(byId.keys()), monthStart, addDays(today, -1));
  /*
   * ⚖️ A schedule of the agent's that came due and has not posted is the agent's to pay (owner decision 2026-10-02):
   * no line of his, and still money net worth will pay — EOM net worth alone, under the band the forward leg names it
   * by (`agentsSeriesBand`). 🔴 Asked by kind, one detection called "income" that came due money out was a bill of
   * HIS here: "came due Oct 1 and has not posted", in his Spending and Net.
   */
  const agentsNet = (band: AgentsBand) =>
    late.series.filter((s) => agentsSeries.get(s.id) === band).reduce((sum, s) => sum - s.amountCents, 0);
  const his = late.series.filter((s) => !agentsSeries.has(s.id));

  const components = his.map((s) => {
    const series = byId.get(s.id)!;
    /*
     * Exact, not an estimate: `projectOccurrences` gives every occurrence of one
     * series the same amount, so a window's total divides by its count with no
     * remainder. Stated because a division inside a money figure is exactly the
     * kind of line that earns a second look.
     */
    const perOccurrenceCents = -s.amountCents / s.occurrenceCount;
    return {
      label: s.name,
      kind: "fixed" as const,
      cents: -s.amountCents,
      detail: `${s.occurrenceCount} × ${formatCents(perOccurrenceCents)} (${CADENCE_LABEL[series.cadence] ?? series.cadence}), came due ${formatDayShortIn(s.nextDate, today)} and has not posted`,
      staleness: seriesStaleness(series, today),
    };
  });
  // the same rule as the forward leg: a late bill on an account outside cash is
  // still owed, and still not EOM cash
  let cashCents = 0;
  const outsideAccountIds = new Set<string>();
  for (const s of his) {
    const accountId = byId.get(s.id)!.accountId;
    if (accountId !== null && outside.has(accountId)) outsideAccountIds.add(accountId);
    else cashCents -= s.amountCents;
  }
  // money-out only (`overdueForSeries`), and still both notes: filed in an income category, a late clawback lowers the
  // agent's income (§6A 43) — the rule names each, never the sign
  return {
    components,
    cashCents,
    outsideAccountIds,
    agentsCents: agentsNet("agentIncome"),
    agentsCostCents: agentsNet("agentCosts"),
  };
}

/** Trailing rows summed per bucket and month, twice — see `bucketTrailing`. */
interface BucketedTrailing {
  /** bucket → monthKey → net-worth-signed sum, over every row */
  all: Map<string, Map<string, number>>;
  /** the same, over the rows on accounts NOT in `ForecastReads.outside` */
  cash: Map<string, Map<string, number>>;
  /** bucket → the outside accounts whose rows `all` summed and `cash` did not */
  outsideAccounts: Map<string, Set<string>>;
}

/**
 * Both variable legs bucket their trailing rows here, once over every row (the
 * lines) and once over the rows EOM cash counts. `bucketOf` names a row's
 * bucket, or null to leave it out of both.
 */
function bucketTrailing(
  rows: readonly TrailingAllocation[],
  bucketOf: (row: TrailingAllocation) => string | null,
  outside: ReadonlySet<string>,
): BucketedTrailing {
  const all = new Map<string, Map<string, number>>();
  const cash = new Map<string, Map<string, number>>();
  const outsideAccounts = new Map<string, Set<string>>();
  const addTo = (sums: Map<string, Map<string, number>>, label: string, row: TrailingAllocation) => {
    const perMonth = sums.get(label) ?? new Map<string, number>();
    const month = monthKey(row.postedOn);
    perMonth.set(month, (perMonth.get(month) ?? 0) + row.amountCents);
    sums.set(label, perMonth);
  };
  for (const row of rows) {
    const label = bucketOf(row);
    if (label === null) continue;
    addTo(all, label, row);
    if (outside.has(row.accountId)) {
      outsideAccounts.set(label, (outsideAccounts.get(label) ?? new Set<string>()).add(row.accountId));
    } else {
      addTo(cash, label, row);
    }
  }
  return { all, cash, outsideAccounts };
}

function variableComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
  { notDrawn, outside, agentsCash }: ForecastReads,
): ForecastLeg {
  const windows = trailingFullMonths(today, TRAILING_FULL_MONTHS);
  const rangeStart = windows[0]!.start;
  const rangeEnd = windows.at(-1)!.end;

  // trailing spend EXCLUDES the rows a series drawn as recurring owns
  // (`linkIsNotRecurring`): a live series' bills project via FIXED, an ended
  // series' stopped, and a dismissed series owns none — its rows are pace here
  const rows = nonRecurringAllocations(db, rangeStart, rangeEnd, notDrawn);

  /*
   * ⚖️ WHICH rows are spending is `spendingBucket`'s to say — an expense-kind row or an uncategorized outflow (an
   * explicit bucket, never hidden; a row filed on the system "Uncategorized" category is uncategorized), off the
   * agent's cash — since it is the classifier behind every figure that says "Spent", and this leg is the pace row's
   * Spending. 🔴 It kept its own copy, keyed on the category's root kind alone, so the agent's monthly Gold fee was
   * projected as HIS "Fees" (owner decision 2026-10-02, §6A 34). ⚖️ …and the agent's UNFILED money out is not his
   * Uncategorized (owner decision 2026-10-05). The agent's rows are bucketed apart (`agentsCostBucket`) and projected
   * by the same pace, for EOM net worth alone (`ForecastLeg.agentsCostCents`) — net worth still pays them.
   */
  const idx = loadCategoryIndex(db);
  const buckets = bucketTrailing(rows, (t) => spendingBucket(idx, agentsCash, t)?.categoryName ?? null, outside);
  const agents = bucketTrailing(rows, (t) => agentsCostBucket(idx, agentsCash, t)?.categoryName ?? null, outside);

  // the pace one bucket's trailing months project over the days remaining
  const project = (perMonth: ReadonlyMap<string, number> | undefined) => {
    // spend magnitudes per trailing month (outflow negative → positive spend)
    const pace = trailingPace(windows.map((w) => -(perMonth?.get(w.key) ?? 0)));
    return { pace, projected: Math.round((pace.expectedExactCents * remainingDays) / daysInMonth) };
  };

  const components: ForecastComponent[] = [];
  let cashCents = 0;
  const outsideAccountIds = new Set<string>();
  for (const [label, perMonth] of buckets.all) {
    /*
     * ⛔ ONE definition of the pace, and it does not live here.
     *
     * This loop used to compute `(newest − oldest) / 2` itself, while
     * `projection.ts` — whose own header names "Engine B forecast.ts
     * variableComponents" as the formula it was written to absorb — computed
     * the same nudge for `/spending` and `/budgets`. Two implementations of one
     * rule, so the recurring card and the spending page could disagree about
     * the very same category. `trailingPace` is now the only place that
     * decides, and the cap it applies is measured rather than chosen: see its
     * docstring for the 36-month backtest.
     */
    const { pace, projected } = project(perMonth);
    // what EOM cash counts: the same pace over this bucket's rows off outside
    // accounts — not a share of the line, since a capped trend is not linear
    const cashProjected = project(buckets.cash.get(label)).projected;
    const line = projected > 0 ? -projected : 0;
    const cashLine = cashProjected > 0 ? -cashProjected : 0;
    cashCents += cashLine;
    if (cashLine !== line) for (const id of buckets.outsideAccounts.get(label) ?? []) outsideAccountIds.add(id);
    if (projected <= 0) continue;
    /*
     * The detail names the RAW slope as well as the applied one whenever they
     * differ. "+ trend $590.24" alone would be a number the reader cannot
     * reproduce from the three months in front of them, which is the opposite
     * of what the visible-math table is for.
     *
     * 🔴 …AND THE CAP HAS TO SAY WHAT IT IS WORTH. "capped at one typical
     * month" over "trend $0.00" is every clause true and the whole
     * unresolvable: the only monthly figure on the row is the 3-month AVERAGE,
     * the cap is the MEDIAN, and wherever those differ the reader's arithmetic
     * does not close. Measured on the owner's ledger 2026-09-10 — the note
     * renders twice on /recurring and BOTH are the zero-median case:
     *
     *     Car            3-mo avg $2,033.33 + trend $0.00
     *                      (slope $3,050.00, capped at one typical month)
     *     Uncategorized  3-mo avg $397.40 + trend $0.00
     *                      (slope $596.11, capped at one typical month)
     *
     * `Car`'s three trailing months are [$0.00, $0.00, $6,100.00], so one
     * typical month really is nothing — but a reader capping $3,050.00 at the
     * $2,033.33 in front of them gets $2,033.33, and the row says $0.00.
     *
     * ⛔ A capped trend IS the cap, so naming it costs no second figure: the
     * leading number is the one the clause is about, and the sentence now says
     * so instead of leaving the reader to guess which figure it meant.
     */
    const trendNote = pace.trendWasCapped
      ? `${formatCents(Math.round(pace.trendCents))} (one typical month, which the ${formatCents(Math.round(pace.rawTrendCents))} slope was capped to)`
      : formatCents(Math.round(pace.trendCents));
    components.push({
      label,
      kind: "variable",
      cents: -projected,
      detail: `3-mo avg ${formatCents(Math.round(pace.averageCents))} + trend ${trendNote}, × ${remainingDays}/${daysInMonth} days`,
    });
  }

  // the agent's: the same pace per bucket, as money out of net worth and no line of his
  let agentsCostCents = 0;
  for (const perMonth of agents.all.values()) {
    const { projected } = project(perMonth);
    if (projected > 0) agentsCostCents -= projected;
  }

  return {
    components: components.sort(
      (a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.label.localeCompare(b.label),
    ),
    cashCents,
    outsideAccountIds,
    // spending: nothing here is anyone's income
    agentsCents: 0,
    agentsCostCents,
  };
}

/**
 * VARIABLE INCOME — the fix for a near-zero "projected income" when income is
 * real but IRREGULAR (a cash job, tutoring) rather than a detected series. Per
 * income subcategory, the trailing average of the last 3 FULL months of ONGOING
 * income, scaled by remaining days. Mirrors variableComponents (spending) but
 * with income honesty (see lib/income-forecast.ts): a bucket must appear in ≥2
 * trailing months (one-off refunds/aid never extrapolate) and there is NO upward
 * trend nudge. Rows a series drawn as recurring owns are excluded
 * (`linkIsNotRecurring`) — a live series' deposits project via FIXED, an ended
 * one's stopped — while a DISMISSED series' deposits count here like any other.
 * Income is `isIncome`'s rows — positive amounts in income-kind categories, off
 * the agent's cash; the agent's are projected apart, for EOM net worth alone.
 */
/**
 * Income subcategories that are event-driven windfalls / misc one-offs, NOT
 * ongoing earnings — never projected forward, even when they happen to cluster
 * across months (a tax refund + a security-deposit return + a merchant refund
 * can all land in the same 2-3 months without any of them recurring; the same
 * goes for "Other Income", the misc catch-all where gifts/settlements/stray
 * inflows land). The presence gate alone can't catch that, so these are
 * excluded by name — only the deliberate earning buckets (Salary, Tutoring,
 * Interest, Dividends) project.
 */
const EVENT_DRIVEN_INCOME = new Set([
  "Financial Aid",
  "Refunds & Reimbursements",
  "Other Income",
]);

function variableIncomeComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
  { notDrawn, outside, agentsCash }: ForecastReads,
): ForecastLeg {
  const windows = trailingFullMonths(today, TRAILING_FULL_MONTHS);
  const rangeStart = windows[0]!.start;
  const rangeEnd = windows.at(-1)!.end;

  const idx = loadCategoryIndex(db);
  // an income row's bucket is its own (sub)category, unless that is an event-driven one
  const ongoing = (categoryId: string): string | null => {
    const name = idx.byId.get(categoryId)!.name;
    return EVENT_DRIVEN_INCOME.has(name) ? null : name;
  };

  // trailing income EXCLUDES the rows a series drawn as recurring owns
  // (`linkIsNotRecurring`): live deposits project via FIXED, an ended series'
  // stopped, and a dismissed series owns none — its deposits are pace here
  const rows = nonRecurringAllocations(db, rangeStart, rangeEnd, notDrawn);

  /*
   * ⚖️ WHICH rows are income is `isIncome`'s to say — a positive amount in an income-kind category, off the agent's
   * cash — since it is the classifier behind every figure that says "Income", and this leg is the pace row's.
   * 🔴 It kept its own copy, keyed on the category's root kind alone, so the agent's month-end interest was projected
   * as HIS on a fixture (3-mo avg $0.04 × 27/31 days, a $0.03 "Interest" line) after every other Income figure had
   * left it out (owner decision 2026-09-28). The agent's rows are bucketed apart and projected by the same gate and
   * average, for EOM net worth alone (`ForecastLeg.agentsCents`).
   *
   * ⚖️ Owner decision 2026-10-06 (§6A 45): the agent's are bucketed EITHER SIGN, by the rule the bridge nets "Agent's
   * income" by (`isAgentsIncomeCategoryRow`, §6A 43), so a posted clawback no live schedule owns — none detected, or
   * one he dismissed — nets inside its bucket. 🔴 They were the agent's credits only (`isAgentsIncome`): $4.00 paid and
   * $3.00 clawed back each month was +$1.00 on the bridge and +$3.48 here. ⛔ His are still his money in only
   * (`isIncome`). ❓ A bucket netting to zero or below fails the gate and projects nothing (`projectOngoingIncome`),
   * where the bridge reads below zero — pinned, not decided (`agents-credit-by-category.test.ts`).
   */
  const buckets = bucketTrailing(
    rows,
    (t) => (isIncome(idx, agentsCash, t) ? ongoing(t.categoryId!) : null),
    outside,
  );
  const agents = bucketTrailing(
    rows,
    (t) => (isAgentsIncomeCategoryRow(idx, agentsCash, t) ? ongoing(t.categoryId!) : null),
    outside,
  );

  // the ongoing-income lines one set of bucket sums projects over the days remaining
  const project = (sums: ReadonlyMap<string, ReadonlyMap<string, number>>): ForecastComponent[] =>
    projectOngoingIncome(
      [...sums].map(([label, perMonth]) => ({
        label,
        monthlyTotalsCents: windows.map((w) => perMonth.get(w.key) ?? 0),
      })),
    )
      .map((e) => ({
        label: e.label,
        kind: "variable" as const,
        cents: Math.round((e.monthlyCents * remainingDays) / daysInMonth),
        detail: `${e.basis}, × ${remainingDays}/${daysInMonth} days`,
      }))
      .filter((c) => c.cents > 0);

  const components = project(buckets.all);
  // what EOM cash counts: the same gate and average over the rows off outside
  // accounts — a bucket can pass the presence gate on all its rows and fail it on those
  const lines = new Map(components.map((c) => [c.label, c.cents]));
  const cashLines = new Map(project(buckets.cash).map((c) => [c.label, c.cents]));
  let cashCents = 0;
  const outsideAccountIds = new Set<string>();
  for (const label of buckets.all.keys()) {
    const cashLine = cashLines.get(label) ?? 0;
    cashCents += cashLine;
    if (cashLine !== (lines.get(label) ?? 0)) for (const id of buckets.outsideAccounts.get(label) ?? []) outsideAccountIds.add(id);
  }
  const agentsCents = project(agents.all).reduce((sum, c) => sum + c.cents, 0);
  // income: nothing here is anyone's cost
  return { components, cashCents, outsideAccountIds, agentsCents, agentsCostCents: 0 };
}

/**
 * How far ahead the calendar may be paged and still get a projection.
 *
 * ⛔ A bound, not a preference. `projectedEomCashCents` for a future month is
 * CHAINED — it sums every intervening month's net — so an unbounded horizon is
 * an unbounded loop over the whole forecast machinery, one page-turn at a time.
 * Two years is well past the last payment of the longest commitment in the
 * ledger (a 24-payment lease), which is the point at which the projection stops
 * describing anything the app actually knows.
 */
export const FORECAST_HORIZON_MONTHS = 24;

/** `YYYY-MM` for the month `n` months after `key`. */
function addMonthKey(key: string, n: number): string {
  return monthKey(addCalendarMonths(`${key}-01`, n));
}

/** Whole months from `from` to `to` inclusive; negative when `to` is earlier. */
function monthsBetweenKeys(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * A whole month still ahead, projected end to end.
 *
 * ⛔ The difference from the running month is the WINDOW, not the arithmetic.
 * Here the whole month is remaining, so the variable pace is a full month's
 * worth rather than a prorated tail, and the fixed occurrences are the ones due
 * between the 1st and the last — not the ones left after today.
 */
function futureMonthParts(db: AppDatabase, today: string, key: string, reads: ForecastReads): MonthParts {
  const monthStart = `${key}-01`;
  const monthEnd = periodBounds(monthStart, "monthly").end;
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  return {
    monthStart,
    monthEnd,
    daysInMonth,
    // the whole month is ahead of today
    remainingDays: daysInMonth,
    ...assembleLegs(
      [fixedComponents(db, today, monthStart, monthEnd, reads)],
      [
        // the whole month remains, so the trailing pace applies in full
        variableIncomeComponents(db, today, daysInMonth, daysInMonth, reads),
        variableComponents(db, today, daysInMonth, daysInMonth, reads),
      ],
    ),
  };
}

/** The nets a month contributes to a chain — each reading's, and what EOM cash counts of each. */
interface ChainedNets {
  /** Σ every line: the full reading's net */
  net: number;
  /** Σ the fixed lines: the committed reading's net */
  committedNet: number;
  /** what EOM cash counts of `net` (`ForecastLeg.cashCents`) */
  cashNet: number;
  /** what EOM cash counts of `committedNet` */
  committedCashNet: number;
  /** the outside accounts that made either pair differ */
  outsideAccountIds: ReadonlySet<string>;
  /** Σ every leg's `agentsCents`: what the full reading's EOM net worth adds to its net */
  agentsNet: number;
  /** Σ the fixed legs' `agentsCents`: what the committed reading's EOM net worth adds to its net */
  committedAgentsNet: number;
  /** Σ every leg's `agentsCostCents`: what the full reading's EOM net worth adds to its net */
  agentsCostNet: number;
  /** Σ the fixed legs' `agentsCostCents`: what the committed reading's EOM net worth adds to its net */
  committedAgentsCostNet: number;
}

/** One month's window, its lines, and the nets its readings take from them. */
interface MonthParts extends ChainedNets {
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  /** today through month end, inclusive — the whole month for a future one */
  remainingDays: number;
  components: ForecastComponent[];
}

/**
 * The fixed legs, then the variable ones, as ONE array — the math table reads in
 * this order — with the nets every reading takes from it.
 *
 * `committedNet` is the fixed lines by `forecastSplit`, as it always was; the
 * fixed legs hold exactly those lines, so what EOM cash counts of it is theirs.
 */
function assembleLegs(
  fixed: readonly ForecastLeg[],
  variable: readonly ForecastLeg[],
): ChainedNets & { components: ForecastComponent[] } {
  const legs = [...fixed, ...variable];
  const components = legs.flatMap((leg) => leg.components);
  const split = forecastSplit(components);
  const cashOf = (some: readonly ForecastLeg[]) => some.reduce((sum, leg) => sum + leg.cashCents, 0);
  const agentsOf = (some: readonly ForecastLeg[]) => some.reduce((sum, leg) => sum + leg.agentsCents, 0);
  const agentsCostOf = (some: readonly ForecastLeg[]) => some.reduce((sum, leg) => sum + leg.agentsCostCents, 0);
  return {
    components,
    net: components.reduce((sum, c) => sum + c.cents, 0),
    committedNet: split.income.fixedCents + split.spending.fixedCents,
    cashNet: cashOf(legs),
    committedCashNet: cashOf(fixed),
    outsideAccountIds: new Set(legs.flatMap((leg) => [...leg.outsideAccountIds])),
    agentsNet: agentsOf(legs),
    committedAgentsNet: agentsOf(fixed),
    agentsCostNet: agentsCostOf(legs),
    committedAgentsCostNet: agentsCostOf(fixed),
  };
}

/** A chain one month longer. Each pair is chained on its own — see `forecastForMonth`. */
function chainMonth(sofar: ChainedNets, month: ChainedNets): ChainedNets {
  return {
    net: sofar.net + month.net,
    committedNet: sofar.committedNet + month.committedNet,
    cashNet: sofar.cashNet + month.cashNet,
    committedCashNet: sofar.committedCashNet + month.committedCashNet,
    outsideAccountIds: new Set([...sofar.outsideAccountIds, ...month.outsideAccountIds]),
    agentsNet: sofar.agentsNet + month.agentsNet,
    committedAgentsNet: sofar.committedAgentsNet + month.committedAgentsNet,
    agentsCostNet: sofar.agentsCostNet + month.agentsCostNet,
    committedAgentsCostNet: sofar.committedAgentsCostNet + month.committedAgentsCostNet,
  };
}

/** `MonthForecast.outsideCash` for a chain: what each reading's EOM cash left out, and where it posts. */
function outsideCashOf(db: AppDatabase, nets: ChainedNets): OutsideCash {
  const ids = nets.outsideAccountIds;
  return {
    netCents: nets.net - nets.cashNet,
    committedNetCents: nets.committedNet - nets.committedCashNet,
    accountNames: ids.size === 0 ? [] : listAccountOptions(db).filter((a) => ids.has(a.id)).map((a) => a.name),
  };
}

/** What a forecast reads once for its whole chain (`ForecastReads`). */
function forecastReads(db: AppDatabase): ForecastReads {
  const agentsCash = outsidePortfolioCashAccountIds(db);
  return {
    notDrawn: seriesIdsNotDrawnAsRecurring(db),
    outside: accountsOutsideCash(db),
    agentsCash,
    agentsSeries: agentsSeriesBands(db, agentsCash),
  };
}

/**
 * The projection for ANY month the calendar can be paged to.
 *
 * Returns null for a month that has already ended: a finished month is not a
 * forecast, and the calendar beneath it already shows what actually posted.
 *
 * ⛔ **The end-of-month cash figure is CHAINED, and it has to be.** "What will
 * I have at the end of October" cannot be answered from October alone — it
 * depends on September. So a future month's `projectedEomCashCents` is today's
 * cash plus every intervening month's projected net, this one included. Showing
 * October's net against today's balance would be a number that is wrong by a
 * whole month and looks entirely reasonable.
 */
export function forecastForMonth(
  db: AppDatabase,
  key: string,
  today: string = todayIso(),
): MonthForecast | null {
  const current = monthKey(today);
  const ahead = monthsBetweenKeys(current, key);
  if (ahead < 0) return null;
  if (ahead > FORECAST_HORIZON_MONTHS) return null;
  // ONE read of each for the whole chain: neither can change inside this call,
  // and every month below reaches the trailing pace twice (spend and income)
  const reads = forecastReads(db);
  if (ahead === 0) return currentMonthForecast(db, today, reads);

  const parts = futureMonthParts(db, today, key, reads);

  /*
   * The running month's own remainder starts the chain — the months between
   * are whole ones. The running month is built once here rather than per step;
   * the chain only needs each month's NETS.
   *
   * ⛔ The committed reading is chained SEPARATELY, never derived from the full
   * one. "Today's cash plus every month's committed net" and "the full chain
   * minus the pace" are the same number only when the pace is zero, and the
   * whole reason this figure exists is that it is not. What EOM cash counts of
   * each is chained separately again, for the same reason: a pace line can post
   * outside cash where no committed line does.
   */
  let chained: ChainedNets = currentMonthParts(db, today, reads);
  for (let i = 1; i < ahead; i++) {
    chained = chainMonth(chained, futureMonthParts(db, today, addMonthKey(current, i), reads));
  }
  chained = chainMonth(chained, parts);

  // what he can spend today, by the one rule `runwayCard` reads (`cashPosition`)
  const balances = latestBalances(db);
  const cashCents = cashPosition(db, balances).spendableCents;

  const income = parts.components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const spend = parts.components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  const split = forecastSplit(parts.components);
  const netWorthCents = latestBridgedNetWorthCents(db, balances);

  return {
    today,
    monthKey: key,
    basis: "future",
    monthStart: parts.monthStart,
    monthEnd: parts.monthEnd,
    daysInMonth: parts.daysInMonth,
    remainingDays: parts.remainingDays,
    projectedIncomeCents: income,
    projectedSpendCents: spend,
    projectedNetCents: parts.net,
    // EOM cash chains what it counts; EOM net worth chains every line, and what the agent's cash is paid and pays
    projectedEomCashCents: cashCents + chained.cashNet,
    projectedEomNetWorthCents: netWorthCents + chained.net + chained.agentsNet + chained.agentsCostNet,
    committed: {
      incomeCents: split.income.fixedCents,
      spendCents: split.spending.fixedCents,
      netCents: parts.committedNet,
      eomCashCents: cashCents + chained.committedCashNet,
      eomNetWorthCents:
        netWorthCents + chained.committedNet + chained.committedAgentsNet + chained.committedAgentsCostNet,
    },
    components: parts.components,
    /*
     * A FUTURE month has no past inside it — every one of its paydays is still
     * to come, so there is nothing that has passed unbanked. Stated rather than
     * omitted: this field is a measurement, and an empty one is the answer here.
     */
    unbankedIncome: { totalCents: 0, occurrenceCount: 0, checkedOccurrenceCount: 0, frontier: { kind: "unchecked" }, names: [] },
    outsideCash: outsideCashOf(db, chained),
    agentsIncome: { netCents: chained.agentsNet, committedNetCents: chained.committedAgentsNet },
    agentsCosts: { netCents: chained.agentsCostNet, committedNetCents: chained.committedAgentsCostNet },
  };
}

export function forecastCurrentMonth(db: AppDatabase, today: string = todayIso()): MonthForecast {
  return currentMonthForecast(db, today, forecastReads(db));
}

/** The running month's window, lines and nets (see `MonthParts`). */
function currentMonthParts(db: AppDatabase, today: string, reads: ForecastReads): MonthParts {
  const { start: monthStart, end: monthEnd } = periodBounds(today, "monthly");
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const remainingDays = diffDays(today, monthEnd) + 1;
  return {
    monthStart,
    monthEnd,
    daysInMonth,
    remainingDays,
    ...assembleLegs(
      [
        // arrears first: they are dated before every forward occurrence, and the
        // math table reads in the order this array is built
        arrearsComponents(db, today, monthStart, reads),
        fixedComponents(db, today, today, monthEnd, reads),
      ],
      [
        variableIncomeComponents(db, today, remainingDays, daysInMonth, reads),
        variableComponents(db, today, remainingDays, daysInMonth, reads),
      ],
    ),
  };
}

/** The running month, with the chain's reads already taken once (see `forecastForMonth`). */
function currentMonthForecast(db: AppDatabase, today: string, reads: ForecastReads): MonthForecast {
  const parts = currentMonthParts(db, today, reads);
  const { monthStart, monthEnd, daysInMonth, remainingDays, components } = parts;

  /*
   * ⛔ Computed, never added. It is not in `components`, so the math table's
   * claim that its rows sum exactly to the projections above stays true.
   */
  const incomeSeriesIds = new Set(
    db
      .select({ id: recurringSeries.id, kind: recurringSeries.kind, accountId: recurringSeries.accountId })
      .from(recurringSeries)
      .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
      .all()
      // his paydays: `/budgets` names the same passed-unpaid figure off the same series (`isAgentsIncomeSeries`)
      .filter((r) => !isAgentsIncomeSeries(reads.agentsCash, r))
      .map((r) => r.id),
  );
  const unbanked = unbankedIncomeForSeries(db, incomeSeriesIds, monthStart, today);

  // the components ARE the math: totals derive from them, exactly
  const projectedIncomeCents = components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const projectedSpendCents = components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  const projectedNetCents = projectedIncomeCents + projectedSpendCents;
  // the SCHEDULE alone — same array, partitioned; see MonthForecast.committed
  const committedSplit = forecastSplit(components);
  const committedNetCents =
    committedSplit.income.fixedCents + committedSplit.spending.fixedCents;

  // what he can spend today, by the one rule `runwayCard` reads (`cashPosition`)
  const balances = latestBalances(db);
  const cashCents = cashPosition(db, balances).spendableCents;

  // bridged, so the EOM projection starts from the same number the dashboard
  // headline shows (docs/inflight-dips.md — one source for "latest net worth").
  // Only the final point is wanted, so this reuses the `balances` map above
  // rather than rebuilding the whole 1,438-day curve to read its last element.
  const latestNetWorth = latestBridgedNetWorthCents(db, balances);

  return {
    today,
    monthKey: monthKey(today),
    basis: "current",
    monthStart,
    monthEnd,
    daysInMonth,
    remainingDays,
    projectedIncomeCents,
    projectedSpendCents,
    projectedNetCents,
    // EOM cash adds what it counts of the net; EOM net worth adds all of it, and what the agent's cash is paid and pays
    projectedEomCashCents: cashCents + parts.cashNet,
    projectedEomNetWorthCents: latestNetWorth + projectedNetCents + parts.agentsNet + parts.agentsCostNet,
    committed: {
      incomeCents: committedSplit.income.fixedCents,
      spendCents: committedSplit.spending.fixedCents,
      netCents: committedNetCents,
      eomCashCents: cashCents + parts.committedCashNet,
      eomNetWorthCents: latestNetWorth + committedNetCents + parts.committedAgentsNet + parts.committedAgentsCostNet,
    },
    components,
    unbankedIncome: unbankedIncomeTotals(unbanked),
    outsideCash: outsideCashOf(db, parts),
    agentsIncome: { netCents: parts.agentsNet, committedNetCents: parts.committedAgentsNet },
    agentsCosts: { netCents: parts.agentsCostNet, committedNetCents: parts.committedAgentsCostNet },
  };
}
