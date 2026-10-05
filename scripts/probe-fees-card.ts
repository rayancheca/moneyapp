/**
 * READ-ONLY. What the banks have charged, and what they have paid — measured
 * off the real ledger's own `Fees` / `Income > Interest` taxonomy rather than
 * off a name match, and measured over BOTH windows the card publishes.
 *
 * Run: npx tsx scripts/probe-fees-card.ts
 */
import { getDb } from "@/db/client";
import { addCalendarMonths, monthKey } from "@/lib/dates";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { activeTxnsInRange, loadCategoryIndex, spendingBucket } from "@/services/analytics";
import { cardsOwedCard } from "@/services/cards-owed";
import { SPEND_BASELINE_MONTHS } from "@/services/committed";
import { listAccounts, outsidePortfolioCashAccountIds } from "@/services/accounts";
import { feesCard } from "@/services/fees-card";

const db = getDb();
const TODAY = "2026-08-27";

const idx = loadCategoryIndex(db);
const agentsCash = outsidePortfolioCashAccountIds(db);
const top = [...idx.byId.values()].find((c) => c.parentId === null && c.name === "Fees")!;
const incomeTop = [...idx.byId.values()].find((c) => c.parentId === null && c.name === "Income")!;
const interest = [...idx.byId.values()].find((c) => c.parentId === incomeTop.id && c.name === "Interest")!;
const interestCharges = [...idx.byId.values()].find((c) => c.parentId === top.id && c.name === "Interest Charges") ?? null;

console.log("── 1. THE TAXONOMY, resolved by id and not by name-match ──────────────");
console.log(`  Fees (top, kind=${top.kind}) ${top.id}`);
for (const c of [...idx.byId.values()].filter((c) => c.parentId === top.id).sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`    └ ${c.name.padEnd(20)} ${c.id}`);
}
console.log(`  Income > Interest (kind=${interest.kind}) ${interest.id}`);
console.log(`  Interest Charges present: ${interestCharges !== null}`);

console.log("\n── 2. THE `LIKE %Fee%` TRAP — what a name match would sweep in ────────");
const likeFee = [...idx.byId.values()].filter((c) => /fee/i.test(c.name));
console.log(`  categories matching /fee/i: ${likeFee.map((c) => c.name).join(", ")}`);
const firstDay = "2000-01-01";
const all = activeTxnsInRange(db, firstDay, TODAY);
const likeIds = new Set(likeFee.map((c) => c.id));
const likeCents = all.filter((t) => t.categoryId !== null && likeIds.has(t.categoryId)).reduce((s, t) => s - t.amountCents, 0);
const coffee = [...idx.byId.values()].find((c) => c.name === "Coffee")!;
const coffeeCents = all.filter((t) => t.categoryId === coffee.id).reduce((s, t) => s - t.amountCents, 0);
console.log(`  a LIKE %Fee% total would be ${formatCents(likeCents)}, of which Coffee is ${formatCents(coffeeCents)}`);

console.log("\n── 3. FEE SUBTREE, all time, by the ledger's own child buckets ────────");
const feeIds = new Set(idx.subtreeIds(top.id));
const interestChargeIds = interestCharges ? new Set(idx.subtreeIds(interestCharges.id)) : new Set<string>();
for (const id of interestChargeIds) feeIds.delete(id);

function report(label: string, from: string, to: string): void {
  const rows = activeTxnsInRange(db, from, to);
  const byCat = new Map<string, { name: string; cents: number; charges: number; refunds: number }>();
  let feeTotal = 0;
  for (const t of rows) {
    if (t.categoryId === null || !feeIds.has(t.categoryId)) continue;
    const node = idx.byId.get(t.categoryId)!;
    const cell = byCat.get(node.id) ?? { name: node.name, cents: 0, charges: 0, refunds: 0 };
    byCat.set(node.id, {
      ...cell,
      cents: cell.cents - t.amountCents,
      charges: cell.charges + (t.amountCents < 0 ? 1 : 0),
      refunds: cell.refunds + (t.amountCents > 0 ? 1 : 0),
    });
    feeTotal -= t.amountCents;
  }
  const interestIds = new Set(idx.subtreeIds(interest.id));
  const intRows = rows.filter((t) => t.categoryId !== null && interestIds.has(t.categoryId));
  const intCents = intRows.reduce((s, t) => s + t.amountCents, 0);
  const chargedIds = interestChargeIds;
  const chargedRows = rows.filter((t) => t.categoryId !== null && chargedIds.has(t.categoryId));
  const chargedCents = chargedRows.reduce((s, t) => s - t.amountCents, 0);

  console.log(`  ${label}  (${from} .. ${to})`);
  for (const [, c] of [...byCat.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
    console.log(`    ${c.name.padEnd(20)} ${formatCents(c.cents).padStart(11)}  ${String(c.charges).padStart(3)} charges  ${c.refunds} refunds`);
  }
  console.log(`    ${"= paid to banks".padEnd(20)} ${formatCents(feeTotal).padStart(11)}`);
  console.log(`    ${"Interest Charges".padEnd(20)} ${formatCents(chargedCents).padStart(11)}  ${chargedRows.length} rows  (empty bucket, not a missing one)`);
  console.log(`    ${"= paid to you".padEnd(20)} ${formatCents(intCents).padStart(11)}  ${intRows.length} rows, ${intRows.filter((t) => t.amountCents < 0).length} clawbacks`);
  console.log(`    ${"NET (them − you)".padEnd(20)} ${formatCentsSigned(intCents - feeTotal - chargedCents).padStart(11)}`);
}

report("ALL TIME", firstDay, TODAY);

const currentMonth = monthKey(TODAY);
const fromMonth = monthKey(addCalendarMonths(`${currentMonth}-01`, -SPEND_BASELINE_MONTHS));
const toMonth = monthKey(addCalendarMonths(`${currentMonth}-01`, -1));
console.log("");
report(`LAST ${SPEND_BASELINE_MONTHS} COMPLETE MONTHS`, `${fromMonth}-01`, `${toMonth}-31`);

console.log("\n── 4. INTEREST BY MONTH — is the reversal a fee rise or an interest fall? ──");
const interestIds = new Set(idx.subtreeIds(interest.id));
const byMonth = new Map<string, number>();
for (const t of all) {
  if (t.categoryId === null || !interestIds.has(t.categoryId)) continue;
  const m = monthKey(t.postedOn);
  byMonth.set(m, (byMonth.get(m) ?? 0) + t.amountCents);
}
const best = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0]!;
console.log(`  best month: ${best[0]} at ${formatCents(best[1])}`);
console.log(`  last 8 months: ${[...byMonth.entries()].sort().slice(-8).map(([m, c]) => `${m} ${formatCents(c)}`).join(", ")}`);

console.log("\n── 5. WHO CHARGES — accounts behind the fee rows, all time ────────────");
const names = new Map(listAccounts(db).map((a) => [a.id, a.name] as const));
const byAcct = new Map<string, number>();
for (const t of all) {
  if (t.categoryId === null || !feeIds.has(t.categoryId)) continue;
  byAcct.set(t.accountId, (byAcct.get(t.accountId) ?? 0) - t.amountCents);
}
for (const [id, c] of [...byAcct.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(names.get(id) ?? id).padEnd(20)} ${formatCents(c).padStart(11)}`);
}

console.log("\n── 6. DOES `spendingBucket` ADMIT EVERY FEE ROW? (kind=expense check) ──");
const admitted = all.filter((t) => t.categoryId !== null && feeIds.has(t.categoryId) && spendingBucket(idx, agentsCash, t) !== null).length;
const feeRowCount = all.filter((t) => t.categoryId !== null && feeIds.has(t.categoryId)).length;
console.log(`  ${admitted} of ${feeRowCount} fee rows are inside the app's spending totals`);

console.log("\n── 7. AGREEMENT WITH CardsOwedCard (the card that already says WHAT THEY COST) ──");
const owed = cardsOwedCard(db, TODAY);
console.log(`  cardsOwedCard.fees      = ${owed?.fees ? `${formatCents(owed.fees.totalCents)} over ${owed.fees.charges} charges, ${owed.fees.firstOn}..${owed.fees.lastOn}` : "null"}`);
console.log(`  cardsOwedCard.fees.annualCents = ${owed?.fees ? formatCents(owed.fees.annualCents) : "n/a"}`);
console.log(`  cardsOwedCard.interestCents    = ${owed?.interestCents === null || owed?.interestCents === undefined ? String(owed?.interestCents) : formatCents(owed.interestCents)}`);
console.log(`  cardsOwedCard.interestNote     = ${JSON.stringify(owed?.interestNote)}`);

console.log("\n── 8. THE CARD ITSELF ─────────────────────────────────────────────────");
const card = feesCard(db, TODAY);
console.log(JSON.stringify(card, null, 2));


// ── 9. SMOKE RENDER — rule 8, and the two glyphs that only show on the page ──
if (card) {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { FeesCard } = await import("@/components/dashboard/FeesCard");
  const html = renderToStaticMarkup(createElement(FeesCard, { data: card }));
  /*
   * ⛔ `<p(?=[\s>])`, not `<p[^>]*>`. The loose form matches `<path d="…">`
   * inside every icon, and the lazy tail then runs to the next real `</p>` —
   * measured, that reported "a popover inside a paragraph" on markup that has
   * none. A rule-8 check that cries wolf is worse than no check, because the
   * next person to see it red will assume it always is.
   */
  const paragraphs = html.match(/<p(?=[\s>])[^>]*>[\s\S]*?<\/p>/g) ?? [];
  console.log("\n── 9. SMOKE RENDER ────────────────────────────────────────────────────");
  console.log(`  paragraphs: ${paragraphs.length}`);
  console.log(`  any <div> inside a <p>: ${paragraphs.some((p) => p.includes("<div"))}`);
  console.log(`  any popover inside a <p>: ${paragraphs.some((p) => p.includes("popover"))}`);
  console.log(
    `  any "-$0.00": ${html.includes("-$0.00")}   any "Infinity": ${html.includes("Infinity")}   any "NaN": ${html.includes("NaN")}`,
  );
  console.log("\n  --- text as a reader sees it ---");
  console.log(html.replace(/></g, "> <").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
