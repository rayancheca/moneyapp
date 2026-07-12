import { and, count, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";

/** Active transactions awaiting review — drives the nav badge on Transactions. */
export function needsReviewCount(db: AppDatabase): number {
  return (
    db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.status, "active"), eq(transactions.needsReview, true)))
      .get()?.n ?? 0
  );
}

/**
 * Per-account count of active transactions awaiting review — drives the
 * per-account "unreviewed" dot on the accounts + dashboard cards (§7.2). Only
 * accounts with a non-zero backlog appear in the map.
 */
export function unreviewedByAccount(db: AppDatabase): Map<string, number> {
  const rows = db
    .select({ accountId: transactions.accountId, n: count() })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), eq(transactions.needsReview, true)))
    .groupBy(transactions.accountId)
    .all();
  return new Map(rows.map((r) => [r.accountId, r.n]));
}
