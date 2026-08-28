/**
 * REAL-DB WRITE (dry-run by default). One merchant that is not a merchant.
 *
 * ## What is wrong, and how it was found
 *
 * `/merchants/019f4ccc-63e2-7287-8107-69d90e3233cf` did not render. It answered
 * with the error boundary, because `claude-categorize` created a merchant whose
 * canonical name is literally **`<UNKNOWN>`** and every insight surface puts a
 * merchant's name into a fact subject — which `insight-facts` refuses (`< > { }
 * \` could be re-read as a slot by the READ gate) by THROWING.
 *
 * The crash is closed in code: the write boundaries now refuse such a name and
 * the surfaces decline to speak rather than throw. This script is about the
 * DATA the old code left behind.
 *
 * ## ⛔ It is not a rename, and that is the whole point
 *
 * `<UNKNOWN>` is the model saying "I don't know", so four unrelated descriptors
 * were filed as ONE merchant, each at 0.3–0.4 confidence:
 *
 *     2026-01-28   -$151.13   COT*FLT844-422-6922DE                    Other Travel
 *     2024-09-01    -$10.32   STORE BRONX NYAPPLE PAY ENDING IN 3883   General
 *     2024-12-07     -$1.94   STORE BRONX NYAPPLE PAY ENDING IN 4600   General
 *     2026-07-31    -$69.90   S MIAMI AVE. MIAMI                       General
 *
 * A flight booking, two card taps at a Bronx store and a Miami street address
 * are four things. Giving them one printable name would cement that, and the
 * four `exact` ALIASES would keep pulling future imports into the same bucket —
 * one merchant identity standing for four, permanently, which is the
 * one-merchant-two-things error the WEIXIN pass exists to avoid.
 *
 * So the rows are UNLINKED and the merchant is removed with its aliases.
 *
 * ## ⛔ What is deliberately NOT touched
 *
 * Their CATEGORIES. Each row is separately categorized and each is plausible;
 * a merchant identity and a category are two decisions, and this script only
 * has evidence about the first. Guards assert all four categories survive, so
 * no money moves between buckets and neither income nor spending changes.
 *
 * They also do not return to the Claude queue: `pendingMerchantQueue` asks for
 * rows with no category AND no merchant, and these keep their categories. The
 * fix costs nothing to re-run against the API.
 *
 * ## How to run it
 *
 *     npx tsx scripts/unlink-unknown-merchant.ts            # DRY RUN (default)
 *     npx tsx scripts/unlink-unknown-merchant.ts --apply    # writes
 *
 * The dry run is a real rehearsal on a SQLite `.backup` copy (⚠️ never `cp` —
 * that drops the `-wal` and copies a torn file). ⚠️ `--apply` needs the dev
 * server stopped: it holds the real database open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { isPrintableName } from "@/lib/printable-name";
import { formatCents } from "@/lib/money";
import { withPreMutationSnapshot } from "../src/db/backup";

const APPLY = process.argv.includes("--apply");

/** Identified by the property that is wrong, not by an id pasted from a probe. */
const BAD_NAME = "<UNKNOWN>";

interface Snapshot {
  rowSum: number;
  rows: number;
  income: number;
  expense: number;
  merchants: number;
  aliases: number;
  /** `postedOn|amountCents|categoryName` for the four rows, in a stable order */
  targetRows: string[];
  unprintableMerchants: number;
  seriesPointingAtTarget: number;
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
    sql.raw(`SELECT id, mapping_source FROM merchants WHERE canonical_name='${BAD_NAME}'`),
  ) as { id: string; mapping_source: string }[];
  if (rows.length !== 1) throw new Error(`expected exactly one "${BAD_NAME}" merchant, found ${rows.length}`);
  if (rows[0]!.mapping_source !== "claude") {
    throw new Error(`expected a model-written mapping, found "${rows[0]!.mapping_source}"`);
  }
  return rows[0]!.id;
}

/**
 * The four rows by their CONTENT, so the guard compares what a reader would
 * see rather than a foreign key that is about to change on purpose.
 */
function targetRowKeys(db: AppDatabase, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const list = ids.map((i) => `'${i}'`).join(",");
  return (
    db.all(
      sql.raw(`SELECT t.posted_on d, t.amount_cents a, COALESCE(c.name,'—') c, t.normalized_description n
               FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
               WHERE t.id IN (${list}) ORDER BY t.posted_on, t.id`),
    ) as { d: string; a: number; c: string; n: string }[]
  ).map((r) => `${r.d}|${r.a}|${r.c}|${r.n}`);
}

function snapshot(db: AppDatabase, rowIds: string[]): Snapshot {
  const badNames = (db.all(sql.raw("SELECT canonical_name v FROM merchants")) as { v: string }[]).filter(
    (r) => !isPrintableName(r.v),
  );
  return {
    rowSum: num(db, "SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'"),
    rows: num(db, "SELECT COUNT(*) v FROM transactions WHERE status='active'"),
    income: kindTotal(db, "income"),
    expense: kindTotal(db, "expense"),
    merchants: num(db, "SELECT COUNT(*) v FROM merchants"),
    aliases: num(db, "SELECT COUNT(*) v FROM merchant_aliases"),
    targetRows: targetRowKeys(db, rowIds),
    unprintableMerchants: badNames.length,
    seriesPointingAtTarget: 0,
  };
}

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(40)} ${detail}`);
  if (!ok) failures.push(name);
};

function run(db: AppDatabase, label: string): void {
  const id = targetId(db);
  const rowIds = (
    db.all(sql.raw(`SELECT id FROM transactions WHERE merchant_id='${id}'`)) as { id: string }[]
  ).map((r) => r.id);
  const seriesBefore = num(db, `SELECT COUNT(*) v FROM recurring_series WHERE merchant_id='${id}'`);
  const aliasesBefore = num(db, `SELECT COUNT(*) v FROM merchant_aliases WHERE merchant_id='${id}'`);
  const before = snapshot(db, rowIds);

  console.log(`\n${label}`);
  console.log(`  merchant ${id}  "${BAD_NAME}"  (mapping_source=claude)`);
  for (const key of before.targetRows) console.log(`    ${key}`);
  console.log(`  ${aliasesBefore} alias(es), ${seriesBefore} recurring series pointing here`);

  /*
   * ⛔ A series pointing at this merchant would make the unlink a change to a
   * commitment, which is not what this script has evidence about. Refused
   * rather than handled: there are none, and a future one deserves a decision
   * rather than a default.
   */
  if (seriesBefore !== 0) throw new Error(`${seriesBefore} recurring series reference this merchant — stopping`);

  db.transaction((tx) => {
    tx.run(sql.raw(`UPDATE transactions SET merchant_id=NULL WHERE merchant_id='${id}'`));
    tx.run(sql.raw(`DELETE FROM merchant_aliases WHERE merchant_id='${id}'`));
    tx.run(sql.raw(`DELETE FROM merchants WHERE id='${id}'`));
  });

  const after = snapshot(db, rowIds);

  console.log(`\n  guards`);
  guard("the merchant is gone", num(db, `SELECT COUNT(*) v FROM merchants WHERE id='${id}'`) === 0, id);
  guard("no merchant is left the app cannot name", after.unprintableMerchants === 0, `was ${before.unprintableMerchants}`);
  guard("exactly one merchant removed", before.merchants - after.merchants === 1, `${before.merchants} → ${after.merchants}`);
  guard("its aliases went with it", before.aliases - after.aliases === aliasesBefore, `${before.aliases} → ${after.aliases}`);
  guard("its rows are unlinked, not deleted", num(db, `SELECT COUNT(*) v FROM transactions WHERE merchant_id='${id}'`) === 0 && rowIds.length === 4, `${rowIds.length} rows`);
  guard("every row keeps its day, amount and category", JSON.stringify(before.targetRows) === JSON.stringify(after.targetRows), `${after.targetRows.length} rows identical`);
  guard("ledger row sum (not net worth)", before.rowSum === after.rowSum, formatCents(after.rowSum));
  guard("active row count", before.rows === after.rows, `${after.rows}`);
  guard("INCOME unchanged", before.income === after.income, formatCents(after.income));
  guard("SPENDING unchanged", before.expense === after.expense, formatCents(-after.expense));
}

if (APPLY) {
  const db = getDb();
  withPreMutationSnapshot(db, "unlink-unknown-merchant", () => {
    run(db, "APPLYING to data/moneyapp.db");
  });
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rehearse-"));
  const copy = path.join(dir, "rehearsal.db");
  const live = new Database(process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db", { readonly: true });
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
