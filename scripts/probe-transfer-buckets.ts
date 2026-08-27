/**
 * READ-ONLY. The 25 unpaired departures the transfers card counts as "already
 * sitting opposite an exact-amount row", split into the buckets the owner
 * approved on 2026-08-27 — and, for each, EVERY exact mirror, so a rival is
 * visible rather than silently resolved by transferCandidates(...)[0].
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { activeTxnsInRange, loadCategoryIndex } from "@/services/analytics";
import { transferCandidates } from "@/services/transfer-links";
import { listAccounts } from "@/services/accounts";
import { transferCategoryResolver } from "@/services/transfer-links";

const db = getDb();
const FROM = "2026-02-01";
const TO = "2026-07-31";

const own = new Set(listAccounts(db).map((a) => transferCategoryResolver(db)([a.id])));
const idx = loadCategoryIndex(db);
const catOf = new Map(
  (db.all(sql.raw(`SELECT id, COALESCE(category_id,'-') c FROM transactions`)) as { id: string; c: string }[])
    .map((r) => [r.id, r.c]),
);
const descOf = new Map(
  (db.all(sql.raw(`SELECT id, COALESCE(NULLIF(normalized_description,''), raw_description) d FROM transactions`)) as { id: string; d: string }[])
    .map((r) => [r.id, r.d]),
);
const groupOf = new Map(
  (db.all(sql.raw(`SELECT id, transfer_group_id g FROM transactions`)) as { id: string; g: string | null }[])
    .map((r) => [r.id, r.g]),
);

const inRange = activeTxnsInRange(db, FROM, TO);
const unpaired = inRange
  .filter((t) => t.categoryId !== null && own.has(t.categoryId) && t.amountCents < 0 && groupOf.get(t.id) === null)
  .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.id.localeCompare(b.id));

type Bucket = "A" | "B" | "C";
const rows: { leg: (typeof unpaired)[0]; mirrors: ReturnType<typeof transferCandidates>; ownMirrors: ReturnType<typeof transferCandidates>; bucket: Bucket }[] = [];

for (const leg of unpaired) {
  const mirrors = transferCandidates(db, leg.id).filter((c) => c.amountDeltaCents === 0);
  if (mirrors.length === 0) continue; // not one of the 25
  const ownMirrors = mirrors.filter((m) => own.has(catOf.get(m.id) ?? "-"));
  const bucket: Bucket = ownMirrors.length === 1 ? "A" : ownMirrors.length === 0 ? "B" : "C";
  rows.push({ leg, mirrors, ownMirrors, bucket });
}

console.log(`unpaired departures in ${FROM}..${TO} with >=1 exact mirror: ${rows.length}`);
const sum = (b: Bucket) => rows.filter((r) => r.bucket === b).reduce((s, r) => s - r.leg.amountCents, 0);
for (const b of ["A", "B", "C"] as Bucket[]) {
  console.log(`  bucket ${b}: ${rows.filter((r) => r.bucket === b).length} legs  ${formatCents(sum(b))}`);
}
console.log(`  TOTAL    : ${rows.length} legs  ${formatCents(rows.reduce((s, r) => s - r.leg.amountCents, 0))}`);
console.log(`  A+B      : ${rows.filter((r) => r.bucket !== "C").length} legs  ${formatCents(sum("A") + sum("B"))}\n`);

for (const r of rows) {
  const catName = idx.byId.get(r.leg.categoryId!)?.name ?? "?";
  console.log(`[${r.bucket}] ${r.leg.postedOn}  ${formatCents(r.leg.amountCents).padStart(11)}  ${catName}`);
  console.log(`      OUT  ${r.leg.id}  ${String(descOf.get(r.leg.id)).slice(0, 58)}`);
  for (const m of r.mirrors) {
    const mc = idx.byId.get(catOf.get(m.id) ?? "-")?.name ?? "(uncategorized)";
    const isOwn = own.has(catOf.get(m.id) ?? "-");
    console.log(`      ${isOwn ? "own " : "  · "} ${m.id}  ${m.postedOn} d${String(m.dayDelta).padStart(2)}  ${m.accountName.padEnd(22)} ${mc.padEnd(22)} ${m.description.slice(0, 40)}`);
  }
}
