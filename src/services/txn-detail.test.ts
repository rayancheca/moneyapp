import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { rules } from "@/db/schema/rules";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { categorizeContext, matchingRules, suggestCategory, txnHistory } from "./txn-detail";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;
let brokerageId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-txndetail-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  brokerageId = createAccount(bundle.db, { institutionId: chase.id, name: "Brokerage", type: "investment" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get()!;
  if (!subName) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get()!.id;
}

let seq = 0;
function insertTxn(opts: {
  accountId?: string;
  postedOn?: string;
  amountCents?: number;
  normalized?: string;
  merchantId?: string | null;
  categoryId?: string | null;
}): string {
  seq += 1;
  const accountId = opts.accountId ?? checkingId;
  const postedOn = opts.postedOn ?? "2026-07-05";
  const amountCents = opts.amountCents ?? -1_599;
  const normalized = opts.normalized ?? "NETFLIX.COM";
  const rawDescription = `${normalized} #${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: normalized,
      merchantId: opts.merchantId ?? null,
      categoryId: opts.categoryId ?? null,
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function netflixMerchantId(): string {
  return bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;
}

describe("suggestCategory", () => {
  test("prefers an enabled rule that assigns a category and matches", () => {
    bundle.db
      .insert(rules)
      .values({
        name: "Netflix → Streaming",
        priority: 10,
        isEnabled: true,
        conditions: JSON.stringify({ descriptionContains: "NETFLIX" }),
        actions: JSON.stringify({ categoryId: catId("Subscriptions > Streaming") }),
      })
      .run();
    const id = insertTxn({ normalized: "NETFLIX.COM", categoryId: null });

    const s = suggestCategory(bundle.db, id);
    expect(s).toMatchObject({
      categoryId: catId("Subscriptions > Streaming"),
      reason: "rule",
      categoryLabel: "Subscriptions > Streaming",
    });
    expect(s?.ruleId).toBeTruthy();
  });

  test("falls back to the merchant's default mapping when no rule matches", () => {
    const merchant = netflixMerchantId();
    bundle.db
      .update(merchants)
      .set({ defaultCategoryId: catId("Subscriptions > Streaming"), mappingSource: "user" })
      .where(eq(merchants.id, merchant))
      .run();
    const id = insertTxn({ merchantId: merchant, normalized: "NFLX", categoryId: null });

    expect(suggestCategory(bundle.db, id)).toMatchObject({
      categoryId: catId("Subscriptions > Streaming"),
      reason: "merchant",
    });
  });

  test("falls back to the same-name group's plurality category", () => {
    // three merchantless rows share a stripped key; two already Groceries
    insertTxn({ normalized: "TRADER JOES", categoryId: catId("Food > Groceries") });
    insertTxn({ normalized: "TRADER JOES", categoryId: catId("Food > Groceries") });
    insertTxn({ normalized: "TRADER JOES", categoryId: catId("Food > Dining") });
    const id = insertTxn({ normalized: "TRADER JOES", categoryId: null });

    expect(suggestCategory(bundle.db, id)).toMatchObject({
      categoryId: catId("Food > Groceries"),
      reason: "history",
      support: 2,
    });
  });

  test("suggests nothing when the best candidate equals the current category", () => {
    const merchant = netflixMerchantId();
    bundle.db
      .update(merchants)
      .set({ defaultCategoryId: catId("Subscriptions > Streaming") })
      .where(eq(merchants.id, merchant))
      .run();
    const id = insertTxn({ merchantId: merchant, categoryId: catId("Subscriptions > Streaming") });
    expect(suggestCategory(bundle.db, id)).toBeNull();
  });

  test("suggests nothing for a lone uncategorized row with no rule, mapping, or history", () => {
    const id = insertTxn({ normalized: "MYSTERY CHARGE", categoryId: null });
    expect(suggestCategory(bundle.db, id)).toBeNull();
  });

  test("a merchant default equal to the current category suppresses the suggestion (merchant > history, no fall-through)", () => {
    const merchant = netflixMerchantId();
    bundle.db
      .update(merchants)
      .set({ defaultCategoryId: catId("Subscriptions > Streaming") })
      .where(eq(merchants.id, merchant))
      .run();
    // a stale sibling plurality in a DIFFERENT category must NOT override the
    // merchant default the target already matches
    insertTxn({ merchantId: merchant, categoryId: catId("Subscriptions > Software") });
    insertTxn({ merchantId: merchant, categoryId: catId("Subscriptions > Software") });
    insertTxn({ merchantId: merchant, categoryId: catId("Subscriptions > Software") });
    const id = insertTxn({ merchantId: merchant, categoryId: catId("Subscriptions > Streaming") });

    expect(suggestCategory(bundle.db, id)).toBeNull();
  });

  test("a plurality tie is broken by category label, not random id (determinism)", () => {
    // two Dining, two Groceries — a genuine tie; 'Food > Dining' sorts before
    // 'Food > Groceries', so the winner is stable across reseeds (ids are random)
    insertTxn({ normalized: "TIE MART", categoryId: catId("Food > Dining") });
    insertTxn({ normalized: "TIE MART", categoryId: catId("Food > Dining") });
    insertTxn({ normalized: "TIE MART", categoryId: catId("Food > Groceries") });
    insertTxn({ normalized: "TIE MART", categoryId: catId("Food > Groceries") });
    const id = insertTxn({ normalized: "TIE MART", categoryId: null });

    expect(suggestCategory(bundle.db, id)).toMatchObject({
      reason: "history",
      categoryLabel: "Food > Dining",
    });
  });
});

describe("txnHistory", () => {
  test("aggregates monthly money-out, count/avg, and a by-account split", () => {
    const merchant = netflixMerchantId();
    insertTxn({ merchantId: merchant, accountId: checkingId, postedOn: "2026-05-05", amountCents: -1_000 });
    insertTxn({ merchantId: merchant, accountId: checkingId, postedOn: "2026-06-05", amountCents: -2_000 });
    const target = insertTxn({ merchantId: merchant, accountId: cardId, postedOn: "2026-07-05", amountCents: -3_000 });

    const h = txnHistory(bundle.db, target, "2026-07-08")!;
    expect(h.count).toBe(3);
    expect(h.totalCents).toBe(6_000);
    expect(h.avgCents).toBe(2_000);
    // last 6 months ending 2026-07 → the three charges land in May/Jun/Jul
    const byMonth = new Map(h.monthly.map((m) => [m.monthKey, m.cents]));
    expect(byMonth.get("2026-05")).toBe(1_000);
    expect(byMonth.get("2026-06")).toBe(2_000);
    expect(byMonth.get("2026-07")).toBe(3_000);
    expect(h.monthly).toHaveLength(6);
    // by account: Checking has 2 rows / 3_000, Card 1 row / 3_000; count desc
    expect(h.byAccount).toEqual([
      { accountName: "Checking", count: 2, cents: 3_000 },
      { accountName: "Card", count: 1, cents: 3_000 },
    ]);
  });

  test("ignores money-in in the money-out total but still counts the row", () => {
    const merchant = netflixMerchantId();
    insertTxn({ merchantId: merchant, amountCents: -1_000, postedOn: "2026-07-01" });
    insertTxn({ merchantId: merchant, amountCents: 400, postedOn: "2026-07-02" }); // a refund
    const target = insertTxn({ merchantId: merchant, amountCents: -1_000, postedOn: "2026-07-03" });

    const h = txnHistory(bundle.db, target, "2026-07-08")!;
    expect(h.count).toBe(3);
    expect(h.totalCents).toBe(2_000); // the refund contributes 0 money-out
    expect(h.avgCents).toBe(1_000); // avg over the two outflow rows only
  });

  test("returns null for an investment-account row (no merchant group)", () => {
    const id = insertTxn({ accountId: brokerageId, normalized: "BUY AAPL", categoryId: catId("Investments > Buys") });
    expect(txnHistory(bundle.db, id)).toBeNull();
  });
});

describe("matchingRules", () => {
  test("returns enabled rules whose conditions match, rendered as sentences", () => {
    bundle.db
      .insert(rules)
      .values({
        name: "Netflix → Streaming",
        priority: 10,
        isEnabled: true,
        conditions: JSON.stringify({ descriptionContains: "NETFLIX" }),
        actions: JSON.stringify({ categoryId: catId("Subscriptions > Streaming") }),
      })
      .run();
    // a disabled rule that would also match must NOT appear
    bundle.db
      .insert(rules)
      .values({
        name: "disabled",
        priority: 20,
        isEnabled: false,
        conditions: JSON.stringify({ descriptionContains: "NETFLIX" }),
        actions: JSON.stringify({ exclude: true }),
      })
      .run();
    // a rule that does not match this row
    bundle.db
      .insert(rules)
      .values({
        name: "Spotify",
        priority: 30,
        isEnabled: true,
        conditions: JSON.stringify({ descriptionContains: "SPOTIFY" }),
        actions: JSON.stringify({ categoryId: catId("Subscriptions > Streaming") }),
      })
      .run();

    const id = insertTxn({ normalized: "NETFLIX.COM" });
    const matched = matchingRules(bundle.db, id);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.name).toBe("Netflix → Streaming");
    expect(matched[0]!.sentence).toContain("Subscriptions > Streaming");
  });

  test("no matching rules for a row nothing targets", () => {
    const id = insertTxn({ normalized: "MYSTERY" });
    expect(matchingRules(bundle.db, id)).toEqual([]);
  });
});

describe("categorizeContext", () => {
  test("bundles suggestion, history, and matching rules in one call", () => {
    const merchant = netflixMerchantId();
    bundle.db
      .update(merchants)
      .set({ defaultCategoryId: catId("Subscriptions > Streaming") })
      .where(eq(merchants.id, merchant))
      .run();
    insertTxn({ merchantId: merchant, amountCents: -1_599, postedOn: "2026-06-05" });
    const target = insertTxn({ merchantId: merchant, amountCents: -1_599, postedOn: "2026-07-05", categoryId: null });

    const ctx = categorizeContext(bundle.db, target, "2026-07-08");
    expect(ctx.suggestion?.reason).toBe("merchant");
    expect(ctx.history?.count).toBe(2);
    expect(ctx.matchingRules).toEqual([]);
  });
});
