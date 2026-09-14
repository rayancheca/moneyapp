/**
 * REAL-DB WRITE (dry-run by default). One merchant's NAME, and nothing else.
 *
 * ## What is wrong
 *
 * His rent is filed under a merchant called **"Flamingos Restaurant"**. It is an
 * apartment building. The row is
 *
 *     2026-07-08   -$2,285.70   ETT*043257FlamingoSout 801-8775491 CO   07/07
 *
 * and the descriptor is where the mistake came from: `FlamingoSout` is
 * *Flamingo South Beach*, truncated by the processor, and the merchant mapper
 * guessed a restaurant. It has been on the standing open list for six handoffs.
 *
 * ⛔ **Only the NAME is wrong.** Measured before writing anything: the row is
 * already categorized `Rent`, and already linked to the recurring series
 * `Flamingo South Beach (rent)`. So this is a label fix on his largest monthly
 * expense — the thing he actually reads on `/merchants/[id]` and in
 * `/spending`'s top-merchants list — and it moves no money, no category and no
 * series link.
 *
 * ## ⛔ What must NOT be touched
 *
 * There is a **second, real** Flamingo in the ledger: `Flamingo Food Market`,
 * 2 rows totalling $17.95, `FLAMINGO FOOD MARKET MIAMI BEACH FL`. That is a
 * genuine corner shop in Miami Beach and it is correctly named. Merging the two
 * because they share a word would file his rent as groceries — the same
 * one-merchant-two-things error the WEIXIN pass was built to avoid, run
 * backwards. A guard asserts it is untouched.
 *
 * ## The new name is BORROWED, not invented
 *
 * `Flamingo South Beach` is what the app already calls this commitment: it is
 * the `recurring_series.name` the row is linked to. Inventing a third spelling
 * for one landlord would be a second name for one thing, which is the defect
 * this repo keeps paying for elsewhere.
 *
 * ## How to run it
 *
 *     npx tsx scripts/rename-flamingo-merchant.ts            # DRY RUN (default)
 *     npx tsx scripts/rename-flamingo-merchant.ts --apply    # writes
 *
 * The dry run is a real rehearsal, not a description: it takes a SQLite
 * `.backup` of the live database (⚠️ never `cp` — that drops the `-wal` and
 * copies a torn file), performs the rename on the copy, and runs every guard
 * against it. What you read is what would happen.
 *
 * ⚠️ `--apply` needs the dev server stopped — it holds the real DB open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { withPreMutationSnapshot } from "../src/db/backup";
import { formatCents } from "@/lib/money";
import { renameMerchant } from "@/services/merchants";

const APPLY = process.argv.includes("--apply");

/** The row's descriptor, so the target is identified by evidence and not by id. */
const DESCRIPTOR_LIKE = "%FlamingoSout%";
const OLD_NAME = "Flamingos Restaurant";
const NEW_NAME = "Flamingo South Beach";
/** The other Flamingo, which is a real shop and must survive untouched. */
const BYSTANDER = "Flamingo Food Market";

interface Snapshot {
  /**
   * ⚠️ The SUM OF EVERY ACTIVE ROW, which is NOT net worth — net worth is
   * assets minus liabilities off balances and holdings. Named honestly because
   * the sibling write scripts call this `netCents()` and it happens to evaluate
   * to $35,530.89, a figure the handoffs specifically flag as a STALE net-worth
   * number (the real one is $111,531.75). A guard whose label is wrong about
   * what it measured is worse than no guard.
   */
  rowSum: number;
  rows: number;
  income: number;
  expense: number;
  merchants: number;
  bystanderRows: number;
  targetRows: number;
  targetCategory: string | null;
  targetSeries: string | null;
}

const num = (db: AppDatabase, q: string): number =>
  ((db.get(sql.raw(q)) as { v: number | null } | undefined)?.v ?? 0) as number;

const kindTotal = (db: AppDatabase, kind: string): number =>
  num(
    db,
    `SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
     JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
     WHERE t.status='active' AND COALESCE(p.kind,c.kind)='${kind}'`,
  );

function targetId(db: AppDatabase): string {
  const rows = db.all(
    sql.raw(`SELECT DISTINCT m.id, m.canonical_name FROM transactions t
             JOIN merchants m ON m.id=t.merchant_id
             WHERE t.status='active' AND t.raw_description LIKE '${DESCRIPTOR_LIKE}'`),
  ) as { id: string; canonical_name: string }[];
  if (rows.length !== 1) {
    throw new Error(`expected exactly one merchant behind ${DESCRIPTOR_LIKE}, found ${rows.length}`);
  }
  if (rows[0]!.canonical_name !== OLD_NAME) {
    throw new Error(`expected "${OLD_NAME}", found "${rows[0]!.canonical_name}" — already renamed?`);
  }
  return rows[0]!.id;
}

function snapshot(db: AppDatabase, id: string): Snapshot {
  const meta = db.get(
    sql.raw(`SELECT c.name cat, rs.name series FROM transactions t
             LEFT JOIN categories c ON c.id=t.category_id
             LEFT JOIN recurring_series rs ON rs.id=t.recurring_series_id
             WHERE t.merchant_id='${id}' AND t.status='active' LIMIT 1`),
  ) as { cat: string | null; series: string | null } | undefined;
  return {
    rowSum: num(db, "SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'"),
    rows: num(db, "SELECT COUNT(*) v FROM transactions WHERE status='active'"),
    income: kindTotal(db, "income"),
    expense: kindTotal(db, "expense"),
    merchants: num(db, "SELECT COUNT(*) v FROM merchants"),
    bystanderRows: num(
      db,
      `SELECT COUNT(*) v FROM transactions t JOIN merchants m ON m.id=t.merchant_id
       WHERE m.canonical_name='${BYSTANDER}' AND t.status='active'`,
    ),
    targetRows: num(db, `SELECT COUNT(*) v FROM transactions WHERE merchant_id='${id}' AND status='active'`),
    targetCategory: meta?.cat ?? null,
    targetSeries: meta?.series ?? null,
  };
}

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(38)} ${detail}`);
  if (!ok) failures.push(name);
};

function run(db: AppDatabase, label: string): void {
  const id = targetId(db);
  const before = snapshot(db, id);

  console.log(`\n${label}`);
  console.log(`  merchant ${id}`);
  console.log(`    "${OLD_NAME}"  →  "${NEW_NAME}"`);
  console.log(
    `    ${before.targetRows} row(s), category ${before.targetCategory}, series ${before.targetSeries}`,
  );

  const result = renameMerchant(db, id, NEW_NAME);
  const after = snapshot(db, id);

  console.log(`\n  guards`);
  guard("the merchant is renamed", (db.get(sql.raw(`SELECT canonical_name v FROM merchants WHERE id='${id}'`)) as { v: string }).v === NEW_NAME, NEW_NAME);
  /*
   * `renameMerchant` keeps the OLD name as a `contains` alias so a future import
   * whose descriptor still carries it resolves here rather than minting a second
   * merchant. That is the service's own contract, asserted rather than assumed.
   */
  guard("the old name survives as an alias", result.aliasCreated, `"${OLD_NAME}" → contains`);
  guard("no merchant created or deleted", before.merchants === after.merchants, `${after.merchants}`);
  // ⛔ before === after, not a literal count: the shop is a real, growing merchant —
  // it held 2 rows when this was written and 4 by 2026-09-14, and a pinned 2 failed the
  // guard on a ledger where nothing about it had changed
  guard("the other Flamingo is untouched", before.bystanderRows === after.bystanderRows, `${BYSTANDER}: ${after.bystanderRows} rows`);
  guard("its rows stay with it", before.targetRows === after.targetRows, `${after.targetRows}`);
  guard("category unchanged", before.targetCategory === after.targetCategory, `${after.targetCategory}`);
  guard("series link unchanged", before.targetSeries === after.targetSeries, `${after.targetSeries}`);
  guard("ledger row sum (not net worth)", before.rowSum === after.rowSum, formatCents(after.rowSum));
  guard("active row count", before.rows === after.rows, `${after.rows}`);
  guard("INCOME unchanged", before.income === after.income, formatCents(after.income));
  guard("SPENDING unchanged", before.expense === after.expense, formatCents(-after.expense));
}

if (APPLY) {
  const db = getDb();
  withPreMutationSnapshot(db, "rename-flamingo-merchant", () => {
    run(db, "APPLYING to data/moneyapp.db");
  });
} else {
  /*
   * A rehearsal on a real copy, not a description of one. `.backup` rather than
   * `cp`: copying a live SQLite file drops the `-wal` and yields a torn database
   * that would rehearse against the wrong bytes.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rehearse-"));
  const copy = path.join(dir, "rehearsal.db");
  const live = new Database(process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db", { readonly: true });
  /*
   * ⚠️ No `wal_checkpoint` first. It is the obvious thing to reach for and it
   * throws `SQLITE_IOERR_WRITE` on a readonly handle — a checkpoint writes. It
   * is also unnecessary: SQLite's online-backup API, which this wraps, already
   * reads through the WAL. Checkpointing would have meant opening the live
   * database for WRITING just to rehearse a change on a copy.
   */
  await live.backup(copy);
  live.close();

  const bundle = createDatabase(copy);
  run(bundle.db, "DRY RUN on a .backup copy — the live database is untouched");
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  (dry run — re-run with --apply to write, with the dev server stopped)`);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} guard(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ all guards passed`);
