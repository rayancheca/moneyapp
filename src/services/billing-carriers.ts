import { inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import type { BillingCarrier } from "@/lib/billed-with";

/**
 * ⚖️ Each series billed INSIDE another, and the carrier it is billed with (owner decision 2026-10-08, §6A 59) — keyed
 * by the CARRIED series' id. The one place the link column is read; `lib/billed-with` is what it means.
 *
 * Two small queries rather than a self-join: `aliasedTable` breaks drizzle's row inference (see `seriesHues`), and on
 * a ledger with no link the second is never asked.
 */
export function billingCarriers(db: AppDatabase): ReadonlyMap<string, BillingCarrier> {
  const carried = db
    .select({ id: recurringSeries.id, carrierId: recurringSeries.userBilledWithSeriesId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userBilledWithSeriesId))
    .all();
  if (carried.length === 0) return new Map();
  const carriers = new Map(
    db
      .select({ id: recurringSeries.id, name: recurringSeries.name, lastMatchedOn: recurringSeries.lastMatchedOn })
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, [...new Set(carried.map((c) => c.carrierId!))]))
      .all()
      .map((c) => [c.id, c] as const),
  );
  // the column REFERENCES the table, so every carrier is there
  return new Map(carried.map((c) => [c.id, carriers.get(c.carrierId!)!] as const));
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
