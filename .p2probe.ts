import { createDatabase } from "@/db/client";
import { categoryMonthlyTrend } from "@/services/category-detail";
import { ledgerReaches } from "@/services/observation-frontier";
import { emptyTrendCopy } from "@/lib/empty-period";
import { sql } from "drizzle-orm";
const b = createDatabase("data/moneyapp.db");
const reaches = ledgerReaches(b.db);
const cats = b.db.all<{ id: string; name: string }>(sql`select id, name from categories where kind != 'system'`);
const months: string[] = [];
for (const y of [2023, 2024, 2025]) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2,"0")}-01`);
const end = (d: string) => { const [y,m] = d.split("-").map(Number); return `${y}-${String(m).padStart(2,"0")}-${new Date(Date.UTC(y!, m!, 0)).getUTCDate()}`; };
let pairs = 0; const sample: string[] = [];
for (const c of cats) for (const m of months) {
  const anchor = end(m);
  const t = categoryMonthlyTrend(b.db, c.id, 12, anchor, reaches);
  if (t.length && t.every((p) => p.spentCents === 0)) {
    pairs++;
    if (sample.length < 3) sample.push(`${c.name} ?period=${m.slice(0,7)} → heading "${t[0]!.month} to ${t[11]!.month}", sentence "${emptyTrendCopy(t)}"`);
  }
}
console.log(`${cats.length} categories × 36 past monthly periods = ${cats.length*36} pages; ${pairs} render an empty 12-month trend whose sentence says "the last 12 months"`);
for (const s of sample) console.log("  " + s);
b.sqlite.close();
