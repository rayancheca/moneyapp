/** READ-ONLY. Exercises the two new provenanceFor shapes against the real ledger. */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { provenanceFor, type Provenance } from "@/services/provenance";
import type { AssetType } from "@/db/schema/holdings";

const db = getDb();
const show = (title: string, p: Provenance | null): void => {
  console.log(`\n── ${title}`);
  if (!p) { console.log("   (no such figure)"); return; }
  console.log(`   verdict: ${p.verdict}   badge: ${p.badgeWord ?? "(default word)"}`);
  console.log(`   ${p.headline}`);
  for (const s of p.sources) console.log(`     · [${s.kind}] ${s.label}${s.detail ? ` — ${s.detail}` : ""}${s.on ? `  (${s.on})` : ""}`);
  for (const i of p.inputs) console.log(`     → ${i.label} ${i.verdict} ${i.detail ?? ""}`);
};

console.log("═══════════ HOLDINGS");
for (const h of db.all(sql.raw(`SELECT DISTINCT symbol, asset_type FROM holdings WHERE is_active=1 ORDER BY symbol`)) as { symbol: string; asset_type: AssetType }[]) {
  show(`HOLDING ${h.symbol}`, provenanceFor(db, { kind: "holding", symbol: h.symbol, assetType: h.asset_type }));
}
show("HOLDING — a closed position (PM)", provenanceFor(db, { kind: "holding", symbol: "PM", assetType: "stock" }));
show("HOLDING — a symbol never held", provenanceFor(db, { kind: "holding", symbol: "ZZZZ", assetType: "stock" }));

console.log("\n═══════════ RECURRING SERIES");
for (const s of db.all(sql.raw(`SELECT id, name FROM recurring_series WHERE status IN ('confirmed','detected') ORDER BY ABS(amount_cents_avg) DESC`)) as { id: string; name: string }[]) {
  show(`SERIES ${s.name}`, provenanceFor(db, { kind: "recurringSeries", id: s.id }));
}
