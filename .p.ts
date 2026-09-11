import { and, inArray, sql } from "drizzle-orm";
import { createDatabase } from "@/db/client";
import { countMatching, matchingTransactionIds } from "@/services/transactions-query";
import { transactions } from "@/db/schema/transactions";
import { cashFlowByPeriod } from "@/services/spending";
import { resolvePeriod } from "@/lib/period";
import type { TxnFilters } from "@/components/transactions/query";

const f = (o: Partial<TxnFilters>): TxnFilters => ({
  view: "all", account: null, category: null, merchant: null,
  from: "2026-01-01", to: "2026-12-31", q: null,
  amountMinCents: null, amountMaxCents: null, flow: null, page: 1, ...o,
});
const b = createDatabase("data/moneyapp.db");
for (const cat of [null, "cashflow", "spending", "income"]) {
  const ff = f({ category: cat });
  const n = countMatching(b.db, ff, "all");
  const ids = matchingTransactionIds(b.db, ff, "all");
  let sum = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    sum += b.db.select({ s: sql<number>`coalesce(sum(${transactions.amountCents}),0)` }).from(transactions).where(inArray(transactions.id, chunk)).get()!.s;
  }
  console.log(`category=${cat ?? "(none)"}: ${n} rows, sum $${(sum/100).toFixed(2)}`);
}
const flow = cashFlowByPeriod(b.db, resolvePeriod({ period: "2026" }, "2026-09-11"), "2026-09-11");
console.log(`\n/spending?period=2026 Net card: $${(flow.totals.netCents/100).toFixed(2)}  earned ${flow.totals.incomeCents/100} spent ${flow.totals.spentCents/100} refunds ${flow.totals.refundsCents/100}`);
b.sqlite.close();
