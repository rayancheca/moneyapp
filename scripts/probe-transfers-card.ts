/**
 * READ-ONLY. What `transfersCard` says about the real ledger, beside the raw
 * counts it must not disagree with and the two services it is not allowed to
 * re-derive.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { formatCents } from "@/lib/money";
import { listAccounts } from "@/services/accounts";
import { activeTxnsInRange, loadCategoryIndex } from "@/services/analytics";
import { transferFlow } from "@/services/transfer-flow";
import { transferCategoryResolver } from "@/services/transfer-links";
import { transfersCard } from "@/services/transfers-card";

const db = getDb();
const TODAY = "2026-08-27";

const card = transfersCard(db, TODAY);
if (!card) {
  console.log("transfersCard returned null");
  process.exit(0);
}

console.log(`window     : ${card.fromMonth} → ${card.toMonth} (${card.months} complete months)`);
console.log(`headline   : ${card.headline} ${card.headlineNoun}`);
console.log(`summary    : ${card.summary}`);
console.log(`departures : ${card.departureCount} legs, ${formatCents(card.movedCents)}`);

console.log(`\nroutes (${formatCents(card.routedCents)} across ${card.routes.length + card.otherRouteCount}):`);
for (const r of card.routes) {
  console.log(`  ${`${r.fromLabel} → ${r.toLabel}`.padEnd(38)} ${formatCents(r.cents).padStart(12)}  ${r.countLabel}`);
}
console.log(`  other    : ${card.otherRouteNote ?? "—"}  ${formatCents(card.otherRouteCents)}`);

console.log(`\nproof.sentence   : ${card.proof.sentence}`);
console.log(`proof.mirrorNote : ${card.proof.mirrorNote ?? "—"}`);
console.log(`proof.stranded   : ${card.proof.strandedNote ?? "—"}`);
console.log(`proof.figures    : linked ${card.proof.linkedCount}/${formatCents(card.proof.linkedCents)} · unpaired ${card.proof.unpairedCount}/${formatCents(card.proof.unpairedCents)} (${card.proof.unpairedPct.toFixed(1)}%) · mirrors ${card.proof.mirrorCount}/${formatCents(card.proof.mirrorCents)} · stranded ${formatCents(card.proof.strandedCents)}`);

console.log(`\nchurn      : ${card.churnNote ?? "—"}`);
console.log(`arrivals   : ${card.arrivalNote ?? "—"}`);
console.log(`other party: ${card.otherPartyNote ?? "—"}`);

// ── the arithmetic a reader could check on the card itself ──────────────────
const routeSum = card.routes.reduce((s, r) => s + r.cents, 0) + card.otherRouteCents;
console.log(`\nCHECK routes shown + other        = ${formatCents(routeSum)}  vs routedCents ${formatCents(card.routedCents)}  ${routeSum === card.routedCents ? "OK" : "MISMATCH"}`);
const legSum = card.proof.linkedCents + card.proof.unpairedCents;
console.log(`CHECK linked + unpaired           = ${formatCents(legSum)}  vs movedCents  ${formatCents(card.movedCents)}  ${legSum === card.movedCents ? "OK" : "MISMATCH"}`);
const routedPlusStranded = card.routedCents + card.proof.strandedCents;
console.log(`CHECK routed + stranded           = ${formatCents(routedPlusStranded)}  vs linkedCents ${formatCents(card.proof.linkedCents)}  ${routedPlusStranded === card.proof.linkedCents ? "OK" : "MISMATCH"}`);
console.log(`CHECK stranded >= 0               : ${card.proof.strandedCents >= 0 ? "OK" : "NEGATIVE"}`);

// ── against the raw ledger, without going through the service ───────────────
const from = `${card.fromMonth}-01`;
const to = `${card.toMonth}-31`;
const idx = loadCategoryIndex(db);
const top = [...idx.byId.values()].find((c) => c.parentId === null && c.kind === "transfer")!;
const own = new Set(listAccounts(db).map((a) => transferCategoryResolver(db)([a.id])));
console.log(`\nown-account categories asked of the resolver: ${[...own].map((id) => idx.byId.get(id)!.name).join(", ")}`);

const all = activeTxnsInRange(db, from, to).filter((t) => t.categoryId !== null && idx.topLevelOf(t.categoryId).id === top.id);
const ownRows = all.filter((t) => own.has(t.categoryId!));
const raw = db
  .select({ id: transactions.id, g: transactions.transferGroupId })
  .from(transactions)
  .where(and(eq(transactions.status, "active"), gte(transactions.postedOn, from), lte(transactions.postedOn, to)))
  .all();
const groupOf = new Map(raw.map((r) => [r.id, r.g] as const));
const unlinkedAll = all.filter((t) => (groupOf.get(t.id) ?? null) === null).length;

console.log(`RAW  all transfer rows ${all.length} · own-account ${ownRows.length} · other party ${all.length - ownRows.length} · unlinked (any) ${unlinkedAll}`);
console.log(`RAW  own out legs ${ownRows.filter((t) => t.amountCents < 0).length} ${formatCents(ownRows.filter((t) => t.amountCents < 0).reduce((s, t) => s - t.amountCents, 0))}`);
console.log(`RAW  own in  legs ${ownRows.filter((t) => t.amountCents > 0).length} ${formatCents(ownRows.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0))}`);
console.log(`RAW  unlinked share of ALL transfer rows ${((unlinkedAll / all.length) * 100).toFixed(1)}% vs own-account departures ${card.proof.unpairedPct.toFixed(1)}%`);

const flow = transferFlow(db, { from, to });
console.log(`FLOW gross ${formatCents(flow.totals.grossCents)} churn ${formatCents(flow.totals.churnCents)} groups ${flow.totals.groupCount} paired ${flow.totals.pairedGroupCount} unattributed ${flow.totals.unattributedGroupCount} ${formatCents(flow.totals.unattributedCents)}`);
console.log(`FLOW agrees with card: gross ${flow.totals.grossCents === card.routedCents ? "OK" : "MISMATCH"} · churn ${flow.totals.churnCents === card.churnCents ? "OK" : "MISMATCH"}`);
