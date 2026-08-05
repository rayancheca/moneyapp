import { sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";

/**
 * A LEAF module, deliberately. This count is read by the root layout, which
 * renders on every route — and `duplicate-resolution.ts` imports the statement
 * importer, which reaches a 2.2 MB PDF parser. Keeping the query here means the
 * nav badge costs one COUNT, not a PDF library on every page.
 *
 * `duplicate-resolution.ts` re-exports `openDuplicateCount` from here so the
 * queue and the badge can never drift apart.
 */

/**
 * Hide an UNRESOLVED pair whose sides are no longer both in balance replay.
 *
 * One row can belong to several pairs: two identical charges in each of two
 * files produce four candidates, because the unique index is on the id pair, not
 * on `pair_key`. Retiring through one of them settles that candidate and leaves
 * its siblings pointing at a now-superseded row — an item the owner can never
 * answer, because every retire button on it throws (both sides must be in
 * replay) and the only working control, "Not a duplicate", would write a
 * dismissal under a content key shared by every identical pair that day, and so
 * suppress a future real detection.
 *
 * Deliberately scoped to `unresolved`. A RESOLVED pair must keep rendering even
 * though its retired side is out of replay — it is the only place a superseded
 * row is visible, and hiding it would turn a reversible retire into exactly the
 * silent delete this module exists to avoid.
 */
export const STILL_ASKABLE = sql`(
  d.resolution != 'unresolved'
  OR (
    (SELECT ta.status FROM transactions ta WHERE ta.id = d.transaction_id_a) IN ('active', 'excluded')
    AND (SELECT tb.status FROM transactions tb WHERE tb.id = d.transaction_id_b) IN ('active', 'excluded')
  )
)`;

/**
 * Unresolved pairs still worth asking about — drives the Duplicates tab badge
 * and the nav pill.
 *
 * Counts CANDIDATE PAIRS, not double-charged amounts: two identical charges in
 * each of two files yield four candidates. Label it "pairs" wherever it is
 * shown; "N possible duplicates" would overstate what the owner is looking at.
 */
export function openDuplicateCount(db: AppDatabase): number {
  return (
    db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n
        FROM duplicate_candidates d
       WHERE d.resolution = 'unresolved'
         AND d.transaction_id_a IS NOT NULL
         AND d.transaction_id_b IS NOT NULL
         AND ${STILL_ASKABLE}
    `)?.n ?? 0
  );
}
