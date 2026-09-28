/**
 * READ-ONLY. What every surface says about the owner's paydays, before and
 * after settle-backwards. Run against a COPY of the real ledger:
 *
 *   MONEYAPP_DB_PATH=/tmp/uc-sb/real.db pnpm exec tsx scripts/probe-settle-backwards.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { recurringSeries, transactions } from "@/db/schema";
import { periodBounds } from "@/lib/dates";
import { unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
import { unbankedIncomeForSeries, unbankedIncomeTotals } from "@/services/arrears";
import { incomeExpectation } from "@/services/budgets";
import { recurringCalendar } from "@/services/recurring-calendar";
import { incomeCard } from "@/services/income-card";
import { listAccounts } from "@/services/accounts";

const db = getDb();
const TODAY = process.env.PROBE_TODAY ?? "2026-09-28";
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

console.log(`### TODAY=${TODAY}`);

const income = db
  .select()
  .from(recurringSeries)
  .where(and(eq(recurringSeries.kind, "income"), inArray(recurringSeries.status, ["detected", "confirmed"])))
  .all();
console.log(`\n## live income series: ${income.length}`);
for (const s of income) {
  const linked = db
    .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.recurringSeriesId, s.id), eq(transactions.status, "active")))
    .all();
  console.log(
    `  ${s.id}  ${s.name}  ${s.cadence}  user=${s.userAmountCents}  avg=${s.amountCentsAvg}  tol=${s.toleranceDays}  linked=${linked.length}`,
  );
  for (const r of linked) console.log(`      ${r.postedOn}  ${money(r.amountCents)}`);
}

for (const month of ["2026-08", "2026-09"]) {
  const { start, end } = periodBounds(`${month}-01`, "monthly");
  console.log(`\n## ${month}  [${start} .. ${end}]`);

  const u = unbankedIncomeForSeries(db, new Set(income.map((s) => s.id)), start, TODAY);
  const t = unbankedIncomeTotals(u);
  console.log(`  unbankedIncomeTotals: ${t.occurrenceCount} paydays, ${money(t.totalCents)}, checked=${t.checkedOccurrenceCount}, frontier=${JSON.stringify(t.frontier)}`);
  for (const s of u.series) console.log(`      ${s.name}  x${s.occurrenceCount}  ${money(s.amountCents)}  first=${s.nextDate}  checkedThrough=${s.checkedThrough}`);

  const inc = incomeExpectation(db, start, end, TODAY);
  console.log(`  incomeExpectation: posted=${money(inc.postedCents)} expected=${money(inc.expectedCents)} scheduled=${money(inc.scheduledCents)} x${inc.scheduledOccurrences}`);
  console.log(
    `  /budgets sentence: "${inc.passedUnpaidOccurrences === 1 ? "1 payday" : `${inc.passedUnpaidOccurrences} paydays`} worth ${money(inc.passedUnpaidCents)} already passed this month${inc.passedUnpaidCheckedOccurrences > 0 ? " with no deposit against them" : ""}"`,
  );
  console.log(
    `  /budgets frontier clause: ${JSON.stringify(
      unbankedIncomeFrontierClause(
        {
          occurrenceCount: inc.passedUnpaidOccurrences,
          checkedOccurrenceCount: inc.passedUnpaidCheckedOccurrences,
          frontier: inc.passedUnpaidFrontier,
        },
        (d) => d,
      ),
    )}`,
  );

  const cal = recurringCalendar(db, month, TODAY);
  const marks: string[] = [];
  for (const [day, entries] of Object.entries(cal.entriesByDay)) {
    for (const e of entries) {
      if (e.kind !== "income") continue;
      marks.push(`      ${day}  ${e.name}  state=${e.state}  reason=${e.unsettledReason ?? "-"}  ${money(e.amountCents)}  txn=${e.transactionId ? "yes" : "no"}`);
    }
  }
  marks.sort();
  console.log(`  calendar income marks (missed=${cal.missedCount} unsettled=${cal.unsettledCount}):`);
  for (const m of marks) console.log(m);
}

const card = incomeCard(db, TODAY);
console.log(`\n## income card`);
console.log(`  summary: ${JSON.stringify(card?.summary ?? null)}`);
for (const p of card?.pay ?? []) {
  console.log(`  ${p.name}: verdict=${JSON.stringify(p.verdict)} banked=${money(p.bankedCents)} implied=${money(p.impliedCents)} ${p.paydaysLabel}`);
}
console.log(`  FULL: ${JSON.stringify(card, null, 1).slice(0, 4000)}`);

const accts = listAccounts(db);
let netCents = 0;
console.log(`\n## balances`);
for (const a of accts) {
  const cents = a.balance?.balanceCents ?? 0;
  netCents += a.isLiability ? -Math.abs(cents) : cents;
  console.log(`  ${a.name.padEnd(34)} ${money(cents).padStart(14)}  ${a.isLiability ? "(liab)" : ""}`);
}
console.log(`  NET (naive sum): ${money(netCents)}`);
