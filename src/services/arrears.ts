import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates, diffDays } from "@/lib/dates";
import { projectOccurrences, seriesHasLapsed, toProjectable } from "./recurring";

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
 */
export function overdueForSeries(
  db: AppDatabase,
  seriesIds: ReadonlySet<string>,
  periodStart: string,
  today: string,
): BudgetTail {
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };
  if (compareDates(periodStart, today) > 0) return { totalCents: 0, series: [] };

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
  const live = rows.filter((r) => !seriesHasLapsed(r, today));
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
        lte(transactions.postedOn, addDays(today, maxTolerance)),
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
    const occ = projectOccurrences(toProjectable(s), periodStart, today)
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
): BudgetTail {
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
     * ⛔ No `seriesHasLapsed` filter, unlike the bills walk. Money in never
     * lapses (`lapsedSeriesShouldStopForecasting`), and a pay series going quiet
     * for three cycles is the very case this figure exists to report — dropping
     * it here would delete the sentence exactly when it matters most.
     */
    .filter((r) => r.kind === "income");
  if (live.length === 0) return { totalCents: 0, series: [] };

  const maxTolerance = live.reduce((m, r) => Math.max(m, r.toleranceDays), 0);
  const bankedBySeries = new Map<string, string[]>();
  for (const row of db
    .select({ seriesId: transactions.recurringSeriesId, postedOn: transactions.postedOn })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        inArray(
          transactions.recurringSeriesId,
          live.map((r) => r.id),
        ),
        gt(transactions.amountCents, 0),
        gte(transactions.postedOn, addDays(periodStart, -maxTolerance)),
        lte(transactions.postedOn, addDays(today, maxTolerance)),
      ),
    )
    .all()) {
    if (row.seriesId === null) continue;
    bankedBySeries.set(row.seriesId, [...(bankedBySeries.get(row.seriesId) ?? []), row.postedOn]);
  }

  const series: BudgetTailSeries[] = [];
  let totalCents = 0;
  for (const s of live) {
    const banked = bankedBySeries.get(s.id) ?? [];
    const occ = projectOccurrences(toProjectable(s), periodStart, addDays(today, -1))
      .filter((o) => o.amountCents > 0)
      .filter((o) => !banked.some((p) => Math.abs(diffDays(p, o.date)) <= s.toleranceDays));
    if (occ.length === 0) continue;
    const amountCents = occ.reduce((sum, o) => sum + o.amountCents, 0);
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
