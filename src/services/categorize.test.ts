import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { applyCorrection, categorizeAll, coverageStats, detectTransfers } from "./categorize";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cat-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function insertTxn(accountId: string, postedOn: string, amountCents: number, rawDescription: string): string {
  seq += 1;
  const normalizedDescription = normalizeDescription(rawDescription);
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription,
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: `${rawDescription}#${seq}`, occurrenceIndex: 0 }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function categoryOf(txnId: string): { name: string | null; source: string | null } {
  const txn = bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
  if (!txn.categoryId) return { name: null, source: txn.categorizationSource };
  const cat = bundle.db.select().from(categories).where(eq(categories.id, txn.categoryId)).get()!;
  return { name: cat.name, source: txn.categorizationSource };
}

describe("categorizeAll pipeline", () => {
  test("merchant map categorizes seeded merchants", () => {
    const id = insertTxn(cardId, "2026-06-01", -1_549, "NETFLIX.COM NETFLIX.COM CA");
    categorizeAll(bundle.db);
    expect(categoryOf(id)).toEqual({ name: "Streaming", source: "merchant_map" });
  });

  test("seeded ATM salary rule beats everything and assigns the synthetic merchant", () => {
    const id = insertTxn(checkingId, "2026-07-02", 128_000, "ATM CASH DEPOSIT 07/02 100 BROADWAY NEW YORK NY");
    categorizeAll(bundle.db);
    const got = categoryOf(id);
    expect(got).toEqual({ name: "Salary", source: "rule" });
    const txn = bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    const employer = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Employer (cash)")).get()!;
    expect(txn.merchantId).toBe(employer.id);
  });

  test("small ATM deposits do NOT match the salary rule ($200 minimum)", () => {
    const id = insertTxn(checkingId, "2026-07-02", 4_000, "ATM CASH DEPOSIT 07/02");
    categorizeAll(bundle.db);
    expect(categoryOf(id).name).toBeNull();
  });

  test("precedence: an explicit user assignment is never overwritten", () => {
    const id = insertTxn(cardId, "2026-06-01", -1_549, "NETFLIX.COM");
    bundle.db
      .update(transactions)
      .set({ categorizationSource: "user" })
      .where(eq(transactions.id, id))
      .run();
    categorizeAll(bundle.db);
    expect(categoryOf(id)).toEqual({ name: null, source: "user" });
  });

  test("credit match: a partial refund inherits the purchase's category", () => {
    const purchase = insertTxn(cardId, "2026-06-01", -8_000, "AMAZON MKTPL XY12AB");
    const refund = insertTxn(cardId, "2026-06-15", 3_000, "AMAZON MKTPL REFUND XY12AB");
    categorizeAll(bundle.db);
    expect(categoryOf(purchase).name).toBe("General");
    expect(categoryOf(refund)).toEqual({ name: "General", source: "merchant_map" });
    // the merchant map already catches Amazon; verify a mapless credit uses credit_match
    const oddPurchase = insertTxn(cardId, "2026-06-02", -5_000, "LOCAL BIKE SHOP 42");
    applyCorrection(bundle.db, {
      transactionId: oddPurchase,
      categoryId: bundle.db.select().from(categories).where(eq(categories.name, "Hobbies")).get()!.id,
    });
    const oddRefund = insertTxn(cardId, "2026-06-20", 5_000, "LOCAL BIKE SHOP 42");
    categorizeAll(bundle.db);
    expect(categoryOf(oddRefund)).toEqual({ name: "Hobbies", source: "credit_match" });
  });

  test("unknown merchants stay uncategorized; only big deposit credits force the review flag", () => {
    insertTxn(cardId, "2026-06-01", -2_100, "ZVX OBSCURE VENDOR 991"); // unknown expense: no flag
    insertTxn(cardId, "2026-06-02", -1_549, "NETFLIX.COM");
    insertTxn(checkingId, "2026-06-03", 95_000, "MYSTERY WIRE CREDIT 41"); // ≥$200 into deposit acct
    categorizeAll(bundle.db);
    const stats = coverageStats(bundle.db);
    expect(stats.total).toBe(3);
    expect(stats.categorized).toBe(1);
    expect(stats.needsReview).toBe(1); // the big credit only (threshold has effect)
  });
});

describe("detectTransfers", () => {
  test("card payment pairs via descriptor hint and categorizes both legs", () => {
    const out = insertTxn(checkingId, "2026-06-05", -84_211, "CHASE CREDIT CRD AUTOPAY 0605");
    const inn = insertTxn(cardId, "2026-06-06", 84_211, "Payment Thank You - Web");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    const a = bundle.db.select().from(transactions).where(eq(transactions.id, out)).get()!;
    const b = bundle.db.select().from(transactions).where(eq(transactions.id, inn)).get()!;
    expect(a.transferGroupId).toBe(b.transferGroupId);
    expect(categoryOf(out).name).toBe("Credit Card Payment");
    expect(categoryOf(inn).source).toBe("transfer_detect");
  });

  test("adversarial: coincidental equal amounts with no hint produce 0 auto-pairs", () => {
    const atm = insertTxn(checkingId, "2026-06-05", -20_000, "ATM WITHDRAWAL 100 BROADWAY");
    const credit = insertTxn(cardId, "2026-06-06", 20_000, "MERCHANDISE CREDIT ADJUSTMENT");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(1);
    for (const id of [atm, credit]) {
      expect(
        bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.transferGroupId,
      ).toBeNull();
    }
  });
});

describe("applyCorrection", () => {
  test("direction guard: refund correction never flips a merchant default silently", () => {
    const purchase = insertTxn(cardId, "2026-06-01", -8_000, "AMAZON MKTPL A1");
    const refund = insertTxn(cardId, "2026-06-10", 3_000, "AMAZON MKTPL A1");
    categorizeAll(bundle.db);
    void purchase;

    const refundsCat = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Refunds & Reimbursements"))
      .get()!;
    const result = applyCorrection(bundle.db, {
      transactionId: refund,
      categoryId: refundsCat.id,
      applyToMerchant: true,
    });
    expect(result.directionGuardTriggered).toBe(true);
    expect(result.merchantUpdated).toBe(false);

    const amazon = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Amazon")).get()!;
    const general = bundle.db.select().from(categories).where(eq(categories.name, "General")).get()!;
    expect(amazon.defaultCategoryId).toBe(general.id); // untouched
    expect(categoryOf(refund).name).toBe("Refunds & Reimbursements"); // txn-only applied
  });

  test("same-direction correction updates the map permanently and retroactively", () => {
    const a = insertTxn(cardId, "2026-06-01", -1_200, "BLUE BOTTLE COFFEE NYC");
    const b = insertTxn(cardId, "2026-06-08", -1_300, "BLUE BOTTLE COFFEE NYC");
    categorizeAll(bundle.db);
    expect(categoryOf(a).name).toBe("Coffee");

    const dining = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Dining"))
      .get()!;
    const result = applyCorrection(bundle.db, {
      transactionId: a,
      categoryId: dining.id,
      applyToMerchant: true,
      retroactive: true,
    });
    expect(result.merchantUpdated).toBe(true);
    expect(result.retroactivelyUpdated).toBe(1);
    expect(categoryOf(b).name).toBe("Dining");
    expect(categoryOf(a).source).toBe("user"); // the corrected txn stays user-owned

    const blueBottle = bundle.db
      .select()
      .from(merchants)
      .where(eq(merchants.canonicalName, "Blue Bottle"))
      .get()!;
    expect(blueBottle.mappingSource).toBe("user");
    // future imports of the same merchant now map to Dining
    const c = insertTxn(cardId, "2026-06-15", -1_250, "BLUE BOTTLE COFFEE NYC");
    categorizeAll(bundle.db);
    expect(categoryOf(c).name).toBe("Dining");
  });
});

describe("detectTransfers — linked payment source (S6)", () => {
  test("an unhinted equal-amount pair auto-pairs when the accounts are linked", () => {
    // no descriptor hint on either leg — normally flagged ambiguous, not paired
    const out = insertTxn(checkingId, "2026-06-10", -75_000, "WITHDRAWAL 8842");
    const inn = insertTxn(cardId, "2026-06-11", 75_000, "CREDIT ADJUSTMENT");
    detectTransfers(bundle.db);
    let outRow = bundle.db.select().from(transactions).where(eq(transactions.id, out)).get()!;
    expect(outRow.transferGroupId).toBeNull(); // unlinked accounts: humans decide

    // link the card to its funding account and re-run: the pair is now hinted
    bundle.db
      .update(accounts)
      .set({ paymentSourceAccountId: checkingId })
      .where(eq(accounts.id, cardId))
      .run();
    detectTransfers(bundle.db);
    outRow = bundle.db.select().from(transactions).where(eq(transactions.id, out)).get()!;
    const innRow = bundle.db.select().from(transactions).where(eq(transactions.id, inn)).get()!;
    expect(outRow.transferGroupId).toBe(out);
    expect(innRow.transferGroupId).toBe(out);
    expect(categoryOf(out).name).toBe("Credit Card Payment");
  });
});
