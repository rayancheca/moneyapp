/** READ-ONLY: does the table's ghost cell name the same DAY / MONTH as its row? */
import { getDb } from "@/db/client";
import { resolvePeriod, stepPeriodParams, subBuckets } from "@/lib/period";
import { cashFlowByPeriod, spendingProjection } from "@/services/spending";

const db = getDb();
const TODAY = "2026-09-11";

const shapes: { label: string; p: any }[] = [];
for (let y = 2023; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y===2026&&m>9) break; shapes.push({label:`${y}-${String(m).padStart(2,"0")}`, p:{period:`${y}-${String(m).padStart(2,"0")}`}}); }
for (let y = 2023; y <= 2026; y++) for (let q = 1; q <= 4; q++) shapes.push({label:`${y}-Q${q}`,p:{period:`${y}-Q${q}`}});
for (let y = 2023; y <= 2026; y++) shapes.push({label:`${y}`,p:{period:`${y}`}});
shapes.push({label:"YTD",p:{period:"YTD"}});
shapes.push({label:"ALL",p:{period:"ALL"}});
shapes.push({label:"custom 2025-06-01..2026-06-30",p:{from:"2025-06-01",to:"2026-06-30"}});
shapes.push({label:"custom 2026-01-15..2026-03-02",p:{from:"2026-01-15",to:"2026-03-02"}});

const mism: string[] = [];
let cells = 0, dayCells = 0, monthCells = 0;
for (const { label, p } of shapes) {
  const period = resolvePeriod(p, TODAY);
  const flow = cashFlowByPeriod(db, period, TODAY);
  const proj = spendingProjection(db, period, TODAY, flow.pace ?? null, flow.totals.spentCents);
  if (!proj.prior) continue;
  const prevPeriod = resolvePeriod(stepPeriodParams(period, -1), TODAY);
  const prevBuckets = subBuckets(prevPeriod);
  const curBuckets = subBuckets(period);
  const byMonth = curBuckets[0]!.key.length === 7;
  let bad = 0; const examples: string[] = [];
  for (let i = 0; i < curBuckets.length; i++) {
    const cur = curBuckets[i]!, prev = prevBuckets[i];
    if (!prev) continue; // renders "—"
    if (proj.prior.aligned[i] === null) continue;
    cells++;
    if (byMonth) {
      monthCells++;
      const curM = cur.key.slice(5,7), prevM = prev.key.slice(5,7);
      if (curM !== prevM) { bad++; if (examples.length<2) examples.push(`row "${cur.label}" (${cur.key}) shows ${prev.key} ($${((proj.prior.aligned[i] as number)/100).toFixed(2)})`); }
    } else {
      dayCells++;
      const curD = cur.from.slice(8), prevD = prev.from.slice(8);
      if (curD !== prevD) { bad++; if (examples.length<2) examples.push(`row "${cur.label}" (${cur.from}) shows ${prev.from} ($${((proj.prior.aligned[i] as number)/100).toFixed(2)})`); }
    }
  }
  if (bad) mism.push(`${label} [${byMonth?"month":"day"} buckets, prior=${prevPeriod.label}]: ${bad} cells off — ${examples.join(" ; ")}`);
}
console.log(`cells compared: ${cells} (day ${dayCells}, month ${monthCells})`);
console.log(mism.length ? mism.join("\n") : "ALL CELLS NAME THEIR OWN DAY/MONTH");
