/** READ-ONLY: annualizedCentsOf horizon boundary + rank/share + committedBook agreement. */
import { getDb } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { addCalendarMonths } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { annualizedCentsOf, listSeries, projectOccurrences, toProjectable, seriesHasLapsed, lapsedSeriesShouldStopForecasting } from "@/services/recurring";
import { committedBook } from "@/services/committed";

const db = getDb();
const TODAY = "2026-09-11";
const HORIZON = addCalendarMonths(TODAY, 12);

// 1. boundary: a monthly open-ended series anchored on TODAY's day-of-month
const mk = (over: any) => ({
  id: "x", name: "x", kind: "bill" as const, cadence: "monthly" as const,
  intervalDaysAvg: null, nextExpectedOn: "2026-09-11", nextExpectedAmountCents: -10000,
  anchorDay: 11, userEndsOn: null, ...over,
});
for (const [lbl, s] of [
  ["monthly anchored on TODAY (the 11th)", mk({})],
  ["monthly anchored on the 12th", mk({ nextExpectedOn: "2026-09-12", anchorDay: 12 })],
  ["monthly anchored on the 10th", mk({ nextExpectedOn: "2026-09-10", anchorDay: 10 })],
  ["weekly from today", mk({ cadence: "weekly", nextExpectedOn: "2026-09-11", anchorDay: null })],
  ["annual from today", mk({ cadence: "annual", nextExpectedOn: "2026-09-11", anchorDay: null })],
  ["annual from 2026-09-12", mk({ cadence: "annual", nextExpectedOn: "2026-09-12", anchorDay: null })],
  ["quarterly from today", mk({ cadence: "quarterly", nextExpectedOn: "2026-09-11", anchorDay: null })],
  ["biweekly from today", mk({ cadence: "biweekly", nextExpectedOn: "2026-09-11", anchorDay: null })],
  ["semimonthly from today", mk({ cadence: "semimonthly", nextExpectedOn: "2026-09-11", anchorDay: null })],
] as [string, any][]) {
  const occ = projectOccurrences(s, TODAY, HORIZON);
  const ann = annualizedCentsOf(s, TODAY);
  console.log(`${lbl.padEnd(40)} occ=${String(occ.length).padStart(3)} annualized=${formatCents(ann ?? 0)}  first=${occ[0]?.date ?? "-"} last=${occ[occ.length-1]?.date ?? "-"}`);
}

// 2. rank + share, re-derived
const rows = db.select().from(recurringSeries).all();
const byId = new Map(rows.map((r: any) => [r.id, r]));
const views = listSeries(db, TODAY);
const live = views.filter((v) => {
  if (v.status !== "confirmed" && v.status !== "detected") return false;
  if (v.annualizedCents === null) return false;
  const row: any = byId.get(v.id);
  if (!row) return false;
  return !(lapsedSeriesShouldStopForecasting(v.kind) && seriesHasLapsed(row, TODAY));
});
const bills = live.filter((v) => v.kind !== "income");
const income = live.filter((v) => v.kind === "income");
const billTotal = bills.reduce((s, v) => s + v.annualizedCents!, 0);
console.log(`\nlive=${live.length}  bills=${bills.length}  income=${income.length}  billTotal=${formatCents(billTotal)}`);
const ranked = [...bills].sort((a, b) => b.annualizedCents! - a.annualizedCents! || a.name.localeCompare(b.name));
ranked.forEach((v, i) => console.log(`  ${String(i + 1).padStart(2)}. ${v.name.padEnd(32)} ${formatCents(v.annualizedCents!).padStart(12)}  ${((v.annualizedCents! / billTotal) * 100).toFixed(1)}%`));

// 3. committedBook agreement
const book = committedBook(db, TODAY, 12);
console.log(`\ncommittedBook(12mo): monthlyCents=${formatCents((book as any).monthlyCents ?? 0)}`);
const lines: any[] = (book as any).lines ?? [];
for (const l of lines) {
  const v = views.find((x) => x.id === l.seriesId);
  const ann = v?.annualizedCents ?? null;
  const twelve = (l.totalCents ?? l.horizonCents ?? null);
  console.log(`  ${String(l.name).padEnd(32)} book12=${twelve === null ? "?" : formatCents(Math.abs(twelve))}  annualized=${ann === null ? "null" : formatCents(ann)}  ${twelve !== null && ann !== null && Math.abs(twelve) !== ann ? "  <-- DIFFERS" : ""}`);
}
