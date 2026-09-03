import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { transferAmbiguities } from "@/db/schema/transfer-ambiguities";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import {
  applyCorrection,
  categorizeAll,
  coverageStats,
  detectTransfers,
  dismissTransferAmbiguity,
} from "./categorize";

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
    // (non-ATM descriptor: ATM rows are reserved for the user and never even flagged)
    const atm = insertTxn(checkingId, "2026-06-05", -20_000, "CHECK WITHDRAWAL 100 BROADWAY");
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

describe("detectTransfers — OVERDRAFT hint + widened hinted window (P0.4 / P0.5a)", () => {
  let savingsId: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    savingsId = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
  });

  function row(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }

  test("same-day OVERDRAFT mirror pairs as Internal Transfer and leaves review", () => {
    const out = insertTxn(savingsId, "2026-06-05", -2_150, "OVERDRAFT TO CHECKING - 9067");
    const inn = insertTxn(checkingId, "2026-06-05", 2_150, "OVERDRAFT FROM SAVINGS - 5791");
    bundle.db.update(transactions).set({ needsReview: true }).run();
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(row(out).transferGroupId).toBe(out);
    expect(row(inn).transferGroupId).toBe(out);
    expect(row(out).needsReview).toBe(false);
    expect(row(inn).needsReview).toBe(false);
    expect(categoryOf(out).name).toBe("Internal Transfer");
  });

  test("both-hinted pair 8 days apart pairs (ACH settlement float)", () => {
    // BOTH descriptors hinted → auto-pairable across the ±10d float window
    const out = insertTxn(checkingId, "2026-06-03", -500_000, "ONLINE TRANSFER TO SOFI SAVINGS");
    const inn = insertTxn(savingsId, "2026-06-11", 500_000, "ACH TRANSFER FROM CHASE 1234");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(row(inn).transferGroupId).toBe(row(out).transferGroupId);
  });

  test("single-sided hint (only one leg) does NOT auto-pair — it flags for review", () => {
    // the outflow is a transfer, but the inflow is a generic deposit whose true source
    // may be unrelated (a coincidental equal-cent credit) — humans confirm, never guessed
    const out = insertTxn(checkingId, "2026-06-03", -500_000, "ONLINE TRANSFER TO SOFI SAVINGS");
    const inn = insertTxn(savingsId, "2026-06-06", 500_000, "DEPOSIT RECEIVED"); // generic, dist 3
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(1);
    expect(row(inn).transferGroupId).toBeNull();
    expect(row(out).needsReview).toBe(true);
    expect(row(inn).needsReview).toBe(true);
  });

  test("both-hinted pair 11 days apart does NOT pair (outside the window)", () => {
    insertTxn(checkingId, "2026-06-03", -500_000, "ONLINE TRANSFER TO SOFI SAVINGS");
    const inn = insertTxn(savingsId, "2026-06-14", 500_000, "ACH TRANSFER FROM CHASE");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row(inn).transferGroupId).toBeNull();
  });

  test("distinct-amount both-hinted chunks each pair via their sole in-window partner", () => {
    // both legs hinted + different amounts → each outflow has exactly one partner → pair
    const a1 = insertTxn(checkingId, "2026-06-03", -500_000, "ONLINE TRANSFER TO SOFI");
    const a2 = insertTxn(checkingId, "2026-06-05", -300_000, "ONLINE TRANSFER TO SOFI");
    const b1 = insertTxn(savingsId, "2026-06-08", 500_000, "ACH TRANSFER FROM CHASE");
    const b2 = insertTxn(savingsId, "2026-06-10", 300_000, "ACH TRANSFER FROM CHASE");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(2);
    expect(row(b1).transferGroupId).toBe(a1);
    expect(row(b2).transferGroupId).toBe(a2);
  });

  test("equal-amount chunks in one window are flagged for review, not FIFO-guessed", () => {
    // two same-amount outflows + two same-amount generic inflows: which pairs which is
    // genuinely ambiguous (a nearer one could be a coincidence), so the detector surfaces
    // them for human confirmation instead of guessing a FIFO order (re-review hardening)
    insertTxn(checkingId, "2026-06-03", -500_000, "ONLINE TRANSFER TO SOFI 1/2");
    insertTxn(checkingId, "2026-06-05", -500_000, "ONLINE TRANSFER TO SOFI 2/2");
    const b1 = insertTxn(savingsId, "2026-06-08", 500_000, "DEPOSIT RECEIVED");
    const b2 = insertTxn(savingsId, "2026-06-10", 500_000, "DEPOSIT RECEIVED");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBeGreaterThanOrEqual(1);
    expect(row(b1).transferGroupId).toBeNull();
    expect(row(b2).transferGroupId).toBeNull();
  });

  test("same-day duplicate mirrors (the OVERDRAFT multiset) pair deterministically", () => {
    const o1 = insertTxn(savingsId, "2026-06-05", -2_000, "OVERDRAFT TO CHECKING - 9067");
    const o2 = insertTxn(savingsId, "2026-06-05", -2_000, "OVERDRAFT TO CHECKING - 9067");
    const i1 = insertTxn(checkingId, "2026-06-05", 2_000, "OVERDRAFT FROM SAVINGS - 5791");
    const i2 = insertTxn(checkingId, "2026-06-05", 2_000, "OVERDRAFT FROM SAVINGS - 5791");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(2);
    expect(stats.flaggedAmbiguous).toBe(0);
    const groups = [o1, o2, i1, i2].map((id) => row(id).transferGroupId);
    expect(groups.every((g) => g !== null)).toBe(true);
    expect(new Set(groups.slice(0, 2)).size).toBe(2); // two distinct pairs
  });

  test("a symmetric different-day tie stays ambiguous (flagged, not paired)", () => {
    const out = insertTxn(checkingId, "2026-06-10", -30_000, "ONLINE TRANSFER REF 1");
    const before = insertTxn(savingsId, "2026-06-05", 30_000, "ONLINE TRANSFER REF 2");
    const after = insertTxn(savingsId, "2026-06-15", 30_000, "ONLINE TRANSFER REF 3");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(1);
    for (const id of [out, before, after]) {
      expect(row(id).transferGroupId).toBeNull();
      expect(row(id).needsReview).toBe(true);
    }
  });

  test("an UNHINTED equal-cent match 7 days out is ignored entirely (no new review noise)", () => {
    const out = insertTxn(checkingId, "2026-06-03", -42_000, "CHECK 1044");
    const inn = insertTxn(savingsId, "2026-06-10", 42_000, "MISC CREDIT");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(0);
    expect(row(out).needsReview).toBe(false);
    expect(row(inn).needsReview).toBe(false);
  });

  test("both legs already categorized under Transfers counts as a hint", () => {
    const out = insertTxn(checkingId, "2026-06-04", -60_000, "WITHDRAWAL 2210");
    const inn = insertTxn(savingsId, "2026-06-10", 60_000, "CREDIT 8814");
    const internal = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Internal Transfer"))
      .get()!;
    bundle.db
      .update(transactions)
      .set({ categoryId: internal.id })
      .where(inArray(transactions.id, [out, inn]))
      .run();
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(row(inn).transferGroupId).toBe(out);
  });

  test("user guard: a leg the user tagged OUTSIDE Transfers is never auto-paired", () => {
    const out = insertTxn(savingsId, "2026-06-05", -2_150, "OVERDRAFT TO CHECKING - 9067");
    const inn = insertTxn(checkingId, "2026-06-05", 2_150, "OVERDRAFT FROM SAVINGS - 5791");
    const dining = bundle.db.select().from(categories).where(eq(categories.name, "Dining")).get()!;
    bundle.db
      .update(transactions)
      .set({ categoryId: dining.id, categorizationSource: "user" })
      .where(eq(transactions.id, inn))
      .run();
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row(out).transferGroupId).toBeNull();
    expect(categoryOf(inn).name).toBe("Dining"); // untouched
  });

  test("user guard: a leg the user tagged WITHIN Transfers pairs but keeps the user's category", () => {
    const out = insertTxn(savingsId, "2026-06-05", -2_150, "OVERDRAFT TO CHECKING - 9067");
    const inn = insertTxn(checkingId, "2026-06-05", 2_150, "OVERDRAFT FROM SAVINGS - 5791");
    const internal = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Internal Transfer"))
      .get()!;
    bundle.db
      .update(transactions)
      .set({ categoryId: internal.id, categorizationSource: "user" })
      .where(eq(transactions.id, inn))
      .run();
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(row(inn).transferGroupId).toBe(out);
    const innRow = row(inn);
    expect(innRow.categorizationSource).toBe("user"); // provenance preserved
    expect(categoryOf(inn).name).toBe("Internal Transfer");
  });
});

describe("detectTransfers — OVERDRAFT symmetry guard (P0.4 mis-pair prevention)", () => {
  let savingsId2: string;
  let brokerageId: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    savingsId2 = createAccount(bundle.db, { institutionId: chase.id, name: "Savings2", type: "savings" });
    brokerageId = createAccount(bundle.db, { institutionId: chase.id, name: "Brokerage", type: "investment" });
  });

  function row2(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }

  test("an OVERDRAFT leg never pairs with a non-overdraft counterpart (AAPL-buy mis-pair class)", () => {
    // real-data shape: an intra-brokerage stock buy 2 days before an unrelated
    // overdraft cover of the same amount — one-sided OVERDRAFT hint must NOT pair
    const buy = insertTxn(brokerageId, "2026-06-14", -20_000, "Apple CUSIP: 037833100 (AAPL)");
    const cover = insertTxn(checkingId, "2026-06-16", 20_000, "OVERDRAFT FROM SAVINGS - 5791");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row2(buy).transferGroupId).toBeNull();
    expect(row2(cover).transferGroupId).toBeNull();
  });

  test("overdraft mirrors on DIFFERENT days are not hint-paired (verified set is same-day)", () => {
    const out = insertTxn(savingsId2, "2026-06-05", -2_150, "OVERDRAFT TO CHECKING - 9067");
    const inn = insertTxn(checkingId, "2026-06-07", 2_150, "OVERDRAFT FROM SAVINGS - 5791");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row2(out).transferGroupId).toBeNull();
    expect(row2(inn).transferGroupId).toBeNull();
  });

  test("a chained same-amount flow pairs the true hops, not across the chain", () => {
    // Savings -100 (overdraft to checking) + Checking +100 (overdraft from
    // savings) SAME DAY, then Checking -100 → Brokerage +100 (ROBINHOOD hint):
    // two true pairs; the Savings leg must not grab the brokerage deposit
    const s = insertTxn(savingsId2, "2026-06-10", -10_000, "OVERDRAFT TO CHECKING - 9067");
    const c1 = insertTxn(checkingId, "2026-06-10", 10_000, "OVERDRAFT FROM SAVINGS - 5791");
    const c2 = insertTxn(checkingId, "2026-06-10", -10_000, "DEBIT CARD ROBINHOOD SECURITIES");
    const b = insertTxn(brokerageId, "2026-06-12", 10_000, "ACH Deposit ROBINHOOD");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(2);
    expect(row2(c1).transferGroupId).toBe(s); // overdraft mirror pair
    expect(row2(b).transferGroupId).toBe(c2); // funding hop pair
  });
});

describe("detectTransfers — Zelle reservation + internal-mirror symmetry (P0.4 dry-run findings)", () => {
  let savingsId3: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    savingsId3 = createAccount(bundle.db, { institutionId: chase.id, name: "Savings3", type: "savings" });
  });

  function row3(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }

  test("Zelle legs are reserved for the user — never auto-paired, never newly flagged", () => {
    // even a perfect self-Zelle mirror stays untouched: the user asked to tag
    // every Zelle row themselves (2026-07-13 decision)
    const out = insertTxn(checkingId, "2026-06-10", -15_000, "Zelle payment from Rayan Karim Checa 0PE0X");
    const inn = insertTxn(savingsId3, "2026-06-10", 15_000, "Direct Payment Zelle® Payment to Rayan");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(0);
    expect(row3(out).transferGroupId).toBeNull();
    expect(row3(inn).transferGroupId).toBeNull();
    expect(row3(out).needsReview).toBe(false); // no NEW review noise either
  });

  test("a third-party Zelle payment cannot claim an internal savings↔checking leg", () => {
    const zelle = insertTxn(checkingId, "2026-06-10", -8_000, "Zelle payment to Oliver Fontaine 123");
    const internal = insertTxn(savingsId3, "2026-06-11", 8_000, "Deposit From Savings - 5791");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row3(zelle).transferGroupId).toBeNull();
    expect(row3(internal).transferGroupId).toBeNull();
  });

  test("internal savings↔checking mirrors pair same-day (Deposit From ↔ Withdrawal To)", () => {
    const out = insertTxn(savingsId3, "2026-06-05", -16_800, "Withdrawal To Checking - 9067");
    const inn = insertTxn(checkingId, "2026-06-05", 16_800, "Deposit From Savings - 5791");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(row3(inn).transferGroupId).toBe(out);
  });

  test("an internal-mirror leg is not claimed by a foreign row even when both are categorized Transfers", () => {
    const internal = insertTxn(savingsId3, "2026-06-05", -16_800, "Withdrawal To Checking - 9067");
    const foreign = insertTxn(checkingId, "2026-06-07", 16_800, "MISC CREDIT 4411");
    const internalCat = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Internal Transfer"))
      .get()!;
    bundle.db
      .update(transactions)
      .set({ categoryId: internalCat.id })
      .where(inArray(transactions.id, [internal, foreign]))
      .run();
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row3(internal).transferGroupId).toBeNull();
  });
});

describe("detectTransfers — ATM reservation + semantic compatibility (P0.4 dry-run findings, round 2)", () => {
  let brokerage2: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    brokerage2 = createAccount(bundle.db, { institutionId: chase.id, name: "Brokerage2", type: "investment" });
  });

  function row4(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }

  test("ATM rows are reserved for the user — never auto-paired, never newly flagged", () => {
    const atm = insertTxn(checkingId, "2026-06-10", -20_000, "ATM CASH DEPOSIT 06/10 100 ARTHUR AVE");
    const rh = insertTxn(brokerage2, "2026-06-11", 20_000, "Debit Card ROBINHOOD SECURITIES");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(0);
    expect(row4(atm).transferGroupId).toBeNull();
    expect(row4(rh).transferGroupId).toBeNull();
  });

  test("a card-payment descriptor never pairs two non-credit accounts (missing-card mis-pair class)", () => {
    // real shape: SoFi Savings pays the (un-imported) Sapphire card; the leg
    // must NOT grab an equal-cent checking transfer 2 days out
    const epay = insertTxn(savingsSemId(), "2026-06-10", -50_000, "Direct Payment CHASE CREDIT CRD EPAY");
    const xfer = insertTxn(checkingId, "2026-06-12", 50_000, "SOFI BANK TRANSFER RKARIM");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row4(epay).transferGroupId).toBeNull();
    expect(row4(xfer).transferGroupId).toBeNull();
  });

  test("a ROBINHOOD-token hint requires an investment-account leg", () => {
    const sofiLeg = insertTxn(checkingId, "2026-06-10", -10_000, "Debit Card ROBINHOOD SECURITIES");
    const chaseLeg = insertTxn(savingsSemId(), "2026-06-11", 10_000, "MOBILE CHECK DEPOSIT");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(row4(sofiLeg).transferGroupId).toBeNull();
  });

  // lazily create one savings account shared by the tests above
  let savingsMemo: string | null = null;
  function savingsSemId(): string {
    if (savingsMemo) return savingsMemo;
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    savingsMemo = createAccount(bundle.db, { institutionId: chase.id, name: "SavingsSem", type: "savings" });
    return savingsMemo;
  }

  afterEach(() => {
    savingsMemo = null;
  });
});

describe("detectTransfers — 2026-07-15 review hardening (preservation · proximity · sticky)", () => {
  let savingsR: string;
  let brokerageR: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    savingsR = createAccount(bundle.db, { institutionId: chase.id, name: "SavingsR", type: "savings" });
    brokerageR = createAccount(bundle.db, { institutionId: chase.id, name: "BrokerageR", type: "investment" });
  });

  function rowR(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }
  function catId(name: string): string {
    return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
  }

  test("a leg categorized OUTSIDE Transfers (non-user source) is never claimed or overwritten", () => {
    // the exact real-ledger bug: a -$200 'Debit Card ROBINHOOD SECURITIES' that is
    // Investments › Buys must NOT be relabeled a transfer despite a hinted counterpart
    const out = insertTxn(checkingId, "2026-06-10", -20_000, "Debit Card ROBINHOOD SECURITIES");
    bundle.db
      .update(transactions)
      .set({ categoryId: catId("Buys"), categorizationSource: "rule" })
      .where(eq(transactions.id, out))
      .run();
    insertTxn(brokerageR, "2026-06-12", 20_000, "ACH Deposit ROBINHOOD");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(rowR(out).transferGroupId).toBeNull();
    expect(categoryOf(out).name).toBe("Buys"); // preserved
    expect(rowR(out).categorizationSource).toBe("rule");
  });

  test("an already-categorized decoy is skipped; the true both-hinted partner still pairs", () => {
    const out = insertTxn(checkingId, "2026-06-10", -30_000, "ONLINE TRANSFER TO SOFI");
    const decoy = insertTxn(savingsR, "2026-06-10", 30_000, "STATEMENT CREDIT"); // same-day but categorized
    bundle.db
      .update(transactions)
      .set({ categoryId: catId("Cash Back"), categorizationSource: "merchant_map" })
      .where(eq(transactions.id, decoy))
      .run();
    const truePartner = insertTxn(savingsR, "2026-06-14", 30_000, "ACH TRANSFER FROM CHASE"); // hinted
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(rowR(truePartner).transferGroupId).toBe(out);
    expect(rowR(decoy).transferGroupId).toBeNull();
    expect(categoryOf(decoy).name).toBe("Cash Back"); // untouched
  });

  test("a distant hinted match never beats a nearer unhinted coincidence — the coincidence is flagged", () => {
    const out = insertTxn(checkingId, "2026-06-10", -30_000, "CHECK WITHDRAWAL 4412"); // no hint
    const nearCoin = insertTxn(savingsR, "2026-06-10", 30_000, "MISC CREDIT"); // same day, no hint
    const farHint = insertTxn(brokerageR, "2026-06-18", 30_000, "ONLINE TRANSFER FROM ACME LLC"); // dist 8, hinted
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(stats.flaggedAmbiguous).toBe(1);
    expect(rowR(out).needsReview).toBe(true);
    expect(rowR(nearCoin).needsReview).toBe(true);
    expect(rowR(farHint).transferGroupId).toBeNull(); // the distant hint is NOT paired
    expect(rowR(farHint).needsReview).toBe(false);
  });

  test("confident pairs settle before ambiguity: a's tie does not strand b2's true partner a2", () => {
    // a1 is equidistant to b1/b2, but a2 is a UNIQUE, corroborated (b-hinted) match for b2.
    // The fixpoint must resolve a2↔b2 first, then a1↔b1 — not flag a1's tie and strand a2.
    const a1 = insertTxn(checkingId, "2026-06-10", -30_000, "ONLINE TRANSFER OUT");
    const b1 = insertTxn(savingsR, "2026-06-07", 30_000, "ONLINE TRANSFER IN A"); // dist 3 from a1
    const b2 = insertTxn(savingsR, "2026-06-13", 30_000, "ONLINE TRANSFER IN B"); // dist 3 from a1, dist 0 from a2
    const a2 = insertTxn(brokerageR, "2026-06-13", -30_000, "ONLINE TRANSFER OUT 2");
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(2);
    expect(stats.flaggedAmbiguous).toBe(0);
    expect(rowR(b2).transferGroupId).toBe(a2); // a2 gets its unique nearest, not stranded
    expect(rowR(b1).transferGroupId).toBe(a1);
  });

  test("a hinted outflow does NOT auto-pair a nearer coincidence over the true farther partner", () => {
    // the exact residual the re-review caught: anchor-only hint + a nearer unrelated
    // uncategorized credit + the true farther ACH leg → flag all, mislabel none
    const out = insertTxn(checkingId, "2026-06-01", -50_000, "ONLINE TRANSFER TO SOFI SAVINGS"); // hinted
    const interest = insertTxn(savingsR, "2026-06-03", 50_000, "INTEREST PAYMENT"); // dist 2, unrelated income
    const truePartner = insertTxn(savingsR, "2026-06-08", 50_000, "DEPOSIT RECEIVED"); // dist 7, real ACH leg
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0); // proximity alone is not evidence when a rival is in the window
    expect(rowR(interest).transferGroupId).toBeNull();
    expect(rowR(interest).categorizationSource).not.toBe("transfer_detect"); // NOT relabeled
    expect(rowR(interest).needsReview).toBe(true); // surfaced for review
    expect(rowR(truePartner).needsReview).toBe(true); // the true partner is surfaced too
  });

  test("an earlier unrelated outflow does NOT steal a hinted inflow from the true later transfer", () => {
    // C is reached first by the loop but is a real landlord check; S is hinted and is
    // really D's ACH partner (nearer to D). Mutual-nearest must give S to D, not C.
    const c = insertTxn(checkingId, "2026-06-01", -50_000, "CHECK 1122 TO LANDLORD"); // unhinted, dist 4 from S
    const d = insertTxn(checkingId, "2026-06-03", -50_000, "ONLINE TRANSFER TO SOFI SAVINGS"); // the real transfer, dist 2
    const s = insertTxn(savingsR, "2026-06-05", 50_000, "ONLINE TRANSFER FROM CHASE 1234"); // hinted inflow
    detectTransfers(bundle.db);
    expect(rowR(s).transferGroupId).toBe(d); // S pairs its true (mutually-nearest) partner
    expect(rowR(c).transferGroupId).toBeNull(); // the landlord check is NOT mislabeled
    expect(rowR(c).categorizationSource).not.toBe("transfer_detect");
  });

  test("two both-hinted outflows competing for one inflow: the nearer pairs, the farther is not mislabeled", () => {
    const d1 = insertTxn(checkingId, "2026-06-01", -50_000, "ONLINE TRANSFER TO SOFI"); // dist 4, farther
    const d2 = insertTxn(checkingId, "2026-06-03", -50_000, "ONLINE TRANSFER TO SOFI"); // dist 2, nearer
    const s = insertTxn(savingsR, "2026-06-05", 50_000, "ACH TRANSFER FROM CHASE"); // hinted → both-hinted pairs
    detectTransfers(bundle.db);
    expect(rowR(s).transferGroupId).toBe(d2); // the nearer (mutually-nearest), not loop order
    expect(rowR(d1).transferGroupId).toBeNull(); // the farther is not silently mislabeled
  });

  test("R4: a single INFLOW-side hint never relabels an unrelated purchase as a transfer", () => {
    // a real local-merchant purchase coincidentally equals a hinted external wire whose
    // true source is not in the ledger — the purchase must NOT be relabeled a transfer
    const purchase = insertTxn(checkingId, "2026-04-02", -73_200, "SQ *UPTOWN WINE & SPIRITS NYC");
    const wire = insertTxn(savingsR, "2026-04-05", 73_200, "ONLINE TRANSFER FROM EXTERNAL ACCT 4471"); // dist 3, hinted
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(rowR(purchase).transferGroupId).toBeNull();
    expect(rowR(purchase).categorizationSource).not.toBe("transfer_detect"); // real spend preserved
  });

  test("R4: a nearer unhinted decoy never gets mislabeled, even blocking the true both-hinted pair", () => {
    // the decoy c is CLOSER to s than the true partner d — neither auto-pairs (c is not
    // auto-pairable; d↔s is not mutually-nearest because c is s's nearest) → all flag, none mislabel
    const c = insertTxn(checkingId, "2026-06-04", -50_000, "CHECK 1122 TO LANDLORD"); // dist 1, unhinted
    const d = insertTxn(checkingId, "2026-06-01", -50_000, "ONLINE TRANSFER TO SOFI SAVINGS"); // dist 4, hinted
    const s = insertTxn(savingsR, "2026-06-05", 50_000, "ONLINE TRANSFER FROM CHASE 1234"); // hinted
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(0);
    expect(rowR(c).transferGroupId).toBeNull();
    expect(rowR(c).categorizationSource).not.toBe("transfer_detect"); // the landlord check is safe
  });

  test("a pair with one user-tagged leg gives BOTH legs the user's category", () => {
    const out = insertTxn(savingsR, "2026-06-05", -2_150, "OVERDRAFT TO CHECKING - 9067");
    const inn = insertTxn(checkingId, "2026-06-05", 2_150, "OVERDRAFT FROM SAVINGS - 5791");
    bundle.db
      .update(transactions)
      .set({ categoryId: catId("Investment Contribution"), categorizationSource: "user" })
      .where(eq(transactions.id, inn))
      .run();
    const stats = detectTransfers(bundle.db);
    expect(stats.paired).toBe(1);
    expect(categoryOf(inn).name).toBe("Investment Contribution"); // user leg kept
    expect(categoryOf(out).name).toBe("Investment Contribution"); // other leg adopts it (coherence)
  });
});

describe("detectTransfers — PASS 2 remembers the owner's answers (2026-08-06)", () => {
  let savingsD: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    savingsD = createAccount(bundle.db, { institutionId: chase.id, name: "SavingsD", type: "savings" });
  });

  function rowD(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }
  function questions() {
    return bundle.db.select().from(transferAmbiguities).all();
  }
  /**
   * How every OTHER path in the app clears the flag — the owner categorizes the
   * row, marks the cluster reviewed, or uses the one-click amnesty. PASS 2 must
   * not undo it on the next import; that is the whole defect under test.
   */
  function clearReview(ids: string[]): void {
    bundle.db.update(transactions).set({ needsReview: false }).where(inArray(transactions.id, ids)).run();
  }
  /**
   * The real shape of the 33: a hinted outflow with two equal-cent counterparts
   * the owner must choose between. They sit EQUIDISTANT on purpose — that is
   * what makes the question genuinely unanswerable by the detector, so PASS 1
   * can never pair it away and PASS 2 owns it however the rows are categorized.
   */
  function askTheQuestion(): { out: string; legA: string; legB: string } {
    return {
      out: insertTxn(checkingId, "2026-06-10", -20_000, "ONLINE TRANSFER TO SOFI"),
      legA: insertTxn(savingsD, "2026-06-09", 20_000, "MISC CREDIT A"),
      legB: insertTxn(savingsD, "2026-06-11", 20_000, "MISC CREDIT B"),
    };
  }

  test("a dismissed ambiguity is never asked again", () => {
    const { out, legA, legB } = askTheQuestion();
    const first = detectTransfers(bundle.db);
    expect(first.paired).toBe(0);
    expect(first.flaggedAmbiguous).toBe(1);
    expect(rowD(out).needsReview).toBe(true);

    const q = questions();
    expect(q).toHaveLength(1);
    expect(q[0]!.resolution).toBe("unresolved");
    expect(q[0]!.legCount).toBe(2);
    expect(dismissTransferAmbiguity(bundle.db, q[0]!.id)).toBe(true);
    clearReview([out, legA, legB]);

    const second = detectTransfers(bundle.db);
    expect(second.flaggedAmbiguous).toBe(0);
    expect(second.dismissedAmbiguous).toBe(1);
    for (const id of [out, legA, legB]) expect(rowD(id).needsReview).toBe(false);
    expect(questions()).toHaveLength(1); // the verdict, not a second copy of the question
  });

  test("the owner categorizing the row closes the question — the wiring, not just the table", () => {
    // dismissTransferAmbiguity is reachable from a real user action or it is
    // shelf-ware: if nothing writes a verdict, every question stays unresolved
    // and PASS 2 re-flags forever, which is the defect this table exists to end
    const { out, legA, legB } = askTheQuestion();
    detectTransfers(bundle.db);
    expect(questions()[0]!.resolution).toBe("unresolved");

    const general = bundle.db.select().from(categories).where(eq(categories.name, "General")).get()!;
    applyCorrection(bundle.db, { transactionId: out, categoryId: general.id, applyToMerchant: false });
    expect(questions()[0]!.resolution).toBe("dismissed");

    clearReview([legA, legB]);
    const second = detectTransfers(bundle.db);
    // the flag does not come back, and no duplicate question is written. The
    // dismissedAmbiguous counter stays 0 here because applyCorrection also marks
    // the row user-categorized, so PASS 2 skips it before it reaches the verdict
    // lookup — a second, independent reason the queue drains.
    expect(second.flaggedAmbiguous).toBe(0);
    expect(rowD(out).needsReview).toBe(false);
    expect(questions()).toHaveLength(1);
  });

  test("the verdict alone stops the re-flag, even with the row still auto-categorized", () => {
    // isolates the TABLE's contribution from applyCorrection's user-source side
    // effect: here nothing marks the row 'user', so PASS 2 does reach the
    // verdict lookup and reports the dismissal it honoured
    const { out, legA, legB } = askTheQuestion();
    detectTransfers(bundle.db);
    const anchorId = questions()[0]!.anchorTransactionId;
    expect(anchorId).toBe(out);

    expect(dismissTransferAmbiguity(bundle.db, questions()[0]!.id)).toBe(true);
    clearReview([out, legA, legB]);

    const second = detectTransfers(bundle.db);
    expect(second.flaggedAmbiguous).toBe(0);
    expect(second.dismissedAmbiguous).toBe(1);
    expect(rowD(out).needsReview).toBe(false);
  });

  test("dismissing is idempotent and never invents a second verdict", () => {
    askTheQuestion();
    detectTransfers(bundle.db);
    const id = questions()[0]!.id;
    expect(dismissTransferAmbiguity(bundle.db, id)).toBe(true);
    expect(dismissTransferAmbiguity(bundle.db, id)).toBe(false); // already answered
    expect(dismissTransferAmbiguity(bundle.db, "no-such-question")).toBe(false);
    expect(questions()).toHaveLength(1);
  });

  test("a NEW counterpart on the dismissed anchor re-asks — the answer never considered it", () => {
    // the exact reason the cheap heuristic ("skip rows the user already categorized")
    // is wrong: this row IS user-touched, and the question has genuinely changed.
    const { out, legA, legB } = askTheQuestion();
    detectTransfers(bundle.db);
    dismissTransferAmbiguity(bundle.db, questions()[0]!.id);
    bundle.db
      .update(transactions)
      .set({ categoryId: catIdD("Internal Transfer"), categorizationSource: "user", needsReview: false })
      .where(inArray(transactions.id, [out, legA, legB]))
      .run();

    const legC = insertTxn(savingsD, "2026-06-13", 20_000, "MISC CREDIT C");
    const stats = detectTransfers(bundle.db);
    expect(stats.flaggedAmbiguous).toBe(1); // three counterparts is a different question
    expect(stats.dismissedAmbiguous).toBe(0);
    expect(rowD(out).needsReview).toBe(true);
    expect(rowD(legC).needsReview).toBe(true);
    const keys = new Set(questions().map((q) => q.ambiguityKey));
    expect(keys.size).toBe(2); // the old verdict is intact beside the new question
  });

  test("a genuinely new ambiguity on the SAME account pair is still flagged", () => {
    const { out, legA, legB } = askTheQuestion();
    detectTransfers(bundle.db);
    dismissTransferAmbiguity(bundle.db, questions()[0]!.id);
    clearReview([out, legA, legB]);

    const out2 = insertTxn(checkingId, "2026-07-14", -31_500, "ONLINE TRANSFER TO SOFI");
    const coin = insertTxn(savingsD, "2026-07-15", 31_500, "MISC CREDIT D");
    const stats = detectTransfers(bundle.db);
    expect(stats.flaggedAmbiguous).toBe(1);
    expect(stats.dismissedAmbiguous).toBe(1); // the old one stays answered
    expect(rowD(out2).needsReview).toBe(true);
    expect(rowD(coin).needsReview).toBe(true);
    expect(rowD(out).needsReview).toBe(false);
  });

  test("the dismissal survives an unimport → re-import that renumbers every row", () => {
    const { out, legA, legB } = askTheQuestion();
    detectTransfers(bundle.db);
    dismissTransferAmbiguity(bundle.db, questions()[0]!.id);

    // unimport hard-deletes the rows under `foreign_keys = ON`; the FK is SET NULL,
    // never cascade, so the owner's verdict outlives the rows it pointed at.
    bundle.db.delete(transactions).where(inArray(transactions.id, [out, legA, legB])).run();
    expect(questions()[0]!.anchorTransactionId).toBeNull();
    expect(questions()[0]!.resolution).toBe("dismissed");

    // re-import: the same three charges, brand-new ids
    const again = askTheQuestion();
    expect(again.out).not.toBe(out);
    const stats = detectTransfers(bundle.db);
    expect(stats.flaggedAmbiguous).toBe(0);
    expect(stats.dismissedAmbiguous).toBe(1);
    for (const id of [again.out, again.legA, again.legB]) expect(rowD(id).needsReview).toBe(false);
    expect(questions()).toHaveLength(1);
  });

  test("an unresolved question is re-pointed at the live rows, not duplicated", () => {
    const { out, legA, legB } = askTheQuestion();
    detectTransfers(bundle.db);
    expect(questions()[0]!.anchorTransactionId).toBe(out);

    bundle.db.delete(transactions).where(inArray(transactions.id, [out, legA, legB])).run();
    const again = askTheQuestion();
    const stats = detectTransfers(bundle.db);
    expect(stats.flaggedAmbiguous).toBe(1); // still unanswered, so still asked
    expect(questions()).toHaveLength(1);
    expect(questions()[0]!.anchorTransactionId).toBe(again.out);
  });

  function catIdD(name: string): string {
    return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
  }
});

describe("the system Uncategorized category", () => {
  test("a row filed on it is not covered", () => {
    const sys = bundle.db.select().from(categories).where(eq(categories.kind, "system")).get()!.id;
    const id = insertTxn(cardId, "2026-06-01", -762, "CONRAD HOTEL N Y");
    bundle.db.update(transactions).set({ categoryId: sys, categorizationSource: "user" }).where(eq(transactions.id, id)).run();
    const stats = coverageStats(bundle.db);
    expect(stats.total).toBe(1);
    expect(stats.categorized).toBe(0);
  });

  /*
   * ⛔ Picking "Uncategorized" is a decision to leave the row category-less. It
   * is written as NULL + user — the shape the pipeline already reads as
   * "deliberately uncategorized" — never as a row ON the system category, and
   * no merchant learns "Uncategorized" as its default. Killed by mutation:
   * writing the chosen id through, and letting the merchant branch run.
   */
  test("choosing it writes NULL as a user decision and teaches no merchant", () => {
    const sys = bundle.db.select().from(categories).where(eq(categories.kind, "system")).get()!.id;
    const id = insertTxn(cardId, "2026-06-01", -1_549, "NETFLIX.COM NETFLIX.COM CA");
    categorizeAll(bundle.db);
    expect(categoryOf(id).name).toBe("Streaming");
    const result = applyCorrection(bundle.db, { transactionId: id, categoryId: sys, applyToMerchant: true, retroactive: true });
    expect(categoryOf(id)).toEqual({ name: null, source: "user" });
    expect(result.merchantUpdated).toBe(false);
    expect(result.retroactivelyUpdated).toBe(0);
    // the pipeline leaves a user decision alone
    categorizeAll(bundle.db);
    expect(categoryOf(id)).toEqual({ name: null, source: "user" });
  });
});

