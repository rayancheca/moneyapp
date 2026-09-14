/**
 * REAL-DB WRITE. Chase Sapphire's 36 hand-reconstructed card-payment rows: the
 * 34 its statements print are attached to the statement that prints them, and
 * the one +$115.00 / −$115.00 pair no statement prints is retired.
 *
 * Owner decision, 2026-09-14: **"Attach 34, drop pair".**
 *
 * ## Measured, read-only, on the live ledger
 *
 *  - 36 active Sapphire rows with `import_file_id IS NULL`, net +$9,680.91,
 *    2025-02-11 → 2026-07-01, all written 2026-07-11T00:42Z by one
 *    reconstruction burst ("reconstructed credit-card payment leg"). They were
 *    exactly `ledger-check`'s "Chase Sapphire 968_091" synthetic baseline, the
 *    entry this commit removes.
 *  - Re-read with the app's own `extractLines` + `parseChaseCardLines`, 12 of
 *    the 19 Sapphire card statements print 34 `MM/DD Payment Thank You-Mobile`
 *    lines that no statement-backed row records, and each is recorded by
 *    exactly one of the 36 — 33 on the row's posted day, one ($100.00 posted
 *    2026-07-01) on its transaction day, printed `06/30`.
 *  - 2026-03-02 holds three hand rows: +$115.00 (occurrence 0), +$115.00
 *    (occurrence 1) and −$115.00 "Cancelled". The statement prints ONE
 *    `03/02 Payment Thank You-Mobile -115.00`. Occurrence 1 and "Cancelled" are
 *    the unprinted pair; they net to $0.00 on one day, which is why 20260302
 *    reconciled with all three inside it.
 *
 * ## Why the importer never inserted those 34 lines
 *
 * The parser READ them — every one is in `parseChaseCardLines`' output, and
 * each statement's own `previous + rows = new` check includes them. They were
 * dropped one step later, correctly: the hand rows predate the statements
 * (imported 2026-08-03 → 2026-09-03), `importOneFile` puts every live row of
 * the account from any OTHER source into `existingIdentityPool` — hand rows,
 * whose file is NULL, included — and `consumeIdentity` found an unconsumed row
 * of the same amount on the printed day. The line was counted
 * `dedupedCrossFormat` (the raw text differs, so the hash missed) and nothing
 * was inserted. The money was recorded; no document owned the record.
 *
 * ## Would re-importing those statements duplicate the attached rows?
 *
 * The rows' `dedupe_hash` does NOT equal the parser's hash for the line (raw
 * text "PAYMENT — Chase ····3522 · Payment to Chase card ending in 9805 02/11"
 * against "Payment Thank You-Mobile"), and this script does not make it:
 * amount, date and description are immutable ledger fields, and matching the
 * 06/30 row would move it off 2026-07-01 and change the 2026-06-30 balance.
 * No import path needs that hash to avoid a duplicate:
 *
 *  1. Same bytes → `skipped_duplicate` at the FILE (unique `file_sha256,
 *     parser_version`); no row is read.
 *  2. Re-downloaded bytes (Chase regenerates them) → a NEW import file. The
 *     attached rows belong to a different file, so they stay in the identity
 *     pool and every line is consumed as in August. This has already happened
 *     for real: `20260702-statements-9805- (1).pdf` imported 0 rows.
 *  3. A parser version bump on the same bytes → `supersedeFileContribution`
 *     retires the old file's rows, these included, BEFORE fresh rows are
 *     inserted, so a fresh row replaces and never doubles. Its transfer link
 *     carries by (posted day, amount) — the printed day for 33 of them.
 *
 * All three rehearsed on copies of the applied ledger, re-importing
 * 20260702 (and, for 2, 20260302): 0 rows inserted in 1 and 2, no balance day
 * moved, and every attached row still recorded by exactly one live row. Path 3
 * (the file marked parser_version 0) superseded 6 rows, inserted 6 and carried
 * 3 links — and cost the ONE transaction-day row two things it would not have
 * lost as a hand row: its replacement is dated the printed 06/30, moving
 * Sapphire's 2026-06-30 balance −$29.11 → $70.89, and it has no link, leaving
 * Chase Checking's −$100.00 (…702124851376) grouped with a superseded row only.
 * That is an open question for the owner, not something this script decides.
 *
 * ## What is written, in ONE transaction
 *
 *  - 34 rows: `import_file_id` := the file that owns the statement period
 *    printing the line. Nothing else. `statement_period_id` stays NULL, as on
 *    all 1,861 statement-imported Sapphire rows — provenance finds the period
 *    by (import_file_id, account).
 *  - The pair: `status` := superseded, `transfer_group_id` := NULL, a note
 *    appended. Not deleted, and not `excluded` (which stays in balance replay).
 *    No `duplicate_candidates` row: that record exists to RESTORE a retired row
 *    when its survivor is un-imported, and restoring +$115.00 without its
 *    −$115.00 would put back money that never moved.
 *  - Chase Checking's +$115.00 "…9805 Cancelled": the retired −$115.00 was its
 *    only partner, so its group would hold one live leg. Detached with the
 *    app's own `staleTransferLegs` / `detachTransferLegs` — the link only. Its
 *    "Credit Card Payment" category stays, like the two checking −$115.00
 *    payments beside it, which already carry no group.
 *
 * Then `rebuildAccount(Sapphire)`, the path every balance change takes, which
 * also regrades its statement periods.
 *
 * ## Guards — before vs after; any failure refuses (or throws, after a write)
 *
 * every Sapphire `daily_balances` day (balance and basis) · every Sapphire
 * statement period's verdict and gap · no stale verdict · net worth on every
 * day · Sapphire's replayed movement per day · Sapphire's active sum (moves by
 * the pair: $0.00) · hand-entered Sapphire money $9,680.91 → $0.00 · statuses
 * ledger-wide (active −2, superseded +2) · Chase Checking's balances untouched
 * · no touched row's category moved · every attached row's transfer shape
 * unchanged, the pair retired, the cancelled checking leg unlinked · group
 * sizes (one single and one two-leg group gone, nothing else) · no superseded
 * row holds a link · no group inside one account.
 *
 *   pnpm tsx scripts/attach-sapphire-payment-rows-2026-09-14.ts --db=data/moneyapp.db
 *   pnpm tsx scripts/attach-sapphire-payment-rows-2026-09-14.ts --db=data/moneyapp.db --confirm
 *
 * The dry run rehearses the whole write and every guard on a throwaway copy
 * (in `--scratch=<dir>`, default the OS temp directory; removed afterwards).
 * `--confirm` rehearses again, takes a restore point, writes, and re-checks.
 * Run twice: "nothing to do". Any other state is refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { fileSha256 } from "@/lib/hash";
import { formatCents } from "@/lib/money";
import { rebuildAccount } from "@/services/derivation";
import { detachTransferLegs, staleTransferLegs } from "@/services/transfer-links";
import { printedStatementLines, type CardStatement } from "./sapphire-attach-io";
import { captureGuards, compareGuards, type GuardReport } from "./sapphire-attach-guards";
import { matchPrintedLines, type Attachment, type LedgerLeg, type PrintedLine } from "./sapphire-printed-lines";

export const SAPPHIRE_ID = "019f4ca7-a750-7f21-8ffa-2546cac01f3a";
const CARD_PROFILE = "chase-card-statement-pdf";
const EXPECTED_CARD_STATEMENTS = 19;
const EXPECTED_PRINTING_FILES = 12;
const EXPECTED_HAND_NET_CENTS = 968_091;
/**
 * Printed lines of the 19 statements that no live row records. Measured
 * 2026-09-14: 1,895 lines = 1,861 statement-backed rows + these 34, exactly.
 * (A posted-day-first matcher left 59 here; see sapphire-printed-lines.ts.)
 */
const EXPECTED_UNCLAIMED_LINES = 0;
const SNAPSHOT_LABEL = "attach-sapphire-payment-rows";

/** The 36 hand rows as measured on 2026-09-14: [id, posted_on, amount_cents]. */
export const HAND_ROWS: readonly (readonly [string, string, number])[] = [
  ["019f4ea0-240b-7005-9cd7-c61d7bb3799b", "2025-02-11", 35000],
  ["019f4ea0-240b-7006-9f57-1c6e6eed887a", "2025-02-25", 16812],
  ["019f4ea0-240d-7002-829d-31d2478b1714", "2025-02-26", 11101],
  ["019f4ea0-240c-7005-847b-2c5fc307a413", "2025-04-03", 51091],
  ["019f4ea0-240b-7007-9973-f4756be4d45f", "2025-06-10", 2000],
  ["019f4ea0-2419-7009-91cc-6fd4971a8e7d", "2025-06-13", 72200],
  ["019f4ea0-2419-700c-981c-a664cce9b962", "2025-08-11", 60599],
  ["019f4ea0-240c-7000-b1ec-1b6d3862ecbd", "2025-08-26", 12110],
  ["019f4ea0-241a-7001-9ccc-c7c1b0343f44", "2025-08-28", 260],
  ["019f4ea0-240b-700c-aa47-cd6d15aeb957", "2025-09-08", 1400],
  ["019f4ea0-241a-7004-9f48-bd1819f72783", "2025-09-11", 700],
  ["019f4ea0-240a-7001-ad61-b127153d05df", "2025-09-12", 1040],
  ["019f4ea0-240b-7003-ada8-f7087ea52a74", "2025-09-22", 35000],
  ["019f4ea0-241a-7007-ab77-b32106056911", "2025-09-25", 927],
  ["019f4ea0-2419-7005-8523-c32533a64cd4", "2025-09-26", 1098],
  ["019f4ea0-240a-7003-8695-2e0aa16599d4", "2025-10-14", 11026],
  ["019f4ea0-240d-7005-bf85-920b9b94efcc", "2025-12-01", 8155],
  ["019f4ea0-240c-7006-bb3f-cad43fa5cca8", "2025-12-04", 35100],
  ["019f4ea0-240b-700a-9b1f-7ae283f31ca4", "2025-12-09", 2904],
  ["019f4ea0-241a-7003-9084-1b24e76c9631", "2025-12-11", 80000],
  ["019f4ea0-241a-7002-8087-346d22d82f0d", "2025-12-26", 4350],
  ["019f4ea0-241b-7000-bbc3-a9809b9fea4f", "2026-01-22", 2050],
  ["019f4ea0-2419-7002-88f5-e8aef8bd2446", "2026-01-27", 60041],
  ["019f4ea0-2408-7000-ac9b-d7fb58e4fe91", "2026-02-13", 30000],
  ["019f4ea0-240d-7003-81fc-2d9c82e82c53", "2026-02-19", 10000],
  ["019f4ea0-240a-7005-bfba-7b220c7db87a", "2026-02-20", 10000],
  ["019f4ea0-240d-7001-a79e-d3f25bbbe7d7", "2026-02-27", 8200],
  ["019f4ea0-2419-7008-a8b8-e1e3558d6f26", "2026-03-02", -11500],
  ["019f4ea0-240c-7003-bc3d-8f309bfdeff6", "2026-03-02", 11500],
  ["019f4ea0-240d-7006-a5c3-e985199c0c72", "2026-03-02", 11500],
  ["019f4ea0-240a-7006-aa9c-2e9671c11008", "2026-05-15", 30000],
  ["019f4ea0-241a-700b-ae43-8d9aaf6e4800", "2026-05-27", 150000],
  ["019f4ea0-240b-7000-8e3f-a14ce49409d3", "2026-06-04", 46427],
  ["019f4ea0-241a-700a-9c08-19d333ce3dff", "2026-06-23", 147000],
  ["019f4ea0-240a-7002-9438-5b478bbf6106", "2026-06-25", 10000],
  ["019f4ea0-240b-700b-953f-fe98274205df", "2026-07-01", 10000],
];

/** Chase Checking's +$115.00 "Payment to Chase card ending in 9805 Cancelled" — its row id keys its group. */
export const CANCELLED_CHECKING_LEG = "019f4ca7-a6cd-7694-9efd-664fae9f334e";

/** The unprinted pair, each with the group it holds today and the live legs that group keeps without it. */
export const RETIRED = [
  { rowId: "019f4ea0-2419-7008-a8b8-e1e3558d6f26", groupId: CANCELLED_CHECKING_LEG, leftBehind: [CANCELLED_CHECKING_LEG] },
  { rowId: "019f4ea0-240d-7006-a5c3-e985199c0c72", groupId: "019f4ca7-a6cc-7081-bee2-87b82db8b194", leftBehind: [] },
] as const;

/** The one row Chase prints on its transaction day rather than its posted day. */
const TRANSACTED_LENS_ROWS = ["019f4ea0-240b-700b-953f-fe98274205df"];

const RETIRE_NOTE =
  "retired 2026-09-14 (owner: Attach 34, drop pair): 20260302-statements-9805-.pdf prints ONE 03/02 -115.00 " +
  "payment; this row and its opposite-signed twin of 2026-03-02 were never printed and cancel";

type HandRow = typeof transactions.$inferSelect;

interface Plan {
  attachments: Attachment[];
  retired: LedgerLeg[];
  unclaimedLines: PrintedLine[];
}

function parseArgs(argv: readonly string[]): { dbPath: string; confirm: boolean; scratch: string } {
  const unknown = argv.filter((a) => a !== "--confirm" && !a.startsWith("--db=") && !a.startsWith("--scratch="));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(" ")}`);
  const db = argv.find((a) => a.startsWith("--db="))?.slice("--db=".length);
  if (!db) throw new Error("--db=<path> is required (the real ledger is data/moneyapp.db)");
  const dbPath = path.resolve(db);
  // createDatabase would CREATE a missing file and then find nothing to do
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  // where the throwaway rehearsal copy lives; NOT read from TMPDIR, which tsx
  // also uses for its IPC socket and which a long path breaks (EINVAL)
  const scratch = path.resolve(argv.find((a) => a.startsWith("--scratch="))?.slice("--scratch=".length) ?? os.tmpdir());
  if (!fs.existsSync(scratch)) throw new Error(`no scratch directory at ${scratch}`);
  return { dbPath, confirm: argv.includes("--confirm"), scratch };
}

function cardStatements({ db }: DbBundle): CardStatement[] {
  return db
    .select({
      fileId: importFiles.id,
      fileName: importFiles.fileName,
      sha: importFiles.fileSha256,
      storagePath: importFiles.storagePath,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
    })
    .from(statementPeriods)
    .innerJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
    .where(and(eq(statementPeriods.accountId, SAPPHIRE_ID), eq(importFiles.parserProfile, CARD_PROFILE)))
    .orderBy(statementPeriods.periodStart)
    .all();
}

const toLeg = (r: HandRow): LedgerLeg => ({
  id: r.id,
  postedOn: r.postedOn,
  transactedOn: r.transactedOn,
  amountCents: r.amountCents,
  occurrenceIndex: r.occurrenceIndex,
});

function loadLegs({ db }: DbBundle): { hand: HandRow[]; backed: LedgerLeg[] } {
  const ids = HAND_ROWS.map(([id]) => id);
  const hand = db.select().from(transactions).where(inArray(transactions.id, ids)).all();
  const backed = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, SAPPHIRE_ID),
        isNotNull(transactions.importFileId),
        ne(transactions.status, "superseded"),
      ),
    )
    .all()
    .filter((r) => !ids.includes(r.id))
    .map(toLeg);
  return { hand, backed };
}

function assertPlan(plan: Plan, hand: readonly HandRow[], statements: readonly CardStatement[]): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  const byId = new Map(hand.map((r) => [r.id, r]));
  for (const [id, postedOn, cents] of HAND_ROWS) {
    const row = byId.get(id);
    expect(row !== undefined, `${id}: missing`);
    if (!row) continue;
    expect(row.accountId === SAPPHIRE_ID, `${id}: not a Chase Sapphire row`);
    expect(row.postedOn === postedOn && row.amountCents === cents, `${id}: is ${row.postedOn} ${row.amountCents}, measured ${postedOn} ${cents}`);
  }
  expect(sum(hand.map((r) => r.amountCents)) === EXPECTED_HAND_NET_CENTS, `hand rows no longer net ${EXPECTED_HAND_NET_CENTS}`);
  expect(statements.length === EXPECTED_CARD_STATEMENTS, `${statements.length} card statements, measured ${EXPECTED_CARD_STATEMENTS}`);

  const retiredIds = RETIRED.map((r) => r.rowId);
  const attachIds = HAND_ROWS.map(([id]) => id).filter((id) => !retiredIds.includes(id as never));
  expect(sameSet(plan.attachments.map((a) => a.rowId), attachIds), `attaches ${plan.attachments.length} rows, not the measured 34`);
  expect(sameSet(plan.retired.map((r) => r.id), [...retiredIds]), `unprinted: ${plan.retired.map((r) => r.id).join(", ")}`);
  expect(sum(plan.retired.map((r) => r.amountCents)) === 0, "the unprinted rows do not cancel");
  expect(new Set(plan.retired.map((r) => r.postedOn)).size === 1, "the unprinted rows are not on one day");
  const transacted = plan.attachments.filter((a) => a.lens === "transacted").map((a) => a.rowId);
  expect(sameSet(transacted, TRANSACTED_LENS_ROWS), `transaction-day matches: ${transacted.join(", ")}`);
  expect(new Set(plan.attachments.map((a) => a.line.fileId)).size === EXPECTED_PRINTING_FILES, "not 12 printing statements");
  for (const a of plan.attachments) {
    const row = byId.get(a.rowId)!;
    expect(row.postedOn >= a.line.periodStart && row.postedOn <= a.line.periodEnd, `${a.rowId}: posted outside ${a.line.fileName}'s period`);
  }
  expect(plan.unclaimedLines.length === EXPECTED_UNCLAIMED_LINES, `${plan.unclaimedLines.length} printed lines record no row`);
  return problems;
}

type State = "pending" | "applied";

/** Exactly the measured before-state, exactly this script's after-state, or a refusal. */
function classifyState({ db }: DbBundle, plan: Plan, hand: readonly HandRow[]): State {
  const byId = new Map(hand.map((r) => [r.id, r]));
  const checking = db.select().from(transactions).where(eq(transactions.id, CANCELLED_CHECKING_LEG)).get();
  const checkingAccount = checking && db.select().from(accounts).where(eq(accounts.id, checking.accountId)).get();
  if (!checking || checkingAccount?.name !== "Chase Checking" || checking.amountCents !== 11500 || checking.status !== "active") {
    throw new Error(`REFUSED — ${CANCELLED_CHECKING_LEG} is not the active +$115.00 Chase Checking row`);
  }
  const items: { name: string; pending: boolean; applied: boolean }[] = [
    ...plan.attachments.map((a) => {
      const r = byId.get(a.rowId)!;
      return {
        name: a.rowId,
        pending: r.status === "active" && r.importFileId === null,
        applied: r.status === "active" && r.importFileId === a.line.fileId,
      };
    }),
    ...RETIRED.map((g) => {
      const r = byId.get(g.rowId)!;
      return {
        name: g.rowId,
        pending: r.status === "active" && r.importFileId === null && r.transferGroupId === g.groupId,
        applied: r.status === "superseded" && r.importFileId === null && r.transferGroupId === null,
      };
    }),
    { name: CANCELLED_CHECKING_LEG, pending: checking.transferGroupId === CANCELLED_CHECKING_LEG, applied: checking.transferGroupId === null },
  ];
  if (items.every((i) => i.pending)) return "pending";
  if (items.every((i) => i.applied)) return "applied";
  const off = items.filter((i) => !i.pending && !i.applied).map((i) => i.name);
  throw new Error(`REFUSED — neither the measured state nor the applied one. Off both: ${off.join(", ") || "(a mix)"}`);
}

/** The write itself. Throws — and so rolls back — on any row count that is not exactly 1. */
function applyPlan({ db }: DbBundle, plan: Plan): void {
  db.transaction((tx) => {
    for (const a of plan.attachments) {
      const result = tx
        .update(transactions)
        .set({ importFileId: a.line.fileId })
        .where(and(eq(transactions.id, a.rowId), isNull(transactions.importFileId), eq(transactions.status, "active")))
        .run();
      if (result.changes !== 1) throw new Error(`attach ${a.rowId}: changed ${result.changes} rows`);
    }
    for (const g of RETIRED) {
      const row = tx.select({ notes: transactions.notes }).from(transactions).where(eq(transactions.id, g.rowId)).get();
      const result = tx
        .update(transactions)
        .set({ status: "superseded", transferGroupId: null, notes: row?.notes ? `${row.notes} · ${RETIRE_NOTE}` : RETIRE_NOTE })
        .where(
          and(
            eq(transactions.id, g.rowId),
            eq(transactions.status, "active"),
            isNull(transactions.importFileId),
            eq(transactions.transferGroupId, g.groupId),
          ),
        )
        .run();
      if (result.changes !== 1) throw new Error(`retire ${g.rowId}: changed ${result.changes} rows`);
      // a group left holding ONE live leg is a half transfer; the app's own rule sheds it
      const left = staleTransferLegs(tx, g.groupId);
      if (!sameSet(left.map((l) => l.id), [...g.leftBehind])) {
        throw new Error(`group ${g.groupId} keeps ${left.map((l) => l.id).join(", ") || "nothing"}, measured ${g.leftBehind.join(", ") || "nothing"}`);
      }
      if (left.length === 1) detachTransferLegs(tx, left);
    }
  });
}

function writeAndGuard(bundle: DbBundle, plan: Plan, today: string, snapshot: boolean): GuardReport {
  const handIds = [...HAND_ROWS.map(([id]) => id), CANCELLED_CHECKING_LEG];
  const before = captureGuards(bundle, handIds);
  if (snapshot) withPreMutationSnapshot(bundle.db, SNAPSHOT_LABEL, () => applyPlan(bundle, plan));
  else applyPlan(bundle, plan);
  // the path every balance change takes; it also regrades Sapphire's periods
  rebuildAccount(bundle.db, SAPPHIRE_ID, today);
  return compareGuards(before, captureGuards(bundle, handIds), {
    attached: plan.attachments.map((a) => a.rowId),
    retired: RETIRED.map((r) => r.rowId),
    unlinked: [CANCELLED_CHECKING_LEG],
    expectedHandNetCents: EXPECTED_HAND_NET_CENTS,
  });
}

async function rehearse(bundle: DbBundle, plan: Plan, today: string, scratch: string): Promise<GuardReport> {
  const dir = fs.mkdtempSync(path.join(scratch, "attach-sapphire-"));
  try {
    const copyPath = path.join(dir, "rehearsal.db");
    await bundle.sqlite.backup(copyPath);
    const copy = createDatabase(copyPath);
    try {
      return writeAndGuard(copy, plan, today, false);
    } finally {
      copy.sqlite.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printPlan(plan: Plan, hand: readonly HandRow[]): void {
  const byId = new Map(hand.map((r) => [r.id, r]));
  console.log(`ATTACH ${plan.attachments.length} rows to the statement that prints them`);
  for (const a of plan.attachments) {
    const r = byId.get(a.rowId)!;
    const printed = `${a.line.day.slice(5, 7)}/${a.line.day.slice(8)} ${a.line.description} ${(-a.line.amountCents / 100).toFixed(2)}`;
    console.log(`  ${r.postedOn} ${formatCents(r.amountCents).padStart(10)}  ${a.line.fileName}  "${printed}"${a.lens === "transacted" ? "  (transaction day)" : ""}`);
  }
  console.log(`RETIRE ${plan.retired.length} unprinted rows (superseded, link released)`);
  for (const r of plan.retired) console.log(`  ${r.postedOn} ${formatCents(r.amountCents).padStart(10)}  ${byId.get(r.id)!.rawDescription}`);
  console.log(`UNLINK Chase Checking ${CANCELLED_CHECKING_LEG} — its only partner is the retired −$115.00`);
}

function printReport(title: string, report: GuardReport): void {
  console.log(`\n${title}`);
  for (const line of report.lines) console.log(`  ${line}`);
}

async function main(): Promise<void> {
  const { dbPath, confirm, scratch } = parseArgs(process.argv.slice(2));
  const bundle = createDatabase(dbPath);
  try {
    const statements = cardStatements(bundle);
    const lines = await printedStatementLines(statements, fileSha256);
    const { hand, backed } = loadLegs(bundle);
    const match = matchPrintedLines(lines, backed, hand.map(toLeg));
    const plan: Plan = { attachments: match.attachments, retired: match.unprinted, unclaimedLines: match.unclaimedLines };
    const problems = assertPlan(plan, hand, statements);
    if (problems.length > 0) throw new Error(`REFUSED — the ledger no longer matches the measured plan:\n  ${problems.join("\n  ")}`);
    printPlan(plan, hand);

    if (classifyState(bundle, plan, hand) === "applied") {
      console.log("\nALREADY APPLIED — every row is in its after-state. Nothing to do.");
      return;
    }
    const today = todayIso();
    const rehearsal = await rehearse(bundle, plan, today, scratch);
    printReport("REHEARSAL on a throwaway copy", rehearsal);
    if (rehearsal.failures.length > 0) throw new Error(`REFUSED — ${rehearsal.failures.length} guard(s) fail on a copy; nothing was written`);
    if (!confirm) {
      console.log(`\nDRY RUN — ${dbPath} was not written. Re-run with --confirm to apply.`);
      return;
    }
    const report = writeAndGuard(bundle, plan, today, true);
    printReport(`APPLIED to ${dbPath}`, report);
    if (report.failures.length > 0) {
      throw new Error(
        `GUARD FAILED after the write: ${report.failures.join("; ")}. Restore the newest ` +
          `pre-*-${SNAPSHOT_LABEL}.db restore point (beside the database, or in $MONEYAPP_BACKUPS_DIR).`,
      );
    }
  } finally {
    bundle.sqlite.close();
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

await main();
