/**
 * Read-only probe for `incomeCard`. Writes nothing.
 *
 * Prints the raw month-by-month income first — the shape that makes this card
 * look like a collapse — and then what the card actually publishes over it.
 */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { incomeByMonth } from "@/services/analytics";
import { incomeCard } from "@/services/income-card";

const db = getDb();
const TODAY = "2026-08-26";

console.log("── raw income by month (the shape the card must NOT report as a collapse)");
const byMonth = new Map<string, number>();
for (const c of incomeByMonth(db, { months: 12, refDate: TODAY })) {
  byMonth.set(c.month, (byMonth.get(c.month) ?? 0) + c.incomeCents);
}
for (const [m, c] of [...byMonth.entries()].sort()) console.log(`   ${m}  ${formatCents(c)}`);
console.log(`   2026-08 present in the ledger: ${byMonth.has("2026-08")}`);

const card = incomeCard(db, TODAY);
if (card === null) {
  console.log("\n── incomeCard: null (no confirmed income series with evidence)");
} else {
  console.log(`\n── incomeCard  window ${card.windowFrom} → ${card.today}`);
  console.log(`   HEADLINE  ${formatCents(card.monthlyRateCents)} a month`);
  console.log(`   SUMMARY   ${card.summary}`);
  for (const l of card.pay) {
    console.log(`\n   ${l.name}  [${l.basis}]`);
    console.log(`     implied ${formatCents(l.impliedCents)} over ${l.paydays} paydays`);
    console.log(`     banked  ${formatCents(l.bankedCents)}`);
    console.log(`     gap     ${formatCents(l.gapMagnitudeCents)} ${l.gapLabel}   (signed ${l.gapCents}, isNegZero=${Object.is(l.gapMagnitudeCents, -0)})`);
    console.log(`     last banked ${l.lastBankedOn ?? "never"} · silent ${l.silentPeriods} · of those checked ${l.checkedSilentPeriods}`);
    console.log(`     records checked through ${l.checkedThrough ?? "nothing"} · unread ${l.unreadDays ?? "n/a"} days`);
    console.log(`     VERDICT ${l.verdict}`);
  }
  console.log(`\n   TOTALS    implied ${formatCents(card.totals.impliedCents)} · banked ${formatCents(card.totals.bankedCents)} · ${formatCents(card.totals.gapMagnitudeCents)} ${card.totals.gapLabel}`);
  console.log(`   SHARE     ${card.bankedSharePct === null ? "null (withheld)" : `${card.bankedSharePct}%`}  finite=${Number.isFinite(card.bankedSharePct ?? 0)}`);
  console.log(`   POSTED    ${formatCents(card.postedThisMonthCents)} in ${card.postedMonth}`);
  console.log(`   NOTE      ${card.postedNote}`);
  console.log(`   CAVEAT    ${card.caveat}`);
}
