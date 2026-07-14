import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import {
  addManualTransaction,
  deleteManualTransaction,
  editManualTransaction,
  isCashWallet,
} from "./manual-transactions";

let dir: string;
let bundle: DbBundle;
let chaseId: string;
let cashInstId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-manual-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  chaseId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  // cash wallets live under the "Cash" institution — the positive marker
  // isCashWallet requires (a structural-only check would misclassify empty
  // regular accounts). Create it once for the helpers below.
  cashInstId = bundle.db.insert(institutions).values({ name: "Cash" }).returning({ id: institutions.id }).get().id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeCashWallet(name = "Wallet"): string {
  return createAccount(bundle.db, { institutionId: cashInstId, name, type: "checking" });
}

function anyCategoryId(): string {
  return bundle.db.select({ id: categories.id }).from(categories).get()!.id;
}

/** Minimal import-file row so we can attach periods / imported transactions. */
function makeImportFile(): string {
  return bundle.db
    .insert(importFiles)
    .values({
      fileName: "statement.csv",
      fileSha256: `sha-${Math.random()}`,
      format: "csv",
      institutionId: chaseId,
      status: "parsed",
      storagePath: "data/originals/statement.csv",
      importedAt: "2026-06-30T00:00:00.000Z",
    })
    .returning({ id: importFiles.id })
    .get().id;
}

function dailyRow(accountId: string, day: string) {
  return bundle.db
    .select()
    .from(dailyBalances)
    .where(and(eq(dailyBalances.accountId, accountId), eq(dailyBalances.day, day)))
    .get();
}

describe("addManualTransaction — cash-wallet gate", () => {
  test("succeeds on a bare cash wallet; row is manual (importFileId NULL) and user-categorized", () => {
    // Arrange
    const acct = makeCashWallet();
    const categoryId = anyCategoryId();

    // Act
    const id = addManualTransaction(bundle.db, {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -2_000,
      description: "Cash coffee",
      categoryId,
    });

    // Assert
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(row.importFileId).toBeNull();
    expect(row.statementPeriodId).toBeNull();
    expect(row.categoryId).toBe(categoryId);
    expect(row.categorizationSource).toBe("user");
    expect(row.occurrenceIndex).toBe(0);
  });

  test("throws on a statement-anchored account", () => {
    const acct = makeCashWallet("Stmt");
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: acct, anchoredOn: "2026-06-30", balanceCents: 100_000, source: "statement" })
      .run();
    expect(isCashWallet(bundle.db, acct)).toBe(false);
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: -2_000,
        description: "Nope",
      }),
    ).toThrow(/cash-wallet/);
  });

  test("throws on an ofx_ledger-anchored account", () => {
    const acct = makeCashWallet("Ofx");
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: acct, anchoredOn: "2026-06-30", balanceCents: 100_000, source: "ofx_ledger" })
      .run();
    expect(isCashWallet(bundle.db, acct)).toBe(false);
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: -2_000,
        description: "Nope",
      }),
    ).toThrow(/cash-wallet/);
  });

  // Regression: a connection-only account whose only ground truth is a
  // real-time 'live' balance is NOT a cash wallet. Before the fix, 'live'
  // was omitted from the anchor exclusion and this insert wrongly SUCCEEDED.
  test("throws on a 'live'-anchored (connection-only) account", () => {
    const acct = makeCashWallet("Live");
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: acct, anchoredOn: "2026-07-10", balanceCents: 100_000, source: "live" })
      .run();
    expect(isCashWallet(bundle.db, acct)).toBe(false);
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: -2_000,
        description: "Nope",
      }),
    ).toThrow(/cash-wallet/);
  });

  test("throws on an account with a statement period", () => {
    const acct = makeCashWallet("Period");
    const importFileId = makeImportFile();
    bundle.db
      .insert(statementPeriods)
      .values({
        importFileId,
        accountId: acct,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        reconciliation: "reconciled",
      })
      .run();
    expect(isCashWallet(bundle.db, acct)).toBe(false);
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: -2_000,
        description: "Nope",
      }),
    ).toThrow(/cash-wallet/);
  });

  test("throws on an account carrying an imported transaction", () => {
    const acct = makeCashWallet("Imported");
    const importFileId = makeImportFile();
    bundle.db
      .insert(transactions)
      .values({
        accountId: acct,
        importFileId,
        postedOn: "2026-06-15",
        amountCents: -3_000,
        rawDescription: "IMPORTED ROW",
        normalizedDescription: "IMPORTED ROW",
        dedupeHash: dedupeHash({
          accountId: acct,
          postedOn: "2026-06-15",
          amountCents: -3_000,
          rawDescription: "IMPORTED ROW",
          occurrenceIndex: 0,
        }),
      })
      .run();
    expect(isCashWallet(bundle.db, acct)).toBe(false);
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: -2_000,
        description: "Nope",
      }),
    ).toThrow(/cash-wallet/);
  });

  test("a not-yet-imported REGULAR account is NOT a cash wallet (institution marker)", () => {
    // the danger: a brand-new bank account with no imports yet would pass a
    // structural-only check and later break its reconciliation. The "Cash"
    // institution marker excludes it.
    const regular = createAccount(bundle.db, {
      institutionId: chaseId,
      name: "Empty Checking",
      type: "checking",
    });
    expect(isCashWallet(bundle.db, regular)).toBe(false);
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: regular,
        postedOn: "2026-06-15",
        amountCents: -500,
        description: "cash tip",
      }),
    ).toThrow(/cash-wallet/);
  });
});

describe("addManualTransaction — occurrence indexing", () => {
  test("two identical rows both insert with occurrenceIndex 0 then 1 and distinct dedupe hashes", () => {
    const acct = makeCashWallet();
    const input = {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -2_000,
      description: "Cash coffee",
    };

    const firstId = addManualTransaction(bundle.db, { ...input });
    const secondId = addManualTransaction(bundle.db, { ...input });

    expect(firstId).not.toBe(secondId);
    const first = bundle.db.select().from(transactions).where(eq(transactions.id, firstId)).get()!;
    const second = bundle.db.select().from(transactions).where(eq(transactions.id, secondId)).get()!;
    expect(first.occurrenceIndex).toBe(0);
    expect(second.occurrenceIndex).toBe(1);
    expect(first.dedupeHash).not.toBe(second.dedupeHash);
  });
});

describe("addManualTransaction — schema validation", () => {
  test("rejects a zero amount", () => {
    const acct = makeCashWallet();
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: 0,
        description: "Zero",
      }),
    ).toThrow();
  });

  test("rejects an empty description", () => {
    const acct = makeCashWallet();
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: "2026-07-02",
        amountCents: -2_000,
        description: "   ",
      }),
    ).toThrow();
  });
});

describe("deleteManualTransaction", () => {
  test("removes a manual row but refuses to delete an imported one", () => {
    const acct = makeCashWallet();
    const manualId = addManualTransaction(bundle.db, {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -2_000,
      description: "Cash coffee",
    });

    // an imported row on the same account (added after, so the gate was open first)
    const importFileId = makeImportFile();
    const importedId = bundle.db
      .insert(transactions)
      .values({
        accountId: acct,
        importFileId,
        postedOn: "2026-06-15",
        amountCents: -3_000,
        rawDescription: "IMPORTED ROW",
        normalizedDescription: "IMPORTED ROW",
        dedupeHash: dedupeHash({
          accountId: acct,
          postedOn: "2026-06-15",
          amountCents: -3_000,
          rawDescription: "IMPORTED ROW",
          occurrenceIndex: 0,
        }),
      })
      .returning({ id: transactions.id })
      .get().id;

    expect(() => deleteManualTransaction(bundle.db, importedId)).toThrow(/audit trail/);
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, importedId)).get()).toBeDefined();

    deleteManualTransaction(bundle.db, manualId);
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, manualId)).get()).toBeUndefined();
  });
});

describe("manual mutations rebuild derived balances", () => {
  test("daily_balances reflects the manual row after insert and again after delete", () => {
    const acct = makeCashWallet();
    // opening anchor keeps the account a cash wallet (manual source is allowed)
    addManualAnchor(bundle.db, { accountId: acct, anchoredOn: "2026-07-01", enteredCents: 100_000 });
    expect(dailyRow(acct, "2026-07-02")?.balanceCents).toBe(100_000); // carried, no txn yet

    const id = addManualTransaction(bundle.db, {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -5_000,
      description: "Cash coffee",
    });
    // rebuildAccount ran on insert: the -$50 row replayed off the anchor
    expect(dailyRow(acct, "2026-07-02")?.balanceCents).toBe(95_000);

    deleteManualTransaction(bundle.db, id);
    // rebuildAccount ran on delete: the day reverts to the carried anchor level
    expect(dailyRow(acct, "2026-07-02")?.balanceCents).toBe(100_000);
  });
});

describe("editManualTransaction — user-authored rows are correctable", () => {
  test("edits amount + date + description, recomputes identity, and rebuilds balances", () => {
    const acct = makeCashWallet();
    addManualAnchor(bundle.db, { accountId: acct, anchoredOn: "2026-07-01", enteredCents: 100_000 });
    const id = addManualTransaction(bundle.db, {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -5_000,
      description: "Cash coffee",
    });
    const before = bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;

    editManualTransaction(bundle.db, id, { amountCents: -7_500, postedOn: "2026-07-03", description: "Cash lunch" });

    const after = bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(after.amountCents).toBe(-7_500);
    expect(after.postedOn).toBe("2026-07-03");
    expect(after.rawDescription).toBe("Cash lunch");
    expect(after.dedupeHash).not.toBe(before.dedupeHash);
    // balances rebuilt: the -$50 left 07-02, the -$75 landed on 07-03
    expect(dailyRow(acct, "2026-07-02")?.balanceCents).toBe(100_000);
    expect(dailyRow(acct, "2026-07-03")?.balanceCents).toBe(92_500);
  });

  test("an identical-tuple edit takes the next occurrence index (no unique-hash collision)", () => {
    const acct = makeCashWallet();
    const base = { accountId: acct, postedOn: "2026-07-02", amountCents: -2_000, description: "Cash snack" };
    addManualTransaction(bundle.db, base);
    const id = addManualTransaction(bundle.db, { ...base, amountCents: -2_500 });
    // editing the second row onto the first row's exact tuple must not collide
    editManualTransaction(bundle.db, id, { amountCents: -2_000 });
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(row.occurrenceIndex).toBe(1);
  });

  test("a no-change patch is a no-op; imported rows and bad patches are rejected", () => {
    const acct = makeCashWallet();
    const id = addManualTransaction(bundle.db, {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -5_000,
      description: "Cash coffee",
    });
    const before = bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    editManualTransaction(bundle.db, id, { amountCents: -5_000 });
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()).toEqual(before);

    expect(() => editManualTransaction(bundle.db, id, {} as never)).toThrow(/Nothing to change/);
    expect(() => editManualTransaction(bundle.db, id, { amountCents: 0 })).toThrow(/cannot be zero/);
    expect(() => editManualTransaction(bundle.db, id, { postedOn: "2026-13-40" })).toThrow(/valid YYYY-MM-DD/);
    expect(() => editManualTransaction(bundle.db, "nope", { amountCents: -1 })).toThrow(/Unknown transaction/);
  });
});
