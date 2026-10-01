/**
 * Measures what a version bump of `chase-spending-report-pdf` does to Chase Sapphire — the re-read of
 * "Spending Report PDF (1).pdf" beside the card statement that covers the same July days — and whether the two files
 * leave the same ledger whichever order they are read in.
 *
 * ⛔ Reads a COPY of whatever `--from=<db>` names and writes only inside the scratch directory it is given; it never
 * opens the real ledger for writing, and its originals and backups go to the scratch directory too.
 *
 *   tsx scripts/probe-identity-transaction-day.ts --from=<db> --scratch=<dir> [--mode=reread|report-first|statement-first|orders]
 *
 * `reread` (the default) is the owner's scenario: the profile ships a new version and he drops the report again.
 * `report-first` and `statement-first` un-import the report and both downloads of the August statement, then read the
 * two files back in the named order. `orders` runs both and grades them against each other (`compareOrders`), which
 * is the only mode that answers "does the order matter?" instead of leaving two logs to be eyeballed.
 *
 * Measured on a copy of the real ledger, 2026-09-22, with `identityWeight` scoring a shared posted day alone:
 *
 *   reread          charges 10319 · 2026-07-03..08-02 gap −$1.25, 72 quarantined, 17 live · ledger-check FAILED
 *                   (Chase Sapphire 2026-07-02 → 2026-08-02 off by $185.78)
 *   report-first    charges 10320 · reconciled
 *   statement-first charges 10320 · reconciled
 *
 * — the same two files, read in three sequences, leaving two different amounts of money. With the transaction-day
 * clause all three give `charges 10320 7d7df1ab675b4862` and pass `ledger-check`, and the re-read leaves
 * `transactions` and `balance_anchors` byte-identical to the ledger it started from.
 *
 * ⚠️ What `orders` still reports as different, same day, same ledger copy: 18 of 10,320 rows, because the row that
 * records a charge BOTH files print belongs to whichever was read first — 14 of them post on a different day
 * (`txns` f41b6f6cf0ab08f4 report-first / cdad5e191a6f8437 statement-first) and with them 4 Chase Sapphire daily
 * balances (`balances` 960dfc37e56a854f / 3fc1be121eb5f5f6), 2026-07-05 reading +$65.90 or −$8.52. The money, all
 * 255 periods and all 309 anchors are identical either way, which is what `compareOrders` requires and what
 * docs/schema.md ("the day a charge posts") now claims. Making the posted day agree too is an owner decision, not a
 * tidy-up — see that section.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { createDatabase, type AppDatabase } from "@/db/client";
import { LIVE_FILE } from "@/db/schema/imports";
import { importStatementFiles, unimportFile } from "@/services/import/service";
import { chaseSpendingReportPdf } from "@/services/import/profiles/spending-report-profile";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const SOURCE = flag("from") ?? "";
const SCRATCH = flag("scratch") ?? "";
const MODE = flag("mode") ?? "reread";
if (SOURCE === "" || SCRATCH === "" || !["reread", "report-first", "statement-first", "orders"].includes(MODE)) {
  console.error("usage: tsx scripts/probe-identity-transaction-day.ts --from=<db> --scratch=<dir> [--mode=reread|report-first|statement-first|orders]");
  process.exit(1);
}

const REPORT = "Spending Report PDF (1).pdf";
const STATEMENT = "20260802-statements-9805-.pdf";
/** the same August statement downloaded a second time — it holds no rows of its own, and an un-import hands it the first's */
const STATEMENT_COPY = "20260802-statements-9805- (1).pdf";
const PERIOD = { start: "2026-07-03", end: "2026-08-02" };

/** A run's own scratch: its copy of the ledger, and the originals and backups its imports may write. */
function workDirFor(mode: string): string {
  const workDir = path.join(SCRATCH, `probe-${mode}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workDir, "originals"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "backups"), { recursive: true });
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(workDir, "originals");
  process.env.MONEYAPP_BACKUPS_DIR = path.join(workDir, "backups");
  return workDir;
}

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
      WHERE file_name = '${name.replace(/'/g, "''")}' AND status IN (${LIVE_FILE.map((s) => `'${s}'`).join(",")})`,
  )[0];
  if (row === undefined) throw new Error(`${name} is not imported in this copy`);
  return { id: String(row.id), storagePath: String(row.storage_path), version: Number(row.parser_version) };
}

const report = (outcomes: { status: string; inserted: number; deduped: number; dedupedCrossFormat: number; quarantined: number }[]): string =>
  outcomes.map((o) => `${o.status} inserted=${o.inserted} deduped=${o.deduped}/${o.dedupedCrossFormat} quarantined=${o.quarantined}`).join("; ");

/** What one read sequence left behind: the digests, and the rows the comparison below reads. */
interface Outcome {
  digests: Map<string, string>;
  /** one line per live charge: account, posted day, made day, amount, text, status */
  rows: string[];
  /** one line per stored balance day: account, day, cents */
  balances: string[];
}

async function runOnce(mode: string): Promise<Outcome> {
  const workDir = workDirFor(mode);
  const dbPath = path.join(workDir, "copy.db");
  const source = new Database(SOURCE, { readonly: true, fileMustExist: true });
  await source.backup(dbPath);
  source.close();

  const { db } = createDatabase(dbPath);
  const files = Object.fromEntries([REPORT, STATEMENT, STATEMENT_COPY].map((name) => [name, fileRow(db, name)]));
  const bytes = Object.fromEntries(Object.entries(files).map(([name, f]) => [name, fs.readFileSync(f.storagePath)]));

  console.log(`== ${mode}, on a copy of ${SOURCE}`);
  console.log("BEFORE");
  for (const line of sapphireFigures(db)) console.log(line);
  for (const d of DIGESTS) console.log(`  ${digest(db, d.label, d.sql)}`);

  // the bump: the next drop of the report is read again at the new version
  (chaseSpendingReportPdf as { version: number }).version = files[REPORT]!.version + 1;

  if (mode === "reread") {
    console.log(`\nRE-READ ${REPORT} at v${files[REPORT]!.version + 1}`);
    console.log(`  ${report(await importStatementFiles(db, [{ name: REPORT, buffer: bytes[REPORT]! }]))}`);
  } else {
    for (const name of [REPORT, STATEMENT, STATEMENT_COPY]) unimportFile(db, files[name]!.id);
    console.log(`\nUN-IMPORTED the report and both downloads of the August statement`);
    const order = mode === "report-first" ? [REPORT, STATEMENT] : [STATEMENT, REPORT];
    for (const name of order) {
      console.log(`  ${name}: ${report(await importStatementFiles(db, [{ name, buffer: bytes[name]! }]))}`);
    }
  }

  console.log("\nAFTER");
  for (const line of sapphireFigures(db)) console.log(line);
  const digests = new Map<string, string>();
  for (const d of DIGESTS) {
    const line = digest(db, d.label, d.sql);
    console.log(`  ${line}`);
    digests.set(d.label.trim(), line.slice(line.indexOf(":") + 1).trim());
  }
  const rows = all(
    db,
    `SELECT a.name, t.posted_on, IFNULL(t.transacted_on, t.posted_on) AS made_on, t.amount_cents, t.normalized_description, t.status
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.status != 'superseded'
      ORDER BY a.name, made_on, t.amount_cents, t.posted_on, t.normalized_description, t.status`,
  ).map((r) => Object.values(r).map((v) => String(v ?? "")).join("|"));
  const balances = all(
    db,
    `SELECT a.name, d.day, d.balance_cents FROM daily_balances d JOIN accounts a ON a.id = d.account_id ORDER BY a.name, d.day`,
  ).map((r) => Object.values(r).map((v) => String(v ?? "")).join("|"));
  return { digests, rows, balances };
}

/** Lines in `mine` that `theirs` does not hold, counting duplicates. */
function missingFrom(mine: readonly string[], theirs: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of theirs) left.set(line, (left.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of mine) {
    const n = left.get(line) ?? 0;
    if (n === 0) out.push(line);
    else left.set(line, n - 1);
  }
  return out;
}

/**
 * The pass condition, named rather than asserted in prose: the same two files read in either order must leave the same
 * MONEY — every charge on the day it was made, for the same amount, in the same state — the same reconciliation of
 * every period, and the same anchors. What it does NOT require is which source's row records a charge both files
 * print, and so that row's posted day and its text: `docs/schema.md`, "the day a charge posts", says why, and this
 * prints every such row so the cost is read rather than assumed.
 */
function compareOrders(a: Outcome, b: Outcome): boolean {
  const must = ["charges", "periods", "anchors"];
  let ok = true;
  console.log("\n== report-first vs statement-first");
  for (const label of [...a.digests.keys()]) {
    const same = a.digests.get(label) === b.digests.get(label);
    const required = must.includes(label);
    if (required && !same) ok = false;
    console.log(`  ${label.padEnd(9)} ${same ? "same" : "DIFFER"}${required ? (same ? "" : "  ← must match") : same ? "" : "  (allowed: the row that records a charge both files print)"}`);
  }

  const onlyA = missingFrom(a.rows, b.rows);
  const onlyB = missingFrom(b.rows, a.rows);
  console.log(`\n  rows that differ: ${onlyA.length} read report-first, ${onlyB.length} read statement-first`);
  const posted = (line: string): string => line.split("|")[1]!;
  const madeAmount = (line: string): string => `${line.split("|")[0]!}|${line.split("|")[2]!}|${line.split("|")[3]!}`;
  const byMoney = new Map<string, string[]>();
  for (const line of onlyB) byMoney.set(madeAmount(line), [...(byMoney.get(madeAmount(line)) ?? []), line]);
  let moved = 0;
  for (const line of onlyA) {
    const [name, , made, amount, text] = line.split("|");
    const other = byMoney.get(madeAmount(line))?.shift();
    if (other === undefined) {
      ok = false;
      console.log(`    ⛔ ${name} made ${made} ${amount} "${text}" — read statement-first this money is not here at all`);
      continue;
    }
    if (posted(line) !== posted(other)) moved += 1;
    console.log(`    ${name} made ${made} ${amount}: posts ${posted(line)} "${text}" / ${posted(other)} "${other.split("|")[4]!}"`);
  }
  for (const [, rest] of byMoney) {
    for (const line of rest) {
      ok = false;
      console.log(`    ⛔ ${line} — read report-first this money is not here at all`);
    }
  }

  const balancesA = missingFrom(a.balances, b.balances);
  const balancesB = missingFrom(b.balances, a.balances);
  console.log(`\n  balance days that differ: ${balancesA.length}`);
  for (const line of balancesA) {
    const [name, day, cents] = line.split("|");
    const other = balancesB.find((l) => l.startsWith(`${name}|${day}|`));
    console.log(`    ${name} ${day}: ${cents} / ${other?.split("|")[2] ?? "MISSING"}`);
  }

  console.log(`\n  ${ok ? "PASS" : "FAIL"} — the money, the periods and the anchors ${ok ? "are the same in either order" : "are NOT the same in either order"}; ${moved} charges post on a different day.`);
  return ok;
}

async function main(): Promise<void> {
  if (MODE !== "orders") {
    await runOnce(MODE);
    return;
  }
  const reportFirst = await runOnce("report-first");
  console.log("");
  const statementFirst = await runOnce("statement-first");
  if (!compareOrders(reportFirst, statementFirst)) process.exitCode = 1;
}

await main();
