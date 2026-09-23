import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { institutions } from "@/db/schema/institutions";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { flagDuplicateCandidates } from "./duplicate-flags";
import { restoreDuplicatesLosingTheirSurvivor, retireStandIn, standInsOn } from "./duplicate-lifecycle";
import { unimportFile } from "./import/service";
import {
  listDuplicatePairs,
  openDuplicateCount,
  resolveDuplicate,
  undoDuplicateResolution,
} from "./duplicate-resolution";
import { attachTransactions } from "./recurring-links";

let dir: string;
let bundle: DbBundle;
let accountId: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-dupres-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  accountId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  fileA = makeFile("statement.pdf", chase.id);
  fileB = makeFile("spending-report.pdf", chase.id);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let fileSeq = 0;
function makeFile(fileName: string, institutionId: string): string {
  fileSeq += 1;
  return bundle.db
    .insert(importFiles)
    .values({
      fileName,
      fileSha256: `sha-res-${fileSeq}`,
      format: "pdf",
      institutionId,
      status: "parsed",
      storagePath: `/tmp/${fileName}`,
      importedAt: "2026-07-01T00:00:00.000Z",
    })
    .returning({ id: importFiles.id })
    .get().id;
}

let seq = 0;
function insertTxn(overrides: {
  importFileId?: string | null;
  postedOn?: string;
  amountCents?: number;
  description?: string;
  status?: TransactionStatus;
  transferGroupId?: string | null;
  dedupeSalt?: string;
}): string {
  seq += 1;
  const postedOn = overrides.postedOn ?? "2026-07-09";
  const amountCents = overrides.amountCents ?? -125;
  const description = overrides.description ?? `CPI CANTEEN VENDING ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      importFileId: overrides.importFileId === undefined ? fileA : overrides.importFileId,
      postedOn,
      amountCents,
      rawDescription: description,
      normalizedDescription: description,
      status: overrides.status ?? "active",
      transferGroupId: overrides.transferGroupId ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn,
        amountCents,
        rawDescription: overrides.dedupeSalt ?? `${description}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/** The shape this module exists for: one charge, two files, one description a prefix of the other. */
function flaggedPair(over: { status?: TransactionStatus } = {}): {
  a: string;
  b: string;
  candidateId: string;
} {
  const a = insertTxn({ description: "CPI CANTEEN VENDING MIAMI", ...over });
  const b = insertTxn({
    importFileId: fileB,
    description: "CPI CANTEEN VENDING MIAMI 800-628-",
    ...over,
  });
  flagDuplicateCandidates(bundle.db, [accountId]);
  const candidateId = bundle.db.select().from(duplicateCandidates).all()[0]!.id;
  return { a, b, candidateId };
}

function statusOf(id: string): TransactionStatus {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.status;
}

function isFlagged(id: string): boolean {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.needsReview;
}

function candidate(id: string) {
  return bundle.db.select().from(duplicateCandidates).where(eq(duplicateCandidates.id, id)).get()!;
}

describe("confirming a duplicate", () => {
  test("retires the side the owner chose and leaves the other one alone", () => {
    const { a, b, candidateId } = flaggedPair();

    const result = resolveDuplicate(bundle.db, {
      candidateId,
      decision: "confirmed_duplicate",
      retiredTransactionId: b,
    });

    expect(result.retiredTransactionId).toBe(b);
    expect(statusOf(b)).toBe("superseded");
    expect(statusOf(a)).toBe("active");
    expect(candidate(candidateId).resolution).toBe("confirmed_duplicate");
    expect(candidate(candidateId).retiredFromStatus).toBe("active");
  });

  test("clears the review flag on BOTH sides, so the survivor is not left as an orphan", () => {
    const { a, b, candidateId } = flaggedPair();
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);

    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });

    // The survivor would otherwise sit in the review queue for ever with no
    // partner and no reason — a question the owner cannot answer or dismiss.
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
    expect(openDuplicateCount(bundle.db)).toBe(0);
  });

  test("refuses to retire a row a statement already proved — its period reconciles to the cent", () => {
    const { b, candidateId } = flaggedPair();
    bundle.db
      .insert(statementPeriods)
      .values({
        accountId,
        importFileId: fileA,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        reconciliation: "reconciled",
      })
      .run();

    expect(() =>
      resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b }),
    ).toThrow(/reconciles/);
    expect(statusOf(b)).toBe("active");
  });

  test("refuses when the pair has since been linked as a transfer", () => {
    const { a, b, candidateId } = flaggedPair();
    bundle.db.update(transactions).set({ transferGroupId: a }).where(eq(transactions.id, a)).run();
    bundle.db.update(transactions).set({ transferGroupId: a }).where(eq(transactions.id, b)).run();

    expect(() =>
      resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b }),
    ).toThrow(/transfer/);
    expect(statusOf(b)).toBe("active");
  });

  test("refuses when a re-parse has made the two descriptions unrelated", () => {
    const { b, candidateId } = flaggedPair();
    bundle.db
      .update(transactions)
      .set({ normalizedDescription: "SOMETHING ENTIRELY ELSE" })
      .where(eq(transactions.id, b))
      .run();

    expect(() =>
      resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b }),
    ).toThrow(/same charge/);
    expect(statusOf(b)).toBe("active");
  });

  test("refuses a transaction that is not part of the pair", () => {
    const { candidateId } = flaggedPair();
    const stranger = insertTxn({ description: "UNRELATED", postedOn: "2026-01-01" });

    expect(() =>
      resolveDuplicate(bundle.db, {
        candidateId,
        decision: "confirmed_duplicate",
        retiredTransactionId: stranger,
      }),
    ).toThrow(/not part of this pair/);
  });

  test("refuses to resolve the same pair twice", () => {
    const { b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });

    expect(() =>
      resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b }),
    ).toThrow(/already been resolved/);
  });
});

describe("dismissing a pair", () => {
  test("moves no money and clears the question", () => {
    const { a, b, candidateId } = flaggedPair();

    resolveDuplicate(bundle.db, { candidateId, decision: "dismissed" });

    expect(statusOf(a)).toBe("active");
    expect(statusOf(b)).toBe("active");
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
    expect(candidate(candidateId).resolution).toBe("dismissed");
  });

  test("confirming without naming a side is rejected before anything runs", () => {
    const { candidateId } = flaggedPair();

    expect(() => resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate" })).toThrow();
  });
});

describe("undoing a resolution", () => {
  test("puts a retired row back and re-opens the question", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });

    undoDuplicateResolution(bundle.db, { candidateId });

    expect(statusOf(b)).toBe("active");
    expect(candidate(candidateId).resolution).toBe("unresolved");
    expect(candidate(candidateId).retiredTransactionId).toBeNull();
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });

  test("restores an EXCLUDED row as excluded, not active", () => {
    const { b, candidateId } = flaggedPair({ status: "excluded" });
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    expect(statusOf(b)).toBe("superseded");

    undoDuplicateResolution(bundle.db, { candidateId });

    // 'excluded' is a decision the owner made for his own reasons; restoring it
    // as 'active' would quietly reverse that decision while claiming to undo.
    expect(statusOf(b)).toBe("excluded");
  });

  test("refuses when another copy has taken the retired row's dedupe slot", () => {
    const { b, candidateId } = flaggedPair();
    const retiredHash = bundle.db.select().from(transactions).where(eq(transactions.id, b)).get()!.dedupeHash;
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    // a re-import (or a manual entry numbered over non-superseded rows) claims
    // the slot the retired row vacated under the partial unique index
    insertTxn({ importFileId: fileB, description: "CPI CANTEEN VENDING MIAMI 800-628-", dedupeSalt: "x" });
    bundle.db
      .update(transactions)
      .set({ dedupeHash: retiredHash })
      .where(eq(transactions.id, bundle.db.select().from(transactions).all().at(-1)!.id))
      .run();

    expect(() => undoDuplicateResolution(bundle.db, { candidateId })).toThrow(/already in your ledger/);
    expect(statusOf(b)).toBe("superseded");
  });

  test("re-opens a dismissed pair", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "dismissed" });

    undoDuplicateResolution(bundle.db, { candidateId });

    expect(candidate(candidateId).resolution).toBe("unresolved");
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });

  test("refuses to undo a pair that was never resolved", () => {
    const { candidateId } = flaggedPair();

    expect(() => undoDuplicateResolution(bundle.db, { candidateId })).toThrow(/not been resolved/);
  });
});

describe("the queue the owner reads", () => {
  test("shows both sides, where each came from, and why they were paired", () => {
    const { a, b, candidateId } = flaggedPair();

    const pairs = listDuplicatePairs(bundle.db);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.candidateId).toBe(candidateId);
    expect(pairs[0]!.reasonDetail).toContain("$1.25");
    expect(pairs[0]!.sides.map((s) => s.id).sort()).toEqual([a, b].sort());
    // naming the FILE is the owner's main way to judge which copy to keep
    expect(pairs[0]!.sides.map((s) => s.sourceLabel).sort()).toEqual(
      ["spending-report.pdf", "statement.pdf"],
    );
    expect(openDuplicateCount(bundle.db)).toBe(1);
  });

  test("keeps a resolved pair visible, so the retired row stays reachable to undo", () => {
    const { b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });

    const pairs = listDuplicatePairs(bundle.db);

    // no transactions view renders a superseded row, so this queue is the only
    // place the owner can see what he retired — or take it back
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.resolution).toBe("confirmed_duplicate");
    expect(pairs[0]!.retiredTransactionId).toBe(b);
    expect(pairs[0]!.sides.find((s) => s.id === b)!.status).toBe("superseded");
    expect(openDuplicateCount(bundle.db)).toBe(0);
  });

  test("drops a sibling pair the owner could never answer, but keeps the resolved one", () => {
    // Two identical charges in EACH of two files. The unique index is on the id
    // pair, not on pair_key, so this is four candidates over four rows — and
    // retiring one row leaves the siblings that name it pointing at a superseded
    // row, which no retire button can act on.
    const a1 = insertTxn({ description: "CPI CANTEEN VENDING MIAMI" });
    const a2 = insertTxn({ description: "CPI CANTEEN VENDING MIAMI" });
    insertTxn({ importFileId: fileB, description: "CPI CANTEEN VENDING MIAMI 800-628-" });
    insertTxn({ importFileId: fileB, description: "CPI CANTEEN VENDING MIAMI 800-628-" });
    flagDuplicateCandidates(bundle.db, [accountId]);
    expect(openDuplicateCount(bundle.db)).toBe(4);

    const naming = bundle.db
      .select()
      .from(duplicateCandidates)
      .all()
      .filter((c) => c.transactionIdA === a1 || c.transactionIdB === a1);
    expect(naming).toHaveLength(2);
    resolveDuplicate(bundle.db, {
      candidateId: naming[0]!.id,
      decision: "confirmed_duplicate",
      retiredTransactionId: a1,
    });

    // the sibling naming a1 is gone from the queue; the two pairs about a2
    // remain askable, and the resolved one stays visible for its undo
    expect(openDuplicateCount(bundle.db)).toBe(2);
    const listed = listDuplicatePairs(bundle.db);
    expect(listed.map((p) => p.candidateId)).toContain(naming[0]!.id);
    expect(listed.map((p) => p.candidateId)).not.toContain(naming[1]!.id);
    expect(listed.filter((p) => p.resolution === "unresolved")).toHaveLength(2);
    expect(listed.filter((p) => p.resolution === "unresolved").every((p) =>
      p.sides.some((s) => s.id === a2),
    )).toBe(true);
  });

  test("marks a side a statement has proved, so the UI can refuse to retire it", () => {
    flaggedPair();
    bundle.db
      .insert(statementPeriods)
      .values({
        accountId,
        importFileId: fileA,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        reconciliation: "reconciled",
      })
      .run();

    expect(listDuplicatePairs(bundle.db)[0]!.sides.every((s) => s.provenByStatement)).toBe(true);
  });
});

describe("a hard delete must not take the money with it", () => {
  test("restores the retired copy when its SURVIVOR is about to be deleted", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    expect(statusOf(b)).toBe("superseded");

    // un-importing the survivor's file is about to delete `a`
    const restored = restoreDuplicatesLosingTheirSurvivor(bundle.db, [a]);

    expect(restored).toEqual([b]);
    // without this the charge would be recorded by ZERO live rows: `a` deleted,
    // `b` still superseded, and the money gone from net worth with no error
    expect(statusOf(b)).toBe("active");
    // 🔴 the pair used to be re-opened here — a question with one side about to
    // be NULL, on no queue — and the owner's verdict was gone, so re-importing
    // `a`'s statement counted the charge twice (duplicate-lifecycle). The copy
    // stands in for `a` and the verdict stays, naming it.
    expect(candidate(candidateId)).toMatchObject({ resolution: "confirmed_duplicate", retiredTransactionId: b });
  });

  test("retired again beside a kept row that has a link of its own, the copy leaves no partner alone in its group", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    const partner = insertTxn({ importFileId: fileB, amountCents: 125, description: "PARTNER LEG", transferGroupId: "group-a" });
    bundle.db.update(transactions).set({ transferGroupId: "group-a" }).where(eq(transactions.id, a)).run();
    bundle.db.transaction((tx) => {
      restoreDuplicatesLosingTheirSurvivor(tx, [a]);
      tx.delete(transactions).where(eq(transactions.id, a)).run();
    });
    const [standIn] = standInsOn(bundle.db, accountId);
    expect(standIn!.copy.id).toBe(b);
    // the line comes back already linked elsewhere
    const back = insertTxn({ description: "CPI CANTEEN VENDING MIAMI", transferGroupId: "group-other" });

    retireStandIn(bundle.db, accountId, standIn!, back);

    expect(bundle.db.select().from(transactions).where(eq(transactions.id, back)).get()!.transferGroupId).toBe("group-other");
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, b)).get()).toMatchObject({ status: "superseded", transferGroupId: null });
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, partner)).get()!.transferGroupId).toBeNull();
  });

  test("retiring the stand-in names the series that was counting the copy, so the import can settle it", () => {
    // It runs inside the write transaction and cannot open one of its own, so
    // it hands the series back to the batch (`settleSeriesStats`) instead. The
    // copy leaves replay; a series still naming its posting would report a
    // charge the ledger no longer counts.
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    const seriesId = bundle.db
      .insert(recurringSeries)
      .values({ name: "CPI canteen", kind: "bill", cadence: "monthly", status: "confirmed" })
      .returning({ id: recurringSeries.id })
      .get().id;
    bundle.db.transaction((tx) => {
      restoreDuplicatesLosingTheirSurvivor(tx, [a]);
      tx.delete(transactions).where(eq(transactions.id, a)).run();
    });
    bundle.db.update(transactions).set({ recurringSeriesId: seriesId }).where(eq(transactions.id, b)).run();
    const [standIn] = standInsOn(bundle.db, accountId);
    const back = insertTxn({ description: "CPI CANTEEN VENDING MIAMI" });

    expect(retireStandIn(bundle.db, accountId, standIn!, back)).toBe(seriesId);
  });

  test("the restored copy takes the kept row's transfer link when it has none", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    bundle.db.update(transactions).set({ transferGroupId: "group-a" }).where(eq(transactions.id, a)).run();

    restoreDuplicatesLosingTheirSurvivor(bundle.db, [a]);

    expect(bundle.db.select().from(transactions).where(eq(transactions.id, b)).get()!.transferGroupId).toBe("group-a");
  });

  test("does nothing when the RETIRED copy is the one being deleted", () => {
    const { b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });

    // the survivor still holds the money, so there is nothing to rescue
    expect(restoreDuplicatesLosingTheirSurvivor(bundle.db, [b])).toEqual([]);
    expect(candidate(candidateId).resolution).toBe("confirmed_duplicate");
  });

  test("leaves an unresolved pair untouched — no row is standing in for another", () => {
    const { a } = flaggedPair();

    expect(restoreDuplicatesLosingTheirSurvivor(bundle.db, [a])).toEqual([]);
  });

  test("skips — never throws — when another live row already holds the retired row's slot", () => {
    const { a, b, candidateId } = flaggedPair();
    const retiredHash = bundle.db.select().from(transactions).where(eq(transactions.id, b)).get()!.dedupeHash;
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    // an edited manual row lands on the retired row's exact identity while it is
    // away — occurrence_index is numbered over non-superseded rows only
    const squatter = insertTxn({ description: "CPI CANTEEN VENDING MIAMI 800-628-", dedupeSalt: "squatter" });
    bundle.db.update(transactions).set({ dedupeHash: retiredHash }).where(eq(transactions.id, squatter)).run();

    // Throwing here would make the survivor's file impossible to un-import for
    // ever. The squatter IS this money, so there is nothing to rescue.
    expect(() => restoreDuplicatesLosingTheirSurvivor(bundle.db, [a])).not.toThrow();
    expect(restoreDuplicatesLosingTheirSurvivor(bundle.db, [a])).toEqual([]);
    expect(statusOf(b)).toBe("superseded");
  });

  /*
   * The restored copy re-enters the ledger the way an imported row does, so it
   * is linked the way an imported row is: to the live series already carrying
   * its exact description. Un-import restores it, and nothing else would.
   */
  test("the copy un-import puts back joins the series that already carries its description", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    const seriesId = bundle.db
      .insert(recurringSeries)
      .values({ name: "CPI canteen", kind: "bill", cadence: "monthly", status: "confirmed" })
      .returning({ id: recurringSeries.id })
      .get().id;
    const sibling = insertTxn({ importFileId: fileB, postedOn: "2026-06-09", description: "CPI CANTEEN VENDING MIAMI 800-628-" });
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: seriesId, seriesLinkSource: "detected" })
      .where(eq(transactions.id, sibling))
      .run();

    unimportFile(bundle.db, fileA);

    expect(bundle.db.select().from(transactions).where(eq(transactions.id, a)).get()).toBeUndefined();
    expect(statusOf(b)).toBe("active");
    const restored = bundle.db.select().from(transactions).where(eq(transactions.id, b)).get()!;
    expect(restored.recurringSeriesId).toBe(seriesId);
    expect(restored.seriesLinkSource).toBe("detected");
  });

  test("un-importing the survivor's file puts the retired copy back, end to end", () => {
    const { a, b, candidateId } = flaggedPair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: b });
    expect(statusOf(b)).toBe("superseded");

    // the owner removes the file the SURVIVING copy came from
    unimportFile(bundle.db, fileA);

    expect(bundle.db.select().from(transactions).where(eq(transactions.id, a)).get()).toBeUndefined();
    // the charge is still recorded exactly once, by the copy that remains
    expect(statusOf(b)).toBe("active");
    expect(isFlagged(b)).toBe(true);
  });
});

/**
 * Retiring a row takes it out of balance replay and out of every total — and a
 * series linked to it went on counting it. `recomputeSeriesStats` reads active
 * rows only, so a series must be re-settled whenever a linked row leaves the
 * ledger or comes back, exactly as an un-import already does.
 */
describe("a retired or restored row re-settles its recurring series", () => {
  function confirmedMonthly(name: string): string {
    return bundle.db
      .insert(recurringSeries)
      .values({ name, kind: "bill", cadence: "monthly", status: "confirmed", intervalDaysAvg: 30 })
      .returning({ id: recurringSeries.id })
      .get().id;
  }

  function lastMatchedOn(seriesId: string): string | null {
    return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get()!.lastMatchedOn;
  }

  /** A monthly series whose newest posting is the copy the owner is about to retire. */
  function seriesEndingOnThePair(): { series: string; retire: string; candidateId: string } {
    const { b, candidateId } = flaggedPair(); // both sides posted 2026-07-09
    // the older postings live in the COPY's file, so un-importing the survivor's
    // file below takes no linked row with it — only the restore matters
    const may = insertTxn({ importFileId: fileB, postedOn: "2026-05-09" });
    const june = insertTxn({ importFileId: fileB, postedOn: "2026-06-09" });
    const series = confirmedMonthly("CPI canteen");
    attachTransactions(bundle.db, series, [may, june, b]);
    expect(lastMatchedOn(series)).toBe("2026-07-09");
    return { series, retire: b, candidateId };
  }

  test("confirming the duplicate stops the series naming the charge it just retired", () => {
    const { series, retire, candidateId } = seriesEndingOnThePair();

    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: retire });

    expect(statusOf(retire)).toBe("superseded");
    expect(lastMatchedOn(series)).toBe("2026-06-09");
  });

  test("undoing the confirmation puts the charge back into the series' stats", () => {
    const { series, retire, candidateId } = seriesEndingOnThePair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: retire });

    undoDuplicateResolution(bundle.db, { candidateId });

    expect(statusOf(retire)).toBe("active");
    expect(lastMatchedOn(series)).toBe("2026-07-09");
  });

  test("the copy an un-import puts back counts again, even though it kept its link", () => {
    // Un-import links the rows it makes active, but that claims UNLINKED rows
    // only — a copy that was already attached to a series comes back carrying
    // its link, and nothing would settle the series it rejoins.
    const { series, retire, candidateId } = seriesEndingOnThePair();
    resolveDuplicate(bundle.db, { candidateId, decision: "confirmed_duplicate", retiredTransactionId: retire });
    expect(lastMatchedOn(series)).toBe("2026-06-09");

    // the owner removes the file the SURVIVING copy came from
    unimportFile(bundle.db, fileA);

    expect(statusOf(retire)).toBe("active");
    expect(lastMatchedOn(series)).toBe("2026-07-09");
  });
});
