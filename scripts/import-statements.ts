import fs from "node:fs";
import { createDatabase } from "@/db/client";
import { manualSnapshot } from "@/db/backup";
import { accountCoverage } from "@/services/coverage";
import { netWorthSeries } from "@/services/derivation";
import { importStatementFiles, type ImportInput } from "@/services/import/service";
import { DbTargetRefusal, dbTargetFrom, originalsDirFor, strayFlags, type DbTarget } from "./db-target";
import { archiveRootsFor, statementFiles } from "./statement-folders";

/**
 * Imports statement folders into the REAL database, behind a restore point.
 *
 * Refuses to run without --confirm, and takes a snapshot first, because the
 * duplicate guard this import leans on is not the sha256 one: Chase regenerates
 * its PDF bytes on every download, so previously-imported statements arrive as
 * new files and re-parse in full. `dedupe_hash` is the only thing preventing a
 * double count there, and it is the mechanism that failed in pass 33 and 38.
 *
 * Run `pnpm trial-import <same folders>` first and read the diff. This script
 * prints the same numbers so the two can be compared directly.
 *
 *   pnpm import-statements statements/discover --confirm
 */

const args = process.argv.slice(2);
const folders = args.filter((a) => !a.startsWith("--"));
const CONFIRMED = args.includes("--confirm");

if (folders.length === 0) {
  console.error("usage: pnpm import-statements <folder> [folder...] [--db=<path>] --confirm");
  process.exit(1);
}

/**
 * `--db=<path>` runs this exact import against a COPY, so a multi-step write
 * (an account created, then statements imported into it) can be rehearsed end
 * to end before the real database is touched. Defaults to the real database.
 * See ./db-target.ts for what is refused.
 *
 * ⛔ The folders are read here too, dry run or not, before anything is written —
 * and refused: one inside the statement archive (or holding it), or any file in
 * them named as the archive names its copies, hands the import the archive's
 * `<sha>-<name>` copies. Which archives depends on the target — a copy archives
 * beside itself. See ./statement-folders.ts.
 */
function commandLine(): { target: DbTarget; files: ImportInput[] } {
  try {
    const stray = strayFlags(args, ["--confirm", "--db"]);
    if (stray.length > 0) throw new DbTargetRefusal(`unknown flag ${stray.join(", ")}`);
    const target = dbTargetFrom(args, { flag: "--db", required: false, cwd: process.cwd(), exists: fs.existsSync });
    const files = statementFiles(folders, archiveRootsFor(target, process.cwd(), process.env), process.cwd());
    return { target, files };
  } catch (error: unknown) {
    if (!(error instanceof DbTargetRefusal)) throw error;
    console.error(`REFUSED: ${error.message}`);
    process.exit(2);
  }
}
const { target: TARGET, files: FILES } = commandLine();
/*
 * ⛔ A rehearsal must not write into the REAL statement archive, and the copy's
 * import_files rows must not point there: a copy archives beside itself. And it
 * is the database for everything this process opens — a lookup that reaches
 * for the default connection lands on the copy, never on the real file.
 */
const ORIGINALS = originalsDirFor(TARGET, process.env);
if (ORIGINALS !== undefined) process.env.MONEYAPP_ORIGINALS_DIR = ORIGINALS;
if (!TARGET.isReal) process.env.MONEYAPP_DB_PATH = TARGET.path;

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  if (!CONFIRMED) {
    console.log(`Would import ${FILES.length} files from ${folders.join(", ")} into ${TARGET.path}.`);
    console.log("Nothing was written. Re-run with --confirm once the trial diff looks right.");
    process.exit(0);
  }

  const bundle = createDatabase(TARGET.path);
  const { db, sqlite } = bundle;
  console.log(`Database: ${TARGET.path}${TARGET.isReal ? " (the real ledger)" : ""} · originals → ${ORIGINALS ?? "data/statements/"}`);

  const snap = manualSnapshot(sqlite);
  console.log(`Restore point: ${snap.path ?? "(none)"}\n`);

  const before = {
    netWorth: netWorthSeries(db).at(-1)?.totalCents ?? 0,
    coverage: accountCoverage(db),
  };

  const outcomes = await importStatementFiles(db, FILES);

  const byStatus = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const sum = (pick: (o: (typeof outcomes)[number]) => number): number => outcomes.reduce((n, o) => n + pick(o), 0);

  console.log("FILE OUTCOMES");
  for (const [k, v] of Object.entries(byStatus).sort()) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`  inserted ${sum((o) => o.inserted)} · deduped ${sum((o) => o.deduped)} · quarantined ${sum((o) => o.quarantined)}`);

  for (const f of outcomes.filter((o) => o.status === "failed")) {
    console.log(`  FAILED  ${f.fileName}: ${f.error}`);
  }
  // parsed, but one account's section was left out — the rest of the file is in, that account is not checked for the month
  for (const f of outcomes) {
    for (const w of f.withheld) console.log(`  WITHHELD  ${f.fileName}: ${w.notice}`);
    // a line another imported file still prints that this re-read no longer writes — out, never added on a guess
    for (const l of f.leftOut) console.log(`  LEFT OUT  ${f.fileName}: ${l.notice}`);
  }

  const after = {
    netWorth: netWorthSeries(db).at(-1)?.totalCents ?? 0,
    coverage: accountCoverage(db),
  };

  console.log("\nCOVERAGE");
  const beforeByName = new Map(before.coverage.map((c) => [c.accountName, c]));
  for (const a of after.coverage) {
    const b = beforeByName.get(a.accountName);
    const changed = b?.grade !== a.grade || b?.verifiedThrough !== a.verifiedThrough;
    console.log(
      `  ${changed ? "*" : " "} ${a.accountName.padEnd(22)} ${a.grade.padEnd(13)} verified→ ${a.verifiedThrough ?? "—"}`,
    );
  }

  console.log(`\nNET WORTH  ${money(before.netWorth)} → ${money(after.netWorth)}`);
  const delta = after.netWorth - before.netWorth;
  console.log(`  delta ${delta === 0 ? "$0.00 — unchanged" : money(delta)}`);
  if (delta !== 0) {
    console.log("  ⚠ net worth moved. If that was not expected, restore from the snapshot above.");
  }

  sqlite.close();
}

await main();
