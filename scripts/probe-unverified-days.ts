/** READ-ONLY. How often does the net-worth chart draw an unchecked total? */
import { getDb } from "@/db/client";
import { netWorthSeries } from "@/services/derivation";
const pts = netWorthSeries(getDb());
const flagged = pts.filter((p) => p.unverifiedAccounts.length > 0);
console.log(`days in series: ${pts.length}`);
console.log(`days with an unchecked account: ${flagged.length} (${((flagged.length / pts.length) * 100).toFixed(2)}%)`);
const byAcct = new Map<string, number>();
for (const p of flagged) for (const a of p.unverifiedAccounts) byAcct.set(a, (byAcct.get(a) ?? 0) + 1);
for (const [a, n] of [...byAcct].sort((x, y) => y[1] - x[1])) console.log(`   ${a}: ${n} days`);
console.log(`first: ${flagged[0]?.day}  last: ${flagged.at(-1)?.day}`);
console.log(`\nsanity — gapAccounts days: ${pts.filter((p) => p.gapAccounts.length > 0).length}`);

console.log("\n── gapAccounts on a sample of days");
for (const d of ["2024-01-15", "2025-06-15", "2026-07-15", "2026-08-25", pts.at(-1)!.day]) {
  const p = pts.find((x) => x.day === d);
  if (p) console.log(`  ${d}: gap=[${p.gapAccounts.join(", ")}] notYetOpen=[${p.notYetOpen.map((n:any)=>n.name).join(", ")}] covered=${p.coveredAccounts}/${p.totalAccounts}`);
}
