/**
 * REAL-DB WRITE. Chase Sapphire's +$100.00 card payment goes onto the 06/30 its statement prints.
 *
 * Owner decision, 2026-09-15: **the Sapphire 06/30 payment carries its PRINTED 06/30.**
 *
 * ## Measured, read-only, on the live ledger (2026-09-15)
 *
 *  - `019f4ea0-240b-700b-953f-fe98274205df`: Chase Sapphire, +$100.00, posted 2026-07-01, transacted 2026-06-30,
 *    "PAYMENT — Chase ····3522 · Payment to Chase card ending in 9805 07/01", note "reconstructed credit-card
 *    payment leg", Transfers › Credit Card Payment by `transfer_detect`, no merchant, series, split, duplicate
 *    record or transfer question. One of the 34 payments `attach-sapphire-payment-rows-2026-09-14.ts` filed
 *    under the statement that prints them, marked `file_link_source = 'attached'` by
 *    `mark-attached-sapphire-rows-2026-09-15.ts` (applied; all 34 carry it) — the only one matched on its
 *    transaction day:
 *    20260702-statements-9805-.pdf (06-03 → 07-02, reconciled) prints `06/30 Payment Thank You-Mobile -100.00`.
 *  - Its transfer group is Chase Checking's −$100.00 of 2026-07-01 (`…702124851376`). Legs a day apart are
 *    ordinary: 160 live two-leg groups with a card leg sit on two days, 71 of them Sapphire's.
 *  - Sapphire 2026-06-30 −$29.11, 2026-07-01 $70.89. The ledger: 10,320 active rows ($28,776.59), 245
 *    superseded, none holding a transfer link.
 *
 * ## Why a successor row, and why it takes the statement's text
 *
 * A row's amount, day and description are immutable, and `editManualTransaction` refuses a row with a file. The
 * app moves an imported row's day only by re-parse: supersede, insert the printed line fresh under
 * `storedLines`' identity, carry the work. `redate-printed-day.ts` does that for this ONE row. A real re-parse of
 * 20260702 would also rewrite its five other rows (three more attached payments back under the statement's text,
 * `categorization_source` re-derived on all six).
 *
 * ⚠️ The successor's description is the statement's, "Payment Thank You-Mobile", not the reconstruction's. That
 * is the price of a dedupe hash the parser produces for this line — the hash covers the raw description — and it
 * is what a parser bump writes onto all 34. The text already names 76 live Sapphire payments; the note still says
 * the row was reconstructed.
 *
 * ## What is written, in ONE transaction, behind a restore point
 *
 *  - successor: posted 2026-06-30, transacted 2026-06-30, "Payment Thank You-Mobile", occurrence 0, the
 *    parser's hash — all from `storedLines` over the statement the app's own card profile reads, refused unless
 *    those bytes are the imported file. Every other column is the old row's: category, source, confidence,
 *    merchant, review flag, series and its owner, transfer group, note, file, the `attached` marker
 *    (`file_link_source`, migration 0016), `created_at` — read from the table, not the schema, so a column a
 *    later migration adds travels too.
 *  - the old row stays filed under the statement with its marker, as history. It is no kept money:
 *    `unimportCountsByFile` counts live attached rows only, so the /imports confirmation for 20260702 reads
 *    "keeps 4" before and after, and an un-import detaches it without deleting it.
 *  - the old row: `superseded`, link released, a note naming its successor. Its day, amount and text stay.
 *
 * Then `rebuildAccount(Sapphire)` with the day this RUNS, which also regrades its periods.
 *
 * ## Guards — refuse before, throw after
 *
 * Before: the row, its group (one other live leg, another account, −$100.00), its file's one period holding both
 * days, no row of another table naming it, no live row holding the line's hash, the file's bytes and period.
 * Before vs after: `daily_balances` of every account — only Sapphire's days in [06-30, 07-01) move, by +$100.00,
 * basis unchanged; net worth the same days, every other day (today included) identical; every
 * `statement_periods` and `balance_anchors` column; every transaction column of every other row; statuses
 * (superseded +1); active count and sum; group sizes; no superseded row gains a link; one-account groups
 * unchanged (1 before: Chase Checking's cancelled $115.00 of 2026-03-02, grouped with its −$115.00 on purpose by
 * owner answer 2 — so not "none"); the transfers card; every import file's un-import counts (what the /imports
 * confirmation says it deletes and keeps). Then the successor, column by column, and a second run reads ALREADY
 * APPLIED.
 *
 *   pnpm tsx scripts/redate-sapphire-0630-payment-2026-09-15.ts --db=data/moneyapp.db
 *   pnpm tsx scripts/redate-sapphire-0630-payment-2026-09-15.ts --db=data/moneyapp.db --confirm
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (`--scratch=<dir>`, default the
 * OS temp directory). `--confirm` rehearses again, takes a restore point, writes, and re-checks. Run twice:
 * "nothing to do".
 */
import fs from "node:fs";
import os from "node:os";
import { and, eq } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { todayIso } from "@/lib/dates";
import { fileSha256 } from "@/lib/hash";
import { formatCents } from "@/lib/money";
import { rebuildAccount } from "@/services/derivation";
import { chaseCardStatementPdf } from "@/services/import/profiles/chase-card-statement-profile";
import { asParsedFile, parseContextFor, storedLines, type StoredLine } from "@/services/import/service";
import { sniffFile } from "@/services/import/sniff";
import { dbTargetFrom, strayFlags } from "./db-target";
import { onRehearsalCopy } from "./guarded-write-harness";
import { Refusal, applyRedate, classifyRedate, identityOf, lineFor, type RedateSpec } from "./redate-printed-day";
import { captureLedger, compareLedger } from "./redate-printed-day-guards";
import type { GuardReport } from "./sapphire-attach-guards";

const SAPPHIRE_ID = "019f4ca7-a750-7f21-8ffa-2546cac01f3a";
const SNAPSHOT_LABEL = "redate-sapphire-0630-payment";

const STATEMENT = {
  fileId: "019fc8ed-e804-7000-bcbb-09f478b6ee6f",
  fileName: "20260702-statements-9805-.pdf",
  sha256: "f7e2f3f49709bb377cc857630558d23a318d9b34869a56d69af9ade2866a7914",
  periodStart: "2026-06-03",
  periodEnd: "2026-07-02",
} as const;

const SPEC: RedateSpec = {
  rowId: "019f4ea0-240b-700b-953f-fe98274205df",
  accountId: SAPPHIRE_ID,
  importFileId: STATEMENT.fileId,
  postedOn: "2026-07-01",
  printedOn: "2026-06-30",
  amountCents: 10_000,
  transferGroupId: "019f4ca7-a6c0-759c-a0f5-702124851376",
  notes: "reconstructed credit-card payment leg",
  retireNote: (successorId) =>
    `superseded 2026-09-15 (owner: the 06/30 payment carries its PRINTED 06/30) by ${successorId}, ` +
    `the same payment on the day ${STATEMENT.fileName} prints`,
};

/** The statement's 06/30 line as the import stores it — read from the imported bytes with the app's own profile. */
async function printedLine({ db }: DbBundle): Promise<StoredLine> {
  const file = db.select().from(importFiles).where(eq(importFiles.id, STATEMENT.fileId)).get();
  if (!file || file.fileName !== STATEMENT.fileName || file.fileSha256 !== STATEMENT.sha256) {
    throw new Refusal(`REFUSED — ${STATEMENT.fileId} is not the measured ${STATEMENT.fileName}`);
  }
  // a version bump retires this file row and re-dates the payment itself: that ledger is not the measured one
  if (file.status !== "parsed" || file.parserProfile !== chaseCardStatementPdf.id || file.parserVersion !== chaseCardStatementPdf.version) {
    throw new Refusal(`REFUSED — ${file.fileName} is ${file.status} at ${file.parserProfile} v${file.parserVersion}, measured parsed at v${chaseCardStatementPdf.version}`);
  }
  const buffer = fs.readFileSync(file.storagePath);
  if (fileSha256(buffer) !== file.fileSha256) throw new Refusal(`REFUSED — ${file.storagePath} is not the imported ${file.fileName}`);
  const account = db.select().from(accounts).where(eq(accounts.id, SAPPHIRE_ID)).get();
  if (!account) throw new Refusal("REFUSED — no Chase Sapphire account");

  const { statements, withheld } = asParsedFile(await chaseCardStatementPdf.parse(sniffFile(file.fileName, buffer), parseContextFor(db)));
  const stored = db
    .select()
    .from(statementPeriods)
    .where(and(eq(statementPeriods.importFileId, file.id), eq(statementPeriods.accountId, SAPPHIRE_ID)))
    .all();
  const [statement] = statements;
  const printed = statement?.period;
  if (
    statements.length !== 1 ||
    withheld.length !== 0 ||
    statement!.accountHint.last4 !== account.last4 ||
    stored.length !== 1 ||
    printed?.start !== STATEMENT.periodStart ||
    printed.end !== STATEMENT.periodEnd ||
    stored[0]!.periodStart !== printed.start ||
    stored[0]!.periodEnd !== printed.end
  ) {
    throw new Refusal(`REFUSED — ${file.fileName} does not read as the one Sapphire statement ${STATEMENT.periodStart} → ${STATEMENT.periodEnd} it was imported as`);
  }
  return lineFor(storedLines(SAPPHIRE_ID, account, statement!), SPEC);
}

function writeAndGuard(bundle: DbBundle, line: StoredLine, today: string, snapshot: boolean): GuardReport {
  const before = captureLedger(bundle, today);
  const write = (): string => applyRedate(bundle, SPEC, line);
  const successorId = snapshot ? withPreMutationSnapshot(bundle.db, SNAPSHOT_LABEL, write) : write();
  // the path every balance change takes; it also regrades Sapphire's periods
  rebuildAccount(bundle.db, SAPPHIRE_ID, today);
  const report = compareLedger(before, captureLedger(bundle, today), SPEC, successorId);
  const rerun = (() => {
    try {
      const state = classifyRedate(bundle, SPEC, line);
      return state.kind === "applied" && state.successorId === successorId ? null : `a second run reads ${state.kind}`;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  return {
    lines: [...report.lines, `${rerun === null ? "PASS" : "FAIL"}  the successor, column by column, and a second run reads ALREADY APPLIED — ${rerun ?? successorId}`],
    failures: rerun === null ? report.failures : [...report.failures, "successor / re-run"],
  };
}

function printPlan(line: StoredLine): void {
  const identity = identityOf(line);
  console.log(`RE-DATE Chase Sapphire ${formatCents(SPEC.amountCents)} ${SPEC.rowId}`);
  console.log(`  retire     posted ${SPEC.postedOn}, link ${SPEC.transferGroupId} released, note names its successor`);
  console.log(`  successor  posted ${identity.posted_on}, transacted ${identity.transacted_on}, "${identity.raw_description}", occurrence ${identity.occurrence_index}`);
  console.log(`             dedupe_hash ${identity.dedupe_hash} (the parser's, ${STATEMENT.fileName})`);
  console.log("             every other column carried, the group included");
}

function printReport(title: string, report: GuardReport): void {
  console.log(`\n${title}`);
  for (const l of report.lines) console.log(`  ${l}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stray = strayFlags(argv, ["--db", "--confirm", "--scratch"]);
  if (stray.length > 0) throw new Error(`unknown flag(s): ${stray.join(" ")}`);
  const target = dbTargetFrom(argv, { flag: "--db", required: true, cwd: process.cwd(), exists: fs.existsSync });
  const scratch = argv.find((a) => a.startsWith("--scratch="))?.slice("--scratch=".length) ?? os.tmpdir();
  if (!fs.existsSync(scratch)) throw new Error(`no scratch directory at ${scratch}`);
  const bundle = createDatabase(target.path);
  try {
    const line = await printedLine(bundle);
    printPlan(line);
    const state = classifyRedate(bundle, SPEC, line);
    if (state.kind === "applied") {
      console.log(`\nALREADY APPLIED — successor ${state.successorId}. Nothing to do.`);
      return;
    }
    const today = todayIso();
    const rehearsal = await onRehearsalCopy(bundle, scratch, SNAPSHOT_LABEL, (copy) => writeAndGuard(copy, line, today, false));
    printReport(`REHEARSAL on a throwaway copy (today ${today})`, rehearsal);
    if (rehearsal.failures.length > 0) throw new Error(`REFUSED — ${rehearsal.failures.length} guard(s) fail on a copy; nothing was written`);
    if (!argv.includes("--confirm")) {
      console.log(`\nDRY RUN — ${target.path} was not written. Re-run with --confirm to apply.`);
      return;
    }
    const report = writeAndGuard(bundle, line, today, true);
    printReport(`APPLIED to ${target.path}`, report);
    if (report.failures.length > 0) {
      throw new Error(
        `GUARD FAILED after the write: ${report.failures.join("; ")}. Restore the newest pre-*-${SNAPSHOT_LABEL}.db ` +
          "restore point (beside the database, or in $MONEYAPP_BACKUPS_DIR).",
      );
    }
  } finally {
    bundle.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
