import { isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import type { BillingCarrier } from "@/lib/billed-with";
import { resolveMergeTarget } from "./recurring";

/**
 * ⚖️ Each series billed INSIDE another, and the carrier it is billed with (owner decision 2026-10-08, §6A 59) — keyed
 * by the CARRIED series' id. The one place the link column is read; `lib/billed-with` is what it means.
 *
 * The carrier is the LIVE series the link names, followed through any merge (`resolveMergeTarget`, detection's own
 * forward map). 🔴 It lent the named series' own `last_matched_on`, and a merge ends the source without touching it:
 * the rent merged into detection's series of the Wells Fargo rows kept posting under the target while the utilities
 * read the ended rent's Sep 2 — and 93 days on they lapsed out of the forecast, the committed book, the arrears and
 * the card's live figure, with nothing on screen to say why. His link stays as he wrote it; the READING follows the
 * merge. A carrier merged INTO the series it carries lends nothing: its postings are that series' own now.
 *
 * Two small queries rather than a self-join: `aliasedTable` breaks drizzle's row inference (see `seriesHues`), and on
 * a ledger with no link the second is never asked. The second reads every series, as detection's merge map does — a
 * merge chain can pass through any of them.
 */
export function billingCarriers(db: AppDatabase): ReadonlyMap<string, BillingCarrier> {
  const carried = db
    .select({ id: recurringSeries.id, carrierId: recurringSeries.userBilledWithSeriesId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userBilledWithSeriesId))
    .all();
  if (carried.length === 0) return new Map();
  const series = db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      lastMatchedOn: recurringSeries.lastMatchedOn,
      mergedIntoId: recurringSeries.mergedIntoId,
    })
    .from(recurringSeries)
    .all();
  const byId = new Map(series.map((s) => [s.id, s] as const));
  const mergedById = new Map(series.map((s) => [s.id, s.mergedIntoId] as const));
  const carriers: (readonly [string, BillingCarrier])[] = [];
  for (const c of carried) {
    const liveId = resolveMergeTarget(c.carrierId!, mergedById);
    if (liveId === c.id) continue;
    // the column REFERENCES the table and a merge names a series in it, so every carrier is there
    const { id, name, lastMatchedOn } = byId.get(liveId)!;
    carriers.push([c.id, { id, name, lastMatchedOn }]);
  }
  return new Map(carriers);
}

/**
 * The rows, each with the carrier it is billed with (`billedWith`, null when billed on its own) — how a series row
 * reaches an evidence reader (`seriesStaleness`, `seriesEvidence`, `hasStoppedForecasting`…), which REQUIRE it.
 */
export function withBillingCarriers<T extends { id: string }>(
  db: AppDatabase,
  rows: readonly T[],
): (T & { billedWith: BillingCarrier | null })[] {
  const carriers = billingCarriers(db);
  return rows.map((r) => ({ ...r, billedWith: carriers.get(r.id) ?? null }));
}
