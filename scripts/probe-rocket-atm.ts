/** READ-ONLY. What does his export call the rows this ledger files as ATM withdrawals / cash? */
import fs from "node:fs";
import Papa from "papaparse";
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";

const EXPORT = process.env.ROCKET_CSV ?? "/Users/rayankarimcheca/Downloads/2026-08-25T18_34_42.633Z-transactions.csv";
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
  LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
  WHERE t.status='active'`) as Mine[];
const byKey = new Map<string, Mine[]>();
for (const m of mine) { const k = `${m.posted_on}|${m.amount_cents}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(m); }

const CASH = new Set(["Cash & ATM > ATM Withdrawals", "Cash & ATM"]);
const out = new Map<string, { unique: { t: Row; m: Mine }[]; ambig: number }>();
for (const t of theirs) {
  const hits = byKey.get(`${t.Date}|${-Math.round(Number(t.Amount) * 100)}`);
  if (!hits?.length) continue;
  if (!CASH.has(hits[0]!.cat)) continue;
  const their = t.Category || "(blank)";
  const e = out.get(their) ?? { unique: [] as { t: Row; m: Mine }[], ambig: 0 };
  if (hits.length === 1) e.unique.push({ t, m: hits[0]! }); else e.ambig++;
  out.set(their, e);
}
const total = db.all(sql`SELECT COUNT(*) n, COALESCE(SUM(ABS(amount_cents)),0) c FROM transactions t
  JOIN categories cc ON cc.id=t.category_id WHERE t.status='active' AND cc.name='ATM Withdrawals'`) as {n:number;c:number}[];
console.log(`ledger: ${total[0]!.n} rows in Cash & ATM > ATM Withdrawals, $${(total[0]!.c/100).toFixed(2)}\n`);
console.log("his export calls them            unique  ambig        $ (unique)");
console.log("─".repeat(66));
for (const [k, e] of [...out.entries()].sort((a, b) => b[1].unique.length - a[1].unique.length)) {
  const amt = e.unique.reduce((s, r) => s + Math.abs(r.m.amount_cents), 0) / 100;
  console.log(`${k.slice(0,30).padEnd(32)}${String(e.unique.length).padStart(5)}  ${String(e.ambig).padStart(5)}  ${("$"+amt.toFixed(2)).padStart(13)}`);
}
if (process.env.DETAIL) {
  const d = out.get(process.env.DETAIL);
  console.log(`\n--- ${process.env.DETAIL} (unique) ---`);
  for (const r of d?.unique ?? []) console.log(`  ${r.m.posted_on}  ${("$"+(Math.abs(r.m.amount_cents)/100).toFixed(2)).padStart(9)}  ${r.m.account.padEnd(16)} ${r.m.raw_description.slice(0,44)}`);
}
