/** READ-ONLY. What the CardsOwedCard will actually display, from the real ledger. */
import { getDb } from "@/db/client";
import { cardsOwedCard } from "@/services/cards-owed";
import { runwayCard } from "@/services/committed";

const db = getDb();
const TODAY = "2026-08-26";

const t0 = Date.now();
const c = cardsOwedCard(db, TODAY);
const ms = Date.now() - t0;
if (!c) {
  console.log("cardsOwedCard returned null");
  process.exit(0);
}

console.log(`(${ms}ms)\n`);
console.log("HEADLINE:", c.headline);
console.log("EXPLAIN :", c.explanation);
console.log("CONVENT :", c.convention);
console.log("owedCents:", c.owedCents, "| nothingOwed:", c.nothingOwed);
console.log("sharedCheckedThrough:", c.sharedCheckedThrough, "| oldest:", c.oldestCheckedThrough, "| daysSinceOldest:", c.daysSinceOldest);
console.log("unpricedCards:", c.unpricedCards, "| closedOwedCents:", c.closedOwedCents);
console.log("\nROWS");
for (const r of c.cards) {
  console.log(
    ` ${r.name}${r.last4 ? ` ····${r.last4}` : ""} | owed: ${r.owedCents} | checkedThrough: ${r.checkedThrough}` +
      ` | daysSinceChecked: ${r.daysSinceChecked} | grade: ${r.grade} | verdict: ${r.verdict}` +
      ` | share: ${r.sharePct === null ? "null" : r.sharePct.toFixed(1) + "%"} | shareLabel: ${r.shareLabel}` +
      ` | caveat: ${r.caveat}` + ` | asOfLabel: ${r.asOfLabel}`,
  );
  console.log(`   fees: ${JSON.stringify(r.fees)}`);
}
console.log("\nFEES (all cards):", JSON.stringify(c.fees));
console.log("interestCents:", c.interestCents);
console.log("\nPROVENANCE");
console.log(" verdict:", c.provenance.verdict, "| badgeWord:", c.provenance.badgeWord, "| checkedThrough:", c.provenance.checkedThrough);
console.log(" headline:", c.provenance.headline);
for (const i of c.provenance.inputs) console.log("  -", i.label, "|", i.verdict, "|", i.detail);

console.log("\n=== AGREEMENT WITH THE RUNWAY CARD ===");
const rc = runwayCard(db, TODAY);
const cardsAssumption = rc.runway.assumptions.find((a) => a.id === "cards")!;
console.log("runway `cards` assumption cents:", cardsAssumption.cents);
console.log("cardsOwedCard owedCents        :", c.owedCents);
console.log("AGREE:", cardsAssumption.cents === c.owedCents);
