/** READ-ONLY. What widening the arrears lookback would do on the real ledger, today. */
import { getDb } from "@/db/client";
import { overdueForSeries } from "@/services/budgets";
import { runwayCard } from "@/services/committed";
import { recurringSeries, transactions } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { addDays, periodBounds } from "@/lib/dates";

const db = getDb();
const TODAY = process.env.PROBE_TODAY ?? "2026-09-02";

// the money-out series set the committed book uses
const rows = db.select().from(recurringSeries).where(inArray(recurringSeries.status, ["detected", "confirmed"])).all();
const moneyOut = new Set(rows.filter((r) => r.kind === "bill" || r.kind === "subscription").map((r) => r.id));
console.log(`TODAY=${TODAY}  money-out series: ${moneyOut.size} / ${rows.length}`);

const monthStart = periodBounds(TODAY, "monthly").start;
const scopes: [string, string][] = [
  ["calendar month (current)", monthStart],
  ["90 days back", addDays(TODAY, -90)],
  ["180 days back", addDays(TODAY, -180)],
  ["365 days back", addDays(TODAY, -365)],
];
for (const [label, start] of scopes) {
  const late = overdueForSeries(db, moneyOut, start, addDays(TODAY, -1), TODAY);
  console.log(`\n--- ${label}  [${start} .. ${addDays(TODAY, -1)}]  total=$${(late.totalCents / 100).toFixed(2)} over ${late.series.length} series`);
  for (const s of late.series) {
    console.log(`    ${s.name.padEnd(38)} $${(s.amountCents / 100).toFixed(2).padStart(10)}  x${s.occurrenceCount}  first ${s.nextDate}`);
  }
}

const card = runwayCard(db, TODAY);
console.log(`\nRUNWAY CARD today: committed=$${(card.committed.totalCents/100).toFixed(2)} perMonth=$${(card.committed.perMonthCents/100).toFixed(2)} overdue=$${(card.committed.overdueCents/100).toFixed(2)} overdueCount=${card.committed.overdueCount}`);
