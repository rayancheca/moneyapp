/**
 * Measures what a version bump of `chase-spending-report-pdf` does to Chase Sapphire — the re-read of
 * "Spending Report PDF (1).pdf" beside the card statement that covers the same July days — and whether the two files
 * leave the same ledger whichever order they are read in.
 *
 * ⛔ Reads a COPY of whatever `--from=<db>` names and writes only inside the scratch directory it is given; it never
 * opens the real ledger for writing, and its originals and backups go to the scratch directory too.
 *
 *   tsx scripts/probe-identity-transaction-day.ts --from=<db> --scratch=<dir> [--mode=reread|report-first|statement-first]
 *
 * `reread` (the default) is the owner's scenario: the profile ships a new version and he drops the report again.
 * `report-first` and `statement-first` un-import the report and both downloads of the August statement, then read the
 * two files back in the named order — the ledger they leave must be the same one, and the digests printed here are
 * what says so.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { createDatabase, type AppDatabase } from "@/db/client";
import { importStatementFiles, unimportFile } from "@/services/import/service";
import { chaseSpendingReportPdf } from "@/services/import/profiles/spending-report-profile";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const SOURCE = flag("from") ?? "";
const SCRATCH = flag("scratch") ?? "";
const MODE = flag("mode") ?? "reread";
if (SOURCE === "" || SCRATCH === "" || !["reread", "report-first", "statement-first"].includes(MODE)) {
  console.error("usage: tsx scripts/probe-identity-transaction-day.ts --from=<db> --scratch=<dir> [--mode=reread|report-first|statement-first]");
  process.exit(1);
}

const REPORT = "Spending Report PDF (1).pdf";
const STATEMENT = "20260802-statements-9805-.pdf";
/** the same August statement downloaded a second time — it holds no rows of its own, and an un-import hands it the first's */
const STATEMENT_COPY = "20260802-statements-9805- (1).pdf";
const PERIOD = { start: "2026-07-03", end: "2026-08-02" };

const workDir = path.join(SCRATCH, `probe-${MODE}`);
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(path.join(workDir, "originals"), { recursive: true });
fs.mkdirSync(path.join(workDir, "backups"), { recursive: true });
process.env.MONEYAPP_ORIGINALS_DIR = path.join(workDir, "originals");
process.env.MONEYAPP_BACKUPS_DIR = path.join(workDir, "backups");
const DB_PATH = path.join(workDir, "copy.db");

interface Row {
  [column: string]: unknown;
}

function sqliteOf(db: AppDatabase): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

function all(db: AppDatabase, sql: string): Row[] {
  return sqliteOf(db).prepare(sql).all() as Row[];
}

/** One line per row, ordered, hashed — a table's content, free of the ids a re-import reassigns. */
function digest(db: AppDatabase, label: string, sql: string): string {
  const rows = all(db, sql).map((r) => Object.values(r).map((v) => String(v ?? "")).join("|"));
  return `${label}: ${String(rows.length).padStart(6)} rows ${crypto.createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16)}`;
}

const DIGESTS: { label: string; sql: string }[] = [
  {
    /**
     * The charges themselves, by the day each was MADE — `transacted_on` where a source knows it, else the posted day.
     * The two files agree about that day, so this digest cannot depend on which of them was read first; which source's
     * row records a charge both print does depend on it, by design (the first to record the money owns the row), and
     * that is what the raw `transactions` digest below shows.
     */
    label: "charges  ",
    sql: `SELECT a.name, IFNULL(t.transacted_on, t.posted_on) AS made_on, t.amount_cents, t.status
            FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE t.status != 'superseded'
           ORDER BY a.name, made_on, t.amount_cents, t.status`,
  },
  {
    label: "txns     ",
    sql: `SELECT a.name, t.posted_on, t.transacted_on, t.amount_cents, t.normalized_description, t.status, t.occurrence_index
            FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE t.status != 'superseded'
           ORDER BY a.name, t.posted_on, t.amount_cents, t.normalized_description, t.occurrence_index, t.status`,
  },
  {
    label: "balances ",
    sql: `SELECT a.name, d.day, d.balance_cents FROM daily_balances d JOIN accounts a ON a.id = d.account_id
           ORDER BY a.name, d.day`,
  },
  {
    label: "periods  ",
    sql: `SELECT a.name, p.period_start, p.period_end, p.beginning_balance_cents, p.ending_balance_cents, p.reconciliation, p.gap_cents
            FROM statement_periods p JOIN accounts a ON a.id = p.account_id
           ORDER BY a.name, p.period_start, p.period_end`,
  },
  {
    label: "anchors  ",
    sql: `SELECT a.name, b.anchored_on, b.balance_cents, b.source FROM balance_anchors b JOIN accounts a ON a.id = b.account_id
           ORDER BY a.name, b.anchored_on, b.source, b.balance_cents`,
  },
];

function sapphireFigures(db: AppDatabase): string[] {
  const period = all(
    db,
    `SELECT p.reconciliation, IFNULL(p.gap_cents, 0) AS gap FROM statement_periods p JOIN accounts a ON a.id = p.account_id
      WHERE a.name LIKE '%Sapphire%' AND p.period_start = '${PERIOD.start}' AND p.period_end = '${PERIOD.end}'`,
  );
  const quarantined = all(
    db,
    `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.name LIKE '%Sapphire%' AND t.status = 'quarantined' AND t.posted_on BETWEEN '${PERIOD.start}' AND '${PERIOD.end}'`,
  );
  const vending = all(
    db,
    `SELECT t.posted_on, IFNULL(t.transacted_on,'-') AS tr, COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.name LIKE '%Sapphire%' AND t.amount_cents = -125 AND t.status IN ('active','excluded')
        AND t.posted_on BETWEEN '2026-07-06' AND '2026-07-10'
      GROUP BY t.posted_on, tr ORDER BY t.posted_on, tr`,
  );
  const live = all(
    db,
    `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.name LIKE '%Sapphire%' AND t.status IN ('active','excluded') AND t.posted_on BETWEEN '${PERIOD.start}' AND '${PERIOD.end}'`,
  );
  return [
    `  period ${PERIOD.start}..${PERIOD.end}: ${String(period[0]?.reconciliation ?? "MISSING")} gap ${String(period[0]?.gap ?? "-")}`,
    `  quarantined in period: ${String(quarantined[0]?.n)}`,
    `  live rows in period:   ${String(live[0]?.n)}`,
    `  -$1.25 rows 07-06..07-10: ${vending.map((v) => `${String(v.posted_on)}/tx ${String(v.tr)} x${String(v.n)}`).join(", ")}`,
  ];
}

interface FileRow {
  id: string;
  storagePath: string;
  version: number;
}

function fileRow(db: AppDatabase, name: string): FileRow {
  const row = all(
    db,
    `SELECT id, storage_path, parser_version FROM import_files
      WHERE file_name = '${name.replace(/'/g, "''")}' AND status IN ('parsed','parsed_with_claude')`,
  )[0];
  if (row === undefined) throw new Error(`${name} is not imported in this copy`);
  return { id: String(row.id), storagePath: String(row.storage_path), version: Number(row.parser_version) };
}

const report = (outcomes: { status: string; inserted: number; deduped: number; dedupedCrossFormat: number; quarantined: number }[]): string =>
  outcomes.map((o) => `${o.status} inserted=${o.inserted} deduped=${o.deduped}/${o.dedupedCrossFormat} quarantined=${o.quarantined}`).join("; ");

async function main(): Promise<void> {
  const source = new Database(SOURCE, { readonly: true, fileMustExist: true });
  await source.backup(DB_PATH);
  source.close();

  const { db } = createDatabase(DB_PATH);
  const files = Object.fromEntries([REPORT, STATEMENT, STATEMENT_COPY].map((name) => [name, fileRow(db, name)]));
  const bytes = Object.fromEntries(Object.entries(files).map(([name, f]) => [name, fs.readFileSync(f.storagePath)]));

  console.log(`== ${MODE}, on a copy of ${SOURCE}`);
  console.log("BEFORE");
  for (const line of sapphireFigures(db)) console.log(line);
  for (const d of DIGESTS) console.log(`  ${digest(db, d.label, d.sql)}`);

  // the bump: the next drop of the report is read again at the new version
  (chaseSpendingReportPdf as { version: number }).version = files[REPORT]!.version + 1;

  if (MODE === "reread") {
    console.log(`\nRE-READ ${REPORT} at v${files[REPORT]!.version + 1}`);
    console.log(`  ${report(await importStatementFiles(db, [{ name: REPORT, buffer: bytes[REPORT]! }]))}`);
  } else {
    for (const name of [REPORT, STATEMENT, STATEMENT_COPY]) unimportFile(db, files[name]!.id);
    console.log(`\nUN-IMPORTED the report and both downloads of the August statement`);
    const order = MODE === "report-first" ? [REPORT, STATEMENT] : [STATEMENT, REPORT];
    for (const name of order) {
      console.log(`  ${name}: ${report(await importStatementFiles(db, [{ name, buffer: bytes[name]! }]))}`);
    }
  }

  console.log("\nAFTER");
  for (const line of sapphireFigures(db)) console.log(line);
  for (const d of DIGESTS) console.log(`  ${digest(db, d.label, d.sql)}`);
}

await main();
