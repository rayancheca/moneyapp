/**
 * READ-ONLY. What `concentrationCard` says about the real ledger, beside the
 * two services it is not allowed to disagree with.
 */
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { concentrationCard } from "@/services/concentration-card";
import { latestBridgedNetWorthCents } from "@/services/in-flight";
import { allocationSlices, holdingRows } from "@/services/portfolio";

const db = getDb();
const TODAY = "2026-08-26";

const card = concentrationCard(db, TODAY);
if (!card) {
  console.log("concentrationCard returned null");
  process.exit(0);
}

const pct = (n: number | null): string => (n === null ? "—" : `${n.toFixed(2)}%`);

console.log(`headline   : ${card.headline} ${card.headlineNoun}`);
console.log(`summary    : ${card.summary}`);
console.log(`topTwoNote : ${card.topTwoNote}`);
console.log(`restNote   : ${card.restNote}`);
console.log(`fundNote   : ${card.fundNote}`);
console.log(`priceNote  : ${card.priceNote}`);
console.log(`unpriced   : ${card.unpricedNote}`);

console.log("\npositions named:");
for (const p of card.positions) {
  console.log(
    `  ${p.symbol.padEnd(5)} ${p.assetType.padEnd(6)} ${formatCents(p.valueCents).padStart(12)}  ` +
      `${pct(p.portfolioPct).padStart(7)} of portfolio  ${pct(p.netWorthPct).padStart(7)} of net worth` +
      `${p.spreadNote ? `  [${p.spreadNote}]` : ""}`,
  );
}
if (card.remainder) {
  console.log(
    `  + ${card.remainder.count} more ${formatCents(card.remainder.valueCents)} ${pct(card.remainder.portfolioPct)}`,
  );
}

console.log("\nby kind:");
for (const k of card.byKind) {
  console.log(
    `  ${k.label.padEnd(18)} ${formatCents(k.valueCents).padStart(12)} ${pct(k.portfolioPct).padStart(7)}` +
      `${k.isSingleName ? "" : "   (spread)"}`,
  );
}

console.log("\ntotals:");
console.log(`  portfolio        ${formatCents(card.portfolioCents)}`);
console.log(`  net worth        ${formatCents(card.netWorthCents)}`);
console.log(`  portfolio share  ${pct(card.portfolioSharePct)}`);
console.log(`  rest of net worth ${formatCents(card.restOfNetWorthCents)}`);
console.log(`  top over rest    ${card.topOverRest === null ? "—" : `${card.topOverRest.toFixed(2)}x`}`);
console.log(`  net worth verdict ${card.netWorthProvenance?.verdict} / ${card.netWorthProvenance?.badgeWord}`);

/* ── the agreements this card is not allowed to break ────────────────────── */
const alloc = allocationSlices(db);
const legSum = holdingRows(db).reduce((s, r) => s + (r.valueCents ?? 0), 0);
const nw = latestBridgedNetWorthCents(db);

console.log("\nagreement checks:");
console.log(`  portfolioCents === allocationSlices.totalCents : ${card.portfolioCents === alloc.totalCents}`);
console.log(`  portfolioCents === Σ holdingRows.valueCents    : ${card.portfolioCents === legSum}`);
console.log(`  netWorthCents  === latestBridgedNetWorthCents  : ${card.netWorthCents === nw}`);

const namedAndRest = card.positions.reduce((s, p) => s + p.valueCents, 0) + (card.remainder?.valueCents ?? 0);
console.log(`  named + remainder === portfolio                : ${namedAndRest === card.portfolioCents}`);
const kindSum = card.byKind.reduce((s, k) => s + k.valueCents, 0);
console.log(`  Σ byKind === portfolio                         : ${kindSum === card.portfolioCents}`);
const kindPct = card.byKind.reduce((s, k) => s + k.portfolioPct, 0);
console.log(`  Σ byKind %% ≈ 100                              : ${kindPct.toFixed(6)}`);
console.log(
  `  topTwo %% === row1 %% + row2 %%                  : ` +
    `${card.topTwo !== null && card.topTwo.portfolioPct === card.positions[0]!.portfolioPct + card.positions[1]!.portfolioPct}`,
);
console.log(
  `  rest === netWorth − portfolio                  : ${card.restOfNetWorthCents === nw - alloc.totalCents}`,
);
console.log(`  no −0 anywhere in cents fields                 : ${!hasNegativeZero(card)}`);

function hasNegativeZero(value: unknown): boolean {
  if (typeof value === "number") return Object.is(value, -0);
  if (Array.isArray(value)) return value.some(hasNegativeZero);
  if (value !== null && typeof value === "object") return Object.values(value).some(hasNegativeZero);
  return false;
}
