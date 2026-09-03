import { and, count, eq } from "drizzle-orm";
import { loadCategoryIndex, uncategorizedWhere } from "./analytics";
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
 * Active transactions with no category at all — the Uncategorized bucket.
 *
 * ⛔ A DIFFERENT QUESTION FROM `needsReviewCount`, and the dashboard once
 * answered one with the other. `ToReviewCard` printed "Nothing to review —
 * every transaction is categorized and confirmed" whenever the REVIEW FLAG
 * count was zero. Measured on the real ledger at today = 2026-09-01: 0 rows
 * flagged, and 9 active rows with no category — nine real purchases from early
 * August, sitting in the same Uncategorized bucket /spending prints one page
 * over. A flag count cannot know a category fact.
 */
export function uncategorizedCount(db: AppDatabase): number {
  return (
    db
      .select({ n: count() })
      .from(transactions)
      // NULL or filed on the system category — one predicate with the ledger's filter
      .where(and(eq(transactions.status, "active"), uncategorizedWhere(loadCategoryIndex(db))))
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
