import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates } from "@/lib/dates";
import { settlePaydaysBackwards, type PaydaySettlement } from "@/lib/payday-settlement";
import { projectOccurrences, toProjectable } from "./recurring";

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
  if (!s || s.kind !== "income") return { settledDates: new Set(), unallocatedCents: 0 };

  const deposits = db
    .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        eq(transactions.recurringSeriesId, seriesId),
        // money IN only: a clawback or a returned payment is not a payday
        gt(transactions.amountCents, 0),
        /*
         * ⛔ Nothing after today has arrived, whatever the row says. A deposit
         * dated forward would otherwise retire paydays from a reading taken
         * before it posted — the same refusal `cashEarnings` makes when it
         * clamps its window to `today`.
         */
        lte(transactions.postedOn, today),
      ),
    )
    .all();
  if (deposits.length === 0) return { settledDates: new Set(), unallocatedCents: 0 };

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

/** Just the dates, for the surfaces that only ask "was this payday met?". */
export function settledPaydaysForSeries(db: AppDatabase, seriesId: string, today: string): ReadonlySet<string> {
  return paydaySettlement(db, seriesId, today).settledDates;
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
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const id of seriesIds) out.set(id, settledPaydaysForSeries(db, id, today));
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
