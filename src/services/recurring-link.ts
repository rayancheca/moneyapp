import { and, inArray, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seriesDrawsAsRecurring } from "@/lib/series-evidence";

/**
 * Every series whose linked rows are NOT recurring money — the query side of
 * `seriesDrawsAsRecurring`, for each aggregate that splits spending into "the
 * bills" and "everything else".
 *
 * 🔴 THE LINK IS NOT THE VERDICT. A row tagged to a DISMISSED series keeps its
 * link on purpose — dismissed is the detector's re-detection sink — while the
 * owner has said the series is not recurring: "the smoothie bat and pura vida
 * are not recurring i just go eat there often". Three money surfaces read the
 * link as the verdict anyway, and each lost those rows its own way:
 *
 *   - `/recurring`'s month forecast held them out of the trailing pace while
 *     its fixed leg projects only live series, so the spend was counted
 *     NOWHERE — 17 rows, $242.72 of June–August on the real ledger 2026-09-14;
 *   - `/budgets` graded them as a bill already paid, held out of the run-rate
 *     with no tail to stand in for them;
 *   - the car card kept them out of "paid up front", as though a commitment
 *     line priced them.
 *
 * `/spending`'s category forecast alone had it right, with a private copy of
 * the dismissed-id set. This is that set with one definition.
 *
 * ⛔ Read through `seriesDrawsAsRecurring`, never a status literal. ENDED stays
 * recurring — it was a bill and stopped, and its history is real. A MERGED
 * series is `ended` with its rows relinked to the target, so they follow the
 * target's status rather than their old series'.
 */
export function seriesIdsNotDrawnAsRecurring(db: AppDatabase): ReadonlySet<string> {
  return new Set(
    db
      .select({ id: recurringSeries.id, status: recurringSeries.status })
      .from(recurringSeries)
      .all()
      .filter((s) => !seriesDrawsAsRecurring(s.status))
      .map((s) => s.id),
  );
}

/** SQL: the row is recurring money — linked, and to a series drawn as recurring. */
export function linkIsRecurring(notDrawn: ReadonlySet<string>): SQL {
  const linked = isNotNull(transactions.recurringSeriesId);
  if (notDrawn.size === 0) return linked;
  return and(linked, notInArray(transactions.recurringSeriesId, [...notDrawn]))!;
}

/** SQL: exactly the complement — no link, or a link to a series that is not recurring. */
export function linkIsNotRecurring(notDrawn: ReadonlySet<string>): SQL {
  const unlinked = isNull(transactions.recurringSeriesId);
  if (notDrawn.size === 0) return unlinked;
  return or(unlinked, inArray(transactions.recurringSeriesId, [...notDrawn]))!;
}

/** The same verdict for a row already in memory. */
export function rowIsRecurring(recurringSeriesId: string | null, notDrawn: ReadonlySet<string>): boolean {
  return recurringSeriesId !== null && !notDrawn.has(recurringSeriesId);
}
