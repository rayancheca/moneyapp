import type { AppDatabase } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { absorbIntoLiveSeries, loadRecomputeCtx, recomputeSeriesStats } from "./recurring";
import { linkFirstPostings } from "./recurring-first-posting";

/**
 * LINKING AT IMPORT — the rows an upload, a gap acceptance or an un-import makes
 * active are linked to the recurring series they belong to, in the same step.
 *
 * 🔴 Nothing on the import path wrote a series link, and every surface decides
 * "paid" from links alone: arrears (`overdueForSeries`), the calendar's posted
 * set, `recurringPostedCents` on /budgets, and `last_matched_on`. So a bill that
 * had just been imported read as a bill still owed until somebody pressed
 * Detect now or attached it by hand. The owner, 2026-09-14: *"im not attaching
 * shit by hand … no im not doing anything by hand"*.
 *
 * ⛔ SCOPED to the rows the operation itself inserted, promoted or restored —
 * his decision, 2026-09-14. An upload must not quietly re-link history nobody
 * has looked at; Detect now is the whole-ledger pass. So a caller passes the ids
 * it made active, and an empty set changes nothing.
 *
 * ⛔ The matching rule is `absorbIntoLiveSeries`, not a copy of it. A second rule
 * here would be a second answer to "is this charge that bill?", and the two
 * would drift.
 *
 * Then, over the SAME scope, `linkFirstPostings`: a commitment that has never
 * posted owns no description for absorption to match, so its first charge is
 * matched by exact amount and schedule instead, under the uniqueness fences its
 * own docstring lists.
 */

/** What linking at import wrote. */
export interface ImportLinkResult {
  /** rows linked because a live series already carries their exact description */
  absorbed: number;
  /** first charges of never-posted commitments, by exact amount and schedule */
  firstPostings: number;
}

/**
 * Links the rows an import-path operation made active. Only rows in
 * `candidateIds` may be claimed; which series owns what is read from the whole
 * ledger. Every series that grows has its stats settled in the same transaction.
 */
export function linkRowsMadeActive(
  db: AppDatabase,
  candidateIds: Iterable<string>,
  today: string = todayIso(),
): ImportLinkResult {
  const scope = new Set(candidateIds);
  if (scope.size === 0) return { absorbed: 0, firstPostings: 0 };
  const ctx = loadRecomputeCtx(db);
  return db.transaction((tx) => {
    const absorbed = absorbIntoLiveSeries(tx, today, ctx, scope);
    // AFTER absorption, in the same transaction: a row a series already owns by
    // description is never offered to a newcomer as its first posting
    const first = linkFirstPostings(tx, today, ctx, scope);
    return { absorbed: absorbed.tagged, firstPostings: first.tagged };
  });
}

/**
 * Re-settles the stored stats of series whose linked rows just LEFT the ledger.
 *
 * `recomputeSeriesStats` is the single settling point, and every write that
 * adds a link already calls it. A hard delete did not: un-importing a file
 * deleted linked rows and left `last_matched_on` naming a posting that no longer
 * exists — the failure `recomputeSeriesStats`' own comment describes for an
 * unlinked row ("the date simply stayed, describing a set that no longer
 * existed"). Linking at import makes that routine: import a statement, its bill
 * links, un-import it, and the series would go on reporting the deleted charge.
 */
export function settleSeriesStats(
  db: AppDatabase,
  seriesIds: Iterable<string>,
  today: string = todayIso(),
): void {
  const ids = new Set(seriesIds);
  if (ids.size === 0) return;
  const ctx = loadRecomputeCtx(db);
  db.transaction((tx) => {
    for (const id of ids) recomputeSeriesStats(tx, id, today, ctx);
  });
}
