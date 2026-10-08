import { count, isNotNull, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { AmountHistoryError, parseAmountHistoryText, seriesAmountCents } from "@/lib/series-kind";

/** A series whose stored rate history the app's one reader refuses. */
export interface RateHistoryRefusal {
  seriesId: string;
  name: string;
  /** the reader's own refusal (`AmountHistoryError`), exactly */
  reason: string;
  /** the line `pnpm ledger-check` fails with */
  sentence: string;
}

/**
 * The series whose `user_amount_history` the app cannot read (§6A 55) — each with the reader's refusal.
 *
 * ⛔ The column is JSON with no constraint, and `effectiveSeries` reads it strictly: a history it refuses refuses every
 * page that projects the series. So `pnpm ledger-check` asks first, through the SAME reader (`parseAmountHistoryText`,
 * held to the series' amount now, `seriesAmountCents`) — never a second, looser test — and fails on each, so a write
 * that got it wrong fails the next commit rather than his dashboard.
 *
 * Read as raw TEXT, not through the column's JSON mode: text that is not JSON would throw inside the query for every
 * series at once, and this names each one.
 */
export function rateHistoryRefusals(db: AppDatabase): RateHistoryRefusal[] {
  const rows = db
    .select({
      seriesId: recurringSeries.id,
      name: recurringSeries.name,
      userAmountCents: recurringSeries.userAmountCents,
      nextExpectedAmountCents: recurringSeries.nextExpectedAmountCents,
      text: sql<string>`${recurringSeries.userAmountHistory}`,
    })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userAmountHistory))
    .orderBy(recurringSeries.name, recurringSeries.id)
    .all();
  return rows.flatMap((row): RateHistoryRefusal[] => {
    try {
      parseAmountHistoryText(row.text, seriesAmountCents(row));
      return [];
    } catch (error: unknown) {
      if (!(error instanceof AmountHistoryError)) throw error;
      return [
        {
          seriesId: row.seriesId,
          name: row.name,
          reason: error.message,
          sentence:
            `The rate history of "${row.name}" (${row.seriesId}) cannot be read — ${error.message}. ` +
            "Every page that projects it refuses it until the history is fixed or set back to NULL.",
        },
      ];
    }
  });
}

/** How many series store a rate history at all — the count line `pnpm ledger-check` prints beside the refusals. */
export function storedRateHistoryCount(db: AppDatabase): number {
  return db.select({ n: count() }).from(recurringSeries).where(isNotNull(recurringSeries.userAmountHistory)).get()!.n;
}
