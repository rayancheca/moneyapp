import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { categoryMonthlyTrend, categoryFlowSign } from "@/services/category-detail";
import { ledgerReaches } from "@/services/observation-frontier";
import { emptyTrendCopy } from "@/lib/empty-period";
import { compareDates, periodBounds } from "@/lib/dates";

const db = getDb();
const today = "2026-09-11";
const reaches = ledgerReaches(db);
const TRUE_LAST_12 = "2025-10..2026-09"; // the window ending at today

const cats = (db.select().from(categories).all() as any[]);
const periods: string[] = [];
for (let y = 2023; y <= 2025; y++) for (let m = 1; m <= 12; m++) periods.push(`${y}-${String(m).padStart(2, "0")}`);

function sweep(anchorMode: "period" | "today") {
  let pages = 0, lastPhrase = 0, falseLastPhrase = 0;
  const ex: string[] = [];
  for (const c of cats) {
    const sign = categoryFlowSign(c.kind);
    for (const p of periods) {
      const from = `${p}-01`;
      const to = periodBounds(from, "monthly").end;
      const anchor = anchorMode === "today" ? today : (compareDates(to, today) < 0 ? to : today);
      const pts = categoryMonthlyTrend(db, c.id, 12, anchor, reaches).map((x) => ({ ...x, spentCents: sign * x.spentCents }));
      pages++;
      const max = pts.reduce((m, x) => Math.max(m, Math.abs(x.spentCents)), 0);
      if (max !== 0) continue;                       // bars render, no sentence
      const copy = emptyTrendCopy(pts);
      if (!copy.includes("in the last 12 months")) continue;
      lastPhrase++;
      const span = `${pts[0]!.month}..${pts[pts.length - 1]!.month}`;
      if (span !== TRUE_LAST_12) {
        falseLastPhrase++;
        if (ex.length < 5) ex.push(`${c.name} ?period=${p} · bars ${span} · "${copy}"`);
      }
    }
  }
  return { anchorMode, pages, lastPhrase, falseLastPhrase, ex };
}

console.log("MY OWN MEASUREMENT — reaches:", reaches, "categories:", cats.length, "periods:", periods.length);
for (const mode of ["period", "today"] as const) {
  const r = sweep(mode);
  console.log(`\nanchor=${mode}  pages=${r.pages}  say-"last 12 months"=${r.lastPhrase}  FALSE=${r.falseLastPhrase}`);
  r.ex.forEach((e) => console.log("   ", e));
}
