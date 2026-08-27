/** READ-ONLY. The two new figure kinds against the real ledger, with their cost. */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { provenanceFor } from "@/services/provenance";
import { budgetStatuses } from "@/services/budgets";
import { periodTotals } from "@/services/spending";

const db = getDb();
const TODAY = "2026-08-27";

const show = (title: string, p: ReturnType<typeof provenanceFor>) => {
  if (!p) return console.log(`\n── ${title}: (no such figure)`);
  console.log(`\n── ${title}  [${p.verdict}]${p.badgeWord ? `  badge: "${p.badgeWord}"` : ""}${p.checkedThrough ? ` · checked through ${p.checkedThrough}` : ""}`);
  console.log(`   ${p.headline}`);
  for (const s of p.sources) console.log(`     · ${s.label}${s.detail ? ` — ${s.detail}` : ""}${s.on ? `  (${s.on})` : ""}`);
};

for (const w of [
  { label: "Aug 2026", from: "2026-08-01", to: "2026-08-31" },
  { label: "2026 so far", from: "2026-01-01", to: "2026-08-24" },
  { label: "the whole ledger", from: "2022-01-01", to: "2026-12-31" },
]) {
  const t0 = performance.now();
  const p = provenanceFor(db, { kind: "allSpend", from: w.from, to: w.to, label: w.label });
  const ms = performance.now() - t0;
  show(`allSpend ${w.label} — ${formatCents(periodTotals(db, { from: w.from, to: w.to }).spentCents)}  [${ms.toFixed(0)}ms]`, p);
}

console.log(`\n\n═══ budgetPlan ═══`);
const statuses = budgetStatuses(db, TODAY).filter((s) => s.budget.period === "monthly");
const t1 = performance.now();
for (const s of [...statuses].sort((a, b) => b.budget.amountCents - a.budget.amountCents).slice(0, 3)) {
  show(`${s.categoryPath} — plan ${formatCents(s.budget.amountCents)}`, provenanceFor(db, { kind: "budgetPlan", id: s.budget.id, label: s.categoryPath }));
}
const all = performance.now();
for (const s of statuses) provenanceFor(db, { kind: "budgetPlan", id: s.budget.id, label: s.categoryPath });
console.log(`\n   3 shown in ${(all - t1).toFixed(0)}ms · all ${statuses.length} monthly plans in ${(performance.now() - all).toFixed(0)}ms`);
