/** READ-ONLY. What proof badge each live series' insight strip would carry. */
import { getDb } from "@/db/client";
import { listSeries } from "@/services/recurring";
import { recurringInsights } from "@/services/recurring-insights";
import { provenanceFor } from "@/services/provenance";
const db = getDb();
const TODAY = "2026-08-27";
for (const s of listSeries(db, TODAY)) {
  if (!recurringInsights(db, s.id, TODAY)) continue;
  const p = provenanceFor(db, { kind: "recurringSeries", id: s.id });
  console.log(`${(p?.verdict ?? "NULL").padEnd(12)} ${(p?.sources ?? []).length} source(s)  ${s.name}`);
  for (const src of p?.sources ?? []) console.log(`             ${src.kind}: ${src.label}`);
}
