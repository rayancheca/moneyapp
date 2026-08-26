/**
 * Tags the August rent payment — which arrived on the Wells Fargo statement
 * imported today — to the rent series it belongs to.
 *
 * ## Why this write exists
 *
 * `Flamingo South Beach (rent)` last had a TAGGED posting on 2026-07-08. The
 * August payment is in the ledger (Wells Fargo, 2026-08-04, $2,237.11, check
 * 043257) but nothing linked it, because importing a statement does not run
 * series detection. So the recurring layer believed rent had gone quiet for 49
 * days, and at the old 48-day forecast tolerance it dropped rent from
 * `upcomingOccurrences` entirely: the runway card reported "Committed bills
 * come to $782.41 a month" against a true $3,068.11.
 *
 * The tolerance half of that is fixed in `recurring.ts` (`LAPSED_MISS_LIMIT`).
 * This is the other half: the ledger should also know he actually paid.
 *
 * ## Why the row and the series really do belong together
 *
 *   row     2026-08-04  −$2,237.11  "043257 Flamingo Rent 260803 xxxxx3120 …"
 *   series  Flamingo South Beach (rent), monthly, 3 tagged postings
 *
 * Same payee, same purpose, same month the series expected one. The amount
 * differs from the series' $2,285.70 average, which is expected — its three
 * tagged postings are already three DIFFERENT amounts.
 *
 * Owner approved on 2026-08-26, choosing "tag the row AND fix the lapse rule".
 *
 * Read-only without `--confirm`. Takes a restore point first.
 */
import { getDbBundle } from "@/db/client";
import { manualSnapshot } from "@/db/backup";
import { sql } from "drizzle-orm";
import { attachTransactions } from "@/services/recurring-links";
import { committedBook } from "@/services/committed";

const CONFIRMED = process.argv.includes("--confirm");
const TODAY = "2026-08-26";

const bundle = getDbBundle();
const db = bundle.db;

const series = (
  db.all(
    sql.raw(`SELECT id, name, last_matched_on FROM recurring_series WHERE name = 'Flamingo South Beach (rent)'`),
  ) as { id: string; name: string; last_matched_on: string | null }[]
)[0];
if (!series) throw new Error("no 'Flamingo South Beach (rent)' series — refusing to guess which series this is");

const rows = db.all(
  sql.raw(`
    SELECT t.id, t.posted_on, t.amount_cents, t.raw_description, t.recurring_series_id
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 'active'
      AND a.name LIKE 'Wells Fargo%'
      AND t.raw_description LIKE '%Flamingo Rent%'`),
) as { id: string; posted_on: string; amount_cents: number; raw_description: string; recurring_series_id: string | null }[];

// ⛔ exactly one, or stop. A LIKE that matched two rows would mean the statement
// carried two rent payments and this script has no opinion about which is which.
if (rows.length !== 1) throw new Error(`expected exactly 1 Wells Fargo rent row, found ${rows.length}`);
const row = rows[0]!;
if (row.recurring_series_id !== null) throw new Error(`row is already linked to ${row.recurring_series_id} — nothing to do`);

const before = committedBook(db, TODAY);
console.log("SERIES  ", series.name, "· last matched", series.last_matched_on);
console.log("ROW     ", row.posted_on, `$${(row.amount_cents / 100).toFixed(2)}`, row.raw_description.slice(0, 52));
console.log("BEFORE  committed bills:", `$${(before.perMonthCents / 100).toFixed(2)}/mo`, `(${before.lines.length} lines)`);

if (!CONFIRMED) {
  console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
  process.exit(0);
}

// ⚠️ the RAW handle, not the drizzle wrapper — manualSnapshot runs sqlite's own
// .backup, which is the only copy that takes the -wal with it (pass 44)
const snapshot = manualSnapshot(bundle.sqlite);
console.log("\nRestore point:", snapshot);

const result = attachTransactions(db, series.id, [row.id], TODAY);
const after = committedBook(db, TODAY);
const settled = (
  db.all(sql.raw(`SELECT last_matched_on FROM recurring_series WHERE id = '${series.id}'`)) as {
    last_matched_on: string | null;
  }[]
)[0]!;

console.log("attached:", result.attached);
console.log("AFTER   committed bills:", `$${(after.perMonthCents / 100).toFixed(2)}/mo`, `(${after.lines.length} lines)`);
console.log("        last matched:", series.last_matched_on, "→", settled.last_matched_on);
console.log("        delta:", `$${((after.perMonthCents - before.perMonthCents) / 100).toFixed(2)}/mo`);
