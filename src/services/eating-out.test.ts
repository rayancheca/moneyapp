import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { eq, and, isNull } from "drizzle-orm";
import { eatingOutCard } from "./eating-out";

/**
 * The card's job is to separate two habits the `Food` total merges, so the
 * tests that matter are the ones about which rows land in which half and how
 * money that came BACK is treated.
 */

let dir: string;
let bundle: DbBundle;
let accountId: string;

/** today is deliberately mid-month: the window must exclude the current month */
const TODAY = "2026-08-26";

function childId(name: string): string {
  const food = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Food"), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, food.id)))
    .get()!.id;
}

let seq = 0;
function addTxn(day: string, cents: number, categoryName: string): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: childId(categoryName),
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-eating-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  accountId = "acct-1";
  bundle.db
    .insert(accounts)
    .values({
      id: accountId,
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

describe("eatingOutCard", () => {
  test("separates eating out from groceries and reports the ratio between them", () => {
    addTxn("2026-07-02", -2000, "Dining");
    addTxn("2026-07-03", -3000, "Dining");
    addTxn("2026-07-04", -1000, "Delivery");
    addTxn("2026-07-05", -1500, "Groceries");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.totalSpentCents).toBe(6000);
    expect(card.totalCount).toBe(3);
    expect(card.groceries.spentCents).toBe(1500);
    expect(card.multipleOfGroceries).toBeCloseTo(4);
    // 6 complete months in the window, so the monthly rate divides by 6
    expect(card.monthlyCents).toBe(1000);
    expect(card.months).toBe(6);
  });

  /**
   * ⛔ THE trap. `WHERE amount_cents < 0` is the obvious query and it is wrong:
   * an inflow inside an expense category is a silent NEGATIVE expense, and the
   * ledger was understated $487.50 by exactly this before pass 66 netted them.
   * A refunded meal is one event with two legs, and the legs cancel.
   */
  test("a refund NETS against spend instead of being ignored", () => {
    addTxn("2026-07-02", -5000, "Dining");
    addTxn("2026-07-09", 2000, "Dining"); // the meal was refunded in part

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.totalSpentCents).toBe(3000);
    // …and the refund is not a visit, so it must not inflate the count
    expect(card.totalCount).toBe(1);
    expect(card.averageTicketCents).toBe(3000);
  });

  /**
   * ⛔ `x / 0` is Infinity, which renders as "Infinity× what you spend on
   * groceries". A ledger with no groceries has no ratio to publish.
   */
  test("no groceries yields a null ratio rather than Infinity", () => {
    addTxn("2026-07-02", -2000, "Dining");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.multipleOfGroceries).toBeNull();
    expect(Number.isFinite(card.multipleOfGroceries ?? 0)).toBe(true);
  });

  test("an average ticket over zero purchases is null, not zero", () => {
    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.averageTicketCents).toBeNull();
    expect(card.isEmpty).toBe(true);
  });

  /**
   * The runway card on the same screen publishes "averaged over 6 complete
   * months"; a second card quoting a different window would be a contradiction
   * the reader has to resolve.
   */
  test("the current, incomplete month is excluded from the window", () => {
    addTxn("2026-08-10", -9999, "Dining"); // this month — must not count
    addTxn("2026-07-10", -1000, "Dining");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.totalSpentCents).toBe(1000);
    expect(card.toMonth).toBe("2026-07");
    expect(card.fromMonth).toBe("2026-02");
  });

  test("a month older than the window is excluded too", () => {
    addTxn("2026-01-15", -8888, "Dining"); // one month before the window opens
    addTxn("2026-02-15", -1000, "Dining");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.totalSpentCents).toBe(1000);
  });

  /** A child with nothing in it is an absence, not a row reading "0 coffees $0.00". */
  test("an empty child category is dropped rather than printed as a zero row", () => {
    addTxn("2026-07-02", -2000, "Dining");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.eatingOut.map((l) => l.name)).toEqual(["Dining"]);
  });

  test("rows are ordered by what they cost, biggest first", () => {
    addTxn("2026-07-02", -500, "Coffee");
    addTxn("2026-07-03", -9000, "Dining");
    addTxn("2026-07-04", -3000, "Delivery");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.eatingOut.map((l) => l.name)).toEqual(["Dining", "Delivery", "Coffee"]);
  });

  test("groceries are never counted inside the eating-out subtotal", () => {
    addTxn("2026-07-02", -2000, "Dining");
    addTxn("2026-07-03", -5000, "Groceries");

    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.totalSpentCents).toBe(2000);
    expect(card.eatingOut.some((l) => l.name === "Groceries")).toBe(false);
  });

  test("a ledger with no Food taxonomy returns null rather than a card of zeroes", () => {
    // renamed rather than deleted: the children carry a FK to it, and the
    // condition under test is "no top-level category called Food", not "no row"
    bundle.db
      .update(categories)
      .set({ name: "Nourishment" })
      .where(and(eq(categories.name, "Food"), isNull(categories.parentId)))
      .run();
    expect(eatingOutCard(bundle.db, TODAY)).toBeNull();
  });
});
