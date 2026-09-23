import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { MAX_FINANCIAL_DATE } from "@/lib/date-window";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { linkTransferPair } from "./transfer-links";
import {
  addManualTransaction,
  cashWalletIds,
  deleteManualTransaction,
  editManualTransaction,
  isCashWallet,
} from "./manual-transactions";
import { attachTransactions } from "./recurring-links";

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

/**
 * The wallet rule asked of every account at once. `/budgets` needs "which of
 * the accounts this category was spent from are wallets" for every row of the
 * page, and a second, batch spelling of the rule beside `isCashWallet` would be
 * two rules that can drift — so `isCashWallet` reads this one.
 */
describe("cashWalletIds — the cash-wallet rule over every account", () => {
  test("holds exactly the accounts isCashWallet accepts, and nothing an import has touched", () => {
    const bare = makeCashWallet("Bare");
    const anchored = makeCashWallet("Anchored");
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: anchored, anchoredOn: "2026-06-30", balanceCents: 100_000, source: "statement" })
      .run();
    const withPeriod = makeCashWallet("Period");
    bundle.db
      .insert(statementPeriods)
      .values({
        importFileId: makeImportFile(),
        accountId: withPeriod,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        reconciliation: "reconciled",
      })
      .run();
    const withImportedRow = makeCashWallet("Imported");
    bundle.db
      .insert(transactions)
      .values({
        accountId: withImportedRow,
        importFileId: makeImportFile(),
        postedOn: "2026-06-15",
        amountCents: -3_000,
        rawDescription: "IMPORTED ROW",
        normalizedDescription: "IMPORTED ROW",
        dedupeHash: dedupeHash({
          accountId: withImportedRow,
          postedOn: "2026-06-15",
          amountCents: -3_000,
          rawDescription: "IMPORTED ROW",
          occurrenceIndex: 0,
        }),
      })
      .run();
    const regular = createAccount(bundle.db, { institutionId: chaseId, name: "Empty Checking", type: "checking" });

    const wallets = cashWalletIds(bundle.db);
    expect([...wallets]).toEqual([bare]);
    for (const id of [bare, anchored, withPeriod, withImportedRow, regular, "no-such-account"]) {
      expect(isCashWallet(bundle.db, id)).toBe(wallets.has(id));
    }
  });

  test("an archived wallet is still a wallet — archiving does not let an import reach it", () => {
    const wallet = makeCashWallet("Old wallet");
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, wallet)).run();
    expect(cashWalletIds(bundle.db).has(wallet)).toBe(true);
  });

  test("with no Cash institution there are no wallets", () => {
    bundle.db.delete(institutions).where(eq(institutions.id, cashInstId)).run();
    expect(cashWalletIds(bundle.db).size).toBe(0);
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

  test("rejects a fat-fingered year and writes nothing", () => {
    const acct = makeCashWallet();
    // a manual row drives this wallet's replay: "1026" would make derivation
    // walk one daily row per day back to the 11th century
    for (const postedOn of ["1026-07-02", "9999-12-31"]) {
      expect(() =>
        addManualTransaction(bundle.db, {
          accountId: acct,
          postedOn,
          amountCents: -2_000,
          description: "Cash coffee",
        }),
      ).toThrow(/postedOn must be between/);
    }
    expect(
      bundle.db.select().from(transactions).where(eq(transactions.accountId, acct)).all(),
    ).toEqual([]);
  });

  test("accepts the window bounds themselves", () => {
    const acct = makeCashWallet();
    expect(() =>
      addManualTransaction(bundle.db, {
        accountId: acct,
        postedOn: MAX_FINANCIAL_DATE,
        amountCents: -2_000,
        description: "Far-dated but legal",
      }),
    ).not.toThrow();
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

  // Regression: the manual leg of a hand-linked transfer took its partner's
  // link with it. `detectTransfers` pairs only rows whose group IS NULL, so a
  // Chase row left pointing at the deleted row's id could never be paired
  // again — and it kept wearing the Transfer category for a move with no
  // second half. `unimportFile` already unlinks the legs its delete leaves
  // alone (`legsLeftAloneBy`); this path did not.
  test("unlinks the partner the delete would leave alone in its group", () => {
    const wallet = makeCashWallet();
    const chase = createAccount(bundle.db, { institutionId: chaseId, name: "Chase Checking", type: "checking" });
    const manualId = addManualTransaction(bundle.db, {
      accountId: wallet,
      postedOn: "2026-07-02",
      amountCents: -50_000,
      description: "Cash deposited at the branch",
    });
    const importedId = bundle.db
      .insert(transactions)
      .values({
        accountId: chase,
        importFileId: makeImportFile(),
        postedOn: "2026-07-02",
        amountCents: 50_000,
        rawDescription: "CASH DEPOSIT",
        normalizedDescription: "CASH DEPOSIT",
        dedupeHash: dedupeHash({
          accountId: chase,
          postedOn: "2026-07-02",
          amountCents: 50_000,
          rawDescription: "CASH DEPOSIT",
          occurrenceIndex: 0,
        }),
      })
      .returning({ id: transactions.id })
      .get().id;
    linkTransferPair(bundle.db, manualId, importedId);
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, importedId)).get()!.transferGroupId).toBe(
      manualId,
    );

    deleteManualTransaction(bundle.db, manualId);

    const partner = bundle.db.select().from(transactions).where(eq(transactions.id, importedId)).get()!;
    expect(partner.transferGroupId).toBeNull();
  });

  test("leaves a group that keeps two other legs alone", () => {
    const wallet = makeCashWallet();
    const chase = createAccount(bundle.db, { institutionId: chaseId, name: "Chase Checking", type: "checking" });
    const manualId = addManualTransaction(bundle.db, {
      accountId: wallet,
      postedOn: "2026-07-02",
      amountCents: -50_000,
      description: "Cash deposited at the branch",
    });
    const importFileId = makeImportFile();
    const importedIds = [50_000, -50_000].map((amountCents, i) =>
      bundle.db
        .insert(transactions)
        .values({
          accountId: chase,
          importFileId,
          postedOn: "2026-07-02",
          amountCents,
          rawDescription: `CASH DEPOSIT ${i}`,
          normalizedDescription: `CASH DEPOSIT ${i}`,
          dedupeHash: dedupeHash({
            accountId: chase,
            postedOn: "2026-07-02",
            amountCents,
            rawDescription: `CASH DEPOSIT ${i}`,
            occurrenceIndex: 0,
          }),
        })
        .returning({ id: transactions.id })
        .get().id,
    );
    // three legs in one group: the manual row plus two imported ones — taking
    // the manual row away still leaves a group, so nothing is detached
    for (const id of [manualId, ...importedIds]) {
      bundle.db.update(transactions).set({ transferGroupId: manualId }).where(eq(transactions.id, id)).run();
    }

    deleteManualTransaction(bundle.db, manualId);

    for (const id of importedIds) {
      expect(bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.transferGroupId).toBe(manualId);
    }
  });

  test("snapshots the row before deleting it, and not when the delete is refused", () => {
    // the archive lives beside the database it protects (.db only — reading a
    // snapshot back leaves -wal/-shm siblings behind)
    const snapshots = () => {
      const backups = path.join(dir, "backups");
      if (!fs.existsSync(backups)) return [];
      return fs.readdirSync(backups).filter((f) => f.startsWith("pre-") && f.endsWith(".db"));
    };

    const acct = makeCashWallet();
    const id = addManualTransaction(bundle.db, {
      accountId: acct,
      postedOn: "2026-07-02",
      amountCents: -2_000,
      description: "Cash coffee",
    });
    expect(() => deleteManualTransaction(bundle.db, "no-such-row")).toThrow(/Unknown transaction/);
    expect(snapshots()).toEqual([]); // refused before any restore point was spent

    deleteManualTransaction(bundle.db, id);
    const name = snapshots()[0]!;
    expect(name).toMatch(/-delete-manual-transaction\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    expect(before.db.select().from(transactions).where(eq(transactions.id, id)).get()).toBeDefined();
    before.sqlite.close();
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
    expect(() => editManualTransaction(bundle.db, id, { postedOn: "1026-07-02" })).toThrow(
      /postedOn must be between/,
    );
    expect(() => editManualTransaction(bundle.db, "nope", { amountCents: -1 })).toThrow(/Unknown transaction/);
  });
});

/**
 * A manual row can be the LAST posting a recurring series has — the cash rent,
 * the cash weekly pay. Deleting it takes the charge out of the ledger, and the
 * series' stored stats still describe the set it used to have.
 */
describe("deleting a manual row re-settles the series it was linked to", () => {
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

  test("the series stops naming the posting the deletion removed", () => {
    // 🔴 `last_matched_on` is written only by recomputeSeriesStats, which counts
    // active rows — and this hard delete never called it, so the series went on
    // reporting a charge that is gone. Same failure un-importing a file had.
    const acct = makeCashWallet();
    const base = { accountId: acct, amountCents: -60_000, description: "Cash rent" };
    const june = addManualTransaction(bundle.db, { ...base, postedOn: "2026-06-01" });
    const july = addManualTransaction(bundle.db, { ...base, postedOn: "2026-07-01" });
    const august = addManualTransaction(bundle.db, { ...base, postedOn: "2026-08-01" });
    const series = confirmedMonthly("Cash rent");
    attachTransactions(bundle.db, series, [june, july, august]);
    expect(lastMatchedOn(series)).toBe("2026-08-01");

    deleteManualTransaction(bundle.db, august);

    expect(lastMatchedOn(series)).toBe("2026-07-01");
  });
});
