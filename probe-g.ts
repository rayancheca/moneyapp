/** READ-ONLY: returnStats' two new percentage extremes, on every holding + the portfolio. */
import { getDb } from "@/db/client";
import { returnStatsInWindow, dailyReturns, type PortfolioDay } from "@/lib/portfolio-returns";
import { portfolioReturnDays, holdingRows } from "@/services/portfolio";
import { holdingDetail } from "@/services/holding-detail";

const db = getDb();
const TODAY = "2026-09-11";
const RANGES = ["1M", "3M", "6M", "1Y", "YTD", "ALL"] as any[];

function report(name: string, days: PortfolioDay[]) {
  const navByDay = new Map(dailyReturns(days).map((r) => [r.day, r.prevNavCents]));
  for (const range of RANGES) {
    let st;
    try { st = returnStatsInWindow(days, TODAY, range); } catch { continue; }
    const b = st.bestDayPct, w = st.worstDayPct;
    const flags: string[] = [];
    for (const [lbl, s] of [["best", b], ["worst", w]] as const) {
      if (!s || s.pct === null) continue;
      const base = navByDay.get(s.day) ?? 0;
      if (Math.abs(s.pct) > 50) flags.push(`${lbl} ${s.pct.toFixed(2)}% on ${s.day} over a prior NAV of $${(base / 100).toFixed(2)} (move $${(s.returnCents / 100).toFixed(2)})`);
      else if (base > 0 && base < 5000) flags.push(`${lbl} ${s.pct.toFixed(2)}% on ${s.day} over a THIN prior NAV of $${(base / 100).toFixed(2)}`);
    }
    if (flags.length) console.log(`${name} [${range}] :: ${flags.join(" | ")}`);
    // sanity: the pct extreme must be >= the dollar extreme's pct
    if (b && st.bestDay && st.bestDay.pct !== null && b.pct !== null && b.pct < st.bestDay.pct - 1e-9)
      console.log(`!! ${name} [${range}] bestDayPct ${b.pct} < bestDay.pct ${st.bestDay.pct}`);
    if (w && st.worstDay && st.worstDay.pct !== null && w.pct !== null && w.pct > st.worstDay.pct + 1e-9)
      console.log(`!! ${name} [${range}] worstDayPct ${w.pct} > worstDay.pct ${st.worstDay.pct}`);
    if ((b === null) !== (w === null)) console.log(`!! ${name} [${range}] one of bestDayPct/worstDayPct is null, the other not`);
  }
}

report("PORTFOLIO", portfolioReturnDays(db));
const rows = holdingRows(db);
console.log(`holdings: ${rows.length}`);
for (const r of rows) {
  try {
    const d = holdingDetail(db, (r as any).assetType, (r as any).symbol, TODAY);
    report(`${(r as any).assetType}/${(r as any).symbol}`, d.returnDays);
  } catch (e) { console.log(`skip ${(r as any).symbol}: ${e}`); }
}
