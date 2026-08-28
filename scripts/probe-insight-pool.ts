/**
 * READ-ONLY. How many sentences each insight surface actually HAS to choose from.
 *
 * ⛔ The measurement that decided what pass 72d is. `runInsights` stops at
 * `MAX_INSIGHTS`, so a surface returning fewer than the cap is showing its
 * ENTIRE pool — nothing was dropped and nothing could have been selected.
 *
 * Measured on the real ledger, 2026-08-28, over 533 surfaces:
 *
 *     insights rendered → surfaces      0 → 364   1 → 4   2 → 144   3 → 16   4 → 5
 *     candidates offered: 360           accepted and proven: 360    dropped: 0
 *
 * and raising `MAX_INSIGHTS` from 4 to 40 produced the IDENTICAL distribution.
 * No page in the ledger has ever had a fifth thing to say, and the write gate
 * has never refused a candidate a surface offered. So a model asked to pick the
 * best four of four would have had no choice to make anywhere — which is why
 * the selector was given SUBJECTS to choose between instead.
 *
 * It also found a live crash: `/merchants/<UNKNOWN>` threw rather than
 * rendering. See `lib/printable-name`.
 */
import { getDb } from "@/db/client";
import { MAX_INSIGHTS } from "@/services/insights";

const db = getDb();
const TODAY = "2026-08-27";

const { spendingInsights, categoryInsights } = await import("@/services/spending-insights");
const { budgetInsights } = await import("@/services/budget-insights");
const { yearInsights } = await import("@/services/year-insights");
const { accountInsights } = await import("@/services/account-insights");
const { merchantInsights } = await import("@/services/merchant-insights");
const { recurringInsights } = await import("@/services/recurring-insights");

const { categories } = await import("@/db/schema/categories");
const { accounts } = await import("@/db/schema/accounts");
const { merchants } = await import("@/db/schema/merchants");
const { recurringSeries } = await import("@/db/schema/recurring");

(globalThis as any).__probe = [];
const rows: { surface: string; n: number; atCap: boolean }[] = [];
const threw: { surface: string; message: string }[] = [];
const record = (surface: string, build: () => { insights: unknown[] } | null) => {
  let r: { insights: unknown[] } | null = null;
  try {
    r = build();
  } catch (e) {
    threw.push({ surface, message: e instanceof Error ? e.message : String(e) });
    return;
  }
  const n = r?.insights.length ?? 0;
  rows.push({ surface, n, atCap: n >= MAX_INSIGHTS });
};

record("/spending", () => spendingInsights(db, TODAY));
record("/budgets", () => budgetInsights(db, TODAY));
record("/summary/2026", () => yearInsights(db, 2026));
record("/summary/2025", () => yearInsights(db, 2025));

for (const c of db.select().from(categories).all().slice(0, 200)) {
  record(`/categories/${c.name}`, () => categoryInsights(db, c.id, TODAY));
}
for (const a of db.select().from(accounts).all()) {
  record(`/accounts/${a.name}`, () => accountInsights(db, a.id, TODAY));
}
for (const m of db.select().from(merchants).all().slice(0, 400)) {
  record(`/merchants/${m.canonicalName}`, () => merchantInsights(db, m.id));
}
for (const s of db.select().from(recurringSeries).all()) {
  record(`/recurring/${s.name}`, () => recurringInsights(db, s.id, TODAY));
}

const kind = (surface: string) => surface.split("/")[1] ?? surface;
const byKind = new Map<string, { n: number; zero: number; atCap: number; total: number }>();
for (const r of rows) {
  const k = kind(r.surface);
  const e = byKind.get(k) ?? { n: 0, zero: 0, atCap: 0, total: 0 };
  e.n += r.n;
  e.total += 1;
  if (r.n === 0) e.zero += 1;
  if (r.atCap) e.atCap += 1;
  byKind.set(k, e);
}
console.log("\nby surface kind: pages / silent / at-cap / mean sentences");
for (const [k, e] of [...byKind.entries()].sort()) {
  console.log(`  ${k.padEnd(12)} ${String(e.total).padStart(4)} / ${String(e.zero).padStart(4)} / ${String(e.atCap).padStart(3)} / ${(e.n / e.total).toFixed(2)}`);
}

const hist = new Map<number, number>();
for (const r of rows) hist.set(r.n, (hist.get(r.n) ?? 0) + 1);
const probe = (globalThis as any).__probe as { offered: number; accepted: number }[];
const offeredHist = new Map<number, number>();
let dropped = 0;
for (const p of probe) { offeredHist.set(p.offered, (offeredHist.get(p.offered) ?? 0) + 1); dropped += p.offered - p.accepted; }
console.log("\ncandidates OFFERED per runInsights call → calls");
for (const n of [...offeredHist.keys()].sort((a,b)=>a-b)) console.log(`  ${n} → ${offeredHist.get(n)}`);
console.log(`total candidates offered: ${probe.reduce((s,p)=>s+p.offered,0)}, accepted+proven: ${probe.reduce((s,p)=>s+p.accepted,0)}, dropped: ${dropped}`);
console.log(`MAX_INSIGHTS = ${MAX_INSIGHTS}`);
console.log(`\nsurfaces measured: ${rows.length}`);
console.log("insights rendered → how many surfaces");
for (const n of [...hist.keys()].sort((a, b) => a - b)) {
  console.log(`  ${n} → ${hist.get(n)}`);
}
const atCap = rows.filter((r) => r.atCap);
console.log(`\nAT THE CAP (pool could be larger, a selector could act): ${atCap.length} of ${rows.length}`);
for (const r of atCap.slice(0, 40)) console.log(`  ${r.surface}`);
console.log(`\nTHREW (a page that cannot render): ${threw.length}`);
for (const t of threw) console.log(`  ${t.surface} — ${t.message}`);
