/**
 * REAL-DB WRITE (dry-run by default). Repoint every archived original after the
 * repo has been moved.
 *
 * ## Why this is needed
 *
 * `import_files.storage_path` holds an ABSOLUTE path — 329 of them on this
 * ledger, every one rooted at wherever the repo was when the file was imported:
 *
 *     /Users/…/Desktop/Dev/MoneyApp/data/statements/chase-checking-3522/075cf…CSV
 *
 * Move the repo and they all point at a directory that no longer exists. No
 * money depends on them — transactions, balances and anchors are in the
 * database — but the link from an import back to the document it came from is
 * the whole reason the archive exists.
 *
 * ## ⛔ Why this does NOT use `migrateStorageLayout`
 *
 * It did, on its first outing, and it repointed **195 of 329 and left 134
 * pointing at a deleted folder.** `migrateStorageLayout` recomputes each file's
 * home from the account it resolves to TODAY, so its `dest` differs from the
 * stored path in the FOLDER as well as the root:
 *
 *     stored   …/data/statements/capital-one-venturex-4147/fd38…pdf
 *     wanted   …/data/statements/capital-one-venturex-4208/fd38…pdf
 *
 * That folder drift is real and pre-existing (a card that was re-numbered, a
 * Robinhood CSV filed under the brokerage before the cash account owned it),
 * and re-deriving it is a legitimate job — but it is NOT this job. It works by
 * MOVING the file from its old path to the new one, and after a repo move the
 * old path is gone, so it can move nothing and repoints nothing.
 *
 * ⛔ **A repo move changes the ROOT and nothing else.** The file is exactly
 * where it was, one directory up. So this rebases the root and leaves the
 * folder alone — and refuses to repoint any row whose file is not actually
 * sitting at the rebased path, so a row can never be left naming a file that
 * is not there.
 *
 * Run `migrateStorageLayout` separately if the archive layout itself should be
 * re-derived; that is a different question with a different answer.
 *
 *   npx tsx scripts/repoint-statement-paths.ts            # DRY RUN
 *   npx tsx scripts/repoint-statement-paths.ts --apply    # writes
 *
 * ⚠️ Run it from the repo's NEW location, with the dev server stopped.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { importFiles } from "@/db/schema/imports";
import { withPreMutationSnapshot } from "../src/db/backup";

const APPLY = process.argv.includes("--apply");
const db = getDb();
const ROOT = process.cwd();

/** Everything from `data/…` onwards — the part a repo move does not change. */
const TAIL = `${path.sep}data${path.sep}`;

/**
 * The same file, under this repo.
 *
 * ⚠️ Split on the LAST `/data/`, not the first. A repo that ever lived under a
 * path containing `/data/` itself (`~/data/projects/MoneyApp`) would otherwise
 * be cut at the wrong place and rebased onto a path that never existed.
 */
function rebase(stored: string): string | null {
  const at = stored.lastIndexOf(TAIL);
  if (at === -1) return null;
  return path.join(ROOT, stored.slice(at + 1));
}

interface Row { id: string; fileName: string; stored: string; rebased: string | null }

const rows: Row[] = db
  .select({ id: importFiles.id, fileName: importFiles.fileName, storagePath: importFiles.storagePath })
  .from(importFiles)
  .all()
  .filter((r): r is typeof r & { storagePath: string } => r.storagePath !== null)
  .map((r) => ({ id: r.id, fileName: r.fileName, stored: r.storagePath, rebased: rebase(r.storagePath) }));

const outside = rows.filter((r) => !r.stored.startsWith(ROOT + path.sep));
console.log(`${rows.length} archived originals · ${outside.length} point outside ${ROOT}`);

/*
 * ⛔ A row already under this root but naming a file that is not there is its
 * own problem, and a silent one: it looks repointed. Reported separately so a
 * clean "nothing to repoint" cannot hide it.
 */
const insideButMissing = rows.filter((r) => r.stored.startsWith(ROOT + path.sep) && !fs.existsSync(r.stored));
if (insideButMissing.length > 0) {
  console.log(`\n⚠️  ${insideButMissing.length} already under this root but the file is not there:`);
  for (const r of insideButMissing.slice(0, 10)) console.log(`     ${r.stored}`);
}

if (outside.length === 0) {
  console.log("\nNothing to repoint — every original is already under this directory.");
  process.exit(insideButMissing.length === 0 ? 0 : 1);
}

const found = outside.filter((r) => r.rebased !== null && fs.existsSync(r.rebased));
const lost = outside.filter((r) => r.rebased === null || !fs.existsSync(r.rebased));

console.log(`\n${APPLY ? "repointing" : "would repoint"} ${found.length}:`);
for (const r of found.slice(0, 5)) console.log(`  ${r.stored}\n    → ${r.rebased}`);
if (found.length > 5) console.log(`  …and ${found.length - 5} more`);

if (lost.length > 0) {
  console.log(`\n⚠️  ${lost.length} left alone — no file at the rebased path:`);
  for (const r of lost.slice(0, 10)) console.log(`     ${r.fileName}\n       stored  ${r.stored}\n       looked  ${r.rebased ?? "(no /data/ segment to rebase on)"}`);
}

if (!APPLY) {
  console.log("\n  (dry run — re-run with --apply to write)");
  process.exit(0);
}

withPreMutationSnapshot(db, "repoint-statement-paths", () => {
  db.transaction((tx) => {
    for (const r of found) {
      tx.update(importFiles).set({ storagePath: r.rebased! }).where(eq(importFiles.id, r.id)).run();
    }
  });
});

const after = db
  .select({ storagePath: importFiles.storagePath })
  .from(importFiles)
  .all()
  .filter((r): r is typeof r & { storagePath: string } => r.storagePath !== null);
const stillOutside = after.filter((r) => !r.storagePath.startsWith(ROOT + path.sep));
const stillMissing = after.filter((r) => !fs.existsSync(r.storagePath));
console.log(`\nrepointed ${found.length}`);
console.log(`  ${stillOutside.length} still point outside this directory`);
console.log(`  ${stillMissing.length} still name a file that is not there`);
process.exit(stillMissing.length === 0 ? 0 : 1);
