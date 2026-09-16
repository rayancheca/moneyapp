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

let dir: string;
let bundle: DbBundle;
let accountId: string;
let otherAccountId: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-dupflag-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  accountId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  otherAccountId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
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
      fileSha256: `sha-${fileSeq}`,
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
  accountId?: string;
  importFileId?: string | null;
  postedOn?: string;
  transactedOn?: string | null;
  amountCents?: number;
  description?: string;
  status?: TransactionStatus;
  needsReview?: boolean;
  transferGroupId?: string | null;
}): string {
  seq += 1;
  const acct = overrides.accountId ?? accountId;
  const postedOn = overrides.postedOn ?? "2026-06-15";
  const amountCents = overrides.amountCents ?? -125;
  const description = overrides.description ?? `CPI CANTEEN VENDING ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: acct,
      importFileId: overrides.importFileId === undefined ? fileA : overrides.importFileId,
      postedOn,
      transactedOn: overrides.transactedOn ?? null,
      amountCents,
      rawDescription: description,
      normalizedDescription: description,
      status: overrides.status ?? "active",
      needsReview: overrides.needsReview ?? false,
      transferGroupId: overrides.transferGroupId ?? null,
      dedupeHash: dedupeHash({
        accountId: acct,
        postedOn,
        amountCents,
        rawDescription: `${description}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function isFlagged(id: string): boolean {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.needsReview;
}

/** The real pair from the owner's ledger: one charge, two sources, one description a prefix of the other. */
function realDuplicatePair(over: { status?: TransactionStatus } = {}): [string, string] {
  const a = insertTxn({ description: "CPI CANTEEN VENDING MIAMI", postedOn: "2026-07-09", ...over });
  const b = insertTxn({
    importFileId: fileB,
    description: "CPI CANTEEN VENDING MIAMI 800-628-",
    postedOn: "2026-07-09",
    ...over,
  });
  return [a, b];
}

describe("flagDuplicateCandidates", () => {
  test("flags BOTH sides of a cross-source pair that describes the same charge differently", () => {
    // description EQUALITY — what the pass this replaces demanded — misses this
    // entirely, which is why that pass flagged 0 rows on the real ledger
    const [a, b] = realDuplicatePair();

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });

  test("never flags two rows from the SAME file", () => {
    // 1,766 rows in the real ledger collide on (account, day, amount) inside a
    // single file. The descriptions here are deliberately IDENTICAL: an earlier
    // version used TRADER JOES vs SHELL GAS, which descriptionScore already
    // vetoes on its own — so the same-file clause could be deleted with the
    // test still green. Identical text isolates the clause under test.
    const a = insertTxn({ description: "CPI CANTEEN VENDING MIAMI", amountCents: -2_500 });
    const b = insertTxn({ description: "CPI CANTEEN VENDING MIAMI", amountCents: -2_500 });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
  });

  test("never flags a pair whose description normalizes away entirely", () => {
    // "".includes("") is true, so descriptionScore scores an empty description
    // 2 against ANY text and the gate stops gating. Reachable: a raw
    // description that is only a reference number normalizes to "".
    const a = insertTxn({ description: "", postedOn: "2026-07-09" });
    const b = insertTxn({ importFileId: fileB, description: "", postedOn: "2026-07-09" });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
  });

  test("never flags two rows whose descriptions are unrelated", () => {
    // measured on the real ledger: a $4,000 Microsoft buy and a $4,000 crypto
    // cash settlement landed on the same day in the same account
    const a = insertTxn({ amountCents: -400_000, description: "Microsoft CUSIP 594918104 MSFT" });
    const b = insertTxn({
      importFileId: fileB,
      amountCents: -400_000,
      description: "Cash settlement Crypto Purchase ETH",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
  });

  test("matches transaction-date to transaction-date when the post dates disagree", () => {
    // a card statement prints the TRANSACTION date; the export already stored
    // carries the POST date, typically a day or three later
    const a = insertTxn({ description: "CPI CANTEEN", postedOn: "2026-07-09", transactedOn: "2026-07-08" });
    const b = insertTxn({
      importFileId: fileB,
      description: "CPI CANTEEN MIAMI",
      postedOn: "2026-07-11",
      transactedOn: "2026-07-08",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });

  test("never cross-matches one row's post date against another's transaction date", () => {
    // measured: consecutive $3.00 MTA fares chain into false pairs this way,
    // because each fare's post date IS the next fare's transaction date. Two
    // distinct rides, not one ride recorded twice — and the descriptions are
    // identical, so the description gate cannot save us here.
    const a = insertTxn({
      amountCents: -300,
      description: "MTA NYCT PAYGO NEW YORK NY",
      postedOn: "2026-04-13",
      transactedOn: "2026-04-11",
    });
    const b = insertTxn({
      importFileId: fileB,
      amountCents: -300,
      description: "MTA NYCT PAYGO NEW YORK NY",
      postedOn: "2026-04-15",
      transactedOn: "2026-04-13",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
  });

  test("never flags adjacent dates — a same-amount charge a day apart is ordinary spending", () => {
    // the "date ±1" of docs/schema.md would pair two distinct month-end ETH
    // buys of $9.90 whose descriptions normalize identically
    const a = insertTxn({ amountCents: 990, postedOn: "2025-11-30", description: "Crypto Purchase ETH" });
    const b = insertTxn({
      importFileId: fileB,
      amountCents: 990,
      postedOn: "2025-12-01",
      description: "Crypto Purchase ETH",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
  });

  describe("reconciliation outranks the heuristic", () => {
    function period(reconciliation: "reconciled" | "accepted" | "gap"): void {
      bundle.db
        .insert(statementPeriods)
        .values({
          accountId,
          importFileId: fileA,
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          reconciliation,
        })
        .run();
    }

    test("never flags inside a RECONCILED period — the statement already proved the money", () => {
      // the owner buys from one vending machine several times a day; a single
      // file records three separate $1.25 charges on 2026-07-08. Two $1.25
      // charges from two files on 2026-07-09 look exactly like a duplicate, and
      // the period they sit in reconciles to the cent with BOTH counted — which
      // proves both are real. This is the flagger's only hit on the whole real
      // ledger without this guard.
      const [a, b] = realDuplicatePair();
      period("reconciled");

      expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
      expect(isFlagged(a)).toBe(false);
      expect(isFlagged(b)).toBe(false);
    });

    test("DOES flag inside an ACCEPTED period — that is a gap the owner could not explain", () => {
      const [a, b] = realDuplicatePair();
      period("accepted");

      expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
      expect(isFlagged(a)).toBe(true);
      expect(isFlagged(b)).toBe(true);
    });

    test("a reconciled period elsewhere in time does not protect rows outside it", () => {
      const [a] = realDuplicatePair(); // dated 2026-07-09
      bundle.db
        .insert(statementPeriods)
        .values({
          accountId,
          importFileId: fileA,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          reconciliation: "reconciled",
        })
        .run();

      expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
      expect(isFlagged(a)).toBe(true);
    });
  });

  test("flags an EXCLUDED twin — excluded money is still in balance replay", () => {
    // 'excluded' hides a row from analytics but the money still moves
    // (derivation REPLAY_STATUSES), so an excluded duplicate double-counts net
    // worth exactly as an active one does
    const [a, b] = realDuplicatePair({ status: "excluded" });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });

  test("ignores rows outside balance replay, and rows already tied as a transfer", () => {
    const [quarantined] = realDuplicatePair({ status: "quarantined" });
    const transferA = insertTxn({ postedOn: "2026-08-01", description: "PAYMENT CHASE 3522", transferGroupId: "g1" });
    insertTxn({
      importFileId: fileB,
      postedOn: "2026-08-01",
      description: "PAYMENT CHASE 3522",
      transferGroupId: "g2",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(quarantined)).toBe(false);
    expect(isFlagged(transferA)).toBe(false);
  });

  test("does not pair rows on different accounts", () => {
    const a = insertTxn({ accountId, description: "CPI CANTEEN VENDING MIAMI" });
    const b = insertTxn({
      accountId: otherAccountId,
      importFileId: fileB,
      description: "CPI CANTEEN VENDING MIAMI",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId, otherAccountId])).toBe(0);
    expect(isFlagged(a)).toBe(false);
    expect(isFlagged(b)).toBe(false);
  });

  test("pairs a hand-entered row against an imported one, but never two hand-entered rows", () => {
    // 172 rows in the real ledger carry a NULL import_file_id. `!=` is NULL for
    // those — the pass this replaces was blind to every one of them — so the
    // join uses `IS NOT`, which also correctly refuses to call two hand-entered
    // rows two sources.
    const manual = insertTxn({ importFileId: null, postedOn: "2026-05-02", description: "CPI CANTEEN VENDING" });
    const imported = insertTxn({ postedOn: "2026-05-02", description: "CPI CANTEEN VENDING MIAMI" });
    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
    expect(isFlagged(manual)).toBe(true);
    expect(isFlagged(imported)).toBe(true);

    const m1 = insertTxn({ importFileId: null, postedOn: "2026-09-09", description: "Coffee" });
    const m2 = insertTxn({ importFileId: null, postedOn: "2026-09-09", description: "Coffee" });
    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(isFlagged(m1)).toBe(false);
    expect(isFlagged(m2)).toBe(false);
  });

  describe("scope", () => {
    test("an empty account list is a no-op, not a whole-ledger sweep", () => {
      const [a, b] = realDuplicatePair();

      expect(flagDuplicateCandidates(bundle.db, [])).toBe(0);
      expect(isFlagged(a)).toBe(false);
      expect(isFlagged(b)).toBe(false);
    });

    test("leaves other accounts alone", () => {
      const [a] = realDuplicatePair();
      const farA = insertTxn({
        accountId: otherAccountId,
        postedOn: "2026-01-05",
        amountCents: -4_242,
        description: "CPI CANTEEN VENDING",
      });
      const farB = insertTxn({
        accountId: otherAccountId,
        importFileId: fileB,
        postedOn: "2026-01-05",
        amountCents: -4_242,
        description: "CPI CANTEEN VENDING MIAMI",
      });

      expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
      expect(isFlagged(a)).toBe(true);
      expect(isFlagged(farA)).toBe(false);
      expect(isFlagged(farB)).toBe(false);
    });

    test("sweeps past the 500-id chunk boundary", () => {
      // 600 ids forces a second chunk; the pair's account is in the LAST one, so
      // a loop that returned after the first chunk would flag nothing
      const [a, b] = realDuplicatePair();
      const padding = Array.from({ length: 599 }, (_, i) => `missing-${i}`);

      expect(flagDuplicateCandidates(bundle.db, [...padding, accountId])).toBe(2);
      expect(isFlagged(a)).toBe(true);
      expect(isFlagged(b)).toBe(true);
    });
  });

  test("counts only rows it newly flags, so a re-run reports nothing found", () => {
    realDuplicatePair();

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(2);
    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
  });

  test("does not re-count a row the owner had already flagged for another reason", () => {
    const a = insertTxn({ description: "CPI CANTEEN VENDING MIAMI", postedOn: "2026-07-09", needsReview: true });
    const b = insertTxn({
      importFileId: fileB,
      description: "CPI CANTEEN VENDING MIAMI 800-628-",
      postedOn: "2026-07-09",
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(1);
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });
});

describe("the recorded pair", () => {
  function candidates() {
    return bundle.db.select().from(duplicateCandidates).all();
  }

  test("records the pair itself, with the reason the owner will read", () => {
    const [a, b] = realDuplicatePair();

    flagDuplicateCandidates(bundle.db, [accountId]);

    const rows = candidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(accountId);
    expect(rows[0]!.reason).toBe("cross_source_same_day");
    expect(rows[0]!.resolution).toBe("unresolved");
    // the sentence names the money and the day — the two things it matched on
    expect(rows[0]!.reasonDetail).toContain("$1.25");
    expect(rows[0]!.reasonDetail).toContain("2026-07-09");
    // ids canonically ordered, so the unique index actually dedupes
    expect([rows[0]!.transactionIdA, rows[0]!.transactionIdB]).toEqual([a, b].sort());
  });

  test("the symmetric self-join emits each pair twice but stores it once", () => {
    realDuplicatePair();

    flagDuplicateCandidates(bundle.db, [accountId]);
    flagDuplicateCandidates(bundle.db, [accountId]);

    expect(candidates()).toHaveLength(1);
  });

  test("never asks again about a pair the owner dismissed — even after a re-import renumbers it", () => {
    const [a, b] = realDuplicatePair();
    flagDuplicateCandidates(bundle.db, [accountId]);
    const pair = candidates()[0]!;
    bundle.db
      .update(duplicateCandidates)
      .set({ resolution: "dismissed", resolvedAt: "2026-07-10" })
      .where(eq(duplicateCandidates.id, pair.id))
      .run();

    // un-import + re-import: the same two charges come back as BRAND-NEW rows.
    // An id-keyed memory would forget the owner's answer here and ask again —
    // which is exactly the import-order dependence this table exists to end.
    bundle.db.delete(transactions).where(eq(transactions.id, a)).run();
    bundle.db.delete(transactions).where(eq(transactions.id, b)).run();
    const [a2, b2] = realDuplicatePair();

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(candidates().filter((c) => c.resolution === "unresolved")).toHaveLength(0);
    expect(isFlagged(a2)).toBe(false);
    expect(isFlagged(b2)).toBe(false);
  });

  test("re-opens a settled pair when the retired copy comes back", () => {
    const [a, b] = realDuplicatePair();
    flagDuplicateCandidates(bundle.db, [accountId]);
    const pair = candidates()[0]!;
    // settled by retiring one side...
    bundle.db
      .update(duplicateCandidates)
      .set({ resolution: "confirmed_duplicate", retiredTransactionId: b, retiredFromStatus: "active" })
      .where(eq(duplicateCandidates.id, pair.id))
      .run();
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, b)).run();
    // ...and while it is retired the pair cannot be re-derived at all
    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(candidates()[0]!.resolution).toBe("confirmed_duplicate");

    // the retired row returns (undone by hand)
    bundle.db.update(transactions).set({ status: "active" }).where(eq(transactions.id, b)).run();

    flagDuplicateCandidates(bundle.db, [accountId]);

    const reopened = candidates()[0]!;
    expect(reopened.resolution).toBe("unresolved");
    expect(reopened.retiredTransactionId).toBeNull();
    expect(isFlagged(a)).toBe(true);
    expect(isFlagged(b)).toBe(true);
  });

  test("records nothing when the description gate vetoes the pair", () => {
    insertTxn({ description: "MICROSOFT CUSIP MSFT", postedOn: "2026-06-23", amountCents: -400000 });
    insertTxn({
      importFileId: fileB,
      description: "cash settlement crypto purchase",
      postedOn: "2026-06-23",
      amountCents: -400000,
    });

    expect(flagDuplicateCandidates(bundle.db, [accountId])).toBe(0);
    expect(candidates()).toHaveLength(0);
  });
});
