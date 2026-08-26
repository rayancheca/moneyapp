/** Read-only probe for the income card. Measures, writes nothing. */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { periodBounds } from "@/lib/dates";
import { cashEarningsReadings } from "@/services/cash-earnings";
import { incomeExpectation } from "@/services/budgets";
import { accountCoverage } from "@/services/coverage";
import { incomeByMonth } from "@/services/analytics";
import { SPEND_BASELINE_MONTHS } from "@/services/committed";

const db = getDb();
const TODAY = "2026-08-26";

console.log("── raw income by month (the TRAP: does this look like a collapse?)");
const cells = incomeByMonth(db, { months: 12, refDate: TODAY });
const byMonth = new Map<string, number>();
for (const c of cells) byMonth.set(c.month, (byMonth.get(c.month) ?? 0) + c.incomeCents);
for (const [m, c] of [...byMonth.entries()].sort()) console.log(`   ${m}  ${formatCents(c)}`);
console.log(`   months present: ${byMonth.size} of 12`);

console.log("\n── incomeBasis (what /budgets grades against — my headline must equal this)");
const month = periodBounds(TODAY, "monthly");
const exp = incomeExpectation(db, month.start, month.end, TODAY);
console.log(`   kind=${exp.basis.kind}  cents=${exp.basis.cents} (${formatCents(exp.basis.cents)})`);
console.log(`   posted this month=${formatCents(exp.postedCents)}  scheduled=${formatCents(exp.scheduledCents)} over ${exp.scheduledOccurrences} paydays`);
console.log(`   explanation: ${exp.basis.explanation}`);

console.log(`\n── cashEarningsReadings, window = ${SPEND_BASELINE_MONTHS} months back → today`);
const from = `${new Date(Date.UTC(2026, 7 - SPEND_BASELINE_MONTHS, 1)).toISOString().slice(0, 7)}-01`;
for (const w of [
  ["6 complete months + this one", from, TODAY],
  ["this month only", "2026-08-01", TODAY],
] as const) {
  console.log(`   [${w[0]}] ${w[1]} → ${w[2]}`);
  const rows = cashEarningsReadings(db, { from: w[1], to: w[2], today: TODAY });
  if (rows.length === 0) console.log("      (none)");
  for (const r of rows) {
    console.log(`      ${r.seriesName} [${r.basis}] implied ${formatCents(r.impliedCents)} over ${r.periodsCovered} periods · banked ${formatCents(r.bankedCents)} · gap ${formatCents(r.unbankedCents)}`);
    console.log(`         last banked ${r.lastBankedOn ?? "never"} · ${r.periodsSinceBanked} periods of silence`);
  }
}

console.log("\n── where attributed pay lands, and how current that account is");
const cov = accountCoverage(db, TODAY);
for (const c of cov.filter((a) => ["checking", "savings"].includes(a.accountType))) {
  console.log(`   ${c.accountName}: grade=${c.grade} verifiedThrough=${c.verifiedThrough} statementsThrough=${c.statementsThrough} daysSinceVerified=${c.daysSinceVerified}`);
}
