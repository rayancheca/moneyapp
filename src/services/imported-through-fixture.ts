import { ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { transactions } from "@/db/schema/transactions";

/**
 * TEST FIXTURE. Every account the ledger holds — investment accounts aside, which bear no import frontier — imported
 * through `day`: one row that moves the frontier and nothing else (`movers-card.test.ts`'s idiom). An uncategorised
 * CREDIT is out of spending everywhere (`spendingBucket` hands the review queue positive category-less rows), so it
 * proves the ledger was shown the account on that day without adding a cent of spend to it.
 *
 * ⚖️ Since his decision 71 (2026-10-13) the window every dashboard card quotes uses only months every account he spends
 * from has been read through to the END of (`baselineWindow` over `spendingCoverageThrough`). A fixture whose newest row
 * is Jul 2 has read July for two days, and its "6 complete months" slide back a month. A test about something else — a
 * floor, a netting, a route — reads the window it means once its accounts are read into the running month: date `day`
 * there, inside no window.
 */
export function importedThrough(db: AppDatabase, day: string): void {
  const ids = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(ne(accounts.type, "investment"))
    .all()
    .map((a) => a.id);
  for (const accountId of ids) {
    const rawDescription = `IMPORTED THROUGH ${day}`;
    db.insert(transactions)
      .values({
        accountId,
        postedOn: day,
        amountCents: 1,
        rawDescription,
        normalizedDescription: rawDescription,
        categoryId: null,
        dedupeHash: `imported-through-${accountId}-${day}`,
      })
      .onConflictDoNothing()
      .run();
  }
}
