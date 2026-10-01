import { and, eq, gt, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates } from "@/lib/dates";
import {
  hasArrived,
  noSettlement,
  settlePaydaysBackwards,
  type PaydaySettlement,
} from "@/lib/payday-settlement";
import {
  effectiveSeries,
  projectOccurrences,
  rollForwardNextExpected,
  toProjectable,
  type SeriesOverrides,
} from "./recurring";

/**
 * The settle-backwards rule, read off the database.
 *
 * `lib/payday-settlement` owns the rule itself and says why. This supplies the
 * two inputs it needs and nothing else: every occurrence the ledger DRAWS for a
 * pay series, and every deposit attributed to it.
 *
 * ⛔ THE UNIVERSE IS NOT THE CALLER'S WINDOW, and it cannot be. A deposit in
 * September pays down paydays in August, so a September window that projected
 * only September would report Aug 27 unpaid on one page and paid on another —
 * the exact disagreement this module exists to end. Every caller gets the same
 * answer for the same series because every caller asks over the same span.
 *
 * ⛔ WHERE THE WALK STOPS, backwards. `projectOccurrences` cannot produce a date
 * before the series' own anchor (`stepsToReach` never returns a negative step),
 * so the earliest payday that can be settled is the earliest one the ledger
 * itself draws. That is the guard the decision asked for in its own terms — a
 * payday the ledger has no reason to think was ever owed is not projected, so
 * it cannot be retro-settled. His pay series is anchored 2026-07-23 and first
 * matched in June 2026; nothing before that is reachable however large a lump
 * lands.
 *
 * ⛔ AND FORWARDS: `today + toleranceDays`. A lump that posts the day before a
 * payday answers that payday (his 2026-09-23 +$4,567.68 covers Sep 24), and
 * that is precisely the double count the budget page used to publish. Past the
 * tolerance window nothing is settled, so a deposit never pre-pays a week it
 * could not reach.
 */
export function paydaySettlement(db: AppDatabase, seriesId: string, today: string): PaydaySettlement {
  const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!s || s.kind !== "income") return noSettlement();

  const deposits = db
    .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        eq(transactions.recurringSeriesId, seriesId),
        // money IN only: a clawback or a returned payment is not a payday
        gt(transactions.amountCents, 0),
      ),
    )
    .all()
    /*
     * ⛔ Nothing after today has arrived, whatever the row says. A deposit
     * dated forward would otherwise retire paydays from a reading taken before
     * it posted. `hasArrived` is the boundary, so the recurring calendar, which
     * draws deposits beside this answer, cuts them on the same day.
     */
    .filter((d) => hasArrived(d.postedOn, today));
  if (deposits.length === 0) return noSettlement();

  /*
   * The walk opens on the earliest evidence there is — the first attributed
   * deposit, or the series' own next-expected anchor when detection wrote one
   * earlier. `projectOccurrences` floors itself at that anchor either way, so
   * passing the earlier of the two asks for "everything the ledger draws"
   * rather than imposing a second, quieter floor of this module's own.
   */
  const firstDeposit = deposits.reduce((first, d) => (compareDates(d.postedOn, first) < 0 ? d.postedOn : first), deposits[0]!.postedOn);
  const anchor = s.userNextExpectedOn ?? s.nextExpectedOn;
  const from = anchor !== null && compareDates(anchor, firstDeposit) < 0 ? anchor : firstDeposit;

  const occurrences = projectOccurrences(toProjectable(s), from, addDays(today, s.toleranceDays)).filter(
    (o) => o.amountCents > 0,
  );

  return settlePaydaysBackwards({ occurrences, deposits, toleranceDays: s.toleranceDays });
}

/**
 * Just the settlements, for the surfaces that ask "was this payday met?".
 *
 * ⛔ AND BY WHICH DEPOSIT — payday date → the settling deposit's `posted_on`.
 * `.has(date)` reads exactly as the old set did; the value is there because
 * every caller also publishes a figure over a window the settling money may sit
 * outside of, and a payday dropped from one window without being added to
 * another is named by nothing. See `lib/payday-settlement`'s `settledBy`.
 */
export function settledPaydaysForSeries(db: AppDatabase, seriesId: string, today: string): ReadonlyMap<string, string> {
  return paydaySettlement(db, seriesId, today).settledBy;
}

/**
 * A series' projected occurrences less the paydays its deposits have already
 * paid down — what is STILL TO COME.
 *
 * ⚖️ A payday a deposit has already paid down is not still to come: settle
 * backwards is his decision of 2026-09-28, and a lump that posts BEFORE the
 * payday it covers (Wed Sep 30's deposit pays Thu Oct 1) is in the bank
 * already. Listing that payday ahead counts the money twice.
 *
 * ⛔ ONE READING for every surface that looks ahead: the forecast, the upcoming
 * list (/recurring's Upcoming tab, the dashboard's strip and its "before your
 * next paycheck") and a series' "Next expected" — and, through `nextStillToCome`,
 * every surface that names a series' single next date to come. 🔴 Only the forecast
 * asked: on Sep 30 the dashboard waited on Oct 1's pay — the pay that had come
 * the day before — and said nothing was due before it, while $2,000.00 of rent
 * due Oct 5 falls before the pay that will actually come, on Oct 8.
 *
 * Income only: settlement speaks about deposits, and a bill's absence is
 * `overdueForSeries`'.
 */
export function stillToCome<T extends { date: string }>(
  db: AppDatabase,
  series: { id: string; kind: SeriesKind },
  occurrences: readonly T[],
  today: string,
): T[] {
  const toCome = isStillToCome(db, series, today);
  return occurrences.filter((o) => toCome(o.date));
}

/**
 * A series' NEXT date still to come: the schedule's next occurrence
 * (`rollForwardNextExpected`), stepped past every payday a deposit has already
 * paid down — the first date of the list `stillToCome` leaves, without projecting
 * a list to find it.
 *
 * 🔴 The single next date never asked. `/recurring?tab=all`'s "Next" and
 * `/categories/<Income>`'s "· next" (`listSeries`) read the bare schedule, so on Sep
 * 30 they named Oct 1, the payday Wed Sep 30's deposit had paid, one tab over from
 * an Upcoming list starting at Oct 8. Measured on a copy of his ledger: read on Sep
 * 23 and Sep 24 they named Sep 24 — the payday the Sep 23 lump of $4,567.68 had paid
 * — while that series' own list said Oct 1.
 *
 * ⛔ NOT the series sentence (`seriesDetail.nextExpectedOn`): its date editor saves
 * the date it opens on as the schedule's anchor, and a payday paid early is still on
 * the schedule. 🔴 Opened on this, a Save with nothing changed anchored his weekly
 * pay past the payday a deposit had paid, which then left the projection
 * `paydaySettlement` walks.
 *
 * ⛔ Not a second copy of the rule: `isStillToCome` is the predicate `stillToCome`
 * filters with, and the steps are `rollForwardNextExpected`'s, so the walk visits
 * exactly the dates settlement graded (both step the effective schedule from its
 * anchor). It ends because settlement names finitely many paydays and every step
 * moves strictly forward.
 *
 * Null when the schedule has no next date, or none a deposit has not already paid:
 * a series whose last payday was paid early expects nothing more, which is what its
 * own page's list says. Money out is never paid down, so a bill's next date is its
 * schedule's, read without a query.
 */
export function nextStillToCome(
  db: AppDatabase,
  series: SeriesOverrides & { id: string; kind: SeriesKind },
  today: string,
): string | null {
  const eff = effectiveSeries(series);
  const toCome = isStillToCome(db, series, today);
  let next = rollForwardNextExpected(eff, today);
  while (next !== null && !toCome(next)) next = rollForwardNextExpected(eff, addDays(next, 1));
  return next;
}

/**
 * Whether a series' occurrence on a date is still to come — the predicate behind
 * both shapes of the question, a list (`stillToCome`) and a single next date
 * (`nextStillToCome`), so the two can only ever drop the same paydays. Asked once
 * per series: the settlement is read when this is built, not per date.
 */
function isStillToCome(
  db: AppDatabase,
  series: { id: string; kind: SeriesKind },
  today: string,
): (date: string) => boolean {
  if (series.kind !== "income") return () => true;
  const settled = settledPaydaysForSeries(db, series.id, today);
  return (date) => !settled.has(date);
}

/**
 * The same answer for several series at once, which is how every caller needs
 * it — `unbankedIncomeForSeries`, the budgets header and the recurring calendar
 * all grade a set of schedules in one pass.
 */
export function settledPaydaysBySeries(
  db: AppDatabase,
  seriesIds: readonly string[],
  today: string,
): Map<string, ReadonlyMap<string, string>> {
  const out = new Map<string, ReadonlyMap<string, string>>();
  for (const [id, settlement] of paydaySettlementsBySeries(db, seriesIds, today)) {
    out.set(id, settlement.settledBy);
  }
  return out;
}

/**
 * The WHOLE settlement for several series — which paydays, and whose money paid
 * them (`portions`) — for a reader whose figures cover a window the money can
 * cross. The budgets header is one: its "in so far" is the money that landed in
 * the month, and settlement spends that money on paydays either side of it.
 */
export function paydaySettlementsBySeries(
  db: AppDatabase,
  seriesIds: readonly string[],
  today: string,
): Map<string, PaydaySettlement> {
  const out = new Map<string, PaydaySettlement>();
  for (const id of seriesIds) out.set(id, paydaySettlement(db, id, today));
  return out;
}

/** The income series among a set of ids — the only ones settlement speaks about. */
export function incomeSeriesIdsAmong(db: AppDatabase, seriesIds: readonly string[]): string[] {
  if (seriesIds.length === 0) return [];
  return db
    .select({ id: recurringSeries.id })
    .from(recurringSeries)
    .where(and(inArray(recurringSeries.id, [...seriesIds]), eq(recurringSeries.kind, "income")))
    .all()
    .map((r) => r.id);
}
