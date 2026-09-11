/** READ-ONLY: full best/worst-pct table over all 34 holding pages + portfolio. */
import { getDb } from "@/db/client";
import { returnStatsInWindow, dailyReturns, type PortfolioDay } from "@/lib/portfolio-returns";
import { portfolioReturnDays } from "@/services/portfolio";
import { holdingDetail } from "@/services/holding-detail";
import { holdingEvents } from "@/db/schema/holding-events";

const db = getDb();
const TODAY = "2026-09-11";
const RANGES = ["1D","1W","1M","3M","YTD","1Y","ALL"] as any[];
const bad: string[] = [];

function report(name: string, days: PortfolioDay[], verbose = false) {
  const nav = new Map(dailyReturns(days).map((r) => [r.day, r.prevNavCents]));
  for (const range of RANGES) {
    const st = returnStatsInWindow(days, TODAY, range);
    if (verbose) {
      const f = (s: any) => (s ? `${s.pct === null ? "null" : s.pct.toFixed(2) + "%"} on ${s.day} ($${(s.returnCents/100).toFixed(2)}, base $${((nav.get(s.day)??0)/100).toFixed(2)})` : "—");
      console.log(`  ${range.padEnd(4)} best$ ${f(st.bestDay)}\n       best% ${f(st.bestDayPct)}\n       wrst$ ${f(st.worstDay)}\n       wrst% ${f(st.worstDayPct)}`);
    }
    if (st.bestDayPct && st.bestDay?.pct !== null && st.bestDayPct.pct !== null && st.bestDayPct.pct < (st.bestDay!.pct as number) - 1e-9) bad.push(`${name}/${range} best% inverted`);
    if (st.worstDayPct && st.worstDay?.pct !== null && st.worstDayPct.pct !== null && st.worstDayPct.pct > (st.worstDay!.pct as number) + 1e-9) bad.push(`${name}/${range} worst% inverted`);
    if ((st.bestDayPct === null) !== (st.worstDayPct === null)) bad.push(`${name}/${range} half-null`);
    for (const s of [st.bestDayPct, st.worstDayPct]) {
      if (s && s.pct !== null && Math.abs(s.pct) > 60) bad.push(`${name}/${range} extreme ${s.pct.toFixed(1)}% on ${s.day} base $${((nav.get(s.day)??0)/100).toFixed(2)}`);
    }
  }
}

console.log("PORTFOLIO");
report("PORTFOLIO", portfolioReturnDays(db), true);
const syms = db.selectDistinct({ a: holdingEvents.assetType, s: holdingEvents.symbol }).from(holdingEvents).all();
console.log(`\nsymbols: ${syms.length}`);
for (const { a, s } of syms as any[]) {
  const d = holdingDetail(db, a, s, TODAY);
  if (s === "ETH") { console.log(`\ncrypto/ETH`); report(`${a}/${s}`, d.returnDays, true); }
  else report(`${a}/${s}`, d.returnDays);
}
console.log(`\nPROBLEMS: ${bad.length === 0 ? "none" : ""}`);
console.log(bad.join("\n"));
