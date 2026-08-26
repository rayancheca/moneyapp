/** READ-ONLY. What the Subscriptions card will actually display. */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { subscriptionsCard } from "@/services/subscriptions-card";

const TODAY = process.argv[2] ?? "2026-08-26";
const c = subscriptionsCard(getDb(), TODAY);
if (c === null) {
  console.log("subscriptionsCard() → null (no money-out recurring series)");
  process.exit(0);
}

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
console.log(`today ${c.today}   window ${c.fromMonth} → ${c.toMonth} (${c.months} complete months)`);
console.log(`HEADLINE  ${formatCents(c.liveMonthlyCents)} a month, still forecast, across ${c.live.length} series`);
console.log(`          of which never billed: ${formatCents(c.neverBilledMonthlyCents)} (${pct(c.neverBilledSharePct)} of it)`);
console.log(`LAPSED    ${formatCents(c.lapsedMonthlyCents)} a month across ${c.lapsed.length} series = ${pct(c.lapsedSharePct)} of everything registered`);
console.log(`          largest lapsed: ${c.largestLapsed?.name ?? "—"} (${formatCents(c.largestLapsed?.monthlyCents ?? 0)}, last seen ${c.largestLapsed?.lastMatchedOn ?? "never"})`);
console.log(`POSTED    ${formatCents(c.postedCents)} across ${c.postedCount} charges in the window (refunds netted)`);
console.log(`UNFORECASTABLE  ${c.unforecastableCount}`);

const row = (l: (typeof c.live)[number]) =>
  `  ${l.name.padEnd(38).slice(0, 38)} ${formatCents(l.monthlyCents).padStart(11)}/mo  ${l.cadence.padEnd(10)} last=${(l.lastMatchedOn ?? "never").padEnd(11)} ${l.daysPastTolerance === null ? "" : `+${l.daysPastTolerance}d past tolerance`.padEnd(26)} posted=${formatCents(l.postedCents).padStart(10)}×${l.postedCount}${l.neverBilled ? "  NEVER BILLED" : ""}`;

console.log("\nSTILL FORECAST");
for (const l of c.live) console.log(row(l));
console.log("\nSTOPPED BEING FORECAST");
for (const l of c.lapsed) console.log(row(l));
