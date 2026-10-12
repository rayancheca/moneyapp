import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import type { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { paydayReadings, type ReadableRow } from "@/lib/per-payday";
import {
  atTodaysRate,
  occurrencesOf,
  postedAverage,
  readsPerOccurrence,
  type Occurrence,
  type PostedAverage,
  type PostedReading,
} from "@/lib/posted-average";
import { currentRateSince } from "@/lib/series-kind";
import { carriedNamesBySeries } from "./billing-carriers";
import { paydaySettlement, readsPerPayday } from "./payday-settlement";
import { effectiveSeries } from "./recurring";

/** A series' posted average, and what its payments carry. */
export interface SeriesPostedAverage extends PostedAverage {
  /**
   * ⚖️ The series billed inside its payments (§6A 59), by name — money its average holds too, named beside it wherever
   * it prints (`carriesPhrase`). Empty for a series that carries nothing.
   */
  carries: readonly string[];
  /**
   * What each payment paid, oldest first (`occurrencesOf`) — the samples of the average, when the series reads per
   * occurrence (`readsPerOccurrence`): ⚖️ the payments at the rate in force now (`atTodaysRate`, §6A 63), every one
   * for a series whose rate never changed; null when it reads per payday or as posted. ⛔ What the popover's sentence
   * counts and ranges beside this average. 🔴 Row by row beside it, his rent's popover read "5 different amounts, from
   * -$2,291.21 to -$1,100.00" before "average … is -$2,312.20" (review of af5b0fa, 2026-10-12).
   */
  occurrences: readonly Occurrence[] | null;
  /**
   * Every payment, at every rate, oldest first — what the series page's Amount history draws, each bar against its own
   * time's rate (§6A 55), as his pay's history draws his cash weeks; null where `occurrences` is. 🔴 Drawn per row, his
   * page read "each of the 5 posted occurrences" under a Per charge of four (review of af5b0fa, 2026-10-12).
   */
  everyOccurrence: readonly Occurrence[] | null;
  /**
   * The first day of the rate in force now (`currentRateSince`) — null for a series whose rate never changed. Where the
   * popover's words start counting when `everyOccurrence` holds payments `occurrences` leaves out (§6A 63).
   */
  rateSince: string | null;
}

/**
 * Per series, what its postings averaged and their spread (`lib/posted-average`) — read off the database the ONE way
 * the series page, the All tab and the amount popover all read it: every active row linked to the series; a pay
 * series' rows read per payday by its settlement (`readsPerPayday`, `paydayReadings` — the calendar's own gate and
 * reading), held to its rate history (`effectiveSeries`); a series with a schedule of charges, per occurrence
 * (`readsPerOccurrence`), held to that same history (`atTodaysRate`, §6A 63); any other, as posted. With it, what
 * each one's payments carry (`carriedNamesBySeries`).
 *
 * ⛔ One function for all three, so no surface can feed the rule a different reading. 🔴 They each averaged the rows
 * themselves — three copies of one mean — and when the mean was the wrong figure for a pay series, all three printed
 * $1,789.15 for a week of $1,141.92 (a copy of his ledger, 2026-10-08).
 */
export function postedAveragesBySeries(
  db: AppDatabase,
  series: readonly (typeof recurringSeries.$inferSelect)[],
  today: string,
): Map<string, SeriesPostedAverage> {
  const out = new Map<string, SeriesPostedAverage>();
  if (series.length === 0) return out;

  const rowsBySeries = new Map<string, ReadableRow[]>();
  for (const r of db
    .select({
      id: transactions.id,
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), inArray(transactions.recurringSeriesId, series.map((s) => s.id))))
    .all()) {
    if (!r.seriesId) continue;
    const list = rowsBySeries.get(r.seriesId);
    if (list) list.push(r);
    else rowsBySeries.set(r.seriesId, [r]);
  }

  const carried = carriedNamesBySeries(db);
  for (const s of series) {
    const rows = rowsBySeries.get(s.id) ?? [];
    const schedule = effectiveSeries(s);
    const reading: PostedReading = readsPerPayday(s)
      ? { per: "payday", readings: paydayReadings(rows, paydaySettlement(db, s.id, today).portions, schedule) }
      : readsPerOccurrence(s)
        ? { per: "occurrence" }
        : { per: "row" };
    const every = reading.per === "occurrence" ? occurrencesOf(rows) : null;
    out.set(s.id, {
      ...postedAverage(rows, reading, schedule),
      carries: carried.get(s.id) ?? [],
      // ⚖️ the payments the average is of — `postedAverage` reads them by this same rule (§6A 63)
      occurrences: every === null ? null : atTodaysRate(every, schedule),
      everyOccurrence: every,
      rateSince: currentRateSince(schedule),
    });
  }
  return out;
}
