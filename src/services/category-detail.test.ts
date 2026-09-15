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
  categoryFlowSign,
  categoryMonthlyTrend,
  categorySubcategorySplit,
  seriesInCategory,
} from "./category-detail";
import { topMerchants } from "./spending";
import { categorySpending } from "./analytics";

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

    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 2, TODAY, "2026-07-06", "2026-06-05", TODAY);
    expect(trend.map((t) => [t.month, t.spentCents])).toEqual([
      ["2026-06", 3_000],
      ["2026-07", 6_500],
    ]);
    expect(trend[1]!.href).toBe(`/transactions?category=${catId("Food")}&from=2026-07-01&to=2026-07-31`);
  });

  test("a month the ledger has not reached is flagged, and one it stopped inside is not", () => {
    /*
     * 🔴 The bar read "Sep 2026: $0.00, 0 transactions" of a month nobody had
     * imported. `ledgerReaches` says it in its own docstring: days after it are
     * days nobody looked at, not days on which nothing happened.
     */
    insertTxn({ postedOn: "2026-06-05", amountCents: -3_000, category: "Food > Dining" });

    // the ledger stops on 2026-07-06 — July HAS been walked into, August has not
    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 3, "2026-08-20", "2026-07-06", "2026-06-05", "2026-08-20");
    expect(trend.map((t) => [t.month, t.unreached])).toEqual([
      ["2026-06", null],
      ["2026-07", null],
      ["2026-08", "after-records"],
    ]);
  });

  /**
   * 🔴 THE OTHER END. Anchored on the page's own period, the window can reach
   * back past the ledger's first day, and those months are exactly as unread as
   * the ones after its last. `?period=2022-09` drew ten "$0.00, 0 transactions"
   * bars over months that predate every import.
   */
  test("a month that ends before the ledger opens is flagged, and one it opens inside is not", () => {
    insertTxn({ postedOn: "2026-06-05", amountCents: -3_000, category: "Food > Dining" });

    // the ledger opens 2026-06-05 — May predates it, June is opened inside
    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 3, "2026-07-06", "2026-07-06", "2026-06-05", TODAY);
    expect(trend.map((t) => [t.month, t.unreached])).toEqual([
      ["2026-05", "before-records"],
      ["2026-06", null],
      ["2026-07", null],
    ]);
  });

  /**
   * 🔴 THE TWO ENDS WERE ONE BOOLEAN, so the bar could not tell them apart:
   * "Apr 2022: not imported yet" of a month before the records begin, on
   * `/categories/<Groceries>?period=2023-03` (owner's ledger, 2026-09-15). The
   * kind is asked through `unreachedKind` — the rule /spending's heatmap and
   * cash-flow table already use — rather than a third inline copy of it.
   */
  test("the two ends are told apart, each by its own cause", () => {
    insertTxn({ postedOn: "2026-06-05", amountCents: -3_000, category: "Food > Dining" });

    // a ledger that opens 2026-06-05 and stops 2026-06-20: May before it, July and August after
    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 4, "2026-08-20", "2026-06-20", "2026-06-05", "2026-08-20");
    expect(trend.map((t) => [t.month, t.unreached])).toEqual([
      ["2026-05", "before-records"],
      ["2026-06", null],
      ["2026-07", "after-records"],
      ["2026-08", "after-records"],
    ]);
  });

  /** ⛔ future is asked first, as every other caller of `unreachedKind` asks it */
  test("a month that has not started is future, not unimported", () => {
    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 2, "2026-08-20", "2026-07-06", "2026-06-05", TODAY);
    expect(trend.map((t) => [t.month, t.unreached])).toEqual([
      ["2026-07", null],
      ["2026-08", "future"],
    ]);
  });

  test("an empty ledger has reached no month at all", () => {
    const trend = categoryMonthlyTrend(bundle.db, catId("Food"), 2, TODAY, null, null, TODAY);
    expect(trend.map((t) => t.unreached)).toEqual(["no-ledger", "no-ledger"]);
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

  /*
   * 🔴 The card listed children only, under a headline counting the whole
   * subtree, so a category's own rows appeared nowhere and the rows did not sum
   * to the figure above them. Measured 2026-09-10 on `/categories/<Travel>` for
   * July: Flights $2,394.89 plus two rows filed directly on Travel ($38.99 and
   * $15.00) = $2,448.88, the headline — and the $53.99 was in no row.
   */
  test("rows filed on the PARENT itself get a row, so the list sums to the headline", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-06", amountCents: -3_899, category: "Food" });
    insertTxn({ postedOn: "2026-07-07", amountCents: -1_500, category: "Food" });

    const split = categorySubcategorySplit(bundle.db, catId("Food"), JULY);
    expect(split.map((s) => [s.name, s.flowCents])).toEqual([
      ["On Food itself", 5_399],
      ["Dining", 5_000],
    ]);
    expect(split.reduce((t, s) => t + s.flowCents, 0)).toBe(
      categorySpending(bundle.db, { categoryId: catId("Food"), from: JULY.from, to: JULY.to }).spentCents,
    );
  });

  test("the parent's own row counts its rows and carries no drill-down", () => {
    // `/transactions?category=` filters by SUBTREE, so a link here would list
    // every child's rows too
    insertTxn({ postedOn: "2026-07-05", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-06", amountCents: -3_899, category: "Food" });

    const own = categorySubcategorySplit(bundle.db, catId("Food"), JULY).find((s) =>
      s.name.startsWith("On "),
    )!;
    expect(own.txnCount).toBe(1);
    expect(own.href).toBeNull();
    expect(own.categoryId).toBe(catId("Food"));
  });

  test("a parent with no rows of its own gets no extra row", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -5_000, category: "Food > Dining" });
    expect(categorySubcategorySplit(bundle.db, catId("Food"), JULY).map((s) => s.name)).toEqual([
      "Dining",
    ]);
  });

  test("an income parent's own rows are money IN, like its children", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-02", amountCents: 2_500, category: "Income", accountId: checkingId });
    const split = categorySubcategorySplit(bundle.db, catId("Income"), JULY);
    expect(split.map((s) => [s.name, s.flowCents])).toEqual([
      ["Salary", 500_000],
      ["On Income itself", 2_500],
    ]);
  });

  /*
   * 🔴 The rows flipped back to money-in for `income` ONLY, so the transfer,
   * investment and rewards pages ranked and SIGNED their children in the frame
   * opposite to the headline directly above them — and `Math.abs` in the page
   * hid it. Measured 2026-09-11 on the real ledger,
   * `/categories/<Investments>?period=2026-07`: header "Net · July 2026
   * -$3,090.00", its one row "Buys  $3,090.00", and that child's own page
   * "-$3,090.00" — the same 66 transactions, two signs, one click apart.
   */
  test("a non-expense parent's children sit in the HEADER's frame, so they sum to it", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -300_000, category: "Investments > Buys", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-03", amountCents: 120_000, category: "Investments > Sells", accountId: checkingId });
    const split = categorySubcategorySplit(bundle.db, catId("Investments"), JULY);
    expect(split.map((s) => [s.name, s.flowCents])).toEqual([
      ["Sells", 120_000],
      ["Buys", -300_000],
    ]);
    // the invariant the card exists to keep: its rows add up to the header
    const header =
      categoryFlowSign("investment") *
      categorySpending(bundle.db, { categoryId: catId("Investments"), from: JULY.from, to: JULY.to }).spentCents;
    expect(split.reduce((total, row) => total + row.flowCents, 0)).toBe(header);
    expect(header).toBe(-180_000);
  });

  /*
   * The live Rewards instance: both children are money IN, and the card ranked
   * them by the money-OUT frame — so all time it printed "Statement Credits
   * $190.00" ABOVE "Cash Back $490.68", inverting the ranking its 57 expense
   * siblings follow.
   */
  test("a rewards parent ranks its children by money IN, largest contributor first", () => {
    insertTxn({ postedOn: "2026-07-04", amountCents: 19_000, category: "Rewards > Statement Credits", accountId: cardId });
    insertTxn({ postedOn: "2026-07-05", amountCents: 49_068, category: "Rewards > Cash Back", accountId: cardId });
    expect(categorySubcategorySplit(bundle.db, catId("Rewards"), JULY).map((s) => [s.name, s.flowCents])).toEqual([
      ["Cash Back", 49_068],
      ["Statement Credits", 19_000],
    ]);
  });

  test("categoryFlowSign: only an expense category is printed money-out", () => {
    expect(categoryFlowSign("expense")).toBe(1);
    for (const kind of ["income", "transfer", "investment", "rewards", "system"] as const) {
      expect(categoryFlowSign(kind)).toBe(-1);
    }
  });
});

describe("seriesInCategory", () => {
  test("returns series whose linked txns fall in the subtree, linking to /recurring/[id]", () => {
    const seriesId = bundle.db
      .insert(recurringSeries)
      // the owner set the amount; the stored average is what the detector measured
      .values({ name: "Spotify", kind: "subscription", cadence: "monthly", amountCentsAvg: -1_099, userAmountCents: -1_299, nextExpectedAmountCents: -1_099, status: "confirmed", nextExpectedOn: "2026-08-01", lastMatchedOn: "2026-07-01" })
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
    // 🔴 the EFFECTIVE amount, user override first — /categories/<Car> printed the
    // lease's registration seed ($559.89) after the ledger had corrected it to $695.04
    expect(rows[0]!.amountCents).toBe(-1_299);
    expect(rows[0]!.evidence).toBe("active");
  });

  test("empty when no linked series", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -1_099, category: "Subscriptions > Streaming" });
    expect(seriesInCategory(bundle.db, catId("Subscriptions"), TODAY)).toEqual([]);
  });

  /*
   * 🔴 `/categories/<Housing>` on 2026-09-08: "Budget · grading Sep 1 – Sep 30 ·
   * $0.00 of $2,291.21 · $2,291.21 left" over "Flamingo South Beach (rent)
   * monthly · next Oct 1 · $2,109.00" and "Rent utilities & fees monthly · next
   * Oct 1 · $182.21". Both came due Sep 1 and neither posted — $2,291.21, the
   * budget to the cent — so the page read as a September with nothing due while
   * the whole month's budget was already spoken for. `nextExpectedOn` walks
   * forward by construction; the backward half is `overdueForSeries`, and
   * /recurring's Next column has printed it since 2026-09-04.
   */
  test("a bill that came due this month and never posted says so, beside its next date", () => {
    // TODAY is 2026-07-08. The June charge posted; July's came due on the 1st
    // and nothing covers it.
    const rent = bundle.db
      .insert(recurringSeries)
      .values({ name: "Rent", kind: "bill", cadence: "monthly", amountCentsAvg: -180_000, nextExpectedAmountCents: -180_000, status: "confirmed", nextExpectedOn: "2026-07-01", anchorDay: 1, lastMatchedOn: "2026-06-01" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-06-01", amountCents: -180_000, category: "Housing > Rent", seriesId: rent });

    const rows = seriesInCategory(bundle.db, catId("Housing"), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.overdue).toEqual({ date: "2026-07-01", occurrenceCount: 1 });
    // the next date STAYS — August's charge is still coming
    expect(rows[0]!.nextExpectedOn).toBe("2026-08-01");
  });

  test("a bill whose charge arrived is not overdue", () => {
    const rent = bundle.db
      .insert(recurringSeries)
      .values({ name: "Rent", kind: "bill", cadence: "monthly", amountCentsAvg: -180_000, nextExpectedAmountCents: -180_000, status: "confirmed", nextExpectedOn: "2026-07-01", anchorDay: 1, lastMatchedOn: "2026-07-01" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-07-01", amountCents: -180_000, category: "Housing > Rent", seriesId: rent });

    expect(seriesInCategory(bundle.db, catId("Housing"), TODAY)[0]!.overdue).toBeNull();
  });

  /*
   * 🔴 THE MEASURED CASE. /categories/<Food> listed five series under a heading
   * reading "Recurring series" on 2026-09-04 — Nabila Inc, CC Vending, Fordham
   * Sambazon, PURA VIDA BAY ROAD MIAMI BEACH, YA-FIT Smoothie Bar — every one
   * of them DISMISSED, and every one labelled "lapsed". Dismissed is the owner
   * saying a pattern is not recurring, and it is the detector's re-detection
   * sink, so those rows exist only because he rejected them.
   */
  test("a dismissed series is not a recurring series in this category", () => {
    const dead = bundle.db
      .insert(recurringSeries)
      .values({ name: "YA-FIT Smoothie Bar", kind: "bill", cadence: "weekly", amountCentsAvg: -1_539, status: "dismissed", lastMatchedOn: "2026-07-25" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-07-25", amountCents: -1_539, category: "Subscriptions > Streaming", seriesId: dead });

    expect(seriesInCategory(bundle.db, catId("Subscriptions"), TODAY)).toEqual([]);
  });

  /* An ENDED series really did bill here and stopped — history this category
     owns — so it stays, described by its status rather than by its evidence,
     and without a "next" date the app is not projecting. */
  test("an ended series stays, and says it ended", () => {
    const over = bundle.db
      .insert(recurringSeries)
      .values({ name: "Netflix", kind: "subscription", cadence: "monthly", amountCentsAvg: -1_599, nextExpectedAmountCents: -1_599, status: "ended", nextExpectedOn: "2026-03-01", lastMatchedOn: "2026-02-01" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-02-01", amountCents: -1_599, category: "Subscriptions > Streaming", seriesId: over });

    const rows = seriesInCategory(bundle.db, catId("Subscriptions"), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("ended");
  });
});

describe("categoryBudgetRef", () => {
  test("returns the active budget targeting this category", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -6_000, category: "Food > Dining" });
    bundle.db.insert(budgets).values({ categoryId: catId("Food"), period: "monthly", amountCents: 40_000, startsOn: "2026-01-01" }).run();

    const ref = categoryBudgetRef(bundle.db, catId("Food"), TODAY);
    expect(ref).toMatchObject({ amountCents: 40_000, spentCents: 6_000, remainingCents: 34_000, period: "monthly", alert: "none", href: "/budgets" });
  });

  /*
   * 🔴 The card names no window, and the page it sits on has a period selector.
   * On 2026-09-04 `/categories/<Housing>?period=2026-07` read
   *
   *     Spent · July 2026            $2,653.58   7 transactions
   *     Budget · monthly budget for this category   $0.00 of $2,291.21
   *
   * — one screen answering "how much of Housing went out?" twice, with
   * $2,653.58 and $0.00, because the budget is always graded at today. The
   * figure is right for September; the sentence was the defect. `/budgets`'
   * own detail card already prints "Grading Sep 1 – Sep 30" for the same
   * reason.
   */
  test("carries the window it graded, because the page it sits on can be showing another", () => {
    bundle.db.insert(budgets).values({ categoryId: catId("Food"), period: "monthly", amountCents: 40_000, startsOn: "2026-01-01" }).run();
    const ref = categoryBudgetRef(bundle.db, catId("Food"), TODAY);
    expect(ref!.bounds).toEqual({ start: "2026-07-01", end: "2026-07-31" });
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
