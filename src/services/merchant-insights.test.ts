import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { merchantInsights } from "./merchant-insights";

/**
 * What a merchant page adds to what it already shows.
 *
 * Every test here is really about the same distinction: a sentence can be
 * arithmetically correct and still mislead, because of what sits next to it or
 * because of how narrow its window is. Both failures were on screen during this
 * pass before these tests existed.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-08-26";
const ACCT = "acct-1";

function topLevelId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

function addMerchant(id: string, name: string): void {
  bundle.db
    .insert(merchants)
    .values({ id, canonicalName: name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .run();
}

let seq = 0;
function addTxn(day: string, cents: number, categoryName: string | null, merchantId: string | null): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: ACCT,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: categoryName === null ? null : topLevelId(categoryName),
      merchantId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-minsights-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id: ACCT,
      institutionId,
      name: "Chase Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what a merchant page adds", () => {
  test("names where the merchant sits among the rest, and its share of a category", () => {
    addMerchant("m-1", "Zzz Eats");
    addMerchant("m-2", "Zzz Deli");
    addTxn("2026-01-10", -6_000, "Food", "m-1");
    addTxn("2026-02-10", -4_000, "Food", "m-1");
    addTxn("2026-01-11", -1_000, "Food", "m-2");
    addTxn("2026-02-11", -1_000, "Food", "m-2");

    const out = merchantInsights(bundle.db, "m-1", TODAY)!;
    /*
     * ⚠️ 90.9%, not 83.3%. The denominator is Food over THIS MERCHANT's span
     * (2026-01-10 → 2026-02-10), and the rival's second row lands on 02-11,
     * outside it — so the whole is $110, not $120. That is why the sentence
     * states its window: a share whose frame is the subject's own span is only
     * honest if the frame is printed.
     */
    expect(out.insights.map((i) => i.text)).toEqual([
      "Zzz Eats is the largest of your 2 regular merchants, at $100.00.",
      "Zzz Eats is 90.9% of what you spent on Food between Jan 2026 and Feb 2026.",
    ]);
  });

  test("the share's whole is the category over the MERCHANT's span, not all time", () => {
    // the same ledger with the rival's row pulled inside the span: the part is
    // unchanged and the share moves, which is the frame doing real work
    addMerchant("m-1", "Zzz Eats");
    addMerchant("m-2", "Zzz Deli");
    addTxn("2026-01-10", -6_000, "Food", "m-1");
    addTxn("2026-02-10", -4_000, "Food", "m-1");
    addTxn("2026-01-11", -1_000, "Food", "m-2");
    addTxn("2026-02-09", -1_000, "Food", "m-2");

    const out = merchantInsights(bundle.db, "m-1", TODAY)!;
    expect(out.insights[1]!.text).toBe(
      "Zzz Eats is 83.3% of what you spent on Food between Jan 2026 and Feb 2026.",
    );
  });

  test("a second-place merchant is ranked, never called the largest", () => {
    addMerchant("m-1", "Zzz Eats");
    addMerchant("m-2", "Zzz Deli");
    addTxn("2026-01-10", -6_000, "Food", "m-1");
    addTxn("2026-02-10", -4_000, "Food", "m-1");
    addTxn("2026-01-11", -1_000, "Food", "m-2");
    addTxn("2026-02-11", -1_000, "Food", "m-2");

    const out = merchantInsights(bundle.db, "m-2", TODAY)!;
    expect(out.insights[0]!.text).toBe("Zzz Deli is the 2nd largest of your 2 regular merchants, at $20.00.");
    expect(out.insights.some((i) => i.text.includes("is the largest"))).toBe(false);
  });

  test("⛔ a one-visit merchant says nothing at all", () => {
    /*
     * Its first and last day are the same day, so its share of a category is a
     * share of whatever that category held on one afternoon. "Highest Standards
     * is 100.0% of what you spend on Shopping" was measured, correct, and read
     * as a claim about a whole shopping habit.
     */
    addMerchant("m-1", "Zzz Standards");
    addMerchant("m-2", "Zzz Deli");
    addTxn("2026-06-10", -1_600, "Shopping", "m-1");
    addTxn("2026-01-11", -1_000, "Shopping", "m-2");
    addTxn("2026-02-11", -1_000, "Shopping", "m-2");

    expect(merchantInsights(bundle.db, "m-1", TODAY)).toBeNull();
  });

  test("the share always states the window it is a share OF", () => {
    // a merchant's span is its own, not the ledger's, so a share with no dates
    // reads as all time on a merchant that ran for a month
    addMerchant("m-1", "Zzz Deli");
    addMerchant("m-2", "Zzz Other");
    addTxn("2026-03-10", -1_000, "Food", "m-1");
    addTxn("2026-03-20", -1_000, "Food", "m-1");
    addTxn("2026-03-21", -5_000, "Food", "m-2");
    addTxn("2026-03-22", -5_000, "Food", "m-2");
    const out = merchantInsights(bundle.db, "m-1", TODAY)!;
    expect(out.insights.some((i) => i.text.includes("in Mar 2026."))).toBe(true);
  });

  test("a merchant with no expense-kind spending says nothing", () => {
    // transfers move money without spending it; a merchant that only ever
    // appears on transfers has no spend to rank or to take a share of
    addMerchant("m-1", "Zzz Wire");
    addTxn("2026-01-10", -5_000, "Transfers", "m-1");
    addTxn("2026-02-10", -5_000, "Transfers", "m-1");
    expect(merchantInsights(bundle.db, "m-1", TODAY)).toBeNull();
  });

  test("an unproven sentence is dropped rather than shown bare", () => {
    // every insight that renders carries a chain; the runner drops any that
    // cannot be proved, so a rendered strip is a proved strip
    addMerchant("m-1", "Zzz Deli");
    addMerchant("m-2", "Zzz Other");
    addTxn("2026-01-10", -1_000, "Food", "m-1");
    addTxn("2026-02-10", -1_000, "Food", "m-1");
    addTxn("2026-01-11", -5_000, "Food", "m-2");
    addTxn("2026-02-11", -5_000, "Food", "m-2");
    for (const i of merchantInsights(bundle.db, "m-1", TODAY)!.insights) {
      expect(i.provenance.verdict).toBeTruthy();
      expect(i.provenance.headline.length).toBeGreaterThan(0);
    }
  });

  test("the proof counts the MERCHANT's rows, not its category's", () => {
    /*
     * ⛔ The first version of this module proved a merchant figure with
     * `categorySpend` over the merchant's dominant category. It would have
     * printed the category's evidence — every row in Food — beside a figure
     * summed from two.
     */
    addMerchant("m-1", "Zzz Deli");
    addMerchant("m-2", "Zzz Other");
    addTxn("2026-01-10", -1_000, "Food", "m-1");
    addTxn("2026-02-10", -1_000, "Food", "m-1");
    for (let i = 0; i < 20; i += 1) addTxn("2026-01-15", -100, "Food", "m-2");
    addTxn("2026-02-15", -100, "Food", "m-2");

    const out = merchantInsights(bundle.db, "m-1", TODAY)!;
    // two rows, not twenty-two
    expect(out.insights[0]!.provenance.headline).toContain("2 rows");
  });
});
