/** READ-ONLY. Dump the ledger rows behind one (their → mine) disagreement pair. */
import fs from "node:fs";
import Papa from "papaparse";
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";

const EXPORT = process.env.ROCKET_CSV
  ?? "/Users/rayankarimcheca/Downloads/2026-08-25T18_34_42.633Z-transactions.csv";
const THEIR = process.env.THEIR ?? "Dining & Drinks";
const MINE = process.env.MINE ?? "Shopping";

type Row = Record<string, string>;
const theirs = Papa.parse<Row>(fs.readFileSync(EXPORT, "utf8"), { header: true, skipEmptyLines: true })
  .data.filter((r) => r.Date && r.Amount !== "");

const db = getDb();
type Mine = { id: string; posted_on: string; amount_cents: number; raw_description: string; cat: string; account: string; src: string | null };
const mine = db.all(sql`
  SELECT t.id, t.posted_on, t.amount_cents, t.raw_description,
         COALESCE(NULLIF(p.name,'')||' > ','')||COALESCE(c.name,'(none)') AS cat,
         a.name AS account, t.categorization_source AS src
  FROM transactions t JOIN accounts a ON a.id=t.account_id
  LEFT JOIN categories c ON c.id=t.category_id
  LEFT JOIN categories p ON p.id=c.parent_id
  WHERE t.status='active'
`) as Mine[];

const byKey = new Map<string, Mine[]>();
for (const m of mine) { const k = `${m.posted_on}|${m.amount_cents}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(m); }

const unique: { t: Row; m: Mine }[] = [];
const ambiguous: { t: Row; n: number }[] = [];
for (const t of theirs) {
  if ((t.Category || "(blank)") !== THEIR) continue;
  const hits = byKey.get(`${t.Date}|${-Math.round(Number(t.Amount) * 100)}`);
  if (!hits?.length) continue;
  if (hits[0]!.cat !== MINE) continue;
  if (hits.length === 1) unique.push({ t, m: hits[0]! });
  else ambiguous.push({ t, n: hits.length });
}

console.log(`${THEIR} → ${MINE}:  ${unique.length} unique, ${ambiguous.length} ambiguous\n`);
const byDesc = new Map<string, { n: number; cents: number; src: Set<string>; sample: string }>();
for (const { m } of unique) {
  const key = m.raw_description.replace(/\s+\d{2}\/\d{2}$/, "").slice(0, 44);
  const e = byDesc.get(key) ?? { n: 0, cents: 0, src: new Set<string>(), sample: m.raw_description };
  e.n++; e.cents += Math.abs(m.amount_cents); e.src.add(m.src ?? "null");
  byDesc.set(key, e);
}
console.log("ledger description (grouped)                   n        $   source");
console.log("─".repeat(80));
for (const [d, e] of [...byDesc.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${d.padEnd(46)}${String(e.n).padStart(3)} ${("$"+(e.cents/100).toFixed(2)).padStart(9)}   ${[...e.src].join(",")}`);
}
console.log(`\ntotal unique $${(unique.reduce((s,r)=>s+Math.abs(r.m.amount_cents),0)/100).toFixed(2)}`);
if (process.env.SHOW_AMBIG) {
  console.log("\nambiguous (skipped):");
  for (const a of ambiguous) console.log(`  ${a.t.Date}  ${String(a.t.Amount).padStart(9)}  ${a.n} candidates  ${a.t.Name}`);
}
