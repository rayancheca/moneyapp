import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { applyUndoPatch } from "./bulk-edit";
import { categorizeAll } from "./categorize";
import {
  merchantSummary,
  renameMerchant,
  similarGroupIds,
  similarTransactions,
  applyMerchantDefaultToUncategorized,
  setMerchantDefaultCategory,
} from "./merchants";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let investmentId: string;
let netflixId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-merch-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  investmentId = createAccount(bundle.db, {
    institutionId: chase.id,
    name: "Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  netflixId = bundle.db
    .select()
    .from(merchants)
    .where(eq(merchants.canonicalName, "Netflix"))
    .get()!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function insertTxn(overrides: {
  accountId?: string;
  postedOn?: string;
  amountCents?: number;
  rawDescription?: string;
  merchantId?: string | null;
  status?: "active" | "excluded";
}): string {
  seq += 1;
  const accountId = overrides.accountId ?? checkingId;
  const postedOn = overrides.postedOn ?? "2026-06-15";
  const amountCents = overrides.amountCents ?? -1_549;
  const rawDescription = overrides.rawDescription ?? `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: normalizeDescription(rawDescription),
      merchantId: overrides.merchantId ?? null,
      status: overrides.status ?? "active",
      dedupeHash: dedupeHash({
        accountId,
        postedOn,
        amountCents,
        rawDescription: `${rawDescription}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

describe("merchantSummary", () => {
  test("counts active rows, sums this calendar year only, returns 5 most recent", () => {
    // Arrange: 6 active rows in 2026, one in 2025, one excluded
    for (let i = 1; i <= 6; i += 1) {
      insertTxn({ merchantId: netflixId, postedOn: `2026-0${i}-10`, amountCents: -1_000 });
    }
    insertTxn({ merchantId: netflixId, postedOn: "2025-12-10", amountCents: -9_999 });
    insertTxn({ merchantId: netflixId, postedOn: "2026-03-01", status: "excluded" });

    // Act
    const summary = merchantSummary(bundle.db, netflixId, "2026-07-10");

    // Assert
    expect(summary.name).toBe("Netflix");
    expect(summary.txnCount).toBe(7); // 6 × 2026 + 1 × 2025, excluded row out
    expect(summary.totalCentsThisYear).toBe(-6_000);
    expect(summary.recent).toHaveLength(5);
    expect(summary.recent[0]!.postedOn).toBe("2026-06-10"); // newest first
  });

  test("excludes future-year rows from this year's total", () => {
    // Arrange: one current-year (2026) row and one next-year (2027) row
    insertTxn({ merchantId: netflixId, postedOn: "2026-05-10", amountCents: -1_000 });
    insertTxn({ merchantId: netflixId, postedOn: "2027-01-05", amountCents: -9_999 });

    // Act
    const summary = merchantSummary(bundle.db, netflixId, "2026-07-10");

    // Assert: only the 2026 row counts, the 2027 row must not leak in
    expect(summary.txnCount).toBe(2);
    expect(summary.totalCentsThisYear).toBe(-1_000);
  });

  test("throws for an unknown merchant", () => {
    expect(() => merchantSummary(bundle.db, "nope", "2026-07-10")).toThrow(/Unknown merchant/);
  });
});

describe("similarTransactions", () => {
  test("same-merchant rows, newest first, self excluded, limit respected", () => {
    // Arrange
    const target = insertTxn({ merchantId: netflixId, postedOn: "2026-06-01" });
    insertTxn({ merchantId: netflixId, postedOn: "2026-05-01" });
    insertTxn({ merchantId: netflixId, postedOn: "2026-04-01" });
    insertTxn({ merchantId: null, rawDescription: "UNRELATED" });

    // Act
    const rows = similarTransactions(bundle.db, target, 5);
    const capped = similarTransactions(bundle.db, target, 1);

    // Assert
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.postedOn)).toEqual(["2026-05-01", "2026-04-01"]);
    expect(rows.map((r) => r.id)).not.toContain(target);
    expect(capped).toHaveLength(1);
  });

  test("merchantless rows fall back to stripped-key matching", () => {
    // Arrange: two COKE dividends with different dates/amounts + one MSFT
    const target = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-04-24 P/D 2026-05-08 - 32. SHARES AT 0.25 (COKE)",
      amountCents: 800,
    });
    const sibling = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-01-16 P/D 2026-02-02 - 30. SHARES AT 0.24 (COKE)",
      amountCents: 720,
      postedOn: "2026-02-02",
    });
    insertTxn({
      rawDescription: "CASH DIV: R/D 2026-05-21 P/D 2026-06-11 - 24. SHARES AT 0.91 (MSFT)",
      amountCents: 2_184,
    });

    // Act
    const rows = similarTransactions(bundle.db, target, 5);

    // Assert
    expect(rows.map((r) => r.id)).toEqual([sibling]);
  });

  test("suppressed entirely on investment-account transactions (§3.2.5)", () => {
    const target = insertTxn({
      accountId: investmentId,
      rawDescription: "CASH DIV: R/D 2026-04-24 - 32. SHARES AT 0.25 (COKE)",
    });
    insertTxn({
      accountId: investmentId,
      rawDescription: "CASH DIV: R/D 2026-01-16 - 30. SHARES AT 0.24 (COKE)",
    });
    expect(similarTransactions(bundle.db, target, 5)).toEqual([]);
  });

  test("empty stripped keys never group; unknown txn throws; limit 0 short-circuits", () => {
    const target = insertTxn({ rawDescription: "12345678" }); // normalizes to ""
    insertTxn({ rawDescription: "87654321" });
    expect(similarTransactions(bundle.db, target, 5)).toEqual([]);
    expect(() => similarTransactions(bundle.db, "nope", 5)).toThrow(/Unknown transaction/);
    expect(similarTransactions(bundle.db, target, 0)).toEqual([]);
  });
});

describe("similarGroupIds (server-recomputed 'Recategorize all N' blast radius)", () => {
  test("merchant rows: every active row in the group, INCLUDING self; excluded rows out", () => {
    // Arrange
    const self = insertTxn({ merchantId: netflixId, postedOn: "2026-06-01" });
    const sibling = insertTxn({ merchantId: netflixId, postedOn: "2026-05-01" });
    insertTxn({ merchantId: netflixId, status: "excluded" });
    insertTxn({ merchantId: null, rawDescription: "UNRELATED" });

    // Act
    const ids = similarGroupIds(bundle.db, self);

    // Assert: self is included, the excluded row and the unrelated row are not
    expect(new Set(ids)).toEqual(new Set([self, sibling]));
  });

  test("merchantless rows: the whole stripped-key group, including self", () => {
    // Arrange: two COKE dividends (different dates) + one MSFT
    const self = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-04-24 P/D 2026-05-08 - 32. SHARES AT 0.25 (COKE)",
    });
    const sibling = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-01-16 P/D 2026-02-02 - 30. SHARES AT 0.24 (COKE)",
      postedOn: "2026-02-02",
    });
    insertTxn({
      rawDescription: "CASH DIV: R/D 2026-05-21 P/D 2026-06-11 - 24. SHARES AT 0.91 (MSFT)",
    });

    // Act
    const ids = similarGroupIds(bundle.db, self);

    // Assert
    expect(new Set(ids)).toEqual(new Set([self, sibling]));
  });

  test("investment rows, empty keys, and unknown ids never produce a group", () => {
    const invest = insertTxn({
      accountId: investmentId,
      rawDescription: "CASH DIV: R/D 2026-04-24 - 32. SHARES AT 0.25 (COKE)",
    });
    expect(similarGroupIds(bundle.db, invest)).toEqual([]);

    const emptyKey = insertTxn({ rawDescription: "12345678" }); // normalizes to ""
    expect(similarGroupIds(bundle.db, emptyKey)).toEqual([]);

    expect(() => similarGroupIds(bundle.db, "nope")).toThrow(/Unknown transaction/);
  });
});

describe("renameMerchant", () => {
  test("renames and preserves categorization through the old-name alias", () => {
    // Act
    const result = renameMerchant(bundle.db, netflixId, "Netflix Inc");

    // Assert: canonical name updated…
    expect(result).toEqual({ id: netflixId, name: "Netflix Inc", aliasCreated: false });
    const merchant = bundle.db.select().from(merchants).where(eq(merchants.id, netflixId)).get()!;
    expect(merchant.canonicalName).toBe("Netflix Inc");
    // …the old name is already covered by the seeded contains alias
    // (unique pattern+type ⇒ aliasCreated false), so matching still works:
    const txnId = insertTxn({ rawDescription: "NETFLIX.COM NETFLIX.COM CA" });
    categorizeAll(bundle.db);
    const txn = bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
    expect(txn.merchantId).toBe(netflixId);
  });

  test("creates the old-name alias when none exists yet", () => {
    // Arrange: a merchant whose canonical name has no alias row
    const id = bundle.db
      .insert(merchants)
      .values({ canonicalName: "CORNER DELI", mappingSource: "claude" })
      .returning({ id: merchants.id })
      .get().id;

    // Act
    const result = renameMerchant(bundle.db, id, "Corner Deli NYC");

    // Assert
    expect(result.aliasCreated).toBe(true);
    const alias = bundle.db
      .select()
      .from(merchantAliases)
      .where(and(eq(merchantAliases.merchantId, id), eq(merchantAliases.pattern, "CORNER DELI")))
      .get();
    expect(alias?.matchType).toBe("contains");
  });

  test("rejects empty names, unknown merchants, and clashes with existing names", () => {
    expect(() => renameMerchant(bundle.db, netflixId, "   ")).toThrow(/cannot be empty/);
    expect(() => renameMerchant(bundle.db, "nope", "X")).toThrow(/Unknown merchant/);
    expect(() => renameMerchant(bundle.db, netflixId, "Spotify")).toThrow(/already exists/);
  });

  test("renaming to the current name is a no-op", () => {
    const before = bundle.db.select().from(merchantAliases).all().length;
    const result = renameMerchant(bundle.db, netflixId, "Netflix");
    expect(result).toEqual({ id: netflixId, name: "Netflix", aliasCreated: false });
    expect(bundle.db.select().from(merchantAliases).all().length).toBe(before);
  });
});

describe("merchant default category (S6)", () => {
  test("sets, validates, and clears the default", () => {
    const food = bundle.db.select().from(categories).where(eq(categories.name, "Food")).all()[0]!;
    const result = setMerchantDefaultCategory(bundle.db, netflixId, food.id);
    expect(result.categoryId).toBe(food.id);
    expect(
      bundle.db.select().from(merchants).where(eq(merchants.id, netflixId)).get()!.defaultCategoryId,
    ).toBe(food.id);

    expect(() => setMerchantDefaultCategory(bundle.db, netflixId, "nope")).toThrow(/Unknown category/);
    expect(() => setMerchantDefaultCategory(bundle.db, "nope", food.id)).toThrow(/Unknown merchant/);

    const cleared = setMerchantDefaultCategory(bundle.db, netflixId, null);
    expect(cleared.categoryId).toBeNull();
    expect(
      bundle.db.select().from(merchants).where(eq(merchants.id, netflixId)).get()!.defaultCategoryId,
    ).toBeNull();
  });

  test("backfills only UNCATEGORIZED active rows, with a lossless undo", () => {
    const food = bundle.db.select().from(categories).where(eq(categories.name, "Food")).all()[0]!;
    const other = bundle.db.select().from(categories).where(eq(categories.name, "Shopping")).all()[0]!;
    const bare = insertTxn({ merchantId: netflixId });
    const kept = insertTxn({ merchantId: netflixId });
    bundle.db
      .update(transactions)
      .set({ categoryId: other.id, categorizationSource: "user" })
      .where(eq(transactions.id, kept))
      .run();

    setMerchantDefaultCategory(bundle.db, netflixId, food.id);
    const result = applyMerchantDefaultToUncategorized(bundle.db, netflixId);
    expect(result.affected).toBe(1);

    const bareRow = bundle.db.select().from(transactions).where(eq(transactions.id, bare)).get()!;
    expect(bareRow.categoryId).toBe(food.id);
    expect(bareRow.categorizationSource).toBe("merchant_map");
    // the user-categorized sibling is untouched
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, kept)).get()!.categoryId).toBe(other.id);

    applyUndoPatch(bundle.db, result.undo);
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, bare)).get()!.categoryId).toBeNull();
  });

  test("a row the user deliberately left uncategorized is not backfilled", () => {
    const food = bundle.db.select().from(categories).where(eq(categories.name, "Food")).all()[0]!;
    const gap = insertTxn({ merchantId: netflixId });
    const userLeftBlank = insertTxn({ merchantId: netflixId });
    // category stays NULL — source='user' makes it a decision, not a gap
    bundle.db
      .update(transactions)
      .set({ categorizationSource: "user" })
      .where(eq(transactions.id, userLeftBlank))
      .run();

    setMerchantDefaultCategory(bundle.db, netflixId, food.id);
    const result = applyMerchantDefaultToUncategorized(bundle.db, netflixId);

    expect(result.affected).toBe(1);
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, gap)).get()!.categoryId).toBe(food.id);
    const untouched = bundle.db.select().from(transactions).where(eq(transactions.id, userLeftBlank)).get()!;
    expect(untouched.categoryId).toBeNull();
    expect(untouched.categorizationSource).toBe("user");
  });

  test("backfill without a default is rejected", () => {
    const bare = bundle.db
      .insert(merchants)
      .values({ canonicalName: "No Default Coffee" })
      .returning({ id: merchants.id })
      .get();
    expect(() => applyMerchantDefaultToUncategorized(bundle.db, bare.id)).toThrow(/Set a default category first/);
  });
});
