/** READ-ONLY: how often the inclusive 12-month horizon inflates a live series by one payment. */
import { getDb } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { addCalendarMonths, addDays } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { listSeries, projectOccurrences, toProjectable, seriesHasLapsed, lapsedSeriesShouldStopForecasting } from "@/services/recurring";

const db = getDb();
const rows = db.select().from(recurringSeries).all();
const byId = new Map(rows.map((r: any) => [r.id, r]));

function liveBills(today: string) {
  return listSeries(db, today).filter((v) => {
    if (v.status !== "confirmed" && v.status !== "detected") return false;
    if (v.annualizedCents === null) return false;
    const row: any = byId.get(v.id);
    if (!row) return false;
    if (lapsedSeriesShouldStopForecasting(v.kind) && seriesHasLapsed(row, today)) return false;
    return v.kind !== "income";
  });
}

// a series is INFLATED on `today` when an occurrence lands exactly on the horizon end
let inflatedDays = 0;
const worst: string[] = [];
for (let i = 0; i < 365; i++) {
  const today = addDays("2026-09-11", i);
  const end = addCalendarMonths(today, 12);
  const hits: string[] = [];
  for (const v of liveBills(today)) {
    const row: any = byId.get(v.id)!;
    const occ = projectOccurrences(toProjectable(row), today, end);
    if (occ.some((o) => o.date === end)) hits.push(`${v.name} (${occ.length} payments, ${formatCents(v.annualizedCents!)})`);
  }
  if (hits.length) { inflatedDays++; if (worst.length < 8) worst.push(`${today}: ${hits.join(" · ")}`); }
}
console.log(`days in the next 365 where ≥1 LIVE commitment annualizes an extra payment: ${inflatedDays}`);
console.log(worst.join("\n"));

// rank + share on a day it fires
for (const today of ["2026-10-01", "2026-09-15"]) {
  const bills = liveBills(today);
  const total = bills.reduce((s, v) => s + v.annualizedCents!, 0);
  console.log(`\n--- ${today}: sideTotal ${formatCents(total)} over ${bills.length} commitments`);
  [...bills].sort((a, b) => b.annualizedCents! - a.annualizedCents!).slice(0, 5).forEach((v, i) =>
    console.log(`   ${i + 1}. ${v.name.padEnd(30)} ${formatCents(v.annualizedCents!).padStart(12)}  ${((v.annualizedCents! / total) * 100).toFixed(1)}%`));
}
