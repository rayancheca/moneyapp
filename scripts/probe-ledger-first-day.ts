/** READ-ONLY. Does `ledgerFirstDay`'s wider status set change which years get a line? */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { ledgerFirstDay } from "@/services/spending";
import { yearInsights } from "@/services/year-insights";

const db = getDb();
console.log(`ledgerFirstDay (active+quarantined+excluded): ${ledgerFirstDay(db)}`);
const rows = db.all(sql.raw(`SELECT status, MIN(posted_on) lo, COUNT(*) n FROM transactions GROUP BY status ORDER BY lo`)) as { status: string; lo: string; n: number }[];
for (const r of rows) console.log(`   ${r.status.padEnd(12)} ${r.n.toString().padStart(6)} rows, earliest ${r.lo}`);
for (const y of [2023, 2024, 2025, 2026]) console.log(`${y}: ${yearInsights(db, y) ? "renders" : "(withheld)"}`);
