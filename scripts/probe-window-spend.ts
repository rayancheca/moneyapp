/** READ-ONLY. What an all-spending-in-a-window figure would be, and where a YoY line lies. */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { formatCents } from "@/lib/money";
import { periodTotals } from "@/services/spending";
import { summaryYears } from "@/services/year-summary";
import { observationFrontier } from "@/services/observation-frontier";
import { accounts } from "@/db/schema/accounts";

const db = getDb();
const b = db.get(sql.raw(`SELECT MIN(posted_on) lo, MAX(posted_on) hi, COUNT(*) n FROM transactions WHERE status='active'`)) as { lo: string; hi: string; n: number };
console.log(`ledger: ${b.n} active rows, ${b.lo} → ${b.hi}`);

const names = new Map(db.select({ id: accounts.id, name: accounts.name, type: accounts.type }).from(accounts).all().map((a) => [a.id, a]));
const fr = observationFrontier(db);
console.log(`\nobservation frontier per ledger-bearing account:`);
const days: string[] = [];
for (const [id, day] of [...fr.byAccount].sort((x, y) => x[1].localeCompare(y[1]))) {
  days.push(day);
  console.log(`   ${day}  ${names.get(id)?.name ?? id} (${names.get(id)?.type})`);
}
console.log(`   → earliest frontier ${days[0]}, latest ${days[days.length - 1]}`);

// like-for-like: 2026 YTD vs the same calendar days of 2025, at several candidate cutoffs
const cutoffs = ["2026-08-24", days[0]!, "2026-08-27"];
console.log(`\nsame-days comparison 2025 vs 2026:`);
for (const cut of [...new Set(cutoffs)]) {
  const md = cut.slice(5);
  const cur = periodTotals(db, { from: "2026-01-01", to: cut });
  const prev = periodTotals(db, { from: "2025-01-01", to: `2025-${md}` });
  const d = cur.spentCents - prev.spentCents;
  console.log(`  through ${md}: 2025 ${formatCents(prev.spentCents).padStart(12)}  2026 ${formatCents(cur.spentCents).padStart(12)}  delta ${formatCents(d).padStart(12)} (${((d / prev.spentCents) * 100).toFixed(1)}%)`);
}

// how much of 2026's spend sits after the earliest frontier — the tail at risk
const tailFrom = days[0]!;
const tail = periodTotals(db, { from: tailFrom, to: "2026-08-24" });
console.log(`\nspend recorded between the earliest frontier (${tailFrom}) and 2026-08-24: ${formatCents(tail.spentCents)}`);
