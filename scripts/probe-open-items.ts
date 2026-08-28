/** READ-ONLY. The standing open-list items, measured rather than quoted. */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { formatCents } from "@/lib/money";

const db = getDb();

console.log("=== 1. the merchant map and his rent ===");
const flam = db.all(sql.raw(`
  SELECT m.id, m.canonical_name, COUNT(t.id) n, SUM(t.amount_cents) cents,
         MIN(t.posted_on) lo, MAX(t.posted_on) hi
  FROM merchants m LEFT JOIN transactions t ON t.merchant_id = m.id AND t.status='active'
  WHERE m.canonical_name LIKE '%lamingo%'
  GROUP BY m.id`)) as { id: string; canonical_name: string; n: number; cents: number; lo: string; hi: string }[];
for (const m of flam) {
  console.log(`  "${m.canonical_name}"  ${m.n} rows  ${formatCents(m.cents ?? 0)}  ${m.lo}..${m.hi}  id=${m.id}`);
  const sample = db.all(sql.raw(`SELECT posted_on, amount_cents, raw_description FROM transactions WHERE merchant_id='${m.id}' AND status='active' ORDER BY posted_on DESC LIMIT 3`)) as { posted_on: string; amount_cents: number; raw_description: string }[];
  for (const r of sample) console.log(`      ${r.posted_on}  ${formatCents(r.amount_cents).padStart(12)}  ${r.raw_description.slice(0, 52)}`);
}

console.log("\n=== 2. income ground truth ===");
const income = db.get(sql.raw(`
  SELECT SUM(t.amount_cents) v FROM transactions t
  JOIN categories c ON c.id=t.category_id
  LEFT JOIN categories p ON p.id=c.parent_id
  WHERE t.status='active' AND COALESCE(p.kind,c.kind)='income' AND t.amount_cents > 0`)) as { v: number };
console.log(`  measured income (positive rows, income-kind top level): ${formatCents(income.v)}`);

console.log("\n=== 2b. the two income definitions ===");
const net = db.get(sql.raw(`
  SELECT SUM(t.amount_cents) v, COUNT(*) n FROM transactions t
  JOIN categories c ON c.id=t.category_id
  LEFT JOIN categories p ON p.id=c.parent_id
  WHERE t.status='active' AND COALESCE(p.kind,c.kind)='income'`)) as { v: number; n: number };
console.log(`  NET  (every income-kind row, both signs): ${formatCents(net.v)} over ${net.n} rows`);
const negs = db.all(sql.raw(`
  SELECT t.posted_on, t.amount_cents, t.raw_description, c.name FROM transactions t
  JOIN categories c ON c.id=t.category_id
  LEFT JOIN categories p ON p.id=c.parent_id
  WHERE t.status='active' AND COALESCE(p.kind,c.kind)='income' AND t.amount_cents < 0`)) as { posted_on: string; amount_cents: number; raw_description: string; name: string }[];
console.log(`  the ${negs.length} NEGATIVE income row(s) that separate the two:`);
for (const r of negs) console.log(`      ${r.posted_on}  ${formatCents(r.amount_cents).padStart(11)}  ${r.name.padEnd(18)} ${r.raw_description.slice(0, 44)}`);

console.log("\n=== 3. the rent merchant's series and category ===");
const rows = db.all(sql.raw(`
  SELECT t.posted_on, c.name cat, rs.name series
  FROM transactions t
  LEFT JOIN categories c ON c.id=t.category_id
  LEFT JOIN recurring_series rs ON rs.id=t.recurring_series_id
  WHERE t.merchant_id='019f4cbe-6483-7b62-ae95-4097de5dc797' AND t.status='active'`)) as { posted_on: string; cat: string; series: string }[];
for (const r of rows) console.log(`      ${r.posted_on}  category=${r.cat ?? "-"}  series=${r.series ?? "-"}`);
const allRent = db.all(sql.raw(`
  SELECT m.canonical_name, COUNT(*) n FROM transactions t
  LEFT JOIN merchants m ON m.id=t.merchant_id
  WHERE t.status='active' AND t.amount_cents = -228570
  GROUP BY m.canonical_name ORDER BY n DESC`)) as { canonical_name: string; n: number }[];
console.log(`  every -$2,285.70 row, by merchant:`);
for (const r of allRent) console.log(`      ${String(r.n).padStart(3)} × ${r.canonical_name ?? "(unlinked)"}`);
