import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { loadRecomputeCtx, recomputeSeriesStats, resolveMergeTarget } from "./recurring";

/**
 * User-owned recurring-series link actions (ux-overhaul-plan §4.2/§4.3). Each
 * stamps series_link_source='user' on the rows it touches and settles every
 * affected series' stats through recomputeSeriesStats, so a later detection run
 * finds the stored stats already equal to what it would compute — and changes
 * nothing. All work happens in one synchronous transaction.
 */

/** Attaches transactions to a series by hand (a user-owned link). Returns the count moved. */
export function attachTransactions(
  db: AppDatabase,
  seriesId: string,
  transactionIds: readonly string[],
  today: string = todayIso(),
): number {
  if (transactionIds.length === 0) return 0;
  const ctx = loadRecomputeCtx(db);
  let attached = 0;
  db.transaction((tx) => {
    const mergedById = new Map(
      tx
        .select({ id: recurringSeries.id, mergedIntoId: recurringSeries.mergedIntoId })
        .from(recurringSeries)
        .all()
        .map((s) => [s.id, s.mergedIntoId]),
    );
    if (!mergedById.has(seriesId)) throw new Error(`Unknown recurring series ${seriesId}`);
    // attach to the LIVE series — a merged-away id routes to its target so rows
    // never strand on a dead (ended) series (mirrors mergeSeries/detection)
    const target = resolveMergeTarget(seriesId, mergedById);

    // capture the series these rows are leaving, so their stats settle too
    const rows = tx
      .select({ id: transactions.id, recurringSeriesId: transactions.recurringSeriesId })
      .from(transactions)
      .where(and(inArray(transactions.id, [...transactionIds]), eq(transactions.status, "active")))
      .all();
    const formerSeriesIds = new Set(
      rows
        .map((r) => r.recurringSeriesId)
        .filter((x): x is string => x !== null && x !== target),
    );

    const res = tx
      .update(transactions)
      .set({ recurringSeriesId: target, seriesLinkSource: "user" })
      .where(and(inArray(transactions.id, [...transactionIds]), eq(transactions.status, "active")))
      .run();
    attached = res.changes;

    recomputeSeriesStats(tx, target, today, ctx);
    for (const former of formerSeriesIds) recomputeSeriesStats(tx, former, today, ctx);
  });
  return attached;
}

/** Unlinks a transaction from its series (a user-owned decision). Returns the former series id. */
export function detachTransaction(
  db: AppDatabase,
  transactionId: string,
  today: string = todayIso(),
): string | null {
  const ctx = loadRecomputeCtx(db);
  let formerSeriesId: string | null = null;
  db.transaction((tx) => {
    const row = tx
      .select({ id: transactions.id, recurringSeriesId: transactions.recurringSeriesId })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get();
    if (!row) throw new Error(`Unknown transaction ${transactionId}`);
    formerSeriesId = row.recurringSeriesId;
    tx.update(transactions)
      .set({ recurringSeriesId: null, seriesLinkSource: "user" })
      .where(eq(transactions.id, transactionId))
      .run();
    if (formerSeriesId) recomputeSeriesStats(tx, formerSeriesId, today, ctx);
  });
  return formerSeriesId;
}

export interface MergeResult {
  relinked: number;
  targetId: string;
}

/**
 * Merges `sourceId` INTO `targetId`: the source's active occurrences relink to
 * the (live) target as user-owned links, the source becomes `ended` with
 * mergedIntoId=target, and the target's stats re-derive over the union. Detection
 * later forward-maps the source's identity to the target and never resurrects it.
 */
export function mergeSeries(
  db: AppDatabase,
  sourceId: string,
  targetId: string,
  today: string = todayIso(),
): MergeResult {
  if (sourceId === targetId) throw new Error("Cannot merge a series into itself");
  const ctx = loadRecomputeCtx(db);
  let relinked = 0;
  let finalTarget = targetId;
  db.transaction((tx) => {
    const rows = tx
      .select({
        id: recurringSeries.id,
        status: recurringSeries.status,
        mergedIntoId: recurringSeries.mergedIntoId,
      })
      .from(recurringSeries)
      .all();
    const mergedById = new Map(rows.map((s) => [s.id, s.mergedIntoId]));
    const statusById = new Map(rows.map((s) => [s.id, s.status]));
    if (!mergedById.has(sourceId)) throw new Error(`Unknown recurring series ${sourceId}`);
    if (!mergedById.has(targetId)) throw new Error(`Unknown recurring series ${targetId}`);
    // A source that was already merged has no live occurrences to move; merging
    // it again would overwrite its mergedIntoId and split its history from its
    // future charges (an irreversible split-brain). Reject it.
    if (mergedById.get(sourceId) !== null || statusById.get(sourceId) === "ended") {
      throw new Error("Series has already been merged");
    }
    // the target may itself have been merged onward — follow to the live one
    finalTarget = resolveMergeTarget(targetId, mergedById);
    if (finalTarget === sourceId) throw new Error("Cannot merge a series into itself");
    // The target must be LIVE. Relinking onto a dismissed/ended series would move
    // the source's charges to a series the forecast/calendar/upcoming views all
    // exclude (status IN detected|confirmed) — the money would silently vanish.
    const targetStatus = statusById.get(finalTarget);
    if (targetStatus !== "detected" && targetStatus !== "confirmed") {
      throw new Error("Cannot merge into an inactive series");
    }

    const res = tx
      .update(transactions)
      .set({ recurringSeriesId: finalTarget, seriesLinkSource: "user" })
      .where(and(eq(transactions.recurringSeriesId, sourceId), eq(transactions.status, "active")))
      .run();
    relinked = res.changes;

    tx.update(recurringSeries)
      .set({ status: "ended", mergedIntoId: finalTarget })
      .where(eq(recurringSeries.id, sourceId))
      .run();
    recomputeSeriesStats(tx, finalTarget, today, ctx);
  });
  return { relinked, targetId: finalTarget };
}
