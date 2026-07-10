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
