import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { periodBounds } from "@/lib/dates";
import { createAccount } from "./accounts";
import {
  activeTxnsInRange,
  categoryBreakdown,
  categorySpending,
  categoryTrends,
  hrefCategoryId,
  ledgerHref,
  incomeByMonth,
  incomeTransactions,
  loadCategoryIndex,
  monthKeysBack,
  monthlySpending,
  spendingBucket,
  spendingTransactions,
  transactionsHref,
} from "./analytics";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;
let brokerageId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-analytics-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  const robinhood = bundle.db
    .select()
    .from(institutions)
    .where(eq(institutions.name, "Robinhood"))
    .get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  brokerageId = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Resolve a seeded category id by "Parent" or "Parent > Sub" path. */
function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`missing category ${parentName}`);
  if (!subName) return parent.id;
  const sub = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  if (!sub) throw new Error(`missing category ${pathStr}`);
  return sub.id;
}

let seq = 0;
interface TxnSpec {
  accountId?: string;
  postedOn: string;
  amountCents: number;
  category?: string | null; // path or null for uncategorized
  status?: TransactionStatus;
}

function insertTxn(spec: TxnSpec): string {
  seq += 1;
  const accountId = spec.accountId ?? cardId;
  const rawDescription = `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: spec.postedOn,
      amountCents: spec.amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: spec.category ? catId(spec.category) : null,
      status: spec.status ?? "active",
      dedupeHash: dedupeHash({
        accountId,
        postedOn: spec.postedOn,
        amountCents: spec.amountCents,
        rawDescription,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

const REF = "2026-07-15";

describe("monthKeysBack", () => {
  test("last N month keys ending at refDate's month, across a year boundary", () => {
    expect(monthKeysBack("2025-01-15", 3)).toEqual(["2024-11", "2024-12", "2025-01"]);
  });

  test("single month window is just the refDate month", () => {
    expect(monthKeysBack("2026-07-31", 1)).toEqual(["2026-07"]);
  });
});

describe("monthlySpending", () => {
  test("rolls subcategories up to their top-level with exact cents", () => {
    insertTxn({ postedOn: "2026-06-03", amountCents: -2_550, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-10", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-21", amountCents: -450, category: "Food > Coffee" });
    insertTxn({ postedOn: "2026-06-15", amountCents: -85_000, category: "Housing > Rent" });

    const cells = monthlySpending(bundle.db, { months: 3, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-06", categoryId: catId("Food"), categoryName: "Food", spentCents: 13_000, txnCount: 3 },
      { month: "2026-06", categoryId: catId("Housing"), categoryName: "Housing", spentCents: 85_000, txnCount: 1 },
    ]);
  });

  test("Uncategorized bucket appears for null-category negatives; positives excluded", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -3_000, category: null });
    insertTxn({ postedOn: "2026-07-02", amountCents: -1_500, category: null });
    insertTxn({ postedOn: "2026-07-03", amountCents: 50_000, category: null }); // review queue owns this

    const cells = monthlySpending(bundle.db, { months: 1, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-07", categoryId: null, categoryName: "Uncategorized", spentCents: 4_500, txnCount: 2 },
    ]);
  });

  test("transfer/investment/rewards kinds are never spending; the system kind is the Uncategorized bucket", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -50_000, category: "Transfers > Credit Card Payment" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -20_000, category: "Investments > Buys" });
    insertTxn({ postedOn: "2026-07-03", amountCents: 1_200, category: "Rewards > Cash Back" });
    // 🔴 this asserted the system-filed row was NOT spending. Owner decision
    // 2026-09-03: the system "Uncategorized" category IS the NULL bucket, so its
    // outflow is uncategorized spending — six of his rows were in no total.
    insertTxn({ postedOn: "2026-07-04", amountCents: -700, category: "Uncategorized" }); // system kind
    insertTxn({ postedOn: "2026-07-05", amountCents: -900, category: "Food > Dining" });

    const cells = monthlySpending(bundle.db, { months: 1, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-07", categoryId: catId("Food"), categoryName: "Food", spentCents: 900, txnCount: 1 },
      { month: "2026-07", categoryId: null, categoryName: "Uncategorized", spentCents: 700, txnCount: 1 },
    ]);
  });

  test("quarantined/excluded/superseded statuses never count", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -1_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -99_999, category: "Food > Dining", status: "quarantined" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -88_888, category: "Food > Dining", status: "excluded" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -77_777, category: "Food > Dining", status: "superseded" });

    const cells = monthlySpending(bundle.db, { months: 1, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-07", categoryId: catId("Food"), categoryName: "Food", spentCents: 1_000, txnCount: 1 },
    ]);
  });

  test("merchant refunds net against the category's spend", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -8_000, category: "Shopping > General" });
    insertTxn({ postedOn: "2026-07-09", amountCents: 3_000, category: "Shopping > General" }); // refund
    const cells = monthlySpending(bundle.db, { months: 1, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-07", categoryId: catId("Shopping"), categoryName: "Shopping", spentCents: 5_000, txnCount: 2 },
    ]);
  });

  test("the months window excludes older transactions", () => {
    insertTxn({ postedOn: "2026-04-30", amountCents: -1_000, category: "Food > Dining" }); // outside 3-mo window
    insertTxn({ postedOn: "2026-05-01", amountCents: -2_000, category: "Food > Dining" }); // first day inside
    const cells = monthlySpending(bundle.db, { months: 3, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-05", categoryId: catId("Food"), categoryName: "Food", spentCents: 2_000, txnCount: 1 },
    ]);
  });
});

describe("categoryBreakdown", () => {
  test("top-level totals with per-subcategory detail rows and txn counts", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -2_550, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -1_450, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -600, category: "Food" }); // direct-to-parent
    insertTxn({ postedOn: "2026-07-06", amountCents: -300, category: null });

    const rows = categoryBreakdown(bundle.db, { from: "2026-07-01", to: "2026-07-31" });
    expect(rows).toEqual([
      {
        categoryId: catId("Food"),
        name: "Food",
        spentCents: 14_600,
        txnCount: 4,
        ownSpentCents: 600,
        ownTxnCount: 1,
        children: [
          { categoryId: catId("Food > Groceries"), name: "Groceries", spentCents: 10_000, txnCount: 1 },
          { categoryId: catId("Food > Dining"), name: "Dining", spentCents: 4_000, txnCount: 2 },
        ],
      },
      { categoryId: null, name: "Uncategorized", spentCents: 300, txnCount: 1, ownSpentCents: 0, ownTxnCount: 0, children: [] },
    ]);
  });

  /*
   * 🔴 S20. `children` skips every row filed on the parent itself, so on
   * `/spending` the expanded rows did not add up to the parent above them.
   * Measured on the real ledger 2026-09-15, `?period=2026-07`: Travel $2,448.88
   * over Flights $2,394.89. The own figure is accumulated directly, never taken
   * as a difference — a difference would hide a child the loop failed to count.
   */
  test("the parent's own rows are carried beside the children, and the two add up to the total", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -4_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -600, category: "Food" });
    insertTxn({ postedOn: "2026-07-06", amountCents: 200, category: "Food" }); // a refund filed on Food itself

    const [food] = categoryBreakdown(bundle.db, { from: "2026-07-01", to: "2026-07-31" });
    expect(food!.ownSpentCents).toBe(400);
    expect(food!.ownTxnCount).toBe(2);
    expect(food!.children.reduce((s, c) => s + c.spentCents, 0) + food!.ownSpentCents).toBe(food!.spentCents);
  });

  test("a parent whose rows are all its own has no children and an own figure equal to its total", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -600, category: "Food" });
    const [food] = categoryBreakdown(bundle.db, { from: "2026-07-01", to: "2026-07-31" });
    expect(food).toMatchObject({ spentCents: 600, ownSpentCents: 600, ownTxnCount: 1, children: [] });
  });

  test("the Uncategorized bucket carries no own figure — its rows have no parent to sit on", () => {
    insertTxn({ postedOn: "2026-07-06", amountCents: -300, category: null });
    const [uncategorized] = categoryBreakdown(bundle.db, { from: "2026-07-01", to: "2026-07-31" });
    expect(uncategorized).toMatchObject({ categoryId: null, ownSpentCents: 0, ownTxnCount: 0, children: [] });
  });
});

describe("incomeByMonth", () => {
  test("splits by Income subcategory with exact sums; negatives and uncategorized positives excluded", () => {
    insertTxn({ accountId: checkingId, postedOn: "2026-06-04", amountCents: 128_000, category: "Income > Salary" });
    insertTxn({ accountId: checkingId, postedOn: "2026-06-11", amountCents: 128_000, category: "Income > Salary" });
    insertTxn({ accountId: checkingId, postedOn: "2026-06-30", amountCents: 412, category: "Income > Interest" });
    insertTxn({ accountId: checkingId, postedOn: "2026-07-02", amountCents: 128_000, category: "Income > Salary" });
    insertTxn({ accountId: checkingId, postedOn: "2026-06-20", amountCents: -5_000, category: "Income > Salary" }); // reversal — not income
    insertTxn({ accountId: checkingId, postedOn: "2026-06-21", amountCents: 40_000, category: null }); // review queue

    const cells = incomeByMonth(bundle.db, { months: 2, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-06", categoryId: catId("Income > Interest"), categoryName: "Interest", incomeCents: 412, txnCount: 1 },
      { month: "2026-06", categoryId: catId("Income > Salary"), categoryName: "Salary", incomeCents: 256_000, txnCount: 2 },
      { month: "2026-07", categoryId: catId("Income > Salary"), categoryName: "Salary", incomeCents: 128_000, txnCount: 1 },
    ]);
  });

  test("investment-account dividends count as income by construction", () => {
    insertTxn({ accountId: brokerageId, postedOn: "2026-07-01", amountCents: 2_150, category: "Income > Dividends" });
    const cells = incomeByMonth(bundle.db, { months: 1, refDate: REF });
    expect(cells).toEqual([
      { month: "2026-07", categoryId: catId("Income > Dividends"), categoryName: "Dividends", incomeCents: 2_150, txnCount: 1 },
    ]);
  });

  test("rewards never count as income", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 2_500, category: "Rewards > Cash Back" });
    expect(incomeByMonth(bundle.db, { months: 1, refDate: REF })).toEqual([]);
  });
});

describe("categoryTrends", () => {
  test("MoM delta and trailing 3-month average against a fixed oracle", () => {
    // Food: Apr 3000, May 6000, Jun 9000, Jul(current) 1200
    insertTxn({ postedOn: "2026-04-10", amountCents: -3_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-05-10", amountCents: -6_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-10", amountCents: -9_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -1_200, category: "Food > Coffee" });

    const trends = categoryTrends(bundle.db, { refDate: REF });
    expect(trends).toEqual([
      {
        categoryId: catId("Food"),
        categoryName: "Food",
        currentMonthCents: 1_200,
        previousMonthCents: 9_000,
        momDeltaCents: -7_800,
        trailing3moAvgCents: 6_000, // (3000+6000+9000)/3
      },
    ]);
  });

  test("trailing average rounds to the nearest cent", () => {
    // Apr 0, May 50, Jun 51 → (0+50+51)/3 = 33.67 → 34
    insertTxn({ postedOn: "2026-05-10", amountCents: -50, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-10", amountCents: -51, category: "Food > Dining" });
    const [food] = categoryTrends(bundle.db, { refDate: REF });
    expect(food?.trailing3moAvgCents).toBe(34);
    expect(food?.momDeltaCents).toBe(-51); // Jul 0 − Jun 51
  });
});

describe("exact reconciliation: every aggregate is a visitable transaction list", () => {
  test("each monthlySpending cell equals the sum and count of its sibling list", () => {
    insertTxn({ postedOn: "2026-06-03", amountCents: -2_550, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-10", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-12", amountCents: 1_000, category: "Food > Groceries" }); // refund
    insertTxn({ postedOn: "2026-07-01", amountCents: -85_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -777, category: null });
    insertTxn({ postedOn: "2026-07-02", amountCents: 999, category: null }); // excluded everywhere

    const cells = monthlySpending(bundle.db, { months: 2, refDate: REF });
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const { start: from, end: to } = periodBounds(`${cell.month}-15`, "monthly");
      const list = spendingTransactions(bundle.db, { categoryId: cell.categoryId, from, to });
      expect(list.length).toBe(cell.txnCount);
      expect(list.reduce((s, t) => s - t.amountCents, 0)).toBe(cell.spentCents);
    }
  });

  test("categorySpending equals the breakdown row for the same range", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -2_550, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -10_000, category: "Food > Groceries" });
    const range = { from: "2026-07-01", to: "2026-07-31" };
    const [foodRow] = categoryBreakdown(bundle.db, range);
    const rollup = categorySpending(bundle.db, { categoryId: catId("Food"), ...range });
    expect(rollup).toEqual({ spentCents: foodRow!.spentCents, txnCount: foodRow!.txnCount });
  });

  test("income cells reconcile to incomeTransactions", () => {
    insertTxn({ accountId: checkingId, postedOn: "2026-07-02", amountCents: 128_000, category: "Income > Salary" });
    insertTxn({ accountId: checkingId, postedOn: "2026-07-09", amountCents: 128_000, category: "Income > Salary" });
    const [cell] = incomeByMonth(bundle.db, { months: 1, refDate: REF });
    const list = incomeTransactions(bundle.db, {
      categoryId: cell!.categoryId,
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(list.length).toBe(cell!.txnCount);
    expect(list.reduce((s, t) => s + t.amountCents, 0)).toBe(cell!.incomeCents);
  });

  test("transactionsHref carries the identical filter params", () => {
    expect(transactionsHref({ categoryId: "abc", from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?category=abc&from=2026-07-01&to=2026-07-31",
    );
    // the null (Uncategorized) bucket is negatives-only in spendingTransactions,
    // so its link scopes to outflows — the drill-down reconciles to the count
    expect(transactionsHref({ categoryId: null, from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?category=uncategorized&from=2026-07-01&to=2026-07-31&flow=out",
    );
  });
});

/*
 * 🔴 Owner decision, 2026-09-03: the system "Uncategorized" category IS the
 * NULL bucket. Six rows he had filed on it ($92.72 of 2024 debits) were in NO
 * total — not expense-kind, so the headline skipped them; not NULL, so the
 * honesty bucket skipped them too. Killed by mutation: dropping the
 * normalisation at the row source, and dropping the belt in spendingBucket.
 */
describe("the system Uncategorized category is the NULL bucket", () => {
  test("a row filed on it reads as category-less, and its outflow lands in the Uncategorized bucket", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -762, category: "Uncategorized" });
    insertTxn({ postedOn: "2026-07-02", amountCents: 24, category: "Uncategorized" });
    const rows = activeTxnsInRange(bundle.db, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.categoryId)).toEqual([null, null]);
    const idx = loadCategoryIndex(bundle.db);
    expect(idx.isUncategorized(catId("Uncategorized"))).toBe(true);
    expect(idx.isUncategorized(catId("Food"))).toBe(false);
    const cells = monthlySpending(bundle.db, { months: 1, refDate: "2026-07-31" });
    expect(cells).toEqual([
      expect.objectContaining({ categoryId: null, categoryName: "Uncategorized", spentCents: 762, txnCount: 1 }),
    ]);
  });

  /*
   * 🔴 2026-09-11: THE NORMALISATION RAN ONE WAY. `activeTxnsInRange` rewrote a
   * system-filed row to null, so a query ASKING for that id matched nothing at
   * all — `/categories` listed "Uncategorized · Locked · 37 txn" and linked to
   * a page that read "$0.00 · 0 transactions" for every period the selector can
   * reach, and over November 2023 — a month holding three of those rows —
   * printed the empty state that asserts a measured zero in so many words.
   *
   * ⚠️ The two spellings are deliberately different populations: `null` is the
   * /spending honesty bucket (a spending figure, negatives only), the system id
   * is the CATEGORY, whose page prints a Net over every row it lists.
   */
  test("asking for the system id returns the whole bucket, both signs; null stays the spending bucket", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -762, category: "Uncategorized" });
    insertTxn({ postedOn: "2026-07-03", amountCents: 24, category: "Uncategorized" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -500, category: null });
    insertTxn({ postedOn: "2026-07-05", amountCents: -300, category: "Food" });
    const systemId = catId("Uncategorized");
    const range = { from: "2026-07-01", to: "2026-07-31" };

    // the CATEGORY — the count the /categories row prints, and the net its page
    // prints over the rows it lists: -(-762 + 24 - 500)
    expect(categorySpending(bundle.db, { categoryId: systemId, ...range })).toEqual({
      spentCents: 1_238,
      txnCount: 3,
    });
    // the /spending BUCKET — a spending figure, so the credit stays out
    expect(categorySpending(bundle.db, { categoryId: null, ...range })).toEqual({
      spentCents: 1_262,
      txnCount: 2,
    });
    // and no Food row leaked into either
    expect(
      spendingTransactions(bundle.db, { categoryId: systemId, ...range }).map((t) => t.amountCents).sort((a, b) => a - b),
    ).toEqual([-762, -500, 24].sort((a, b) => a - b));
  });

  /*
   * The drill-down contract: a link carrying the raw system id filters by that
   * id alone, and every such row has been normalised away — so it opened the
   * hand-filed rows under a count of the whole bucket. One spelling now.
   */
  test("hrefCategoryId spells the system category as the bucket, and leaves every other id alone", () => {
    expect(hrefCategoryId(bundle.db, catId("Uncategorized"))).toBeNull();
    expect(hrefCategoryId(bundle.db, null)).toBeNull();
    expect(hrefCategoryId(bundle.db, catId("Food"))).toBe(catId("Food"));
    expect(ledgerHref({ category: hrefCategoryId(bundle.db, catId("Uncategorized")) })).toBe(
      "/transactions?category=uncategorized",
    );
  });

  test("spendingBucket gives the same answer to a caller handing in its own rows", () => {
    const idx = loadCategoryIndex(bundle.db);
    const row = {
      id: "x",
      accountId: cardId,
      postedOn: "2026-07-02",
      rawDescription: "",
      merchantId: null,
      categoryId: catId("Uncategorized"),
      recurringSeriesId: null,
      splitId: null,
    };
    expect(spendingBucket(idx, { ...row, amountCents: -100 })).toEqual({ categoryId: null, categoryName: "Uncategorized" });
    // an uncategorized credit belongs to the review queue, not to spending
    expect(spendingBucket(idx, { ...row, amountCents: 100 })).toBeNull();
  });
});

