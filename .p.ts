import { getDb } from "@/db/client";
import { resolvePeriod, subBuckets } from "@/lib/period";
import { cashFlowByPeriod, spendingProjection } from "@/services/spending";
import { cashFlowCumulative } from "@/lib/cash-flow-cumulative";
const db = getDb();
const TODAY = "2026-09-11";
const shapes: {label:string;p:any}[] = [];
for (let y = 2023; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y===2026&&m>9) break; shapes.push({label:`${y}-${String(m).padStart(2,"0")}`,p:{period:`${y}-${String(m).padStart(2,"0")}`}}); }
for (let y = 2023; y <= 2026; y++) for (let q = 1; q <= 4; q++) shapes.push({label:`${y}-Q${q}`,p:{period:`${y}-Q${q}`}});
for (let y = 2023; y <= 2026; y++) shapes.push({label:`${y}`,p:{period:`${y}`}});
shapes.push({label:"YTD",p:{period:"YTD"}},{label:"ALL",p:{period:"ALL"}},{label:"W2026-08-31",p:{period:"W2026-08-31"}},{label:"day 2026-08-18",p:{period:"2026-08-18"}});
shapes.push({label:"custom 2026-07-25..2026-08-25",p:{from:"2026-07-25",to:"2026-08-25"}});
let noGhost = 0, withGhost = 0, lenMismatch = 0;
const bad: string[] = [];
for (const s of shapes) {
  const period = resolvePeriod(s.p, TODAY);
  const cf = cashFlowByPeriod(db, period, TODAY);
  const proj = spendingProjection(db, period, TODAY, cf.pace, cf.totals.spentCents);
  const nSub = subBuckets(period).length;
  const nBuckets = cf.buckets.length;
  if (nSub !== nBuckets) { lenMismatch++; bad.push(`${s.label}: subBuckets=${nSub} cashFlow.buckets=${nBuckets}`); }
  if (!proj.prior) continue;
  const rows = cashFlowCumulative(cf.buckets as any, proj.prior.aligned, proj.prior.spentCents);
  const anyGhost = rows.some((r) => r.ghostCum !== null);
  if (anyGhost) withGhost++; else { noGhost++; bad.push(`${s.label}: prior exists but ghostCum all null (aligned.len=${proj.prior.aligned.length}, buckets=${nBuckets})`); }
}
console.log("shapes:", shapes.length, "withGhost:", withGhost, "priorButNoGhost:", noGhost, "lenMismatch:", lenMismatch);
for (const b of bad.slice(0, 20)) console.log("  ", b);
