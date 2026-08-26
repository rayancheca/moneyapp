/** READ-ONLY. Exercises the categorySpend figure against the real ledger. */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { provenanceFor } from "@/services/provenance";

const db = getDb();
type Row = { id: string; name: string; n: number };
const cats = db.all(sql.raw(`
  SELECT c.id, c.name, COUNT(t.id) n FROM categories c
  LEFT JOIN transactions t ON t.category_id = c.id AND t.status='active'
  GROUP BY c.id HAVING n > 0 ORDER BY n DESC LIMIT 6`)) as Row[];

for (const c of [...cats, { id: cats[0]!.id, name: cats[0]!.name + " (empty window)", n: 0 }]) {
  const window = c.name.includes("empty") ? { from: "2019-01-01", to: "2019-12-31" } : { from: "2026-01-01", to: "2026-08-26" };
  const p = provenanceFor(db, { kind: "categorySpend", categoryId: c.id, ...window });
  if (!p) { console.log(`\n── ${c.name}: (no such category)`); continue; }
  console.log(`\n── ${c.name}  [${p.verdict}]${p.badgeWord ? `  badge: "${p.badgeWord}"` : ""}${p.checkedThrough ? ` · checked through ${p.checkedThrough}` : ""}`);
  console.log(`   ${p.headline}`);
  for (const s of p.sources) console.log(`     · ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
}
