import { and, eq, gt, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays } from "@/lib/dates";
import {
  firstPaydayOn,
  hasArrived,
  noSettlement,
  settlePaydaysBackwards,
  type PaydaySettlement,
} from "@/lib/payday-settlement";
import { paydayReadings, type PaydayReading } from "@/lib/per-payday";
import { ratePeriodOf } from "@/lib/series-kind";
import {
  effectiveSeries,
  projectOccurrences,
  rollForwardNextExpected,
  toProjectable,
  type ProjectionOverrides,
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
 * ⚖️ WHERE THE WALK STOPS, backwards: the series' FIRST PAYDAY (`firstPaydayOn`,
 * §6A 55 step B) — its anchor's rhythm walked back to its first deposit. A payday
 * before any money arrived is one the ledger has no reason to think was ever
 * owed, so it is not projected and cannot be retro-settled, however large a lump
 * lands. His series is anchored 2026-07-23 and first paid on 2026-06-04: the
 * walk opens on Thursday Jun 4.
 *
 * 🔴 It opened on the stored ANCHOR (`projectOccurrences` floors its walk there),
 * while Earned vs banked counted from the first deposit: on his ledger June's
 * cash weeks were earned on the income card and drawn on no calendar, and Jun 4's
 * $1,047.00 read "toward no payday". ⛔ The calendar and /budgets open on the
 * same day (`firstPaydayOn` rides on the answer; `paydayProjectable`).
 *
 * ⛔ AND FORWARDS: `today + toleranceDays`. A lump that posts the day before a
 * payday answers that payday (his 2026-09-23 +$4,567.68 covers Sep 24), and
 * that is precisely the double count the budget page used to publish. Past the
 * tolerance window nothing is settled, so a deposit never pre-pays a week it
 * could not reach.
 */
export function paydaySettlement(db: AppDatabase, seriesId: string, today: string): SeriesPaydaySettlement {
  const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!s || s.kind !== "income") return unsettled();

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
  if (deposits.length === 0) return unsettled();

  /*
   * The walk opens on the series' first payday — its effective anchor's rhythm walked back to the first deposit — and
   * reaches `today + toleranceDays`. Money has arrived, so there is a first payday.
   */
  const firstOn = firstPaydayOn(effectiveSeries(s), s.toleranceDays, deposits, today);
  const projectable = paydayProjectable(s, { firstPaydayOn: firstOn }, today);
  const occurrences = projectOccurrences(projectable, firstOn ?? today, addDays(today, s.toleranceDays)).filter(
    (o) => o.amountCents > 0,
  );

  // ⚖️ the eras of his rate history (§6A 55a): money pays only the paydays priced in its own era
  const settlement = settlePaydaysBackwards({
    occurrences,
    deposits,
    toleranceDays: s.toleranceDays,
    periodOf: (day) => ratePeriodOf(projectable, day),
  });
  return { ...settlement, firstPaydayOn: firstOn };
}

/**
 * A series' settlement, and the first payday it opened on.
 *
 * ⛔ `firstPaydayOn` rides on the answer because every reader that draws a pay series' paydays beside it — the
 * recurring calendar, /budgets and its passed-unpaid leg — must draw the paydays it walked (`paydayProjectable`), not
 * the ones a projection floored at the anchor would. Null when no money has arrived: nothing opens before the anchor.
 */
export interface SeriesPaydaySettlement extends PaydaySettlement {
  firstPaydayOn: string | null;
}

const unsettled = (): SeriesPaydaySettlement => ({ ...noSettlement(), firstPaydayOn: null });

/**
 * A series' projection over its whole payday universe: `toProjectable`, opened on the first payday its settlement
 * walked from (`firstPaydayOn`). ⛔ One rule for every reader of past paydays — a reader projecting from the anchor
 * alone names fewer paydays than the settlement it reads, and than Earned vs banked counts.
 *
 * ⛔ The walk back is for the PAST (`walkBackBefore`, today): from today on the schedule is its anchor's, the one the
 * forecast, Upcoming and /budgets' expected leg project. 🔴 Unbounded, a next payday he dated ahead — Oct 22, set on
 * Oct 8 — left Oct 8 and Oct 15 scheduled on /budgets and drawn upcoming on the calendar, in no other figure.
 */
export function paydayProjectable(
  s: Parameters<typeof toProjectable>[0],
  settlement: Pick<SeriesPaydaySettlement, "firstPaydayOn"> | undefined,
  today: string,
): ReturnType<typeof toProjectable> {
  return { ...toProjectable(s), firstOn: settlement?.firstPaydayOn ?? null, walkBackBefore: today };
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
  series: ProjectionOverrides & { id: string; kind: SeriesKind },
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
 * The WHOLE settlement for several series — which paydays, and whose money paid
 * them (`portions`) — for a reader whose figures cover a window the money can
 * cross. The budgets header is one: its "in so far" is the money that landed in
 * the month, and settlement spends that money on paydays either side of it.
 *
 * ⛔ The one way a set of schedules is graded — `unbankedIncomeForSeries`, the
 * budgets header and the recurring calendar — because each must also DRAW the
 * paydays settlement walked, from its first payday (`paydayProjectable`). A
 * settled-dates-only map (`settledPaydaysBySeries`, gone with §6A 55 step B)
 * let a reader grade the paydays a projection floored at the anchor drew.
 */
export function paydaySettlementsBySeries(
  db: AppDatabase,
  seriesIds: readonly string[],
  today: string,
): Map<string, SeriesPaydaySettlement> {
  const out = new Map<string, SeriesPaydaySettlement>();
  for (const id of seriesIds) out.set(id, paydaySettlement(db, id, today));
  return out;
}

/**
 * Whether a series' rows are read per payday (`lib/per-payday`): money in that
 * the forecast still projects — the pay series whose paydays the recurring
 * calendar grades by settlement. ONE gate, so the calendar and the series page
 * read the same rows the same way; an ended job's history is read as it posted.
 */
export function readsPerPayday(s: { kind: SeriesKind; status: SeriesStatus }): boolean {
  return s.kind === "income" && (s.status === "detected" || s.status === "confirmed");
}

/**
 * Per series, each active row's per-payday reading, from that series'
 * settlement — every row, not a window's, because the spread a row is measured
 * against is the series' whole history — held to the series' rate at the payday
 * it paid (`effectiveSeries`: the rate now and its dated history, §6A 55).
 */
export function paydayReadingsBySeries(
  db: AppDatabase,
  settlements: ReadonlyMap<string, PaydaySettlement>,
): Map<string, ReadonlyMap<string, PaydayReading>> {
  const out = new Map<string, ReadonlyMap<string, PaydayReading>>();
  if (settlements.size === 0) return out;
  const schedules = new Map(
    db
      .select()
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, [...settlements.keys()]))
      .all()
      .map((s) => [s.id, effectiveSeries(s)] as const),
  );
  const rowsBySeries = new Map<string, { id: string; postedOn: string; amountCents: number }[]>();
  for (const r of db
    .select({
      id: transactions.id,
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), inArray(transactions.recurringSeriesId, [...settlements.keys()])))
    .all()) {
    if (!r.seriesId) continue;
    const list = rowsBySeries.get(r.seriesId);
    if (list) list.push(r);
    else rowsBySeries.set(r.seriesId, [r]);
  }
  for (const [seriesId, settlement] of settlements) {
    const schedule = schedules.get(seriesId);
    if (!schedule) continue; // a series settlement spoke about is a row in this table — no schedule, no reading
    out.set(seriesId, paydayReadings(rowsBySeries.get(seriesId) ?? [], settlement.portions, schedule));
  }
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
