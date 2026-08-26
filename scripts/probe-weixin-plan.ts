/** READ-ONLY. Shows the China-trip mapping in `weixin-plan.ts` with live row counts. */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { WEIXIN_PLAN as PLAN, WEIXIN_SCOPE } from "./weixin-plan";

const db = getDb();
const SCOPE = WEIXIN_SCOPE;
type Row = { id: string; amount_cents: number; raw_description: string; cat: string };
const rowsFor = (where: string): Row[] =>
  db.all(sql.raw(`SELECT t.id, t.amount_cents, t.raw_description,
      COALESCE(NULLIF(p.name,'')||' > ','')||COALESCE(c.name,'?') cat
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
    WHERE ${SCOPE} AND (${where})`)) as Row[];

console.log("target                       rows       $   moving from");
console.log("─".repeat(78));
const claimed = new Map<string, string>();
let total = 0, cents = 0;
for (const p of PLAN) {
  const rows = rowsFor(p.where).filter((r) => r.cat !== p.to);
  for (const r of rows) {
    if (claimed.has(r.id)) throw new Error(`row ${r.id} claimed twice: ${claimed.get(r.id)} and ${p.to}`);
    claimed.set(r.id, p.to);
  }
  const from = [...new Set(rows.map((r) => r.cat))].join(", ");
  const amt = rows.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  total += rows.length; cents += amt;
  console.log(`${p.to.padEnd(28)}${String(rows.length).padStart(4)} ${("$"+(amt/100).toFixed(2)).padStart(8)}   ${from}`);
}
console.log("─".repeat(78));
console.log(`${"TOTAL".padEnd(28)}${String(total).padStart(4)} ${("$"+(cents/100).toFixed(2)).padStart(8)}\n`);

// what his rule reclassifies OUT of the existing Travel bucket
const stillTravel = rowsFor(`1=1`).filter((r) => r.cat.startsWith("Travel") && !claimed.has(r.id));
console.log("staying in Travel (rail + Ctrip + unclear):");
const grp = new Map<string, number>();
for (const r of stillTravel) grp.set(r.raw_description.slice(0, 24), (grp.get(r.raw_description.slice(0, 24)) ?? 0) + 1);
for (const [d, n] of [...grp.entries()].sort()) console.log(`  ${String(n).padStart(2)}x ${d}`);

const leftInShopping = rowsFor(`1=1`).filter((r) => r.cat === "Shopping" && !claimed.has(r.id));
console.log(`\nleft in bare Shopping (his call — unidentifiable): ${leftInShopping.length} rows, $${(leftInShopping.reduce((s,r)=>s+Math.abs(r.amount_cents),0)/100).toFixed(2)}`);
const pc = rowsFor(`1=1`).filter((r) => r.cat === "Personal Care" && !claimed.has(r.id));
console.log(`left in Personal Care (ambiguous, not approved):    ${pc.length} rows — ${pc.map(r=>r.raw_description.slice(7,22)).join(", ")}`);
