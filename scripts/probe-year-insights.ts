/** READ-ONLY. What /summary/[year] would say, for every year the ledger holds. */
import { getDb } from "@/db/client";
import { yearInsights } from "@/services/year-insights";
import { summaryYears } from "@/services/year-summary";

const db = getDb();
for (const y of summaryYears(db).slice().sort()) {
  const r = yearInsights(db, y);
  if (!r) { console.log(`\n${y}: (withheld)`); continue; }
  console.log(`\n${y}  [${r.windowLabel}]`);
  if (r.windowNote) console.log(`   note: ${r.windowNote}`);
  for (const i of r.insights) {
    console.log(`   • ${i.text}`);
    console.log(`     ${i.provenance.verdict}${i.provenance.badgeWord ? ` "${i.provenance.badgeWord}"` : ""} — ${i.provenance.headline}`);
    for (const inp of i.provenance.inputs) console.log(`        · [${inp.verdict}] ${inp.label} — ${inp.detail}`);
  }
}
for (const y of [2019, 2027]) console.log(`\n${y}: ${yearInsights(db, y) ? "renders" : "(withheld)"}`);
