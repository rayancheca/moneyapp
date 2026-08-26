/**
 * REAL-DB WRITE. Re-normalizes the Wells Fargo rows against normalizer v2 and
 * re-runs categorization over them.
 *
 * `normalized_description` is computed at IMPORT time and stored, so teaching
 * the normalizer about the Wells Fargo envelope (`src/lib/normalize.ts`) does
 * nothing for the 39 rows already in the ledger. This backfills them.
 *
 * ⚠️ `normalized_description` is NOT part of `dedupe_hash` — that hashes the RAW
 * description precisely so the normalizer can evolve (`@/lib/hash`). So this
 * cannot create or destroy a duplicate, and a guard below asserts every raw
 * description and every dedupe hash is byte-identical afterwards.
 *
 * Scope is Wells Fargo alone, and that is measured rather than assumed: a query
 * before the write asserts that no row on any other account carries the
 * envelope, so no other key can move.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { normalizeDescription } from "@/lib/normalize";
import { categorizeAll } from "@/services/categorize";

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const num = (q: string): number => one<{ v: number }>(q).v;
const str = (q: string): string => one<{ v: string }>(q).v;

const netCents = () => num("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
const rowCount = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active'");
const rawText = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||raw_description x FROM transactions ORDER BY id)");
const hashes = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||dedupe_hash x FROM transactions ORDER BY id)");
const balances = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)");
const normText = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||normalized_description x FROM transactions ORDER BY id)");
const catText = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(category_id,'-') x FROM transactions ORDER BY id)");

// ── scope, measured ──────────────────────────────────────────────────
const ENVELOPE = `(raw_description LIKE 'PURCHASE AUTHORIZED ON%'
  OR raw_description LIKE 'RECURRING PAYMENT AUTHORIZED ON%'
  OR raw_description LIKE 'PURCHASE WITH CASH BACK%')`;
const strays = num(`SELECT COUNT(*) v FROM transactions t JOIN accounts a ON a.id=t.account_id
                    WHERE ${ENVELOPE} AND a.last4 <> '5481'`);
if (strays > 0) throw new Error(`${strays} rows outside Wells Fargo carry the envelope — widen the guard before running`);

const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-renormalize-wf.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

type Row = { id: string; raw_description: string; normalized_description: string };
const wf = db.all(sql.raw(`SELECT t.id, t.raw_description, t.normalized_description
  FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.last4='5481'`)) as Row[];

const before = {
  net: netCents(),
  rows: rowCount(),
  raws: rawText(),
  hashes: hashes(),
  balances: balances(),
  norms: normText(),
  cats: catText(),
  uncategorized: num(`SELECT COUNT(*) v FROM transactions t JOIN accounts a ON a.id=t.account_id
                      WHERE a.last4='5481' AND t.status='active' AND t.category_id IS NULL`),
};

const changed = wf.filter((r) => normalizeDescription(r.raw_description) !== r.normalized_description);
console.log(`${wf.length} Wells Fargo rows · ${changed.length} normalize differently under v2\n`);
for (const r of changed.slice(0, 4)) {
  console.log(`  ${JSON.stringify(r.normalized_description.slice(0, 56))}`);
  console.log(`    → ${JSON.stringify(normalizeDescription(r.raw_description))}`);
}
if (changed.length > 4) console.log(`  … and ${changed.length - 4} more\n`);

const now = new Date().toISOString();
for (const r of changed) {
  db.run(
    sql`UPDATE transactions SET normalized_description = ${normalizeDescription(r.raw_description)}, updated_at = ${now}
        WHERE id = ${r.id}`,
  );
}
// merchant + rule matching reads normalized_description, so it must run after
categorizeAll(db);

// ── guards ───────────────────────────────────────────────────────────
const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(34)} ${detail}`);
  if (!ok) failures.push(name);
};

const afterNorms = new Map(
  (db.all(sql.raw("SELECT id, normalized_description n FROM transactions")) as { id: string; n: string }[]).map((r) => [r.id, r.n]),
);
const wfIds = new Set(wf.map((r) => r.id));

/**
 * ⚠️ Snapshot ONCE, outside the comparison. Written as
 * `before.split(",").filter((p, i) => p !== after().split(",")[i])` this
 * re-queries the whole table and re-splits a 10,111-element string for EVERY
 * element — O(n²) with a database round trip per step. It exhausted the V8
 * heap on the first trial run of this very script, after the write had already
 * landed. The guard is the riskiest code in the pass, every time.
 */
const afterNormsText = normText().split(",");
const afterCatsText = catText().split(",");
const movedNorms = before.norms.split(",").filter((p, i) => p !== afterNormsText[i]).length;

guard("net worth", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("RAW descriptions untouched", before.raws === rawText(), "byte-identical");
guard("dedupe hashes untouched", before.hashes === hashes(), "no duplicate created or destroyed");
guard("daily_balances", before.balances === balances(), "untouched");
guard("only Wells Fargo re-normalized", movedNorms === changed.length, `${movedNorms} of ${changed.length}`);
guard(
  "every re-normalized row is Wells Fargo",
  changed.every((r) => wfIds.has(r.id)),
  `${changed.length} rows`,
);
guard(
  "each landed on v2's answer",
  changed.every((r) => afterNorms.get(r.id) === normalizeDescription(r.raw_description)),
  "verified row by row",
);

const uncategorizedAfter = num(`SELECT COUNT(*) v FROM transactions t JOIN accounts a ON a.id=t.account_id
                                WHERE a.last4='5481' AND t.status='active' AND t.category_id IS NULL`);
console.log(`\n  uncategorized Wells Fargo rows: ${before.uncategorized} → ${uncategorizedAfter}`);
// Categorization is allowed to move rows — that is the point — but ONLY on the
// account being re-normalized. A category change anywhere else means
// categorizeAll found something this pass did not intend to touch.
const catChangedIds = before.cats
  .split(",")
  .filter((p, i) => p !== afterCatsText[i])
  .map((p) => p.split(":")[0]!);
guard(
  "no category moved off Wells Fargo",
  catChangedIds.every((id) => wfIds.has(id)),
  `${catChangedIds.length} category changes, all on Wells Fargo`,
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
