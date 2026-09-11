/** READ-ONLY: does ?category=cashflow sum to the Net card, on many periods? */
import { and, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { categories } from "@/db/schema/categories";
import { resolvePeriod } from "@/lib/period";
import { formatCents } from "@/lib/money";
import { cashFlowByPeriod } from "@/services/spending";
import { filterConditions, viewCondition } from "@/services/transactions-query";

const db = getDb();
const TODAY = "2026-09-11";
const refs = db.select({ id: categories.id, parentId: categories.parentId, kind: categories.kind }).from(categories).all();

const shapes: any[] = [];
for (let y = 2022; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 9) break; shapes.push({ period: `${y}-${String(m).padStart(2, "0")}` }); }
for (let y = 2022; y <= 2026; y++) for (let q = 1; q <= 4; q++) shapes.push({ period: `${y}-Q${q}` });
for (let y = 2022; y <= 2026; y++) shapes.push({ period: `${y}` });
shapes.push({ period: "YTD" }, { period: "ALL" });
[["2026-01-15","2026-03-02"],["2025-06-01","2026-06-30"],["2026-07-05","2026-08-20"]].forEach(([f,t]) => shapes.push({ from: f, to: t }));

const bad: string[] = [];
let ok = 0;
for (const s of shapes) {
  const p = resolvePeriod(s, TODAY);
  const flow = cashFlowByPeriod(db, p, TODAY);
  const filters: any = { view: "all", account: null, category: "cashflow", merchant: null, from: p.from, to: p.to, q: null, amountMinCents: null, amountMaxCents: null, flow: null, page: 1 };
  const conds = [...filterConditions(filters, refs), viewCondition("all")];
  const r = db.select({ n: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${transactions.amountCents}),0)` }).from(transactions).where(and(...conds)).get()!;
  if (r.s !== flow.totals.netCents) bad.push(`${p.label.padEnd(24)} list ${formatCents(r.s)} (${r.n} rows) vs Net card ${formatCents(flow.totals.netCents)}  Δ ${formatCents(r.s - flow.totals.netCents)}`);
  else ok++;
}
console.log(`periods checked: ${shapes.length}; reconciled: ${ok}; MISMATCH: ${bad.length}`);
console.log(bad.slice(0, 25).join("\n"));
