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
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { flagDuplicateCandidates } from "./duplicate-flags";
import { restoreDuplicatesLosingTheirSurvivor } from "./duplicate-lifecycle";
import { unimportFile } from "./import/service";
import {
  listDuplicatePairs,
  openDuplicateCount,
  resolveDuplicate,
  undoDuplicateResolution,
} from "./duplicate-resolution";

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
    expect(candidate(candidateId).resolution).toBe("unresolved");
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
