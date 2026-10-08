import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates, diffDays, periodBounds } from "@/lib/dates";
import { sharedFrontier, type UnbankedFrontier } from "@/lib/unbanked-income";
import { checkedThroughBySeries, silenceMeasuredThroughBySeries } from "./cash-earnings";
import { settledPaydaysBySeries } from "./payday-settlement";
import { hasStoppedForecasting, projectOccurrences, toProjectable } from "./recurring";

/**
 * ARREARS — bills that came due inside a window and that no posting covers.
 *
 * This lives in its own module rather than in `budgets.ts` for one reason: the
 * FORECAST needs the same rule, and `budgets.ts` already imports
 * `trailingFullMonths` from `forecast.ts`. Three surfaces now publish a figure
 * that answers "what came due and never arrived?" — the runway card, the
 * budgets header, and the month forecast — and the whole point of the rule
 * having one home is that they cannot disagree about the same bill.
 *
 * The vocabulary (`BudgetTail`) is still the budgets one, because that is where
 * it was born and renaming it would churn every caller to say the same thing.
 */

export interface BudgetTailSeries {
  id: string;
  name: string;
  cadence: string;
  /** first in-window occurrence date */
  nextDate: string;
  /** total expected inside the window, as positive money-out cents */
  amountCents: number;
  occurrenceCount: number;
  href: string;
}

export interface BudgetTail {
  totalCents: number;
  series: BudgetTailSeries[];
}

export interface UnbankedIncomeSeries extends BudgetTailSeries {
  /**
   * `earliestVerified` over the accounts this pay has landed in — the last day
   * the ledger has read every place its deposit could arrive — or null when one
   * of them has no checked record, or the pay has never landed anywhere
   * (`checkedThroughBySeries` — archived accounts read only as far as their
   * statements reached, never to today).
   */
  checkedThrough: string | null;
  /** of `occurrenceCount`, the paydays dated on or before `checkedThrough` */
  checkedOccurrenceCount: number;
  checkedCents: number;
}

export interface UnbankedIncome {
  totalCents: number;
  series: UnbankedIncomeSeries[];
}

/**
 * The overdue rule itself, over an explicit set of series.
 *
 * Extracted from `budgetOverdue` so the committed book can ask the same
 * question of EVERY bill series at once. It cannot reuse `budgetOverdue`
 * directly: that is scoped to a category subtree, and unioning it over all
 * categories double-counts every series whose category has a parent — measured
 * 2026-08-24, walking the category tree reported $128.42 overdue where the
 * truth is $64.21, because Utilities and its Internet/Electricity children each
 * claimed the same two bills.
 *
 * One implementation, so "is this bill late?" cannot get two answers.
 *
 * ⛔ MONEY-OUT ONLY, and not by accident: the `amountCents < 0` filter is what
 * keeps a missed PAYDAY out of every caller. An outflow nobody paid is money
 * still owed; an inflow nobody banked is evidence about the imports, and
 * carrying it forward would inflate a cash projection.
 *
 * ⛔ The walk is `[periodStart, through]`; `today` is the day of the QUESTION, and a series the forecast has let go
 * that day (`hasStoppedForecasting`) is owed for none of the window. They are two parameters because every caller but
 * `/budgets` closes the walk the day BEFORE today, and with one parameter the lapse was judged on that day. 🔴 Measured
 * on the owner's ledger 2026-10-08: Amazon Prime lapsed that morning, and the runway card, /recurring's month forecast
 * and the bill's own page still owed its Oct 5 $4.99 beside the subscriptions card's "STOPPED BEING FORECAST".
 */
export function overdueForSeries(
  db: AppDatabase,
  seriesIds: ReadonlySet<string>,
  periodStart: string,
  through: string,
  today: string,
): BudgetTail {
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };
  if (compareDates(periodStart, through) > 0) return { totalCents: 0, series: [] };

  const rows = db
    .select()
    .from(recurringSeries)
    .where(
      and(
        inArray(recurringSeries.id, [...seriesIds]),
        inArray(recurringSeries.status, ["detected", "confirmed"]),
      ),
    )
    .all();
  // measured to each series' checked day, as every forward leg measures it (§6A 57) — today where none is coming
  const checkedThrough = silenceMeasuredThroughBySeries(db, today);
  const live = rows.filter((r) => !hasStoppedForecasting(r, today, checkedThrough(r.id)));
  if (live.length === 0) return { totalCents: 0, series: [] };

  // postings linked to these series, widened by the largest tolerance so a bill
  // that landed a few days either side of its due date still counts as paid
  const maxTolerance = live.reduce((m, r) => Math.max(m, r.toleranceDays), 0);
  const postedBySeries = new Map<string, string[]>();
  for (const row of db
    .select({ seriesId: transactions.recurringSeriesId, postedOn: transactions.postedOn })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        inArray(transactions.recurringSeriesId, [...seriesIds]),
        gte(transactions.postedOn, addDays(periodStart, -maxTolerance)),
        lte(transactions.postedOn, addDays(through, maxTolerance)),
      ),
    )
    .all()) {
    if (row.seriesId === null) continue;
    postedBySeries.set(row.seriesId, [...(postedBySeries.get(row.seriesId) ?? []), row.postedOn]);
  }

  const series: BudgetTailSeries[] = [];
  let totalCents = 0;
  for (const s of live) {
    const posted = postedBySeries.get(s.id) ?? [];
    const occ = projectOccurrences(toProjectable(s), periodStart, through)
      .filter((o) => o.amountCents < 0)
      .filter((o) => !posted.some((p) => Math.abs(diffDays(p, o.date)) <= s.toleranceDays));
    if (occ.length === 0) continue;
    const amountCents = occ.reduce((sum, o) => sum - o.amountCents, 0);
    totalCents += amountCents;
    series.push({
      id: s.id,
      name: s.name,
      cadence: occ[0]!.cadence,
      nextDate: occ[0]!.date,
      amountCents,
      occurrenceCount: occ.length,
      href: `/recurring/${s.id}`,
    });
  }
  series.sort((a, b) => compareDates(a.nextDate, b.nextDate) || a.name.localeCompare(b.name));
  return { totalCents, series };
}

/**
 * What these series owe THIS CALENDAR MONTH: `overdueForSeries` over `[the 1st, the day before today]`, asked today.
 *
 * ⚖️ Arrears are scoped to the calendar month — owner decision 2026-09-02; this does not widen the leg. It closes the
 * day BEFORE today because the forward legs own today: a bill due today and unposted is due, not late (see
 * `committedBook`). `/budgets` alone closes on today, inclusive, and calls `overdueForSeries` itself (`budgetOverdue`).
 *
 * ⛔ ONE CALL, every surface that says a bill "came due": the runway card, the month forecast, /recurring's Next
 * column, the bill's own page and the category page. Each spelled the window out by hand, and each passed its last
 * day as the day to judge a lapse on — see `overdueForSeries`.
 */
export function arrearsThisMonth(db: AppDatabase, seriesIds: ReadonlySet<string>, today: string): BudgetTail {
  return overdueForSeries(db, seriesIds, periodBounds(today, "monthly").start, addDays(today, -1), today);
}

/**
 * THE INCOME MIRROR — paydays that have already passed inside a window with no
 * deposit banked against them.
 *
 * ⛔ NOT a forecast leg, and it never becomes one. `overdueForSeries` above says
 * why in its own words: an outflow nobody paid is money still owed, an inflow
 * nobody banked is evidence about the IMPORTS, and carrying it forward would
 * inflate a cash projection on a ledger whose owner is paid in cash and banks
 * it in lumps. This exists so surfaces can NAME the figure instead of leaving a
 * hole where a reader has to find it.
 *
 * 🔴 The hole, measured on the owner's ledger 2026-09-04 — a Friday, the day
 * after a Thursday payday, with nothing imported past 2026-08-31:
 *
 *     /budgets    "$0.00 in so far, $3,141.00 still expected"
 *                 "4 paydays fall in this month, scheduled at $4,188.00"
 *     /recurring  "PROJECTED NET -$426.60"  over a month strip on the same
 *                 screen reading "as scheduled +$620.40"
 *
 * $1,047.00 twice, on two pages, called nothing on either.
 *
 * ⛔ THE TWO LEGS ABUT AT `today`, MIRRORED FROM THE BILLS ONE. Bills: forward
 * opens on today and arrears closes the day before, because `budgetOverdue`
 * owns today for spending. Income: the forward leg OWNS today (a payday dated
 * today is future until its money posts), so this closes the day before too —
 * `[periodStart, today)`. One day a month the two rules meet and they must not
 * both claim it.
 *
 * Whether an occurrence was met is judged with the series' own `toleranceDays`,
 * the same arbiter bills get, so income and spending cannot disagree about
 * whether a scheduled amount arrived.
 */
export function unbankedIncomeForSeries(
  db: AppDatabase,
  seriesIds: ReadonlySet<string>,
  periodStart: string,
  today: string,
): UnbankedIncome {
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };
  // the walk is `[periodStart, today)`; an empty or inverted one has nothing past
  if (compareDates(periodStart, today) >= 0) return { totalCents: 0, series: [] };

  const live = db
    .select()
    .from(recurringSeries)
    .where(
      and(
        inArray(recurringSeries.id, [...seriesIds]),
        inArray(recurringSeries.status, ["detected", "confirmed"]),
      ),
    )
    .all()
    /*
     * ⛔ No lapse filter, unlike the bills walk — and none is needed: money in
     * never lapses (`hasStoppedForecasting`), and a pay series going quiet
     * for three cycles is the very case this figure exists to report — dropping
     * it here would delete the sentence exactly when it matters most.
     */
    .filter((r) => r.kind === "income");
  if (live.length === 0) return { totalCents: 0, series: [] };

  /*
   * ⚖️ SETTLE BACKWARDS, his decision of 2026-09-28. Whether a payday was met is
   * `paydaySettlement`'s answer, not a date-match of this module's own: a
   * deposit pays down the paydays behind it up to its amount, so his 2026-09-23
   * lump of $4,567.68 retires Sep 24, Sep 17, Sep 10 and Sep 3 rather than the
   * single week it lands on. `lib/payday-settlement` carries the rule and the
   * decision; the point of reading it here is that /budgets, the recurring
   * calendar and this figure cannot disagree about the same Thursday.
   */
  const settled = settledPaydaysBySeries(
    db,
    live.map((r) => r.id),
    today,
  );

  const unmet = live
    .map((s) => {
      const met = settled.get(s.id) ?? new Map<string, string>();
      const occ = projectOccurrences(toProjectable(s), periodStart, addDays(today, -1))
        .filter((o) => o.amountCents > 0)
        .filter((o) => !met.has(o.date));
      return { s, occ };
    })
    .filter(({ occ }) => occ.length > 0);
  if (unmet.length === 0) return { totalCents: 0, series: [] };

  /*
   * 🔴 THE CALENDAR IS NOT THE RECORD. A payday passed; whether anyone has
   * LOOKED for its deposit is a question about how far the account it lands in
   * has been read. Measured on the owner's ledger 2026-09-15: /budgets said Sep
   * 3 and Sep 10 passed "with no deposit against them" and /recurring called
   * them "Cash pay that never reaches a bank", while Chase Checking — the only
   * account that pay has landed in — was read through Aug 12.
   *
   * ⛔ The frontier is `cashEarningsReadings`' rule, not a second one: the same
   * `checkedThroughBySeries` (`landingAccountsBySeries` and `earliestVerified`
   * over every account's checked record, archived ones to their last statement),
   * so /spending and these two surfaces cannot disagree about which paydays were
   * read. A payday ON the frontier day was read. Coverage is only read when a
   * payday is actually unmet, so the common month costs nothing extra.
   */
  const checkedOf = checkedThroughBySeries(db, today);

  const series = unmet.map(({ s, occ }): UnbankedIncomeSeries => {
    const checkedThrough = checkedOf(s.id);
    const checked = checkedThrough === null ? [] : occ.filter((o) => compareDates(o.date, checkedThrough) <= 0);
    return {
      id: s.id,
      name: s.name,
      cadence: occ[0]!.cadence,
      nextDate: occ[0]!.date,
      amountCents: occ.reduce((sum, o) => sum + o.amountCents, 0),
      occurrenceCount: occ.length,
      href: `/recurring/${s.id}`,
      checkedThrough,
      checkedOccurrenceCount: checked.length,
      checkedCents: checked.reduce((sum, o) => sum + o.amountCents, 0),
    };
  });
  series.sort((a, b) => compareDates(a.nextDate, b.nextDate) || a.name.localeCompare(b.name));
  return { totalCents: series.reduce((sum, x) => sum + x.amountCents, 0), series };
}

/** One reading of the unbanked paydays, for a sentence about all of them. */
export interface UnbankedIncomeTotals {
  totalCents: number;
  occurrenceCount: number;
  /** of those, the paydays on days the ledger has checked every landing account through */
  checkedOccurrenceCount: number;
  /**
   * How far the accounts the pay lands in were checked, across every series
   * (`sharedFrontier`): the one day they share, `per-schedule` when they were
   * checked through different days, or `unchecked` when one has no checked
   * record or nothing passed unpaid. Never the earliest of several days — that
   * is false of every later schedule's paydays.
   */
  frontier: UnbankedFrontier;
  names: string[];
}

export function unbankedIncomeTotals(u: UnbankedIncome): UnbankedIncomeTotals {
  return {
    totalCents: u.totalCents,
    occurrenceCount: u.series.reduce((n, s) => n + s.occurrenceCount, 0),
    checkedOccurrenceCount: u.series.reduce((n, s) => n + s.checkedOccurrenceCount, 0),
    frontier: sharedFrontier(u.series.map((s) => s.checkedThrough)),
    names: u.series.map((s) => s.name),
  };
}
