import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { cashEarnings, type CashEarnings, type PaySeries } from "@/lib/cash-earnings";

/**
 * Earned versus banked, read off the real ledger.
 *
 * Feeds `lib/cash-earnings`, whose docstring carries the reasoning. What this
 * layer owns is the choice of EVIDENCE, and there are two decisions in it that
 * a reader will otherwise think are arbitrary.
 *
 * **1. The series' life comes from its linked rows, not from `last_matched_on`.**
 * That column is written at detection time and nothing revisits it — the same
 * shape of defect as the stored reconciliation verdicts of pass 59, and it is
 * already wrong on the live database. Measured 2026-08-21: "Cash job (weekly
 * pay)" carries `last_matched_on = 2026-07-06`, but no transaction links to the
 * series on that day; the $150 row that was once matched there has since been
 * re-categorised to `Transfers > Internal Transfer` and unlinked. The newest
 * genuinely linked deposit is 2026-06-05. Reading the cache would understate
 * the silence by a month, so this reads the rows.
 *
 * **2. Only ATTRIBUTED deposits count as banked.** A row counts when it carries
 * `recurring_series_id`, never merely because it looks like a cash deposit. The
 * 2026-07-21 pair of ATM deposits totalling $6,900 is his mother's money, and a
 * heuristic wide enough to catch a payday would have swept it into wages — the
 * exact mistake pass 59 had to undo by hand.
 *
 * ⚠️ Not to be confused with `lib/income-forecast`'s `projectOngoingIncome`,
 * which looks FORWARD from trailing history to estimate next month. This looks
 * BACKWARD from a confirmed schedule at a window that has already happened.
 * Merging them would be a category error: one projects, one reconciles.
 */

export interface CashEarningsReading extends CashEarnings {
  seriesId: string;
  seriesName: string;
}

export interface CashEarningsWindow {
  from: string;
  to: string;
  today?: string;
}

/**
 * One reading per confirmed income series — never a single aggregate.
 *
 * Summing them would produce a total whose `basis` is meaningless: one live
 * schedule and one long-dead one average out to a number that describes
 * neither. The caller renders what it wants and each row keeps its own verdict.
 *
 * `confirmed` only, deliberately. A `detected` income series is a hypothesis the
 * owner has not agreed to, and implying earnings from an unconfirmed guess is
 * the fabrication this whole module exists to avoid.
 */
export function cashEarningsReadings(
  db: AppDatabase,
  { from, to, today = todayIso() }: CashEarningsWindow,
): CashEarningsReading[] {
  const series = db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      cadence: recurringSeries.cadence,
      userCadence: recurringSeries.userCadence,
      intervalDaysAvg: recurringSeries.intervalDaysAvg,
      amountCentsAvg: recurringSeries.amountCentsAvg,
      userAmountCents: recurringSeries.userAmountCents,
      userEndsOn: recurringSeries.userEndsOn,
      anchorDay: recurringSeries.anchorDay,
    })
    .from(recurringSeries)
    .where(and(eq(recurringSeries.kind, "income"), eq(recurringSeries.status, "confirmed")))
    .orderBy(asc(recurringSeries.name))
    .all();

  if (series.length === 0) return [];

  const linked = db
    .select({
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(isNotNull(transactions.recurringSeriesId), eq(transactions.status, "active")))
    .orderBy(asc(transactions.postedOn))
    .all();

  const readings: CashEarningsReading[] = [];

  for (const s of series) {
    const banked = linked
      .filter((r) => r.seriesId === s.id)
      .map((r) => ({ postedOn: r.postedOn, amountCents: r.amountCents }));

    /*
     * A schedule with no evidence at all has no life to bound, so it implies
     * nothing rather than implying everything since the epoch. `startedOn` is
     * the first deposit the owner actually attributed to it — the earliest
     * moment we can say the arrangement existed.
     */
    const firstBanked = banked[0];
    if (firstBanked === undefined) continue;

    const amountCents = s.userAmountCents ?? s.amountCentsAvg;
    if (amountCents === null || amountCents <= 0) continue;

    const pay: PaySeries = {
      cadence: s.userCadence ?? s.cadence,
      // a user-set cadence replaces the measured gap: the owner declaring
      // "weekly" outranks an average taken over two deposits a day apart
      intervalDaysAvg: s.userCadence ? null : s.intervalDaysAvg,
      anchorDay: s.anchorDay ?? null,
      amountCents,
      startedOn: firstBanked.postedOn,
      endedOn: s.userEndsOn ?? null,
    };

    readings.push({
      seriesId: s.id,
      seriesName: s.name,
      ...cashEarnings({ series: pay, banked, from, to, today }),
    });
  }

  return readings;
}
