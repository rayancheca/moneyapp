/** READ-ONLY. Precondition check for the 21-leg link: collisions, splits, review, categories. */
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { activeTxnsInRange } from "@/services/analytics";
import { transferCandidates, transferCategoryResolver } from "@/services/transfer-links";
import { listAccounts } from "@/services/accounts";
import { hasSplits } from "@/services/transaction-splits";

const db = getDb();
const own = new Set(listAccounts(db).map((a) => transferCategoryResolver(db)([a.id])));
const catOf = new Map((db.all(sql.raw(`SELECT id, COALESCE(category_id,'-') c FROM transactions`)) as any[]).map((r) => [r.id, r.c]));
const groupOf = new Map((db.all(sql.raw(`SELECT id, transfer_group_id g FROM transactions`)) as any[]).map((r) => [r.id, r.g]));
const raw = new Map((db.all(sql.raw(`SELECT id, raw_description d, needs_review nr, account_id ac FROM transactions`)) as any[]).map((r) => [r.id, r]));

const unpaired = activeTxnsInRange(db, "2026-02-01", "2026-07-31")
  .filter((t) => t.categoryId !== null && own.has(t.categoryId) && t.amountCents < 0 && groupOf.get(t.id) === null)
  .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.id.localeCompare(b.id));

const plan: { outId: string; inId: string; cents: number; day: string }[] = [];
for (const leg of unpaired) {
  const mirrors = transferCandidates(db, leg.id).filter((c) => c.amountDeltaCents === 0);
  if (mirrors.length === 0) continue;
  const ownM = mirrors.filter((m) => own.has(catOf.get(m.id) ?? "-"));
  if (ownM.length === 1) plan.push({ outId: leg.id, inId: ownM[0]!.id, cents: -leg.amountCents, day: leg.postedOn });
  else if (ownM.length === 0) {
    if (mirrors.length !== 1) { console.log(`!! bucket B leg ${leg.id} has ${mirrors.length} mirrors — ambiguous`); continue; }
    plan.push({ outId: leg.id, inId: mirrors[0]!.id, cents: -leg.amountCents, day: leg.postedOn });
  }
}
console.log(`plan: ${plan.length} pairs, ${formatCents(plan.reduce((s, p) => s + p.cents, 0))}`);

// ── collisions ──────────────────────────────────────────────────────
const seen = new Map<string, string>();
let collisions = 0;
for (const p of plan) {
  for (const id of [p.outId, p.inId]) {
    const prior = seen.get(id);
    if (prior) { console.log(`!! COLLISION ${id} used by ${prior} and ${p.outId}`); collisions++; }
    seen.set(id, p.outId);
  }
}
console.log(`distinct rows touched: ${seen.size} (expect ${plan.length * 2})   collisions: ${collisions}`);

// ── per-leg preconditions ───────────────────────────────────────────
let splits = 0, review = 0, sameAcct = 0, alreadyLinked = 0, uncat = 0;
for (const p of plan) {
  for (const id of [p.outId, p.inId]) {
    if (hasSplits(db, id)) { console.log(`!! split ${id}`); splits++; }
    if (raw.get(id).nr) { console.log(`   needs_review: ${id} ${String(raw.get(id).d).slice(0,40)}`); review++; }
    if (groupOf.get(id) !== null) { console.log(`!! already linked ${id}`); alreadyLinked++; }
    if (catOf.get(id) === "-") { console.log(`   uncategorized: ${id} ${String(raw.get(id).d).slice(0,50)}`); uncat++; }
  }
  if (raw.get(p.outId).ac === raw.get(p.inId).ac) { console.log(`!! same account ${p.outId}`); sameAcct++; }
}
console.log(`splits ${splits} · needs_review ${review} · already-linked ${alreadyLinked} · same-account ${sameAcct} · uncategorized ${uncat}`);

// ── which pairs would CHANGE category ────────────────────────────────
let catChanges = 0;
for (const p of plan) {
  const target = transferCategoryResolver(db)([raw.get(p.outId).ac, raw.get(p.inId).ac]);
  for (const id of [p.outId, p.inId]) {
    if (catOf.get(id) !== target) { console.log(`   cat change: ${id} ${catOf.get(id)} -> ${target}`); catChanges++; }
  }
}
console.log(`category changes: ${catChanges}`);

console.log(`\nthe WF opening-deposit pair, full descriptions:`);
for (const p of plan.filter((p) => p.cents === 2500)) {
  console.log(`  OUT ${p.outId}  ${raw.get(p.outId).d}`);
  console.log(`  IN  ${p.inId}  ${raw.get(p.inId).d}`);
}
console.log(JSON.stringify(plan, null, 0).slice(0, 200));
