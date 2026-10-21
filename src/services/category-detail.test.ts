import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { budgets } from "@/db/schema/budgets";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { budgetCoverageSentence } from "@/lib/budget-coverage";
import { budgetVerdict } from "@/lib/budget-verdict";
import { periodBounds } from "@/lib/dates";
import { formatDayLong } from "@/lib/format-date";
import { dedupeHash } from "@/lib/hash";
import { CategoryBudgetCard } from "@/components/categories/CategoryBudgetCard";
import { createAccount } from "./accounts";
import { budgetPaceStatuses, categoryReachContext, categoryReachFor, createBudget, setBudgetRollover } from "./budgets";
import { createCashWallet } from "./cash-wallets";
import { checkedThrough } from "./checked-days-fixture";
import { addManualTransaction } from "./manual-transactions";
import { ledgerOpens } from "./observation-frontier";
import { provenanceFor } from "./provenance";
import {
  categoryBudgetRef,
  categoryDetailHeader,
  categoryFlowSign,
  categoryMonthlyTrend,
  categorySubcategorySplit,
  seriesInCategory,
} from "./category-detail";
import { categoryEmptyCopy, topMerchants } from "./spending";
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
    // the June charge is the Card's newest row, so no statement has reached Jul 1 — the note's quiet reading
    expect(rows[0]!.overdue).toEqual({
      date: "2026-07-01",
      occurrenceCount: 1,
      owedCents: 180_000,
      unreadCents: 180_000,
      inGraceCents: 0,
    });
    // the next date STAYS — August's charge is still coming
    expect(rows[0]!.nextExpectedOn).toBe("2026-08-01");
  });

  // 🔴 "Oct 1 — not posted" under `/categories/<Housing>` of a day no import had reached (his ledger, 2026-10-08)
  test("a bill due on a day its account has been imported past is read", () => {
    const rent = bundle.db
      .insert(recurringSeries)
      .values({ name: "Rent", kind: "bill", cadence: "monthly", amountCentsAvg: -180_000, nextExpectedAmountCents: -180_000, status: "confirmed", nextExpectedOn: "2026-07-01", anchorDay: 1, lastMatchedOn: "2026-06-01" })
      .returning({ id: recurringSeries.id })
      .get().id;
    insertTxn({ postedOn: "2026-06-01", amountCents: -180_000, category: "Housing > Rent", seriesId: rent });
    insertTxn({ postedOn: "2026-07-06", amountCents: -900, category: "Food" });
    // …and its balances checked through it: the day its chip measures to, which the ✕ reads (his decision 62)
    checkedThrough(bundle.db, cardId, "2026-07-06");

    expect(seriesInCategory(bundle.db, catId("Housing"), TODAY)[0]!.overdue).toMatchObject({ owedCents: 180_000, unreadCents: 0 });
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

/**
 * ⚖️ OWNER DECISION 2026-10-07 (§6A 49): `/categories/[id]` names the CATEGORY'S OWN imported-through day — the rule
 * its `/budgets` row uses (`categoryCoverage`) — not the ledger-wide one. Measured on his ledger that day: the Car row
 * read "spending imported through Aug 12 · 7 days of this period unaccounted" (Chase Checking stops Aug 12) while
 * `/categories/<Car>` one click away read "…the ledger is imported through Thu, Sep 24, 2026."
 *
 * The fixture is that ledger's shape: Transport (his Car) is spent from a checking account that stops Aug 12, a card
 * imported through Sep 24, and a cash wallet; Fees only from the checking account.
 */
describe("⚖️ §6A 49 — a category page asks its own imported-through day", () => {
  const OCT_7 = "2026-10-07";

  function carLedger(): { walletId: string } {
    insertTxn({ postedOn: "2026-07-15", amountCents: -69_504, category: "Transport", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-03", amountCents: -1_200, category: "Fees", accountId: checkingId });
    insertTxn({ postedOn: "2026-08-05", amountCents: -1_200, category: "Fees", accountId: checkingId });
    insertTxn({ postedOn: "2026-08-12", amountCents: -4_000, category: "Shopping", accountId: checkingId });
    insertTxn({ postedOn: "2026-09-11", amountCents: -35_758, category: "Transport", accountId: cardId });
    insertTxn({ postedOn: "2026-09-24", amountCents: -2_000, category: "Shopping", accountId: cardId });
    const walletId = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-01", openingBalanceCents: 600_000 });
    addManualTransaction(bundle.db, {
      accountId: walletId,
      postedOn: "2026-08-11",
      amountCents: -500_000,
      description: "CAR DOWN PAYMENT",
      categoryId: catId("Transport"),
    });
    return { walletId };
  }

  /** the page's one builder, asked as the page asks it */
  function emptyCopy(categoryPath: string, from: string, to: string, label: string) {
    return categoryEmptyCopy(bundle.db, catId(categoryPath), { from, to }, {
      today: OCT_7,
      label,
      ledgerOpens: ledgerOpens(bundle.db),
      formatDay: formatDayLong,
    });
  }

  /** the agent's own cash account, paired with its brokerage book — what makes its money the agent's */
  function agentsAccount(): string {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking" });
    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    return agentic;
  }

  const AGENTS_LEFT_OUT = /The agent's own account paid or was paid money in this period, and none of it is counted here/;

  test("a dormant subcategory asks its nearest ancestor before the ledger, and names the day as the ancestor's", () => {
    carLedger();
    // Interest Charges has no rows at all; its parent Fees is spent from the checking account, imported through Aug 12
    const reach = categoryReachFor(bundle.db, catId("Fees > Interest Charges"), "2026-10-01", OCT_7);
    expect(reach).toMatchObject({ whose: "category", through: "2026-08-12", owner: { name: "Fees" } });
    expect(emptyCopy("Fees > Interest Charges", "2026-10-01", "2026-10-31", "October 2026").description).toMatch(
      /^Nothing has been imported for 7 days of it; spending in Fees is imported through Wed, Aug 12, 2026\. /,
    );
    // a top-level category with no account of its own and no ancestor keeps the ledger's day, in the ledger's words
    expect(categoryReachFor(bundle.db, catId("Travel"), "2026-10-01", OCT_7)).toMatchObject({ whose: "ledger", through: "2026-09-24" });
    expect(emptyCopy("Travel", "2026-10-01", "2026-10-31", "October 2026").description).toMatch(
      /; the ledger is imported through Thu, Sep 24, 2026\. /,
    );
    // …and a subcategory whose parent has no day either
    expect(categoryReachFor(bundle.db, catId("Travel > Hotels"), "2026-10-01", OCT_7)).toMatchObject({ whose: "ledger", through: "2026-09-24" });
  });

  test("⚖️ the agent's money is said where the category's own day leaves the window unread, and on cash only", () => {
    const { walletId } = carLedger();
    const agentic = agentsAccount();
    // the agent's fee, Sep 10 — past Fees' own Aug 12, inside the window
    insertTxn({ postedOn: "2026-09-10", amountCents: -500, category: "Fees", accountId: agentic });
    const fees = emptyCopy("Fees", "2026-09-01", "2026-09-20", "Sep 1 – 20, 2026");
    expect(fees.title).toBe("Sep 1 – 20, 2026 has not been imported yet");
    expect(fees.description).toMatch(AGENTS_LEFT_OUT);

    addManualTransaction(bundle.db, {
      accountId: walletId,
      postedOn: "2026-08-20",
      amountCents: -2_500,
      description: "FLOWERS",
      categoryId: catId("Gifts & Donations"),
    });
    insertTxn({ postedOn: "2026-10-02", amountCents: -1_000, category: "Gifts & Donations", accountId: agentic });
    const gifts = emptyCopy("Gifts & Donations", "2026-10-01", "2026-10-31", "October 2026");
    expect(gifts.title).toBe("Nothing recorded for October 2026");
    expect(gifts.description).toMatch(AGENTS_LEFT_OUT);
  });

  test("the day is the budget row's own: one function, the same day for the same category and period", () => {
    carLedger();
    createBudget(bundle.db, { categoryId: catId("Transport"), period: "monthly", amountCents: 150_000, startsOn: "2026-10-01" });
    const row = budgetPaceStatuses(bundle.db, OCT_7).find((s) => s.categoryName === "Transport")!;
    const reach = categoryReachFor(bundle.db, catId("Transport"), "2026-10-01", OCT_7);
    expect(row.importedThroughOn).toBe("2026-08-12");
    expect(reach).toMatchObject({ whose: "category", through: row.importedThroughOn });
    expect(reach.coverage).toEqual({
      importedThroughOn: row.importedThroughOn,
      spentFromSince: row.spentFromSince,
      spentFromAccounts: row.spentFromAccounts,
      spentFromWallets: row.spentFromWallets,
    });
  });

  test("Car in October: the page names Aug 12, its own day, as the ledger's Sep 24 would not", () => {
    carLedger();
    const copy = emptyCopy("Transport", "2026-10-01", "2026-10-31", "October 2026");
    expect(copy.title).toBe("October 2026 has not been imported yet");
    expect(copy.description).toMatch(
      /^Nothing has been imported for 7 days of it; spending in Transport is imported through Wed, Aug 12, 2026\. /,
    );
  });

  test("a window inside the ledger but past the category's day is not a measured zero", () => {
    carLedger();
    // Fees is spent only from the checking account: Sep 1 – 20 is imported for the ledger, not for Fees
    const copy = emptyCopy("Fees", "2026-09-01", "2026-09-20", "Sep 1 – 20, 2026");
    expect(copy.title).toBe("Sep 1 – 20, 2026 has not been imported yet");
    expect(copy.description).toMatch(
      /^Nothing has been imported for 20 days of it; spending in Fees is imported through Wed, Aug 12, 2026\./,
    );
  });

  test("the trend's empty month says what that month's own page says; a month holding rows keeps its figure", () => {
    carLedger();
    const ctx = categoryReachContext(bundle.db);
    const opens = ledgerOpens(bundle.db);
    const fees = categoryMonthlyTrend(bundle.db, catId("Fees"), 4, OCT_7, ctx.ledgerReaches, opens, OCT_7, ctx);
    expect(fees.map((t) => [t.month, t.unreached])).toEqual([
      ["2026-07", null],
      ["2026-08", null],
      // the ledger reaches Sep 24, Fees' one account Aug 12 — "Sep 2026: $0.00, 0 transactions" would be a zero nobody measured
      ["2026-09", "after-records"],
      ["2026-10", "after-records"],
    ]);
    const car = categoryMonthlyTrend(bundle.db, catId("Transport"), 4, OCT_7, ctx.ledgerReaches, opens, OCT_7, ctx);
    // September is past Car's Aug 12 too, but it holds the card's Sep 11 row: a figure, never a dash over real rows
    expect(car.map((t) => [t.month, t.unreached, t.txnCount])).toEqual([
      ["2026-07", null, 1],
      ["2026-08", null, 1],
      ["2026-09", null, 1],
      ["2026-10", "after-records", 0],
    ]);
  });

  test("the headline's proof grades an empty total against the same day as the sentence under it", () => {
    carLedger();
    const was = process.env.MONEYAPP_FAKE_TODAY;
    process.env.MONEYAPP_FAKE_TODAY = OCT_7;
    try {
      const fees = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: catId("Fees"), from: "2026-09-01", to: "2026-09-20" })!;
      // the ledger's Sep 24 would call this "zero rather than unproven" two lines above "has not been imported yet"
      expect(fees.headline).toMatch(/^Nothing has been imported for 20 days between /);
      expect(fees.headline).toMatch(/a window nobody has looked at rather than a measurement/);
      // a window inside the category's own day is still a measured zero
      const july = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: catId("Fees"), from: "2026-07-10", to: "2026-07-31" })!;
      expect(july.headline).toMatch(/^No rows in Fees between /);
    } finally {
      if (was === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
      else process.env.MONEYAPP_FAKE_TODAY = was;
    }
  });

  test("⚖️ a cash-only category's page says so in its budget row's words", () => {
    const { walletId } = carLedger();
    addManualTransaction(bundle.db, {
      accountId: walletId,
      postedOn: "2026-08-20",
      amountCents: -2_500,
      description: "FLOWERS",
      categoryId: catId("Gifts & Donations"),
    });
    const reach = categoryReachFor(bundle.db, catId("Gifts & Donations"), "2026-10-01", OCT_7);
    expect(reach).toMatchObject({ whose: "cash-only", through: OCT_7 });
    const copy = emptyCopy("Gifts & Donations", "2026-10-01", "2026-10-31", "October 2026");
    expect(`${copy.title}. ${copy.description}`).toBe(
      "Nothing recorded for October 2026. Gifts & Donations is spent only from a cash wallet since Apr 1 — no statement will ever cover it. " +
        "Nothing was typed in for this period, so there is no import to wait for.",
    );
    // a wallet holds what was typed into it, so its nothing is read: the headline keeps its $0.00
    expect(copy.figure).toBe("zero");
  });

  /*
   * 🔴 THE HEADLINE PRINTED $0.00 OVER ITS OWN "NOT IMPORTED YET". Read on his ledger copy 2026-10-12:
   * `/categories/<Housing>?period=2026-10` headlined "SPENT · OCTOBER 2026  $0.00  0 transactions" directly above
   * "October 2026 has not been imported yet … spending in Housing is imported through Wed, Aug 12, 2026". The world the
   * headline is drawn in is the one the sentence under it is written in — one read of the category's own day, carried
   * out of the same builder (`figure`), never a second derivation on the page.
   */
  test("the headline's figure is asked in the sentence's own world: a dash wherever no elapsed day was read", () => {
    carLedger();
    const figureOf = (categoryPath: string, from: string, to: string, label: string) => {
      // only an EMPTY window has an empty state; a window holding rows prints its figure
      expect(categorySpending(bundle.db, { categoryId: catId(categoryPath), from, to }).txnCount).toBe(0);
      const copy = emptyCopy(categoryPath, from, to, label);
      return [copy.figure, copy.title];
    };
    // past the category's own Aug 12 — the ledger reaches Sep 24, the day that would have called these read
    expect(figureOf("Transport", "2026-10-01", "2026-10-31", "October 2026")).toEqual(["dash", "October 2026 has not been imported yet"]);
    expect(figureOf("Fees", "2026-09-01", "2026-09-20", "Sep 1 – 20, 2026")).toEqual(["dash", "Sep 1 – 20, 2026 has not been imported yet"]);
    // before the ledger's first row (Jul 3)
    expect(figureOf("Transport", "2026-06-01", "2026-06-30", "June 2026")).toEqual(["dash", "June 2026 is before your records begin"]);
    // a month that has not begun has no elapsed day to have read
    expect(figureOf("Transport", "2026-11-01", "2026-11-30", "November 2026")).toEqual(["dash", "November 2026 has not happened yet"]);
    // an income category asks the same rule — no account of its own, so the ledger's Sep 24, and October is past it
    expect(figureOf("Income > Salary", "2026-10-01", "2026-10-31", "October 2026")).toEqual(["dash", "October 2026 has not been imported yet"]);
    // every elapsed day read (Fees through Aug 12), nothing posted: a measured $0.00
    expect(figureOf("Fees", "2026-07-10", "2026-07-31", "Jul 10 – 31, 2026")[0]).toBe("zero");
    // Aug 6–12 read, Aug 13–20 not: the empty state calls it a lower bound, and so does the figure
    const partly = emptyCopy("Fees", "2026-08-06", "2026-08-20", "Aug 6 – 20, 2026");
    expect(partly.figure).toBe("lower-bound");
    expect(partly.description).toMatch(/so this is a lower bound rather than a measurement\./);
    expect(partly.zeroIs).toBe("a lower bound rather than a measurement");
  });

  /*
   * ⚖️ …and a NET window read in part is neither (decision 72's `partReadTotal`): a sum of both signs, so the days still
   * to import can move it either way — said once, by the builder the sentence and the headline over it both read
   * (`zeroIs`), in the words its proof uses. 🔴 Review of b356d57, his ledger copy 2026-10-21: 7 empty Net windows of
   * 2026 called their $0.00 "a lower bound" in all three places — Buys for September (1,917 negative rows to 80
   * positive, read through Sep 9) and Loans for August among them, whose unread days push them below $0.00.
   */
  test("an empty Net window read in part is neither a measurement nor a bound, in its sentence and headline", () => {
    carLedger();
    // Internal Transfer moves money on the checking account, imported through Aug 12
    const transfer = "Transfers > Internal Transfer";
    insertTxn({ postedOn: "2026-07-20", amountCents: -50_000, category: transfer, accountId: checkingId });
    const neither = "neither a measurement nor a bound: the days still to import can move it either way";
    const partly = emptyCopy(transfer, "2026-08-06", "2026-08-20", "Aug 6 – 20, 2026");
    expect(partly.figure).toBe("lower-bound");
    expect(partly.zeroIs).toBe(neither);
    expect(partly.description).toBe(
      `8 days of it have not been imported — activity in Internal Transfer is imported through Wed, Aug 12, 2026, so this ` +
        `is ${neither}.`,
    );
    // the same window's proof says the same of its zero
    const proof = provenanceFor(bundle.db, {
      kind: "categorySpend",
      categoryId: catId(transfer),
      from: "2026-08-06",
      to: "2026-08-20",
    })!;
    expect(proof.headline).toMatch(new RegExp(`, so this zero is ${neither}\\.$`));
  });

  test("an empty ledger has looked at nothing: a dash", () => {
    // no carLedger(): not one row anywhere
    const copy = emptyCopy("Transport", "2026-10-01", "2026-10-31", "October 2026");
    expect([copy.figure, copy.title]).toEqual(["dash", "Nothing imported yet"]);
    // ⚖️ …while a month that has not begun holds nothing yet: its dash says so, never "not imported"
    const november = emptyCopy("Transport", "2026-11-01", "2026-11-30", "November 2026");
    expect([november.figure, november.title]).toEqual(["dash", "November 2026 has not happened yet"]);
    expect(november.description).not.toMatch(/import/i);
  });

  /*
   * 🔴 THE BUDGET CARD GRADED A MONTH NOBODY HAD IMPORTED, IN GREEN. On his ledger copy 2026-10-12
   * `/categories/<Housing>` headlined "— October 2026 has not been imported yet" and, one card below, "monthly budget ·
   * grading Oct 1 – Oct 31 · $0.00 of $2,291.21 · $2,291.21 left" in `text-positive` — while the same row on /budgets
   * read "Awaiting statements" over "spending imported through Aug 12 · 12 days of this period unaccounted". All 12 of
   * his budgets read the same way. ⛔ The card carries its /budgets row's verdict (`budgetVerdict`) and sentence
   * (`budgetCoverageSentence`), read off the one pace status /budgets builds for that row — never a second rule.
   */
  test("the budget card reads its /budgets row's verdict and coverage sentence, from that row's own pace status", () => {
    const { walletId } = carLedger();
    addManualTransaction(bundle.db, {
      accountId: walletId,
      postedOn: "2026-08-20",
      amountCents: -2_500,
      description: "FLOWERS",
      categoryId: catId("Gifts & Donations"),
    });
    createBudget(bundle.db, { categoryId: catId("Transport"), period: "monthly", amountCents: 30_000, startsOn: "2026-01-01" });
    createBudget(bundle.db, { categoryId: catId("Fees"), period: "monthly", amountCents: 10_000, startsOn: "2026-01-01" });
    createBudget(bundle.db, { categoryId: catId("Gifts & Donations"), period: "monthly", amountCents: 10_000, startsOn: "2026-01-01" });

    const both = (categoryPath: string, refDate: string) => {
      const row = budgetPaceStatuses(bundle.db, refDate).find((s) => s.budget.categoryId === catId(categoryPath))!;
      const ref = categoryBudgetRef(bundle.db, catId(categoryPath), refDate)!;
      const verdict = budgetVerdict(row);
      // one rule: the card's reading IS the row's, word for word
      expect(ref.verdict, `${categoryPath} @ ${refDate}`).toEqual(verdict);
      expect(ref.coverageSentence, `${categoryPath} @ ${refDate}`).toBe(verdict.withheld ? budgetCoverageSentence(row) : null);
      // …and its colour is the row's pace, the one /budgets' headline wears (never `alert`'s 80% line)
      expect(ref.pace, `${categoryPath} @ ${refDate}`).toBe(row.pace);
      return ref;
    };

    // Car in October: an unimported month — withheld, in the row's words, not "$300.00 left" in green; and ⚖️ not one
    // day of it read, so no Spent and no Left at all (§6A 64)
    expect(both("Transport", OCT_7)).toMatchObject({
      spentCents: 0,
      verdict: { headline: "Awaiting statements", withheld: true, unread: true },
      coverageSentence: "spending imported through Aug 12 · 7 days of this period unaccounted",
    });
    // ⚖️ a category spent only from a cash wallet offers no reading, and says why (owner decision 2026-09-15)
    expect(both("Gifts & Donations", OCT_7)).toMatchObject({
      verdict: { headline: "Cash only", withheld: true, unread: false },
      coverageSentence: "spent only from a cash wallet since Apr 1 — no statement will ever cover it",
    });
    // past the line on partial data is a fact more data cannot undo: graded, not withheld
    expect(both("Transport", "2026-09-30")).toMatchObject({
      alert: "over",
      verdict: { headline: "Over budget by 19%", withheld: false },
      coverageSentence: null,
    });
    // every elapsed day read (Fees through Aug 12, graded Aug 1 – 10): a measurement, and no coverage sentence
    expect(both("Fees", "2026-08-10")).toMatchObject({
      spentCents: 1_200,
      verdict: { headline: "On track · 12% used", withheld: false },
      coverageSentence: null,
    });
  });

  /*
   * 🔴 NO TEST HAD A PARTLY READ WINDOW REACH THE CARD (review of e37997b): its component tests hand it a coverage
   * sentence typed by hand, so a wrong day count would have printed unseen. Fees on Aug 20: its account read through
   * Aug 12, so 8 of the window's 20 elapsed days are not — the card says the row's 8, and ⚖️ decision 72's line under
   * the headline over it, the proof of the same window's total, says the same 8 in the same words.
   */
  test("a month read in part: the card counts the days the headline over it counts, in the same words", () => {
    vi.stubEnv("MONEYAPP_FAKE_TODAY", "2026-08-20");
    try {
      carLedger();
      createBudget(bundle.db, { categoryId: catId("Fees"), period: "monthly", amountCents: 10_000, startsOn: "2026-01-01" });
      const ref = categoryBudgetRef(bundle.db, catId("Fees"), "2026-08-20")!;
      const card = renderToStaticMarkup(createElement(CategoryBudgetCard, { budget: ref }))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const line = "spending imported through Aug 12 · 8 days of this period unaccounted";
      expect(card).toBe(
        `Budget Awaiting statements monthly budget · grading Aug 1 – Aug 31 ${line} $12.00 of $100.00 $88.00 left Budgets →`,
      );
      const total = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: catId("Fees"), from: "2026-08-01", to: "2026-08-31" })!;
      expect(total.partlyRead).toEqual({ uncoveredDays: 8, line });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /*
   * ⚡ The page has already read the category's day — the frontier, the wallets, the accounts awaiting statements, the
   * ledger's two ends (`categoryReachContext`, `ledgerOpens`) — for its headline and its trend. 🔴 The card asked every
   * one of them again, twice: once for the carry and once for the row (review of e37997b, "+23 ms per category page").
   * It reads the page's: handed a frontier that reads every account through Oct 31, October is a measurement.
   */
  test("the card reads the day the page hands it, never a second read of its own", () => {
    carLedger();
    const id = createBudget(bundle.db, { categoryId: catId("Transport"), period: "monthly", amountCents: 100_000, startsOn: "2026-01-01" });
    setBudgetRollover(bundle.db, id, { enabled: true });
    const page = { ...categoryReachContext(bundle.db), opens: ledgerOpens(bundle.db) };
    // what the page read, handed in: the same card as reading it again
    expect(categoryBudgetRef(bundle.db, catId("Transport"), OCT_7, page)).toEqual(categoryBudgetRef(bundle.db, catId("Transport"), OCT_7));
    expect(categoryBudgetRef(bundle.db, catId("Transport"), OCT_7)!.verdict.withheld).toBe(true);

    const readThroughOct31 = {
      ...page,
      frontier: { byAccount: new Map([...page.frontier.byAccount.keys()].map((account) => [account, "2026-10-31"])) },
    };
    const ref = categoryBudgetRef(bundle.db, catId("Transport"), OCT_7, readThroughOct31)!;
    expect(ref.verdict.withheld).toBe(false);
    expect(ref.coverageSentence).toBeNull();
    // …and September, read whole by that day, banks into the carry: the carry was asked the page's day too
    expect(ref.rolloverCents).toBeGreaterThan(0);
  });

  /*
   * 🔴 THE CARD AND THE HEADLINE OVER IT NAMED TWO DAYS FOR ONE WINDOW. A category with no account of its own asks its
   * nearest ancestor, then the ledger, on its page (`categoryReachFor`); its budget row asked no day at all and counted
   * every elapsed day. On a copy of his ledger copy 2026-10-12, a monthly budget made on Travel › Hotels (3 rows ever,
   * none since March) at 2026-09-02: the headline a measured $0.00 ("This window sits inside what has been imported"),
   * the card under it "Awaiting statements · nothing imported for this category since Mar 1 · 2 days of this period
   * unaccounted"; Utilities › Mobile the same. And once the ancestor's day moves inside the window, the headline counts
   * N days where the card kept counting all of them. ⛔ The row asks the page's day — `categoryReachFor`, never a copy.
   */
  test("a budget on a category with no account of its own counts what its page counts, against the page's day", () => {
    carLedger();
    createBudget(bundle.db, { categoryId: catId("Fees > Interest Charges"), period: "monthly", amountCents: 5_000, startsOn: "2026-01-01" });
    createBudget(bundle.db, { categoryId: catId("Travel"), period: "monthly", amountCents: 20_000, startsOn: "2026-01-01" });

    /** the page's headline world and its budget card, asked as `/categories/<id>` asks them on `refDate` */
    const onePage = (categoryPath: string, refDate: string, label: string) => {
      const { start, end } = periodBounds(refDate, "monthly");
      const copy = categoryEmptyCopy(bundle.db, catId(categoryPath), { from: start, to: end }, {
        today: refDate,
        label,
        ledgerOpens: ledgerOpens(bundle.db),
        formatDay: formatDayLong,
      });
      const row = budgetPaceStatuses(bundle.db, refDate).find((s) => s.budget.categoryId === catId(categoryPath))!;
      const ref = categoryBudgetRef(bundle.db, catId(categoryPath), refDate)!;
      // one rule: the card is its /budgets row, word for word
      expect(ref.verdict).toEqual(budgetVerdict(row));
      expect(ref.coverageSentence).toBe(ref.verdict.withheld ? budgetCoverageSentence(row) : null);
      // ⚖️ §6A 64 — and over a window holding no rows, the card prints a dash exactly where the headline over it does
      expect(row.txnCount).toBe(0);
      expect(ref.verdict.unread, `${categoryPath} @ ${refDate}`).toBe(copy.figure === "dash");
      return {
        figure: copy.figure,
        description: copy.description,
        uncoveredDays: row.uncoveredDays,
        verdict: ref.verdict.headline,
        sentence: ref.coverageSentence,
      };
    };

    // Aug 1 – 10, every day read on Fees' Aug 12: the page's measured $0.00 is the card's measurement too
    expect(onePage("Fees > Interest Charges", "2026-08-10", "August 2026")).toMatchObject({
      figure: "zero",
      uncoveredDays: 0,
      verdict: "On track · 0% used",
      sentence: null,
    });
    // Aug 1 – 20, read through Fees' Aug 12: the page's lower bound counts 8 days, and so does the card
    const august = onePage("Fees > Interest Charges", "2026-08-20", "August 2026");
    expect(august.figure).toBe("lower-bound");
    expect(august.description).toMatch(/^8 days of it have not been imported — spending in Fees is imported through Wed, Aug 12, 2026, /);
    expect(august).toMatchObject({
      uncoveredDays: 8,
      verdict: "Awaiting statements",
      sentence: "nothing imported for this category since Feb 1 · spending in Fees imported through Aug 12 · 8 days of this period unaccounted",
    });
    // October, past Fees' Aug 12: the dash and the withheld card name one day and one count
    const october = onePage("Fees > Interest Charges", OCT_7, "October 2026");
    expect(october.figure).toBe("dash");
    expect(october.description).toMatch(/^Nothing has been imported for 7 days of it; spending in Fees is imported through Wed, Aug 12, 2026\. /);
    expect(october).toMatchObject({
      uncoveredDays: 7,
      verdict: "Awaiting statements",
      sentence: "nothing imported for this category since Apr 1 · spending in Fees imported through Aug 12 · 7 days of this period unaccounted",
    });

    // a top-level category with no ancestor to ask: the ledger's Sep 24 on the page, so on the card
    expect(onePage("Travel", "2026-09-20", "September 2026")).toMatchObject({
      figure: "zero",
      uncoveredDays: 0,
      verdict: "On track · 0% used",
      sentence: null,
    });
    const travel = onePage("Travel", OCT_7, "October 2026");
    expect(travel.description).toMatch(/^Nothing has been imported for 7 days of it; the ledger is imported through Thu, Sep 24, 2026\. /);
    expect(travel).toMatchObject({
      figure: "dash",
      uncoveredDays: 7,
      sentence: "nothing imported for this category since Apr 1 · the ledger imported through Sep 24 · 7 days of this period unaccounted",
    });
  });
});
