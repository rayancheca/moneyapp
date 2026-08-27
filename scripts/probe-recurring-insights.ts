/** READ-ONLY. What recurringInsights says about every live series on the real ledger. */
import { getDb } from "@/db/client";
import { listSeries } from "@/services/recurring";
import { recurringInsights } from "@/services/recurring-insights";
const db = getDb();
const TODAY = "2026-08-27";
let withStrip = 0, without = 0;
for (const s of listSeries(db, TODAY)) {
  const r = recurringInsights(db, s.id, TODAY);
  if (!r) { without++; continue; }
  withStrip++;
  console.log(`\n${s.name}  [${s.status}/${s.kind}]`);
  console.log(`  window: ${r.windowLabel}`);
  console.log(`  note  : ${r.windowNote ?? "—"}`);
  for (const i of r.insights) console.log(`  · ${i.text}`);
}
console.log(`\n\n${withStrip} series with a strip, ${without} without.`);
