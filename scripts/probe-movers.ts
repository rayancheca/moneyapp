/**
 * READ-ONLY. What the "what changed" card can honestly compare on the real
 * ledger — and what the two obvious comparisons would have published instead.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, monthKey } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { activeTxnsInRange, loadCategoryIndex, monthlySpending, spendingBucket } from "@/services/analytics";
import { moversCard } from "@/services/movers-card";
import { observationFrontier } from "@/services/observation-frontier";
import { listAccounts } from "@/services/accounts";

const db = getDb();
const TODAY = "2026-08-26";

// ── 1. how far each account has been shown, and how much spend it carries ──
const frontier = observationFrontier(db);
const accounts = new Map(listAccounts(db).map((a) => [a.id, a.name] as const));

const idx = loadCategoryIndex(db);
const windowFrom = "2026-01-01";
const windowTo = "2026-08-31";
const byAccount = new Map<string, number>();
for (const t of activeTxnsInRange(db, windowFrom, windowTo)) {
  if (!spendingBucket(idx, t)) continue;
  byAccount.set(t.accountId, (byAccount.get(t.accountId) ?? 0) - t.amountCents);
}
const totalSpend = [...byAccount.values()].reduce((s, c) => s + c, 0);

console.log(`ACCOUNTS — expense spend ${windowFrom}..${windowTo}, and the day each is imported through`);
for (const [id, cents] of [...byAccount.entries()].sort((a, b) => b[1] - a[1])) {
  const through = frontier.byAccount.get(id) ?? "never";
  const pct = ((cents / totalSpend) * 100).toFixed(1);
  console.log(`  ${(accounts.get(id) ?? id).padEnd(30)} ${formatCents(cents).padStart(12)}  ${pct.padStart(5)}%  through ${through}`);
}

// ── 2. monthly spend totals, so the shape of the cliff is visible ──────────
const cells = monthlySpending(db, { months: 14, refDate: TODAY });
const totals = new Map<string, number>();
for (const c of cells) totals.set(c.month, (totals.get(c.month) ?? 0) + c.spentCents);
console.log("\nTOTAL EXPENSE SPEND BY MONTH");
for (const [m, cents] of [...totals.entries()].sort()) console.log(`  ${m}  ${formatCents(cents).padStart(12)}`);

// ── 3. the three comparisons, side by side ────────────────────────────────
function spendByCategory(from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of activeTxnsInRange(db, from, to)) {
    const b = spendingBucket(idx, t);
    if (!b) continue;
    out.set(b.categoryName, (out.get(b.categoryName) ?? 0) - t.amountCents);
  }
  return out;
}

function report(label: string, current: Map<string, number>, baseline: Map<string, number>, divisor: number): void {
  console.log(`\n${label}`);
  const names = new Set([...current.keys(), ...baseline.keys()]);
  const rows = [...names]
    .map((name) => {
      const now = current.get(name) ?? 0;
      const usual = Math.round((baseline.get(name) ?? 0) / divisor);
      return { name, now, usual, delta: now - usual };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6);
  for (const r of rows) {
    const pct = r.usual > 0 ? `${((r.delta / r.usual) * 100).toFixed(0)}%` : "—";
    console.log(
      `  ${r.name.padEnd(18)} now ${formatCents(r.now).padStart(11)}  usual ${formatCents(r.usual).padStart(11)}  ` +
        `delta ${formatCents(r.delta).padStart(11)}  ${pct.padStart(6)}`,
    );
  }
}

// (a) THE TRAP: August so far against whole prior months
report(
  "(a) NAIVE — Aug 1..26 (26 days, partly unimported) against the mean of 6 WHOLE months Feb..Jul",
  spendByCategory("2026-08-01", TODAY),
  spendByCategory("2026-02-01", "2026-07-31"),
  6,
);

// (b) elapsed-days-to-date against the same elapsed days of prior months
const sameDays = new Map<string, number>();
for (let i = 1; i <= 6; i += 1) {
  const m = monthKey(addCalendarMonths("2026-08-01", -i));
  for (const [k, v] of spendByCategory(`${m}-01`, `${m}-26`)) sameDays.set(k, (sameDays.get(k) ?? 0) + v);
}
report("(b) ELAPSED-DAYS — Aug 1..26 against days 1..26 of the 6 months before it", spendByCategory("2026-08-01", TODAY), sameDays, 6);

// (c) clamped to the earliest frontier among accounts that carry spend — i.e.
// only the days of August that EVERY spending account has been shown through
const materialThrough = [...byAccount.keys()]
  .map((id) => frontier.byAccount.get(id))
  .filter((d): d is string => d !== undefined)
  .sort();
const floor = materialThrough[0]!;
console.log(`\n(c) CLAMPED — the floor across every account that carries spend is ${floor}`);
if (floor < "2026-08-01") {
  console.log(`    …which is BEFORE August opens: zero of August's 26 elapsed days are covered by every`);
  console.log(`    spending account, so there is no like-for-like part-month to compare at all.`);
} else {
  const clampDay = Number(floor.slice(8, 10));
  const clampedBaseline = new Map<string, number>();
  for (let i = 1; i <= 6; i += 1) {
    const m = monthKey(addCalendarMonths("2026-08-01", -i));
    for (const [k, v] of spendByCategory(`${m}-01`, `${m}-${String(clampDay).padStart(2, "0")}`))
      clampedBaseline.set(k, (clampedBaseline.get(k) ?? 0) + v);
  }
  report(`    Aug 1..${clampDay} against days 1..${clampDay} of the 6 months before it`, spendByCategory("2026-08-01", floor), clampedBaseline, 6);
}

// (d) the choice: the newest COMPLETE, fully-observed month against the 6 before it
report(
  "(d) CHOSEN — 2026-07 (complete, and imported through by every spending account) against 2026-01..2026-06",
  spendByCategory("2026-07-01", "2026-07-31"),
  spendByCategory("2026-01-01", "2026-06-30"),
  6,
);

const julyTotal = [...spendByCategory("2026-07-01", "2026-07-31").values()].reduce((s, c) => s + c, 0);
const baseTotal = [...spendByCategory("2026-01-01", "2026-06-30").values()].reduce((s, c) => s + c, 0);
console.log(
  `\n  July total ${formatCents(julyTotal)} vs usual ${formatCents(Math.round(baseTotal / 6))} → ` +
    `${formatCents(julyTotal - Math.round(baseTotal / 6))}`,
);

// ── 4. does every spending account cover the whole window? ─────────────────
console.log("\nFIRST IMPORTED DAY per spending account (baseline opens 2026-01-01)");
for (const id of byAccount.keys()) {
  const first = db
    .select({ d: sql<string>`min(${transactions.postedOn})` })
    .from(transactions)
    .where(and(eq(transactions.accountId, id), eq(transactions.status, "active")))
    .get()?.d;
  console.log(`  ${(accounts.get(id) ?? id).padEnd(30)} from ${first}`);
}

// ── 5. the service itself ─────────────────────────────────────────────────
const card = moversCard(db, TODAY);
console.log("\n══ moversCard(db, \"2026-08-26\") ══");
if (!card) {
  console.log("  returned null");
} else {
  console.log(`  headline        ${card.headline} ${card.headlineNoun}`);
  console.log(`  summary         ${card.summary}`);
  console.log(`  compared month  ${card.month} (${card.monthLabel})  total ${formatCents(card.monthTotalCents)}`);
  console.log(`  usual           ${formatCents(card.usualMonthlyCents)}  over ${card.baselineFromLabel} .. ${card.baselineToLabel}`);
  console.log(`  total delta     ${formatCents(card.totalDeltaCents)}  (${card.totalPctOfUsual === null ? "—" : `${card.totalPctOfUsual.toFixed(1)}%`})`);
  console.log("  movers:");
  for (const m of card.movers) {
    console.log(
      `    ${m.categoryName.padEnd(16)} month ${formatCents(m.monthCents).padStart(11)}  usual ${formatCents(m.usualMonthlyCents).padStart(11)}  ` +
        `delta ${formatCents(m.deltaCents).padStart(11)}  ${(m.pctLabel ?? "—").padStart(7)}  seen ${m.monthsSeen}/6` +
        `${m.thinNote ? `  ⚠️ ${m.thinNote}` : ""}`,
    );
    console.log(`      → ${m.href}`);
  }
  console.log(`  other           ${card.otherCount} rows, ${formatCents(card.otherDeltaCents)}  note: ${card.otherNote}`);
  const shown = card.movers.reduce((s, m) => s + m.deltaCents, 0) + card.otherDeltaCents;
  console.log(`  RECONCILES      rows ${formatCents(shown)} === total ${formatCents(card.totalDeltaCents)} → ${shown === card.totalDeltaCents}`);
  console.log(`  current month   ${card.currentMonthNote}`);
  console.log("  lagging:");
  for (const l of card.lagging) console.log(`    ${l.name.padEnd(30)} through ${l.through}  ${l.sharePct.toFixed(1)}% of usual`);
  console.log(`  historyNote     ${card.historyNote ?? "(none)"}`);
  const negZero = JSON.stringify(card).includes("-0,") || JSON.stringify(card).includes("-0}");
  console.log(`  contains -0     ${negZero}`);
  console.log(`  every pct finite ${card.movers.every((m) => m.pctOfUsual === null || Number.isFinite(m.pctOfUsual))}`);
}
