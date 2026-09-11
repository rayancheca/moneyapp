/** READ-ONLY: does withPeriod/periodParams round-trip to the SAME window? */
import { resolvePeriod, periodParams, periodQuery, subBuckets, type ResolvedPeriod } from "@/lib/period";

const TODAY = "2026-09-11";
const shapes: any[] = [];
for (let y = 2022; y <= 2026; y++) for (let m = 1; m <= 12; m++) shapes.push({ period: `${y}-${String(m).padStart(2, "0")}` });
for (let y = 2022; y <= 2026; y++) for (let q = 1; q <= 4; q++) shapes.push({ period: `${y}-Q${q}` });
for (let y = 2021; y <= 2026; y++) shapes.push({ period: `${y}` });
shapes.push({ period: "YTD" }, { period: "ALL" });
for (let d = 0; d < 30; d++) shapes.push({ period: `W2026-0${1 + (d % 9)}-0${1 + (d % 9)}` });
["2026-09-10", "2026-02-28", "2024-12-31", "2026-09-11"].forEach((p) => shapes.push({ period: p }));
[["2026-01-01","2026-01-10"],["2025-06-01","2026-06-30"],["2026-08-30","2026-09-11"],["2022-08-25","2026-09-11"]].forEach(([f,t]) => shapes.push({ from: f, to: t }));

const bad: string[] = [];
for (const s of shapes) {
  let p: ResolvedPeriod;
  try { p = resolvePeriod(s, TODAY); } catch { continue; }
  const back = resolvePeriod(periodParams(p), TODAY);
  const same = back.from === p.from && back.to === p.to && back.granularity === p.granularity && back.label === p.label;
  if (!same) bad.push(`${JSON.stringify(s)} -> ${p.granularity} ${p.from}..${p.to} "${p.label}"  ==[?${periodQuery(p)}]==>  ${back.granularity} ${back.from}..${back.to} "${back.label}"`);
  const nb = subBuckets(p).length, nb2 = subBuckets(back).length;
  if (nb !== nb2) bad.push(`${JSON.stringify(s)}: bucket count ${nb} -> ${nb2}`);
}
console.log(`shapes: ${shapes.length}; round-trip failures: ${bad.length}`);
console.log(bad.slice(0, 20).join("\n"));
