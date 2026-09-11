/** READ-ONLY: re-derive annualizedCents for every series, old vs new. */
import { getDb } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { formatCents } from "@/lib/money";
import { listSeries, annualizedCentsOf, toProjectable, projectOccurrences, effectiveSeries } from "@/services/recurring";
import { addCalendarMonths } from "@/lib/dates";

const db = getDb();
const TODAY = "2026-09-11";
const OPY: Record<string, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, annual: 1 };

const rows = db.select().from(recurringSeries).all();
const views = listSeries(db, TODAY);
console.log(`series in DB: ${rows.length}; views: ${views.length}`);
const horizon = addCalendarMonths(TODAY, 12);
console.log(`horizon: ${TODAY} .. ${horizon}`);

const byId = new Map(rows.map((r: any) => [r.id, r]));
let moved = 0;
const lines: string[] = [];
for (const v of views) {
  const r: any = byId.get(v.id)!;
  const eff = effectiveSeries(r);
  const old = eff.nextExpectedAmountCents === null ? null : Math.abs(eff.nextExpectedAmountCents) * OPY[eff.cadence]!;
  const now = v.annualizedCents;
  const occ = projectOccurrences(toProjectable(r), TODAY, horizon);
  const manual = eff.nextExpectedAmountCents === null ? null : occ.reduce((s, o) => s + Math.abs(o.amountCents), 0);
  if (now !== manual) lines.push(`!! ${v.name}: view ${now} vs manual ${manual}`);
  if (old !== now) {
    moved++;
    lines.push(
      `MOVED  ${v.name.padEnd(34)} status=${v.status.padEnd(9)} kind=${v.kind.padEnd(7)} cadence=${eff.cadence.padEnd(12)} ` +
      `endsOn=${String(r.userEndsOn ?? "—").padEnd(11)} nextOn=${String(eff.nextExpectedOn ?? "—")} amt=${eff.nextExpectedAmountCents} ` +
      `\n         old=${old === null ? "null" : formatCents(old)}  new=${now === null ? "null" : formatCents(now)}  occurrences=${occ.length}`
    );
  }
}
console.log(`\n${moved} of ${views.length} series moved`);
console.log(lines.join("\n"));

// zero / null distribution
const zeros = views.filter((v) => v.annualizedCents === 0);
const nulls = views.filter((v) => v.annualizedCents === null);
console.log(`\nannualized === 0 : ${zeros.length}  -> ${zeros.map((z) => `${z.name} [${z.status}]`).join(", ")}`);
console.log(`annualized null  : ${nulls.length}  -> ${nulls.map((z) => `${z.name} [${z.status}]`).join(", ")}`);
