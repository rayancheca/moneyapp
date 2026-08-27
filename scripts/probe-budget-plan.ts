/** READ-ONLY. What a plan-ranking would say, and whether its denominator is the page's. */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { budgetStatuses, totalBudgetedCents } from "@/services/budgets";
const db = getDb();
const TODAY = "2026-08-27";
const all = budgetStatuses(db, TODAY);
console.log(`budgets: ${all.length}`);
const byPeriod = new Map<string, typeof all>();
for (const s of all) byPeriod.set(s.budget.period, [...(byPeriod.get(s.budget.period) ?? []), s]);
for (const [p, list] of byPeriod) {
  const present = new Set(list.map((s) => s.budget.categoryId));
  const counted = list.filter((s) => !s.ancestorCategoryIds.some((id) => present.has(id)));
  const total = totalBudgetedCents(list);
  const sumCounted = counted.reduce((x, s) => x + s.budget.amountCents, 0);
  console.log(`\n${p}: ${list.length} budgets, ${counted.length} counted, total ${formatCents(total)} (sum of counted ${formatCents(sumCounted)} ${total === sumCounted ? "MATCH" : "MISMATCH"})`);
  for (const s of [...counted].sort((a, b) => b.budget.amountCents - a.budget.amountCents)) {
    console.log(`   ${formatCents(s.budget.amountCents).padStart(11)}  ${(s.budget.amountCents / total * 100).toFixed(1).padStart(5)}%  ${s.categoryPath}`);
  }
  const excluded = list.filter((s) => s.ancestorCategoryIds.some((id) => present.has(id)));
  for (const s of excluded) console.log(`   EXCLUDED  ${formatCents(s.budget.amountCents)}  ${s.categoryPath}`);
}
