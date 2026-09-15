/**
 * READ-ONLY. What the "how the investments are actually doing" card can honestly
 * headline — and why the three returns on this screen cannot be stacked.
 */
import { getDb } from "@/db/client";
import { diffDays } from "@/lib/dates";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { holdingRows, investmentAccounts, portfolioDayChange, portfolioOverview, portfolioSeries } from "@/services/portfolio";

const db = getDb();
const o = portfolioOverview(db);

console.log("ACCOUNTS");
for (const a of investmentAccounts(db)) console.log(`  ${a.name.padEnd(22)} ${a.subtype ?? "—"}  crypto=${a.isCrypto}`);

console.log("\nportfolioOverview() — verbatim");
console.log(`  valueCents         ${formatCents(o.valueCents).padStart(14)}   asOf ${o.asOf}`);
const dc = portfolioDayChange(db, holdingRows(db));
console.log(`  dayChange.cents    ${dc.cents === null ? "null".padStart(14) : formatCentsSigned(dc.cents).padStart(14)}   pct ${dc.pct?.toFixed(4) ?? "null"}  exact=${dc.exact}  ${dc.on} vs ${dc.vsDay}`);
console.log(`  twrPct             ${(o.twrPct?.toFixed(4) ?? "null").padStart(14)}   gain ${formatCentsSigned(o.twrGainCents)}  anchor ${o.twrAnchor}`);
console.log(`  xirrPct            ${(o.xirrPct?.toFixed(4) ?? "null").padStart(14)}   exact=${o.xirrExact}`);
console.log(`  costBasisPlCents   ${o.costBasisPlCents === null ? "null".padStart(14) : formatCentsSigned(o.costBasisPlCents).padStart(14)}   pct ${o.costBasisPlPct?.toFixed(4) ?? "null"}`);
console.log(`  realizedPlCents    ${o.realizedPlCents === null ? "null".padStart(14) : formatCentsSigned(o.realizedPlCents).padStart(14)}   sells ${o.realizedSellCount}  exact=${o.realizedPlExact}`);
console.log(`  hasCrypto          ${o.hasCrypto}`);

// ── THE SCALE PROBLEM ────────────────────────────────────────────────────
// twrPct is CUMULATIVE since the anchor. xirrPct is ANNUALIZED
// (moneyWeightedReturn's docstring: "annualized money-weighted (XIRR) return").
// Stacked bare they read as two answers to one question.
if (o.twrPct !== null && o.twrAnchor && o.asOf) {
  const days = diffDays(o.twrAnchor, o.asOf);
  const years = days / 365.25;
  const twrAnnual = (Math.pow(1 + o.twrPct / 100, 1 / years) - 1) * 100;
  console.log("\nTHE SCALE PROBLEM — the two percentages are not the same kind of number");
  console.log(`  span                       ${days} days = ${years.toFixed(2)} years (${o.twrAnchor} → ${o.asOf})`);
  console.log(`  TWR, cumulative            ${o.twrPct.toFixed(2)}%   ← total over the whole span`);
  console.log(`  TWR, if annualized         ${twrAnnual.toFixed(2)}%/yr  (NOT published — shown here only to size the gap)`);
  console.log(`  XIRR, annualized           ${o.xirrPct?.toFixed(2)}%/yr`);
  console.log(`  → bare, TWR 30% looks BIGGER than XIRR 28%; per year it is less than half.`);
}

// ── SCOPE — the three measures do not cover the same money ───────────────
const rows = holdingRows(db);
const priced = rows.filter((r) => r.valueCents !== null && r.costCents !== null);
console.log("\nSCOPE — what each measure is even about");
console.log(`  holdings total             ${rows.length}`);
console.log(`  priced AND costed          ${priced.length}   ← the only rows costBasisPl covers`);
console.log(`  unpriced or uncosted       ${rows.length - priced.length}`);
const sumParts = (o.costBasisPlCents ?? 0) + (o.realizedPlCents ?? 0);
console.log(`  cost-basis + realized      ${formatCentsSigned(sumParts)}`);
console.log(`  twrGainCents               ${formatCentsSigned(o.twrGainCents)}`);
console.log(`  difference                 ${formatCentsSigned(o.twrGainCents - sumParts)}   ← they are NOT the same total`);

// ── COVERAGE — how much of the span both accounts were in ────────────────
const series = portfolioSeries(db);
const complete = series.filter((p) => p.complete).length;
console.log("\nSERIES");
console.log(`  covered days               ${series.length}  (${series[0]?.day} → ${series.at(-1)?.day})`);
console.log(`  days with every account    ${complete}`);

// ── THE CARD, as it would render ─────────────────────────────────────────
import { performanceCard } from "@/services/performance-card";
const TODAY = "2026-08-27";
const card = performanceCard(db, TODAY);
console.log("\nperformanceCard(db, '2026-08-27')");
if (card === null) {
  console.log("  null");
} else {
  console.log(`  headline    ${card.headline}  ${card.headlineNoun}   (headlineCents=${card.headlineCents}, negZero=${Object.is(card.headlineCents, -0)})`);
  console.log(`  direction   ${card.direction}`);
  console.log(`  span        ${card.spanLabel} (${card.spanDays} days) since ${card.anchor} → asOf ${card.asOf}  stale=${card.pricesAreStale}`);
  console.log(`  summary     ${card.summary}`);
  console.log("  measures");
  for (const m of card.measures) {
    const money = m.cents === null ? "—" : `${m.approximate ? "≈ " : ""}${formatCentsSigned(m.cents)}`;
    console.log(`    ${m.label.padEnd(28)} ${(m.pctLabel ?? "—").padStart(18)}  ${money.padStart(14)}${m.isHeadline ? "   ← headline" : ""}`);
    console.log(`      ${m.meaning}`);
  }
  console.log(`  scaleNote   ${card.scaleNote}`);
  for (const n of card.notes) console.log(`  note        ${n}`);
  console.log(`  footer      ${card.footer}`);
}

// ── RENDER SMOKE — rule 8 (no block element inside a <p>) and the -0 sweep ──
// `createElement` rather than JSX so this stays one .ts probe rather than two files.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PerformanceCard } from "@/components/dashboard/PerformanceCard";
if (card !== null) {
  const html = renderToStaticMarkup(createElement(PerformanceCard, { data: card }));
  // ⚠️ `<p[^>]*>` also matches `<path …>` inside an inline SVG icon, which then
  // runs to the next real `</p>` and sweeps up whatever sits between the two.
  // (`scripts/probe-movers-render.tsx` carries that bug: its "any <div> inside a
  // <p>" line can report true on perfectly valid markup.) The lookahead pins the
  // tag name to exactly `p`.
  const paragraphs = html.match(/<p(?=[\s>])[^>]*>[\s\S]*?<\/p>/g) ?? [];
  console.log("\nRENDER SMOKE");
  console.log(`  paragraphs                 ${paragraphs.length}`);
  console.log(`  <div> inside a <p>         ${paragraphs.some((p) => p.includes("<div"))}   ← must be false (hydration #418)`);
  console.log(`  <dl>/<ul> inside a <p>     ${paragraphs.some((p) => p.includes("<dl") || p.includes("<ul"))}`);
  console.log(`  contains "-$0.00"          ${html.includes("-$0.00")}`);
  console.log(`  contains "Infinity"        ${html.includes("Infinity")}`);
  console.log(`  contains "NaN"             ${html.includes("NaN")}`);
  console.log(`  contains "undefined"       ${html.includes("undefined")}`);
  console.log(`  ≈ present                  ${html.includes("≈")}`);
}
