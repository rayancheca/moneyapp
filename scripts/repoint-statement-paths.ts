/**
 * REAL-DB WRITE (dry-run by default). Repoint every archived original after the
 * repo has been moved.
 *
 * ## Why this is needed
 *
 * `import_files.storage_path` holds an ABSOLUTE path — measured on the live
 * database, **329 of them**, every one rooted at wherever the repo was when the
 * file was imported:
 *
 *     /Users/…/Desktop/Dev/MoneyApp/data/statements/chase-checking-3522/075cf…CSV
 *
 * Move the repo and all 329 point at a directory that no longer exists. Nothing
 * about the ledger's money depends on them — the transactions, balances and
 * anchors are all in the database — but the link from an import back to the
 * document it came from is the whole reason the archive exists, and this repo's
 * standing rule is that a figure must be able to name the row it came from.
 *
 * ## What it does
 *
 * `migrateStorageLayout` already recomputes each file's home from the CURRENT
 * working directory and repoints the row when the file really is there. Moving
 * the repo makes every row's `dest` differ from its stored path while the file
 * itself has travelled with the folder, which is precisely the case it handles:
 * it finds the file at `dest`, moves nothing, and rewrites the path.
 *
 * ⛔ It only ever repoints a row whose file it can SEE at the new location. A
 * row whose original is genuinely missing keeps its old path and is reported,
 * rather than being quietly repointed at nothing.
 *
 *   npx tsx scripts/repoint-statement-paths.ts            # DRY RUN
 *   npx tsx scripts/repoint-statement-paths.ts --apply    # writes
 *
 * ⚠️ Run it from the repo's NEW location, with the dev server stopped.
 */
import { getDb } from "@/db/client";
import { importFiles } from "@/db/schema/imports";
import { migrateStorageLayout } from "@/services/import/service";
import { withPreMutationSnapshot } from "../src/db/backup";

const APPLY = process.argv.includes("--apply");
const db = getDb();

const before = db.select({ storagePath: importFiles.storagePath }).from(importFiles).all();
const stale = before.filter((r) => r.storagePath !== null && !r.storagePath.startsWith(process.cwd()));
console.log(`${before.length} archived originals · ${stale.length} point outside ${process.cwd()}`);
for (const r of stale.slice(0, 3)) console.log(`  ${r.storagePath}`);
if (stale.length > 3) console.log(`  …and ${stale.length - 3} more`);

if (stale.length === 0) {
  console.log("\nNothing to repoint — every original is already under this directory.");
  process.exit(0);
}

const run = (): void => {
  const results = migrateStorageLayout(db, { move: APPLY });
  const moved = results.filter((r) => r.moved);
  const missing = results.filter((r) => !r.moved);
  console.log(`\n${APPLY ? "repointed" : "would repoint"}: ${APPLY ? moved.length : results.length}`);
  for (const r of missing.slice(0, 10)) {
    console.log(`  ⚠️  ${r.fileName} — no file at ${r.to}, left pointing at ${r.from}`);
  }
  if (APPLY) {
    const after = db.select({ storagePath: importFiles.storagePath }).from(importFiles).all();
    const left = after.filter((r) => r.storagePath !== null && !r.storagePath.startsWith(process.cwd()));
    console.log(`\n${left.length} still point outside this directory`);
  }
};

if (APPLY) {
  withPreMutationSnapshot(db, "repoint-statement-paths", run);
} else {
  run();
  console.log("\n  (dry run — re-run with --apply to write)");
}
