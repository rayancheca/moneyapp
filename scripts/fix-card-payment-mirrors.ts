import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { withPreMutationSnapshot } from "../src/db/backup";
import { accounts } from "../src/db/schema/accounts";
import { duplicateCandidates } from "../src/db/schema/duplicate-candidates";
import { importFiles, statementPeriods } from "../src/db/schema/imports";
import { LIVE_ROW, transactions } from "../src/db/schema/transactions";
import { dedupeHash, duplicatePairKey } from "../src/lib/hash";
import { categorizeAll, detectTransfers } from "../src/services/categorize";
import { flagDuplicateCandidates } from "../src/services/duplicate-flags";
import { reconcileAccounts } from "../src/services/import/service";
import { rebuildAccount } from "../src/services/derivation";

/**
 * Retire the hand-made card-payment MIRROR rows that double-count every Chase
 * Sapphire payment, and pull the handful of straddling rows into the statement
 * window that declares them.
 *
 * WHY THIS EXISTS. Each card payment is in the ledger twice: once as the line
 * Chase prints on its statement, and once as a mirror row a one-off script
 * wrote in a single burst on 2026-07-11 — months before the card had any
 * statements at all. The mirror carries the BANK's post date, one to five days
 * after the date Chase prints, and 106 of 107 have no transaction date, so
 * neither lens of `consumeIdentity` could ever match them (it keys on an EXACT
 * day, posted-to-posted then transacted-to-transacted). The result is a
 * double-counted credit in every affected statement period.
 *
 * The arithmetic identifies itself: a matcher that never looks at a balance
 * pairs exactly 71 mirrors totalling $23,983.06, and `sum(gap_cents)` over the
 * gapped periods is −$23,983.06. To the cent. The match is a UNIQUE perfect
 * matching — no mirror has a second candidate and no statement row is claimable
 * twice — so it is stable under any iteration order and at any tolerance from
 * 5 to 60 days. The earlier diagnosis (boundary drift from the transaction-date
 * lens) was measured and is wrong; it accounts for four rows, not the gap.
 *
 * WHAT IS DELIBERATE HERE, each because review found the naive form destructive:
 *
 *  1. Rows are SUPERSEDED, never deleted, and every retirement is recorded as a
 *     `duplicate_candidates` row in the SAME transaction. That is not
 *     bookkeeping: `restoreDuplicatesLosingTheirSurvivor` (duplicate-lifecycle
 *     .ts:33) rescues a retired row ONLY from a `confirmed_duplicate` candidate,
 *     and `unimportFile` hard-deletes a file's rows behind that guard. A bare
 *     status flip would arm one-click un-import to strand up to $4,619.92 of
 *     payments on zero live rows, silently — the failure mode commit 3e5a7fc
 *     was reverted for. The candidate row is also the ONLY surface that shows a
 *     superseded row (DuplicatePairs.tsx:47-56), so without it the retirement is
 *     invisible and irreversible through every shipped path.
 *  2. The transfer link moves onto the statement row ONLY when that row has
 *     none. Exactly one paired statement row already carries a correct
 *     2-member group; overwriting it with the mirror's dead singleton would
 *     orphan the SoFi Savings leg — destroying a real transfer to fix a count.
 *     `fillFromCarry` (import/service.ts:326) already encodes this rule.
 *  3. Every row write is in ONE transaction. Between the supersede and the
 *     clamp, 26 payments worth $8,481.48 sit quarantined with their mirrors
 *     already retired — recorded by zero replay-eligible rows. That state must
 *     never be observable, and `withPreMutationSnapshot` gives no atomicity of
 *     its own (it snapshots, then calls the mutation).
 *  4. The settle afterwards is the IMPORT path's full sequence
 *     (import/service.ts:645-665), not a subset: six of the released rows have
 *     no category, and a shorter sequence leaves a state the next import
 *     diverges from.
 *
 * Run `pnpm tsx scripts/fix-card-payment-mirrors.ts` to see the plan and the
 * predicted end state without writing; add `--apply` to commit it.
 */

const TOLERANCE_DAYS = 5;
const EXPECTED_PAIRS = 71;
const EXPECTED_CENTS = 2_398_306;

interface Row {
  id: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  rawDescription: string;
  normalizedDescription: string;
  status: string;
  transferGroupId: string | null;
  occurrenceIndex: number;
  accountId: string;
}

interface Pair {
  mirror: Row;
  statement: Row;
  deltaDays: number;
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.round(Math.abs(ms) / 86_400_000);
}

/**
 * Pair each mirror with the statement row recording the same money.
 *
 * The order is pinned — mirrors by `(posted_on, id)`, nearest candidate first,
 * ties broken by `(posted_on, id)` — because the assignment decides which
 * statement row inherits which transfer group and which mirror each candidate
 * row names. The SET is provably order-independent (see the header), but the
 * row-to-row linkage is not, and after this runs it is permanent.
 */
function pairMirrors(mirrors: readonly Row[], statements: readonly Row[]): Pair[] {
  const claimed = new Set<string>();
  const pairs: Pair[] = [];
  const byDateThenId = (a: Row, b: Row): number =>
    a.postedOn === b.postedOn ? a.id.localeCompare(b.id) : a.postedOn.localeCompare(b.postedOn);

  for (const mirror of [...mirrors].sort(byDateThenId)) {
    const candidates = statements
      .filter(
        (s) =>
          !claimed.has(s.id) &&
          s.amountCents === mirror.amountCents &&
          daysBetween(s.postedOn, mirror.postedOn) <= TOLERANCE_DAYS,
      )
      .sort((a, b) => {
        const da = daysBetween(a.postedOn, mirror.postedOn);
        const db = daysBetween(b.postedOn, mirror.postedOn);
        return da === db ? byDateThenId(a, b) : da - db;
      });
    const best = candidates[0];
    if (!best) continue;
    claimed.add(best.id);
    pairs.push({ mirror, statement: best, deltaDays: daysBetween(best.postedOn, mirror.postedOn) });
  }
  return pairs;
}

interface Clamp {
  row: Row;
  from: string;
  to: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * Rows a statement declares that fall outside its own window.
 *
 * Chase prints the TRANSACTION date, so a charge made in the last days of a
 * cycle lands on the next statement while dating into the previous window. Only
 * files owning exactly ONE balance-bearing period are considered: a combined
 * statement covering several periods gives no unambiguous window, and guessing
 * one against real money is what this whole pass exists to stop doing.
 */
function findStraddlers(db: ReturnType<typeof createDatabase>["db"]): Clamp[] {
  const periods = db
    .select()
    .from(statementPeriods)
    .where(sql`${statementPeriods.beginningBalanceCents} is not null and ${statementPeriods.endingBalanceCents} is not null`)
    .all();
  const byFile = new Map<string, typeof periods>();
  for (const p of periods) {
    if (p.importFileId === null) continue;
    const bucket = byFile.get(p.importFileId);
    if (bucket) bucket.push(p);
    else byFile.set(p.importFileId, [p]);
  }

  const out: Clamp[] = [];
  for (const [fileId, filePeriods] of byFile) {
    if (filePeriods.length !== 1) continue;
    const period = filePeriods[0]!;
    const rows = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.importFileId, fileId), inArray(transactions.status, [...LIVE_ROW])))
      .all();
    for (const r of rows) {
      if (r.postedOn >= period.periodStart && r.postedOn <= period.periodEnd) continue;
      out.push({
        row: r as unknown as Row,
        from: r.postedOn,
        to: r.postedOn < period.periodStart ? period.periodStart : period.periodEnd,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });
    }
  }
  return out;
}

/**
 * How many transfer groups still hold exactly two live rows.
 *
 * This is the gate the naive "move the link" rule fails: superseding a mirror
 * whose statement twin ALREADY has a group would leave the counterparty leg
 * alone in its group, and the row count stays put, so only a group-shape check
 * can see it. Superseded rows are excluded because a retired row is not a leg.
 */
function twoMemberGroupCount(db: ReturnType<typeof createDatabase>["db"]): number {
  const groups = db
    .select({ g: transactions.transferGroupId, c: sql<number>`count(*)` })
    .from(transactions)
    .where(sql`${transactions.transferGroupId} is not null and ${transactions.status} != 'superseded'`)
    .groupBy(transactions.transferGroupId)
    .all();
  return groups.filter((row) => row.c === 2).length;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const dbPath = process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db";
  const { db } = createDatabase(dbPath);

  const card = db.select().from(accounts).where(eq(accounts.type, "credit")).all();
  const sapphire = card.find((a) => a.name === "Chase Sapphire");
  if (!sapphire) throw new Error("Chase Sapphire account not found");

  const all = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, sapphire.id), sql`${transactions.amountCents} > 0`))
    .all() as unknown as Row[];

  const cardFiles = new Set(
    db
      .select({ id: importFiles.id })
      .from(importFiles)
      .where(eq(importFiles.parserProfile, "chase-card-statement-pdf"))
      .all()
      .map((f) => f.id),
  );
  const mirrors = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, sapphire.id),
        isNull(transactions.importFileId),
        sql`${transactions.amountCents} > 0`,
        eq(transactions.status, "active"),
      ),
    )
    .all() as unknown as Row[];
  const statementRows = all.filter(
    (r) => (r as Row & { importFileId: string | null }).importFileId !== null
      && cardFiles.has((r as Row & { importFileId: string }).importFileId)
      && r.status !== "superseded",
  );

  const pairs = pairMirrors(mirrors, statementRows);
  const paired = pairs.reduce((s, p) => s + p.mirror.amountCents, 0);
  const gap = db
    .select({ total: sql<number>`coalesce(sum(${statementPeriods.gapCents}), 0)` })
    .from(statementPeriods)
    .where(and(eq(statementPeriods.accountId, sapphire.id), eq(statementPeriods.reconciliation, "gap")))
    .all()[0]!.total;

  console.log(`mirrors=${mirrors.length}  statement credits=${statementRows.length}`);
  console.log(`pairs=${pairs.length}  retired total=${paired}c ($${(paired / 100).toFixed(2)})`);
  console.log(`sum(gap_cents)=${gap}  =>  ${gap === -paired ? "MATCH" : "*** NO MATCH ***"}`);

  // Refuse to write on anything but the measured ledger. These are not
  // defensive nice-to-haves: a different count means the pairing found
  // different money than the one that was reviewed and approved.
  if (pairs.length !== EXPECTED_PAIRS) throw new Error(`expected ${EXPECTED_PAIRS} pairs, found ${pairs.length}`);
  if (paired !== EXPECTED_CENTS) throw new Error(`expected ${EXPECTED_CENTS}c retired, found ${paired}`);
  if (gap !== -paired) throw new Error(`gap ${gap} is not the negation of the retired total ${paired}`);

  const straddlers = findStraddlers(db);
  console.log(`\nstraddling rows (file owns exactly one period): ${straddlers.length}`);
  for (const c of straddlers) {
    console.log(`  ${c.from} -> ${c.to}  ${String(c.row.amountCents).padStart(8)}c  ${c.row.rawDescription.slice(0, 40)}`);
  }
  const foreign = straddlers.filter((c) => c.row.accountId !== sapphire.id);
  if (foreign.length > 0) throw new Error(`clamp would touch ${foreign.length} non-Sapphire rows; refusing`);

  const relinks = pairs.filter((p) => p.statement.transferGroupId === null && p.mirror.transferGroupId !== null);
  const keepExisting = pairs.filter((p) => p.statement.transferGroupId !== null);
  console.log(`\ntransfer links: ${relinks.length} moved onto the statement row, ${keepExisting.length} left alone (already linked)`);
  const groupsBefore = twoMemberGroupCount(db);
  console.log(`two-member transfer groups before: ${groupsBefore}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  const now = new Date().toISOString();
  withPreMutationSnapshot(db, "card-payment-mirrors", () => {
    db.transaction((tx) => {
      for (const { mirror, statement, deltaDays } of pairs) {
        // (1) the link moves ONLY onto a statement row that has none
        if (statement.transferGroupId === null && mirror.transferGroupId !== null) {
          tx.update(transactions)
            .set({ transferGroupId: mirror.transferGroupId })
            .where(eq(transactions.id, statement.id))
            .run();
        }
        // the mirror always releases its link, so a superseded row can never be
        // counted as a live member of a transfer group
        tx.update(transactions)
          .set({ transferGroupId: null, status: "superseded" })
          .where(eq(transactions.id, mirror.id))
          .run();

        // (2) the record that makes this reversible AND rescuable on un-import
        const [a, b] = [mirror.id, statement.id].sort();
        tx.insert(duplicateCandidates)
          .values({
            accountId: sapphire.id,
            transactionIdA: a!,
            transactionIdB: b!,
            pairKey: duplicatePairKey(
              sapphire.id,
              {
                postedOn: mirror.postedOn,
                transactedOn: mirror.transactedOn,
                amountCents: mirror.amountCents,
                normalizedDescription: mirror.normalizedDescription,
              },
              {
                postedOn: statement.postedOn,
                transactedOn: statement.transactedOn,
                amountCents: statement.amountCents,
                normalizedDescription: statement.normalizedDescription,
              },
            ),
            reason: "card_payment_mirror",
            reasonDetail:
              `$${(mirror.amountCents / 100).toFixed(2)} card payment recorded twice: the statement line Chase printed on ` +
              `${statement.postedOn}, and a hand-entered mirror dated ${mirror.postedOn} (${deltaDays} day` +
              `${deltaDays === 1 ? "" : "s"} later, the bank's post date). The statement line was kept.`,
            resolution: "confirmed_duplicate",
            resolvedAt: now,
            retiredTransactionId: mirror.id,
            retiredFromStatus: "active",
          })
          .run();
      }

      // (3) pull straddling rows into the window that declares them. posted_on
      // is in the dedupe hash, so the hash is recomputed; transacted_on keeps
      // the date Chase printed, which is what it means.
      for (const c of straddlers) {
        tx.update(transactions)
          .set({
            postedOn: c.to,
            dedupeHash: dedupeHash({
              accountId: c.row.accountId,
              postedOn: c.to,
              amountCents: c.row.amountCents,
              rawDescription: c.row.rawDescription,
              occurrenceIndex: c.row.occurrenceIndex,
            }),
          })
          .where(eq(transactions.id, c.row.id))
          .run();
      }
    });
  });

  // (4) the import path's full settle sequence — outside the transaction,
  // because a nested BEGIN throws
  categorizeAll(db);
  detectTransfers(db);
  reconcileAccounts(db, [sapphire.id]);
  rebuildAccount(db, sapphire.id);
  flagDuplicateCandidates(db, [sapphire.id]);

  const after = db
    .select({ reconciliation: statementPeriods.reconciliation, gapCents: statementPeriods.gapCents })
    .from(statementPeriods)
    .where(eq(statementPeriods.accountId, sapphire.id))
    .all();
  const reconciled = after.filter((p) => p.reconciliation === "reconciled").length;
  const stillGapped = after.filter((p) => p.reconciliation === "gap");
  const quarantined = db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.accountId, sapphire.id), eq(transactions.status, "quarantined")))
    .all()[0]!.n;
  const groupsAfter = twoMemberGroupCount(db);

  console.log(`\nAPPLIED.`);
  console.log(`  periods reconciled: ${reconciled} / ${after.length}`);
  console.log(`  still gapped:       ${stillGapped.length}${stillGapped.length ? ` ${JSON.stringify(stillGapped.map((p) => p.gapCents))}` : ""}`);
  console.log(`  quarantined rows:   ${quarantined}`);
  console.log(`  two-member groups:  ${groupsBefore} -> ${groupsAfter}`);
  if (groupsAfter < groupsBefore) {
    throw new Error(`a transfer group lost a member (${groupsBefore} -> ${groupsAfter}) — restore the snapshot`);
  }
}

main();
