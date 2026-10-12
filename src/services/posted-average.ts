import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import type { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { paydayReadings, type ReadableRow } from "@/lib/per-payday";
import { postedAverage, readsPerOccurrence, type PostedAverage, type PostedReading } from "@/lib/posted-average";
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
}

/**
 * Per series, what its postings averaged and their spread (`lib/posted-average`) — read off the database the ONE way
 * the series page, the All tab and the amount popover all read it: every active row linked to the series; a pay
 * series' rows read per payday by its settlement (`readsPerPayday`, `paydayReadings` — the calendar's own gate and
 * reading), held to its rate history (`effectiveSeries`); a series with a schedule of charges, per occurrence
 * (`readsPerOccurrence`); any other, as posted. With it, what each one's payments carry (`carriedNamesBySeries`).
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
    out.set(s.id, { ...postedAverage(rows, reading, schedule), carries: carried.get(s.id) ?? [] });
  }
  return out;
}
