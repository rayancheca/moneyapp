import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { compareDates, todayIso } from "@/lib/dates";
import { cashEarnings, type CashEarnings, type PaySeries } from "@/lib/cash-earnings";
import { accountCoverage } from "./coverage";

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
  /**
   * The last day every account this pay has landed in has been read through —
   * `earliestVerified` — or null when one of them has no checked record. Present
   * only when the caller asked (`withChecked`).
   *
   * 🔴 The /spending note said "none of it reached an account" of September's
   * paydays while Chase Checking, the only account that pay has ever landed in,
   * was read through Aug 12 (measured 2026-09-14). The calendar says a payday
   * passed; only this says whether anyone has looked for the deposit.
   */
  checkedThrough?: string | null;
  /** of `periodsCovered`, the paydays on or before `checkedThrough` (0 when it is null) */
  checkedPeriodsCovered?: number;
  /** of `periodsSinceBanked`, the ones on or before `checkedThrough` (0 when it is null) */
  checkedPeriodsSinceBanked?: number;
}

export interface CashEarningsWindow {
  from: string;
  to: string;
  today?: string;
  /** see `lib/cash-earnings`: `today` is a fully-read day, not the running one */
  todayIsComplete?: boolean;
  /**
   * Also measure each reading against how far its landing accounts have been
   * read. Off by default: it reads every account's coverage, and the dashboard
   * card that calls this several times computes its own frontier once.
   */
  withChecked?: boolean;
}

/** The accounts each income series' attributed pay has actually landed in. */
export function landingAccountsBySeries(db: AppDatabase): Map<string, Set<string>> {
  const rows = db
    .select({ seriesId: transactions.recurringSeriesId, accountId: transactions.accountId })
    .from(transactions)
    .where(and(isNotNull(transactions.recurringSeriesId), eq(transactions.status, "active")))
    .all();

  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.seriesId === null) continue;
    const set = out.get(r.seriesId) ?? new Set<string>();
    set.add(r.accountId);
    out.set(r.seriesId, set);
  }
  return out;
}

/**
 * The EARLIEST `verifiedThrough` across every account a series' pay has landed
 * in — the last day the ledger has checked every place a payday could arrive.
 *
 * A single account with nothing verified collapses the whole thing to null,
 * which is the honest answer rather than the convenient one: if one possible
 * landing place is unchecked, a deposit could be sitting in it unseen and no
 * surface may claim the ledger looked.
 */
export function earliestVerified(
  accountIds: ReadonlySet<string>,
  verifiedThroughByAccount: ReadonlyMap<string, string | null>,
  today: string,
): string | null {
  if (accountIds.size === 0) return null;
  let earliest: string | null = null;
  for (const id of accountIds) {
    const through = verifiedThroughByAccount.get(id) ?? null;
    if (through === null) return null;
    if (earliest === null || compareDates(through, earliest) < 0) earliest = through;
  }
  // a record reaching past today still cannot have been read against today
  if (earliest !== null && compareDates(earliest, today) > 0) return today;
  return earliest;
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
  { from, to, today = todayIso(), todayIsComplete = false, withChecked = false }: CashEarningsWindow,
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
  const verifiedThroughByAccount = withChecked
    ? new Map(accountCoverage(db, today).map((c) => [c.accountId, c.verifiedThrough] as const))
    : null;
  const landings = withChecked ? landingAccountsBySeries(db) : null;

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

    const reading: CashEarningsReading = {
      seriesId: s.id,
      seriesName: s.name,
      ...cashEarnings({ series: pay, banked, from, to, today, todayIsComplete }),
    };
    if (verifiedThroughByAccount === null || landings === null) {
      readings.push(reading);
      continue;
    }
    const checkedThrough = earliestVerified(landings.get(s.id) ?? new Set<string>(), verifiedThroughByAccount, today);
    if (checkedThrough === null) {
      readings.push({ ...reading, checkedThrough, checkedPeriodsCovered: 0, checkedPeriodsSinceBanked: 0 });
      continue;
    }
    /*
     * The same schedule, read AS OF the frontier: a day the records have read
     * through is complete, so a payday dated on it is checked — unless the
     * frontier IS the running day, where a deposit may still post.
     */
    const asChecked = cashEarnings({
      series: pay,
      banked,
      from,
      to: compareDates(to, checkedThrough) < 0 ? to : checkedThrough,
      today: checkedThrough,
      todayIsComplete: compareDates(checkedThrough, today) < 0,
    });
    readings.push({
      ...reading,
      checkedThrough,
      checkedPeriodsCovered: asChecked.periodsCovered,
      checkedPeriodsSinceBanked: asChecked.periodsSinceBanked,
    });
  }

  return readings;
}
