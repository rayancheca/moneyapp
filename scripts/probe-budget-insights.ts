/** READ-ONLY. What /budgets would say, on the real ledger. */
import { getDb } from "@/db/client";
import { budgetInsights } from "@/services/budget-insights";
const r = budgetInsights(getDb(), "2026-08-27");
if (!r) console.log("(withheld)");
else {
  console.log(`[${r.windowLabel}]\n   note: ${r.windowNote}`);
  for (const i of r.insights) {
    console.log(`   · ${i.text}`);
    console.log(`     ${i.provenance.verdict} "${i.provenance.badgeWord}" — ${i.provenance.headline}`);
  }
}
