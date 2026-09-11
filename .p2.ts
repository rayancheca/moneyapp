import { getDb } from "@/db/client";
import { cashFlowByPeriod, spendingProjection } from "@/services/spending";
import { resolvePeriod } from "@/lib/period";
import { cashFlowCumulative } from "@/lib/cash-flow-cumulative";
import { stepPeriodParams } from "@/lib/period";
import { subBuckets } from "@/lib/period";

// the DELETED pre-diff resample, restored verbatim from 3fe32fc^
function reindexByPosition(values: readonly number[], targetLength: number): number[] {
  if (targetLength <= 0 || values.length === 0) return [];
  if (targetLength === 1) return [values[values.length - 1]!];
  const lastSrc = values.length - 1;
  const out: number[] = [];
  for (let i = 0; i < targetLength; i++) {
    const srcIdx = lastSrc === 0 ? 0 : Math.round((i / (targetLength - 1)) * lastSrc);
    out.push(values[srcIdx]!);
  }
  return out;
}

const db = getDb();
const today = "2026-09-11";
const probes = ["2023-06", "2022-09", "2023-04", "2026-09", "2024-02"];
for (const p of probes) {
  const period = resolvePeriod({ period: p } as never, today);
  const cf = cashFlowByPeriod(db, period, today);
  const proj = spendingProjection(db, period, today, cf.pace, cf.totals.spentCents);
  const prior = proj.prior!;
  const prevPeriod = resolvePeriod(stepPeriodParams(period, -1), today);
  const prevFlow = cashFlowByPeriod(db, prevPeriod, today);
  const priorDaily = prevFlow.buckets.map((b) => b.spendingCents);
  const bucketCount = subBuckets(period).length;
  const oldGhost = reindexByPosition(priorDaily, bucketCount);
  const oldLast = oldGhost.reduce((s, v) => s + v, 0);
  const rows = cashFlowCumulative(cf.buckets, prior.aligned, prior.spentCents);
  const newLast = rows[rows.length - 1]!.ghostCum!;
  const byHere = prior.aligned.reduce<number>((s, v) => s + (v ?? 0), 0);
  const lastPriorBucket = prevFlow.buckets[prevFlow.buckets.length - 1]!;
  console.log(
    `${p} prior=${prior.label} priorBuckets=${priorDaily.length} curBuckets=${bucketCount}\n` +
      `   OLD last (resample sum) = $${(oldLast / 100).toFixed(2)}\n` +
      `   NEW last (pinned total) = $${(newLast / 100).toFixed(2)}\n` +
      `   index-aligned by-here   = $${(byHere / 100).toFixed(2)}\n` +
      `   prior's own last bucket: ${lastPriorBucket.label} = $${(lastPriorBucket.spendingCents / 100).toFixed(2)}\n` +
      `   prior TOTAL (page readout) = $${(prior.spentCents / 100).toFixed(2)}`,
  );
}
