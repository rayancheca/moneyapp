/**
 * REAL-DB WRITE — the owner's answer to §6A 23 of 2026-09-28, step 1 of 2: pin the three Fordham aid deposits
 * (2022-09-15 +$3,238.00, 2023-09-28 +$5,681.00, 2023-10-10 +$2,500.00) as HIS, `Income › Financial Aid`, so that
 * re-dropping the Chase archive — step 2 — cleans the 13 descriptions that still carry the statement's 20-digit margin
 * id and moves no category. "Only the 13 descriptions may change."
 *
 * The measurement, why the re-read would refile them to Education, and every guard are in
 * `scripts/fordham-aid-pin.ts`. This file is the command line.
 *
 * ## The runbook — in this order, from the main checkout, with the dev server stopped
 *
 *   1. pnpm tsx scripts/pin-fordham-aid-2026-09-28.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *      pnpm tsx scripts/pin-fordham-aid-2026-09-28.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *      pnpm tsx scripts/pin-fordham-aid-2026-09-28.ts --db=data/moneyapp.db             # ALREADY APPLIED — nothing to do
 *   2. Re-drop the 75 archived statement PDFs under the names the ledger recorded them by, from a folder OUTSIDE data/,
 *      one per sha subfolder (48 statements in 75 byte-copies: their names collide in one folder; the import reads
 *      subfolders and records the base name):
 *        S=$(mktemp -d); for f in data/statements/chase-checking-3522/*.pdf; do b=$(basename "$f"); h=${b%%-*}
 *          mkdir -p "$S/$h" && cp "$f" "$S/$h/${b#????????????????-}"; done; find "$S" -type f | wc -l   # 75
 *        pnpm trial-import "$S"                            # read the diff
 *        pnpm import-statements "$S" --confirm             # its own restore point: pre-*-manual-backup.db
 *   3. pnpm ledger-check
 *      pnpm tsx scripts/probe-chase-redrop.ts --before=<step 2's pre-*-manual-backup.db> --after=data/moneyapp.db
 *      pnpm tsx scripts/pin-fordham-aid-2026-09-28.ts --db=data/moneyapp.db             # still nothing to do: the
 *                                                                                       # pin travelled to the new rows
 *
 * ⛔ Step 2 before step 1 refiles the three to Education, and this script then REFUSES ("the re-read ran before the
 * pin"): restore from step 2's restore point and start again.
 *
 * ⛔ Not `pnpm import-statements data/statements/chase-checking-3522` — both commands now refuse it, and any file named
 * as the archive names its copies, and print this staged path (scripts/statement-folders.ts). The same money, but the
 * archive names its copies `<sha>-<name>`, so that run records all 75 under the sha-prefixed name, archives each AGAIN
 * as `<sha>-<sha>-<name>` (75 duplicate PDFs in data/statements/chase-checking-3522/), and reads the folder's archived
 * activity CSV, which no profile matches by that name: a FAILED import — a red row at the top of /imports — and a copy
 * in data/statements/chase/. The staged folder brings none of that: each original is already archived under its hashed
 * name (`archiveTo`).
 *
 * ## Rehearsed on a byte copy of the live ledger, 2026-09-28 (sha 2bc4573f…, no WAL)
 *
 * Step 1 pins 3; every guard holds; net worth $119,958.63 (`netWorthSeries`, 2026-09-28) on every day, unchanged.
 * Step 2 (staged): 75 parsed, 0 failed, 1,536 inserted and as many superseded, 1,684 deduped, 1,243 left to the activity
 * CSV that owns their days, 0 quarantined; active rows 10,328 → 10,328; no file added to the archive. Step 3: the probe
 * reads ONLY THE MARGIN IDS MOVED — 13 lines lose the margin id and keep every other word, no category moves, live rows
 * carrying the margin id 13 → 0 (its old 20-digit tally, 55 → 42, also counted 42 rows that never carried one: IBANs
 * and card references), net worth identical on every day; `ledger-check` exits 0 with its output byte-identical to
 * before; this script reads ALREADY APPLIED on the three new rows. Re-deriving Chase Checking also carries its last
 * balance to the day it runs: 45 `carried` daily balances, 2026-08-15 → 2026-09-28, the way Wells Fargo's (re-derived
 * 09-28) already run to today; no existing balance moves, and net worth already carried it.
 * Control, step 2 WITHOUT step 1: 16 lines move — the 13 and these three, to Education — and step 1 then refuses.
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (in `--scratch=<dir>`, default the OS
 * temp directory; removed afterwards). `--confirm` rehearses again, takes a `pre-*-pin-fordham-aid.db` restore point
 * beside the ledger, writes, and re-checks every guard. Any state but the measured one, the pinned one, or the pinned
 * one after a re-read is refused.
 */
import fs from "node:fs";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { formatCents } from "@/lib/money";
import { onRehearsalCopy } from "./guarded-write-harness";
import {
  REAL_AID,
  SNAPSHOT_LABEL,
  applyPin,
  capturePinState,
  classifyPin,
  comparePin,
  loadPinFacts,
  parsePinCli,
  rehearsePin,
  type PinState,
} from "./fordham-aid-pin";

function printRows(bundle: DbBundle): void {
  const facts = loadPinFacts(bundle);
  const pathOf = bundle.sqlite.prepare(
    "SELECT coalesce(p.name || ' › ', '') || c.name AS path FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?",
  );
  for (const want of REAL_AID.rows) {
    const fact = facts.byId.get(want.id);
    // a row a re-read replaced is shown by the row that holds its money now
    const shown = fact?.row.status === "superseded" ? (facts.liveByRow.get(want.id) ?? [])[0] : fact;
    if (shown === undefined) {
      console.log(`  ${want.postedOn}  +${formatCents(want.amountCents).padStart(9)}  ${want.id}  not in this ledger`);
      continue;
    }
    const categoryId = shown.row.categoryId;
    const category = categoryId === null ? "—" : ((pathOf.get(categoryId) as { path: string } | undefined)?.path ?? categoryId);
    const now = shown === fact ? "" : ` · now row ${shown.row.id}`;
    console.log(`  ${want.postedOn}  +${formatCents(want.amountCents).padStart(9)}  ${want.id}  ${category} · ${shown.row.categorizationSource ?? "no source"}${now}`);
  }
}

function report(label: string, before: PinState, after: PinState): void {
  const worth = (s: PinState) => (s.lastNetWorth === null ? "—" : `${s.lastNetWorth.day} ${formatCents(s.lastNetWorth.cents)}`);
  console.log(`  ${label}: net worth ${worth(before)} → ${worth(after)} (every day ${before.netWorth === after.netWorth ? "identical" : "MOVED"})`);
}

async function main(): Promise<void> {
  const cli = parsePinCli(process.argv.slice(2), { cwd: process.cwd(), exists: fs.existsSync });
  const real = createDatabase(cli.dbPath);
  try {
    const verdict = classifyPin(loadPinFacts(real));
    console.log(`\n── plan on ${cli.dbPath}: ${verdict.kind.toUpperCase()}`);
    printRows(real);
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do: all three are his, filed as Income › Financial Aid");
    console.log(`  pins ${verdict.pin.length}: the source becomes his hand (\`user\`); the category, and Fordham's default, stay as they are`);

    const rehearsal = await onRehearsalCopy(real, cli.scratch, SNAPSHOT_LABEL, (copy) => rehearsePin(copy));
    report("rehearsal", rehearsal.before, rehearsal.after);
    if (rehearsal.failures.length > 0) {
      for (const failure of rehearsal.failures) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ rehearsed on a copy: every guard holds, and a second run is ALREADY APPLIED");
    if (!cli.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");

    const before = capturePinState(real);
    withPreMutationSnapshot(real.db, SNAPSHOT_LABEL, () => applyPin(real, verdict.pin));
    const after = capturePinState(real);
    const failures = comparePin(before, after, verdict.pin);
    if (failures.length > 0) {
      throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${SNAPSHOT_LABEL}.db restore point:\n${failures.join("\n")}`);
    }
    report("written", before, after);
    const again = classifyPin(loadPinFacts(real));
    console.log(`APPLIED — every guard holds; ${again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
