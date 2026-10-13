import type { AppDatabase } from "@/db/client";
import { dailyBalances } from "@/db/schema/balances";
import { addDays, compareDates } from "@/lib/dates";

/**
 * TEST FIXTURE. An account's balance walk CHECKED through `to` — `derived` days from `from`, what `accountCoverage`
 * grades checked (`verifiedThrough`); days already walked keep what they hold.
 *
 * ⚖️ What a bill's due day is read against since his decision 62 (2026-10-12, review of 9940f1c): the day its "running
 * late" chip measures to (`dueDayReadings` over `silenceMeasuredThroughBySeries`) — so a fixture whose import has
 * "reached" a day reaches it on BOTH arbiters, rows and checked balances, or the ✕ never reads it.
 */
export function checkedThrough(db: AppDatabase, accountId: string, to: string, from = "2026-01-01"): void {
  for (let day = from; compareDates(day, to) <= 0; day = addDays(day, 1)) {
    db.insert(dailyBalances)
      .values({ accountId, day, balanceCents: 100_000, basis: "derived" })
      .onConflictDoNothing()
      .run();
  }
}
