import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "@/db/client";
import { accountCoverage } from "@/services/coverage";
import { netWorthSeries } from "@/services/derivation";
import { importStatementFiles, type ImportInput } from "@/services/import/service";
import { DbTargetRefusal, dbTargetFrom, strayFlags } from "./db-target";

/**
 * Imports a folder of statements into a THROWAWAY COPY of the real database and
 * reports exactly what it would do — before anything touches the real one.
 *
 * This exists because the obvious sanity check is not available here: the sha256
 * duplicate guard does not work for Chase PDFs. Chase regenerates the file bytes
 * on every download, so a statement already imported months ago arrives as a
 * brand-new file and re-parses in full. The only thing standing between that and
 * a double count is the transaction-level `dedupe_hash` — which is exactly the
 * mechanism that failed in pass 33 and again in pass 38. "It should dedupe" is
 * not a claim to make about money without watching it happen.
 *
 *   pnpm trial-import statements/discover
 *   pnpm trial-import statements/discover "statements/chase college checking"
 */

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (args.length === 0) {
  console.error("usage: pnpm trial-import <folder> [folder...]");
  process.exit(1);
}

/**
 * `--from=<db>` copies THAT database instead of the real one — for a rehearsal
 * whose earlier step already wrote to a copy (an account the statements need,
 * created on `<db>`), so the trial sees the ledger the real run will see.
 *
 * ⛔ Any other flag is refused: `--db=<copy>` is import-statements' spelling, and
 * ignoring it here would trial the REAL ledger while the operator believes the
 * copy was read. See ./db-target.ts.
 */
function sourceDb(): string {
  const argv = process.argv.slice(2);
  try {
    const stray = strayFlags(argv, ["--from"]);
    if (stray.length > 0) throw new DbTargetRefusal(`unknown flag ${stray.join(", ")} — the trial's source is --from=<db>`);
    return dbTargetFrom(argv, { flag: "--from", required: false, cwd: process.cwd(), exists: fs.existsSync }).path;
  } catch (error: unknown) {
    if (!(error instanceof DbTargetRefusal)) throw error;
    console.error(`REFUSED: ${error.message}`);
    process.exit(2);
  }
}
const SOURCE_DB = sourceDb();

const SCRATCH = path.join(process.cwd(), ".trial");
const TRIAL_DB = path.join(SCRATCH, "trial.db");
const TRIAL_ORIGINALS = path.join(SCRATCH, "originals");

function collect(dir: string): ImportInput[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      if (!/\.(pdf|csv|qfx|ofx)$/i.test(entry.name)) return [];
      return [{ name: entry.name, buffer: fs.readFileSync(full) }];
    });
}

interface Snapshot {
  netWorthCents: number;
  netWorthDay: string;
  txnByStatus: Record<string, number>;
  periodsByReconciliation: Record<string, number>;
  basisCounts: Record<string, number>;
  /** active rows per recurring series — an import now links what it brings in */
  seriesLinks: Record<string, number>;
  grades: { name: string; grade: string; verifiedThrough: string | null }[];
}

function snapshot(db: ReturnType<typeof createDatabase>["db"], sqlite: ReturnType<typeof createDatabase>["sqlite"]): Snapshot {
  const series = netWorthSeries(db);
  const last = series.at(-1);
  const group = (sql: string): Record<string, number> =>
    Object.fromEntries((sqlite.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]));

  return {
    netWorthCents: last?.totalCents ?? 0,
    netWorthDay: last?.day ?? "—",
    txnByStatus: group("SELECT status AS k, COUNT(*) AS n FROM transactions GROUP BY status"),
    periodsByReconciliation: group("SELECT reconciliation AS k, COUNT(*) AS n FROM statement_periods GROUP BY reconciliation"),
    basisCounts: group("SELECT basis AS k, COUNT(*) AS n FROM daily_balances GROUP BY basis"),
    // keyed by name AND id: two series can share a name (the real ledger has two
    // ended "YOUTUBEPREMIUM" series, 7 and 4 rows), and `group` keeps one row per
    // key, so a name alone printed one line and one count for both
    seriesLinks: group(
      "SELECT s.name || ' · ' || substr(s.id, 1, 8) AS k, COUNT(*) AS n FROM transactions t JOIN recurring_series s ON s.id = t.recurring_series_id WHERE t.status = 'active' GROUP BY s.id",
    ),
    grades: accountCoverage(db).map((c) => ({
      name: c.accountName,
      grade: c.grade,
      verifiedThrough: c.verifiedThrough,
    })),
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function diffTable(label: string, before: Record<string, number>, after: Record<string, number>): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  console.log(`\n${label}`);
  for (const k of keys) {
    const b = before[k] ?? 0;
    const a = after[k] ?? 0;
    const delta = a - b;
    console.log(`  ${k.padEnd(20)} ${String(b).padStart(6)} → ${String(a).padStart(6)}  ${delta === 0 ? "" : delta > 0 ? `+${delta}` : `${delta}`}`);
  }
}

async function main(): Promise<void> {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(TRIAL_ORIGINALS, { recursive: true });

  /*
   * Copy the real DB via SQLite's own backup API so a live WAL cannot tear it.
   *
   * Opened READONLY and deliberately NOT through createDatabase(): that helper
   * runs `migrate()` on every open (db/client.ts), so merely taking this
   * snapshot used to apply any pending migration to the REAL database. It is
   * additive DDL and harmless to money, but a script whose whole purpose is to
   * leave the real file alone must not be the thing that writes to it — and the
   * claim printed at the end of this run has to stay true.
   */
  const source = new Database(SOURCE_DB, { readonly: true, fileMustExist: true });
  await source.backup(TRIAL_DB);
  source.close();
  console.log(`Trial copy of ${SOURCE_DB}`);

  // every write below lands in .trial/ — the real archive is never touched
  process.env.MONEYAPP_ORIGINALS_DIR = TRIAL_ORIGINALS;

  const { db, sqlite } = createDatabase(TRIAL_DB);
  const before = snapshot(db, sqlite);

  const files = args.flatMap((dir) => collect(dir));
  console.log(`Trial-importing ${files.length} files from ${args.join(", ")}\n`);

  const outcomes = await importStatementFiles(db, files);

  const byStatus = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const sum = (pick: (o: (typeof outcomes)[number]) => number): number => outcomes.reduce((n, o) => n + pick(o), 0);

  console.log("FILE OUTCOMES");
  for (const [k, v] of Object.entries(byStatus).sort()) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\n  inserted   ${sum((o) => o.inserted)}`);
  console.log(`  deduped    ${sum((o) => o.deduped)}   (cross-format ${sum((o) => o.dedupedCrossFormat)})`);
  console.log(`  carried    ${sum((o) => o.carriedForward)}`);
  console.log(`  quarantined ${sum((o) => o.quarantined)}`);
  // The service calls this one "visible, never silent" — it was neither, and a
  // 32-file import that skipped 448 rows reported only "inserted 0".
  console.log(`  skippedOwned ${sum((o) => o.skippedOwned)}  (a higher-fidelity source already covers the day)`);
  console.log(`  supersededTakeover ${sum((o) => o.supersededTakeover)}`);

  const failures = outcomes.filter((o) => o.status === "failed");
  if (failures.length > 0) {
    console.log(`\nFAILURES (${failures.length})`);
    const reasons = failures.reduce<Record<string, number>>((acc, f) => {
      const key = f.error ?? "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    for (const [reason, n] of Object.entries(reasons)) console.log(`  ${n}x  ${reason}`);
  }

  const after = snapshot(db, sqlite);

  diffTable("TRANSACTIONS BY STATUS", before.txnByStatus, after.txnByStatus);
  diffTable("STATEMENT PERIODS", before.periodsByReconciliation, after.periodsByReconciliation);
  diffTable("DAILY BALANCE BASIS", before.basisCounts, after.basisCounts);
  // an import links the rows it brings in to recurring series, so a trial has
  // to show which series would gain rows before the real ledger does
  diffTable("ACTIVE ROWS LINKED PER RECURRING SERIES", before.seriesLinks, after.seriesLinks);

  console.log("\nCOVERAGE GRADES");
  const beforeByName = new Map(before.grades.map((g) => [g.name, g]));
  for (const a of after.grades) {
    const b = beforeByName.get(a.name);
    const changed = !b || b.grade !== a.grade || b.verifiedThrough !== a.verifiedThrough;
    const arrow = changed ? `${b?.grade ?? "—"} (${b?.verifiedThrough ?? "—"}) → ${a.grade} (${a.verifiedThrough ?? "—"})` : `${a.grade} (${a.verifiedThrough ?? "—"}) unchanged`;
    console.log(`  ${changed ? "*" : " "} ${a.name.padEnd(22)} ${arrow}`);
  }

  console.log("\nNET WORTH");
  console.log(`  before ${money(before.netWorthCents)}  (${before.netWorthDay})`);
  console.log(`  after  ${money(after.netWorthCents)}  (${after.netWorthDay})`);
  const delta = after.netWorthCents - before.netWorthCents;
  console.log(`  delta  ${delta === 0 ? "$0.00 — unchanged" : money(delta)}`);

  sqlite.close();
  console.log(`\nTrial DB left at ${TRIAL_DB} for inspection. ${SOURCE_DB} was opened READONLY and never written.`);
}

await main();
