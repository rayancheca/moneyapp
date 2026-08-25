/**
 * READ-ONLY probe. Rebuilds the (date, amount) match between the Rocket Money
 * export and this ledger, and reports the disagreement pairs.
 *
 * The export is sign-inverted relative to this ledger: positive = money out.
 */
import fs from "node:fs";
import Papa from "papaparse";
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";

const EXPORT = process.env.ROCKET_CSV
  ?? "/Users/rayankarimcheca/Downloads/2026-08-25T18_34_42.633Z-transactions.csv";

type Row = Record<string, string>;
const parsed = Papa.parse<Row>(fs.readFileSync(EXPORT, "utf8"), {
  header: true,
  skipEmptyLines: true,
});
const theirs = parsed.data.filter((r) => r.Date && r.Amount !== undefined && r.Amount !== "");
console.log(`export rows: ${theirs.length}  (parse errors: ${parsed.errors.length})`);

const db = getDb();
type Mine = {
  id: string;
  posted_on: string;
  amount_cents: number;
  raw_description: string;
  cat: string;
  account: string;
  needs_review: number;
};
const mine = db.all(sql`
  SELECT t.id, t.posted_on, t.amount_cents, t.raw_description,
         COALESCE(NULLIF(p.name,'')||' > ','')||COALESCE(c.name,'(none)') AS cat,
         a.name AS account, t.needs_review
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories p ON p.id = c.parent_id
  WHERE t.status = 'active'
`) as Mine[];
console.log(`ledger active rows: ${mine.length}\n`);

// index by (day, amount_cents)
const byKey = new Map<string, Mine[]>();
for (const m of mine) {
  const k = `${m.posted_on}|${m.amount_cents}`;
  (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(m);
}

type Pair = { their: string; mine: string; rows: { t: Row; m: Mine }[]; ambiguous: number };
const pairs = new Map<string, Pair>();
let matched = 0;
let unmatched = 0;
let ambiguousTotal = 0;

for (const t of theirs) {
  const cents = -Math.round(Number(t.Amount) * 100);
  const k = `${t.Date}|${cents}`;
  const hits = byKey.get(k);
  if (!hits || hits.length === 0) { unmatched++; continue; }
  matched++;
  const their = t.Category || "(blank)";
  const m = hits[0]!;
  const pk = `${their}→${m.cat}`;
  const p = pairs.get(pk) ?? { their, mine: m.cat, rows: [], ambiguous: 0 };
  if (hits.length === 1) p.rows.push({ t, m });
  else { p.ambiguous++; ambiguousTotal++; }
  pairs.set(pk, p);
}

console.log(`matched ${matched} of ${theirs.length} (${((matched / theirs.length) * 100).toFixed(1)}%)`);
console.log(`unmatched ${unmatched} · ambiguous (>1 ledger row on same day+amount) ${ambiguousTotal}\n`);

const sorted = [...pairs.values()]
  .filter((p) => p.their !== p.mine)
  .sort((a, b) => (b.rows.length + b.ambiguous) - (a.rows.length + a.ambiguous));

console.log("their category → my category           unique  ambig     $ (unique)");
console.log("─".repeat(78));
for (const p of sorted.slice(0, 40)) {
  const amt = p.rows.reduce((s, r) => s + Math.abs(r.m.amount_cents), 0) / 100;
  console.log(
    `${(p.their + " → " + p.mine).slice(0, 46).padEnd(46)}` +
    `${String(p.rows.length).padStart(5)}  ${String(p.ambiguous).padStart(5)}  ` +
    `${("$" + amt.toFixed(2)).padStart(12)}`,
  );
}
