import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { budgets } from "@/db/schema/budgets";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import {
  categoryBudgetRef,
  categoryDetailHeader,
  categoryMonthlyTrend,
  categorySubcategorySplit,
  seriesInCategory,
} from "./category-detail";
import { topMerchants } from "./spending";

const TODAY = "2026-07-08";

let dir: string;
let bundle: DbBundle;
let cardId: string;
let checkingId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-catdetail-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db.select().from(categories).where(and(eq(categories.name, parentName!), isNull(categories.parentId))).get();
  if (!parent) throw new Error(`missing ${parentName}`);
  if (!subName) return parent.id;
  const sub = bundle.db.select().from(categories).where(and(eq(categories.name, subName), eq(categories.parentId, parent.id))).get();
  if (!sub) throw new Error(`missing ${pathStr}`);
  return sub.id;
}

let seq = 0;
function insertTxn(spec: { postedOn: string; amountCents: number; category?: string | null; accountId?: string; seriesId?: string; status?: TransactionStatus }): string {
  seq += 1;
  const accountId = spec.accountId ?? cardId;
  const raw = `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: spec.postedOn,
      amountCents: spec.amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: spec.category ? catId(spec.category) : null,
      recurringSeriesId: spec.seriesId ?? null,
      status: spec.status ?? "active",
      dedupeHash: dedupeHash({ accountId, postedOn: spec.postedOn, amountCents: spec.amountCents, rawDescription: raw, occurrenceIndex: seq }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

const JULY = { from: "2026-07-01", to: "2026-07-31" };

describe("categoryDetailHeader", () => {
  test("top-level category", () => {
    const h = categoryDetailHeader(bundle.db, catId("Food"));
    expect(h).toMatchObject({ name: "Food", kind: "expense", isSubcategory: false, parentId: null, parentName: null });
  });
  test("subcategory carries its parent", () => {
    const h = categoryDetailHeader(bundle.db, catId("Food > Dining"));
    expect(h).toMatchObject({ name: "Dining", isSubcategory: true, parentName: "Food" });
  });
  test("unknown id throws", () => {
    expect(() => categoryDetailHeader(bundle.db, "nope")).toThrow(/Unknown category/);
  });
});

describe("categoryMonthlyTrend", () => {
  test("subtree spend per month with a drill href", () => {
    insertTxn({ postedOn: "2026-06-05", amountCents: -3_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-06", amountCents: -1_500, category: "Food > Coffee" });

    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 2, TODAY);
    expect(trend.map((t) => [t.month, t.spentCents])).toEqual([
      ["2026-06", 3_000],
      ["2026-07", 6_500],
    ]);
    expect(trend[1]!.href).toBe(`/transactions?category=${catId("Food")}&from=2026-07-01&to=2026-07-31`);
  });
});

describe("categorySubcategorySplit", () => {
  test("children of an expense top-level, by money out", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-06", amountCents: -8_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-07", amountCents: -1_500, category: "Food > Coffee" });

    const split = categorySubcategorySplit(bundle.db, catId("Food"), JULY);
    expect(split.map((s) => [s.name, s.flowCents])).toEqual([
      ["Groceries", 8_000],
      ["Dining", 5_000],
      ["Coffee", 1_500],
    ]);
  });

  test("income top-level reports money in as positive flow", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-15", amountCents: 1_200, category: "Income > Interest", accountId: checkingId });
    const split = categorySubcategorySplit(bundle.db, catId("Income"), JULY);
    expect(split.map((s) => [s.name, s.flowCents])).toEqual([
      ["Salary", 500_000],
      ["Interest", 1_200],
    ]);
  });

  test("a subcategory (leaf) has no split", () => {
    expect(categorySubcategorySplit(bundle.db, catId("Food > Dining"), JULY)).toEqual([]);
  });
});

describe("seriesInCategory", () => {
  test("returns series whose linked txns fall in the subtree, linking to /recurring/[id]", () => {
    const seriesId = bundle.db
      .insert(recurringSeries)
      .values({ name: "Spotify", kind: "subscription", cadence: "monthly", amountCentsAvg: -1_099, status: "confirmed", nextExpectedOn: "2026-08-01", lastMatchedOn: "2026-07-01" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-06-01", amountCents: -1_099, category: "Subscriptions > Streaming", seriesId });
    insertTxn({ postedOn: "2026-07-01", amountCents: -1_099, category: "Subscriptions > Streaming", seriesId });
    // an unrelated series in a different category must NOT appear
    const otherId = bundle.db
      .insert(recurringSeries)
      .values({ name: "Rent", kind: "bill", cadence: "monthly", amountCentsAvg: -180_000, status: "confirmed" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-07-01", amountCents: -180_000, category: "Housing > Rent", seriesId: otherId });

    const rows = seriesInCategory(bundle.db, catId("Subscriptions"), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: seriesId, name: "Spotify", href: `/recurring/${seriesId}` });
  });

  test("empty when no linked series", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -1_099, category: "Subscriptions > Streaming" });
    expect(seriesInCategory(bundle.db, catId("Subscriptions"), TODAY)).toEqual([]);
  });
});

describe("categoryBudgetRef", () => {
  test("returns the active budget targeting this category", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -6_000, category: "Food > Dining" });
    bundle.db.insert(budgets).values({ categoryId: catId("Food"), period: "monthly", amountCents: 40_000, startsOn: "2026-01-01" }).run();

    const ref = categoryBudgetRef(bundle.db, catId("Food"), TODAY);
    expect(ref).toMatchObject({ amountCents: 40_000, spentCents: 6_000, remainingCents: 34_000, period: "monthly", alert: "none", href: "/budgets" });
  });

  test("null when no budget", () => {
    expect(categoryBudgetRef(bundle.db, catId("Food"), TODAY)).toBeNull();
  });
});

describe("categoryMerchants (via topMerchants subtree scope)", () => {
  test("only rows inside the category subtree count", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -9_000, category: "Housing > Rent" }); // outside Food
    const scoped = topMerchants(bundle.db, JULY, 8, { categoryId: catId("Food") });
    expect(scoped.entries.reduce((s, e) => s + e.spentCents, 0)).toBe(5_000);
  });
});
