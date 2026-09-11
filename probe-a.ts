/** READ-ONLY probe: cash-flow ghost + cumulative across every period shape. */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { resolvePeriod, subBuckets } from "@/lib/period";
import { cashFlowByPeriod, spendingProjection } from "@/services/spending";
import { cashFlowCumulative } from "@/lib/cash-flow-cumulative";

const db = getDb();
const TODAY = "2026-09-11";

const params: { label: string; p: { period?: string | null; from?: string | null; to?: string | null } }[] = [];
for (let y = 2022; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 9) break;
    params.push({ label: `${y}-${String(m).padStart(2, "0")}`, p: { period: `${y}-${String(m).padStart(2, "0")}` } });
  }
}
for (let y = 2022; y <= 2026; y++) for (let q = 1; q <= 4; q++) params.push({ label: `${y}-Q${q}`, p: { period: `${y}-Q${q}` } });
for (let y = 2021; y <= 2026; y++) params.push({ label: `${y}`, p: { period: `${y}` } });
params.push({ label: "YTD", p: { period: "YTD" } });
params.push({ label: "ALL", p: { period: "ALL" } });
for (let d = 0; d < 40; d++) {
  const dt = new Date(Date.UTC(2026, 0, 5 + d * 7));
  const iso = dt.toISOString().slice(0, 10);
  params.push({ label: `W${iso}`, p: { period: `W${iso}` } });
}
["2026-09-10", "2026-08-01", "2026-02-28", "2025-12-31"].forEach((d) => params.push({ label: `day ${d}`, p: { period: d } }));
const customs: [string, string][] = [
  ["2026-01-01", "2026-01-10"],
  ["2026-01-15", "2026-03-02"],
  ["2025-06-01", "2026-06-30"],
  ["2026-02-01", "2026-02-28"],
  ["2026-07-05", "2026-08-20"],
  ["2024-01-01", "2024-12-31"],
  ["2026-03-01", "2026-05-31"],
  ["2026-08-30", "2026-09-11"],
];
customs.forEach(([f, t]) => params.push({ label: `custom ${f}..${t}`, p: { from: f, to: t } }));

let checked = 0;
let noGhost = 0;
const problems: string[] = [];

for (const { label, p } of params) {
  let period;
  try {
    period = resolvePeriod(p, TODAY);
  } catch (e) {
    problems.push(`${label}: resolvePeriod threw ${e}`);
    continue;
  }
  const flow = cashFlowByPeriod(db, period, TODAY);
  const proj = spendingProjection(db, period, TODAY, flow.pace ?? null, flow.totals.spentCents);
  const prior = proj.prior;
  if (!prior) { noGhost++; continue; }
  checked++;
  const bc = subBuckets(period).length;
  if (bc !== flow.buckets.length) problems.push(`${label}: subBuckets=${bc} but flow.buckets=${flow.buckets.length}`);
  const rows = cashFlowCumulative(flow.buckets, prior.aligned, prior.spentCents);
  const last = rows[rows.length - 1];
  if (!last) { problems.push(`${label}: no rows`); continue; }
  if (last.ghostCum === null) {
    problems.push(`${label}: GHOST NULL at last though prior exists (aligned.len=${prior.aligned.length} buckets=${flow.buckets.length})`);
  } else if (last.ghostCum !== prior.spentCents) {
    problems.push(`${label}: graph last ghost ${formatCents(last.ghostCum)} vs readout ${formatCents(prior.spentCents)}`);
  }
  if (last.netCum !== flow.totals.netCents) problems.push(`${label}: graph last net ${formatCents(last.netCum)} vs totals.net ${formatCents(flow.totals.netCents)}`);
  if (last.spentCum !== flow.totals.spentCents) problems.push(`${label}: spentCum ${last.spentCum} vs totals ${flow.totals.spentCents}`);
  if (last.earnedCum !== flow.totals.earnedCents) problems.push(`${label}: earnedCum ${last.earnedCum} vs totals ${flow.totals.earnedCents}`);
  if (last.refundsCum !== flow.totals.refundsCents) problems.push(`${label}: refundsCum ${last.refundsCum} vs totals ${flow.totals.refundsCents}`);
  let prev = 0;
  for (const r of rows) {
    if (r.ghostCum === null) continue;
    if (r.ghostCum < prev) problems.push(`${label}: ghostCum decreases at ${r.key}: ${prev} -> ${r.ghostCum}`);
    prev = r.ghostCum;
  }
}
console.log(`checked ${checked} periods with a ghost; ${noGhost} with none`);
console.log(problems.length === 0 ? "NO PROBLEMS" : problems.join("\n"));
