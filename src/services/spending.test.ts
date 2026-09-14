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
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { parseFilters } from "@/components/transactions/query";
import { dedupeHash } from "@/lib/hash";
import { resolvePeriod } from "@/lib/period";
import { createAccount } from "./accounts";
import { setSplits } from "./transaction-splits";
import { countMatching } from "./transactions-query";
import {
  cashFlowByPeriod,
  cashFlowSegmentHref,
  dailySpendHeatmap,
  dayLedgerHref,
  honestyBuckets,
  largestTransactions,
  ledgerFirstDay,
  periodComparison,
  periodTotals,
  spendingProjection,
  topMerchants,
} from "./spending";

const TODAY = "2026-07-08";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-spending-"));
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

function makeMerchant(name: string): string {
  return bundle.db.insert(merchants).values({ canonicalName: name }).returning({ id: merchants.id }).get().id;
}

let seq = 0;
interface TxnSpec {
  accountId?: string;
  postedOn: string;
  amountCents: number;
  category?: string | null;
  status?: TransactionStatus;
  merchantId?: string | null;
  normalized?: string;
}

function insertTxn(spec: TxnSpec): string {
  seq += 1;
  const accountId = spec.accountId ?? cardId;
  const raw = spec.normalized ?? `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: spec.postedOn,
      amountCents: spec.amountCents,
      rawDescription: raw,
      normalizedDescription: spec.normalized ?? raw,
      categoryId: spec.category ? catId(spec.category) : null,
      merchantId: spec.merchantId ?? null,
      status: spec.status ?? "active",
      dedupeHash: dedupeHash({ accountId, postedOn: spec.postedOn, amountCents: spec.amountCents, rawDescription: raw, occurrenceIndex: seq }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

const JULY = resolvePeriod({ period: "2026-07" }, TODAY);

describe("periodTotals", () => {
  test("earned / GROSS spent / refunds / net / savings, with exclusions", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-12", amountCents: 2_000, category: "Food > Dining" }); // refund — NOT netted into spent
    insertTxn({ postedOn: "2026-07-15", amountCents: -3_000, category: null }); // uncategorized spend
    insertTxn({ postedOn: "2026-07-16", amountCents: 9_999, category: null }); // uncat credit — review queue, excluded
    insertTxn({ postedOn: "2026-07-05", amountCents: -50_000, category: "Transfers > Internal Transfer" }); // excluded

    expect(periodTotals(bundle.db, JULY)).toEqual({
      earnedCents: 500_000,
      spentCents: 5_000 + 10_000 + 3_000, // 18_000 GROSS debits — the +2_000 refund does NOT reduce it
      refundsCents: 2_000,
      netCents: 500_000 + 2_000 - 18_000, // 484_000 — a refund is money in, so net is unchanged
      savingsRatePct: Math.round(((500_000 + 2_000 - 18_000) / 500_000) * 1000) / 10, // 96.8
    });
  });

  test("a big expense-category credit never drags Spent negative (gross floor)", () => {
    // the real "FORDHAM UNIVERSI INVOICE" shape: a large inflow miscategorized as expense
    insertTxn({ postedOn: "2026-07-03", amountCents: -4_000, category: "Food > Dining" }); // small real spend
    insertTxn({ postedOn: "2026-07-10", amountCents: 1_600_000, category: "Food > Groceries" }); // huge credit in an expense cat

    const t = periodTotals(bundle.db, JULY);
    expect(t.spentCents).toBe(4_000); // gross outflow only — never negative
    expect(t.refundsCents).toBe(1_600_000);
    expect(t.netCents).toBe(1_596_000); // 0 earned + 1_600_000 refund − 4_000 spent
  });

  test("no income → null savings rate", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    expect(periodTotals(bundle.db, JULY).savingsRatePct).toBeNull();
  });
});

describe("cashFlowByPeriod", () => {
  test("a month yields 31 day-buckets, mirrored series, and a net line", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-15", amountCents: -3_000, category: null });

    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    expect(cf.buckets).toHaveLength(31);
    expect(cf.incomeSeries.map((s) => s.label)).toEqual(["Salary"]);
    expect(cf.spendingSeries.map((s) => s.label)).toEqual(["Food", "Uncategorized"]);

    const jul1 = cf.buckets.find((b) => b.key === "2026-07-01")!;
    expect(jul1.incomeCents).toBe(500_000);
    expect(jul1.netCents).toBe(500_000);
    const jul3 = cf.buckets.find((b) => b.key === "2026-07-03")!;
    const foodKey = cf.spendingSeries.find((s) => s.label === "Food")!.key;
    expect(jul3.spending[foodKey]).toBe(5_000);
    expect(jul3.netCents).toBe(-5_000);
    const jul15 = cf.buckets.find((b) => b.key === "2026-07-15")!;
    expect(jul15.spending.__uncat).toBe(3_000);

    // reconciles with periodTotals
    expect(cf.totals).toEqual(periodTotals(bundle.db, JULY));
  });

  test("pace projects spend-to-date over the elapsed fraction for the current period", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" }); // before today
    insertTxn({ postedOn: "2026-07-20", amountCents: -9_000, category: "Food > Dining" }); // after today

    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    expect(cf.pace).not.toBeNull();
    expect(cf.pace!.actualToDateCents).toBe(5_000); // only the 07-03 row
    expect(cf.pace!.elapsedFraction).toBeCloseTo(8 / 31, 6);
    expect(cf.pace!.projectedCents).toBe(Math.round(5_000 / (8 / 31))); // 19_375
  });

  /**
   * 🔴 THE DAY THE NUMERATOR AND THE DENOMINATOR HAVE TO AGREE ABOUT.
   *
   * `elapsedFraction` is 8/31 on the 8th — today IS an elapsed day. So spending
   * posted today has to be inside `actualToDateCents`, or the tile divides a
   * seven-day total by an eight-day fraction and under-projects the month.
   *
   * Nothing tested it: `TODAY` is 2026-07-08 and no fixture row in this file is
   * dated the 8th, so `<= 0` → `< 0` on that bound survived the whole suite.
   * The same blindness dropped the whole of today's spending from the tile the
   * dashboard leads with.
   */
  test("spending posted TODAY is inside the pace, because today is inside the elapsed days", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-08", amountCents: -2_000, category: "Food > Dining" }); // today
    insertTxn({ postedOn: "2026-07-09", amountCents: -9_000, category: "Food > Dining" }); // tomorrow

    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    expect(cf.pace!.elapsedFraction).toBeCloseTo(8 / 31, 6);
    expect(cf.pace!.actualToDateCents).toBe(7_000);
    expect(cf.pace!.projectedCents).toBe(Math.round(7_000 / (8 / 31)));
  });

  test("past period has no pace", () => {
    const june = resolvePeriod({ period: "2026-06" }, TODAY);
    insertTxn({ postedOn: "2026-06-03", amountCents: -5_000, category: "Food > Dining" });
    expect(cashFlowByPeriod(bundle.db, june, TODAY).pace).toBeNull();
  });

  test("a year buckets into 12 months", () => {
    insertTxn({ postedOn: "2026-02-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-11-10", amountCents: -8_000, category: "Housing > Rent" });
    const cf = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026" }, TODAY), TODAY);
    expect(cf.buckets).toHaveLength(12);
    expect(cf.buckets.find((b) => b.key === "2026-02")!.spendingCents).toBe(5_000);
    expect(cf.buckets.find((b) => b.key === "2026-11")!.spendingCents).toBe(8_000);
  });

  test("beyond the top-7 spending categories fold into Other", () => {
    const cats = ["Food > Dining", "Housing > Rent", "Transport > Gas", "Travel > Flights", "Shopping > General", "Health > Medical", "Utilities > Internet", "Subscriptions > Streaming"];
    cats.forEach((c, i) => insertTxn({ postedOn: `2026-07-0${(i % 9) + 1}`, amountCents: -(1000 * (cats.length - i)), category: c }));
    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    expect(cf.spendingSeries).toHaveLength(8); // top 7 + Other
    expect(cf.spendingSeries.at(-1)!.key).toBe("__other");
  });
});

/**
 * 🔴 S11 — A ZERO-FILLED BUCKET THE LEDGER HAS NOT REACHED, AT EITHER END.
 *
 * `cashFlowByPeriod` built a zero shell for every bucket and said nothing about
 * whether anyone had read its days. The table lens printed each one. Measured on
 * the owner's ledger 2026-09-14 (first active row 2022-08-25, newest 2026-09-12):
 *
 *   - `?period=2026-09&cash=table`: rows 13–30 "$0.00 $0.00 $0.00" — two days
 *     nobody has imported and sixteen that have not happened;
 *   - `?period=2022-08&cash=table`: rows 1–24 the same, before the records begin;
 *   - `?period=2026&cash=table`: Oct, Nov and Dec, months that have not begun.
 *
 * ⛔ The FIGURES stay zero — `computePace`, the dashboard's pace tile and the
 * graph's running totals all read them. Coverage is said beside them.
 *
 * ⚠️ Every fixture above posts a row on July 1 or later and none before, so
 * without the rows chosen here the opening end could not be expressed: the
 * oldest row sits INSIDE the period, the newest BEFORE today, and an empty
 * covered day lies between them.
 */
describe("cashFlowByPeriod — which buckets the ledger has reached", () => {
  test("a day before the first row, a covered empty day, an unimported day and a future day are four worlds", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" }); // the ledger opens
    insertTxn({ postedOn: "2026-07-05", amountCents: -2_000, category: "Food > Groceries" }); // …and stops

    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const unreached = Object.fromEntries(cf.buckets.map((b) => [b.key.slice(8), b.unreached]));
    expect(unreached["01"]).toBe("before-records");
    expect(unreached["02"]).toBe("before-records");
    expect(unreached["03"]).toBeNull(); // the opening day is a measurement
    expect(unreached["04"]).toBeNull(); // a covered day with nothing in it…
    expect(cf.buckets[3]!.spendingCents).toBe(0); // …is a real zero
    expect(unreached["05"]).toBeNull();
    expect(unreached["06"]).toBe("after-records");
    expect(unreached["08"]).toBe("after-records"); // today is not the future
    expect(unreached["09"]).toBe("future");
    expect(unreached["31"]).toBe("future");
    expect(cf.buckets.filter((b) => b.unreached === null)).toHaveLength(3);
  });

  test("the figures behind an unreached bucket stay zero, so the pace does not move", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -2_000, category: "Food > Groceries" });

    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const jul1 = cf.buckets[0]!;
    expect([jul1.incomeCents, jul1.spendingCents, jul1.refundsCents, jul1.netCents]).toEqual([0, 0, 0, 0]);
    expect(cf.pace!.actualToDateCents).toBe(7_000);
    expect(cf.totals).toEqual(periodTotals(bundle.db, JULY));
  });

  /* ⛔ data wins: a posted row after today is drawn, totalled and floored into the
     projection above, so its bucket is a figure and not "has not happened yet" */
  test("a bucket holding a posted row is a figure, even after today", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-20", amountCents: -9_000, category: "Food > Dining" }); // after today

    const cf = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const byDay = new Map(cf.buckets.map((b) => [b.key, b]));
    expect(byDay.get("2026-07-20")!.unreached).toBeNull();
    expect(byDay.get("2026-07-20")!.spendingCents).toBe(9_000);
    // the newest row is Jul 20 now, so Jul 6–8 have been walked through
    expect(byDay.get("2026-07-07")!.unreached).toBeNull();
    expect(byDay.get("2026-07-19")!.unreached).toBe("future");
    expect(byDay.get("2026-07-21")!.unreached).toBe("future");
  });

  test("a year's months: before the records, a month the ledger opens inside, and months not begun", () => {
    insertTxn({ postedOn: "2026-02-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -8_000, category: "Housing > Rent" });

    const cf = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026" }, TODAY), TODAY);
    expect(cf.buckets.map((b) => [b.key, b.unreached])).toEqual([
      ["2026-01", "before-records"],
      ["2026-02", null], // opens on the 3rd: looked at from then on, a figure
      ["2026-03", null], // covered and empty — a measured zero
      ["2026-04", null],
      ["2026-05", null],
      ["2026-06", null],
      ["2026-07", null], // stops on the 5th, three days before today: still a figure
      ["2026-08", "future"],
      ["2026-09", "future"],
      ["2026-10", "future"],
      ["2026-11", "future"],
      ["2026-12", "future"],
    ]);
  });
});

describe("cashFlowSegmentHref", () => {
  test("category, Uncategorized, and Other drill to their exact windows", () => {
    expect(cashFlowSegmentHref("cat-abc", "cat-abc", { from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?category=cat-abc&from=2026-07-01&to=2026-07-31",
    );
    expect(cashFlowSegmentHref("__uncat", null, { from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?category=uncategorized&from=2026-07-01&to=2026-07-31&flow=out",
    );
    expect(cashFlowSegmentHref("__other", null, { from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?from=2026-07-01&to=2026-07-31",
    );
  });

  test("income segments drill positive-only (flow=in) to match the positive-only bar", () => {
    expect(cashFlowSegmentHref("cat-salary", "cat-salary", { from: "2026-07-01", to: "2026-07-31" }, "in")).toBe(
      "/transactions?category=cat-salary&from=2026-07-01&to=2026-07-31&flow=in",
    );
  });

  /**
   * 🔴 …AND SPENDING SEGMENTS DRILL NEGATIVE-ONLY, for the identical reason.
   * The bars are GROSS spending — debits only — so a drill with no direction
   * opens the category's credits too. The Uncategorized branch above has always
   * said so in its own comment ("negatives-only → drill to outflows so it
   * reconciles"); the named categories passed no flow at all. Measured on the
   * real ledger 2026-09-11: **47 of 2,415 drawn segments** opened rows the bar
   * never drew — `?period=2023-03`'s Shopping bar is $339.88 over a list
   * carrying $312.46 of credits.
   */
  test("spending segments drill negative-only (flow=out) to match the gross bar", () => {
    expect(cashFlowSegmentHref("cat-shop", "cat-shop", { from: "2026-07-01", to: "2026-07-31" }, "out")).toBe(
      "/transactions?category=cat-shop&from=2026-07-01&to=2026-07-31&flow=out",
    );
    // …the same shape the Uncategorized bucket already had
    expect(cashFlowSegmentHref("__uncat", null, { from: "2026-07-01", to: "2026-07-31" })).toContain("flow=out");
  });
});

describe("dailySpendHeatmap", () => {
  test("per-day outflow + income, with the tint denominator", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -2_000, category: "Food > Coffee" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -12_000, category: "Housing > Rent" });

    const heat = dailySpendHeatmap(bundle.db, "2026-07");
    expect(heat.maxOutflowCents).toBe(12_000);
    expect(heat.days.find((d) => d.iso === "2026-07-03")).toMatchObject({
      iso: "2026-07-03",
      spentCents: 7_000,
      incomeCents: 0,
    });
    expect(heat.days.find((d) => d.iso === "2026-07-01")).toMatchObject({
      iso: "2026-07-01",
      spentCents: 0,
      incomeCents: 500_000,
    });
  });

  test("each day carries its spending count and top categories, biggest first", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -2_000, category: "Food > Coffee" }); // same top-level: Food
    insertTxn({ postedOn: "2026-07-03", amountCents: -9_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-07-03", amountCents: 400_000, category: "Income > Salary", accountId: checkingId });

    const day = dailySpendHeatmap(bundle.db, "2026-07").days.find((d) => d.iso === "2026-07-03")!;
    // the income row is not a spending row: it moves incomeCents, not the count
    expect(day.txnCount).toBe(3);
    expect(day.incomeCents).toBe(400_000);
    // categories roll up to their TOP level (Dining + Coffee → Food), biggest first
    expect(day.topCategories).toEqual([
      { name: "Housing", cents: 9_000 },
      { name: "Food", cents: 7_000 },
    ]);
  });

  test("top categories are capped at three, so a busy day stays readable", () => {
    insertTxn({ postedOn: "2026-07-04", amountCents: -1_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -2_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -3_000, category: "Transport > Gas" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -4_000, category: "Shopping > General" });

    const day = dailySpendHeatmap(bundle.db, "2026-07").days.find((d) => d.iso === "2026-07-04")!;
    expect(day.topCategories.map((c) => c.name)).toEqual(["Shopping", "Transport", "Housing"]);
  });

  test("top merchants name the linked merchant, and fall back to the description when unlinked", () => {
    const dunkin = makeMerchant("Dunkin'");
    insertTxn({ postedOn: "2026-07-05", amountCents: -500, category: "Food > Coffee", merchantId: dunkin, normalized: "DUNKIN Q35" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -700, category: "Food > Coffee", merchantId: dunkin, normalized: "DUNKIN Q35" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -3_000, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });

    const day = dailySpendHeatmap(bundle.db, "2026-07").days.find((d) => d.iso === "2026-07-05")!;
    expect(day.topMerchants).toEqual([
      { name: "NEW BEST GOURMET DELI", cents: 3_000 },
      { name: "Dunkin'", cents: 1_200 }, // both linked rows group under one name
    ]);
  });

  test("a SPLIT purchase is one transaction, not one per part (it reconciles with the ledger it links to)", () => {
    const txnId = insertTxn({ postedOn: "2026-07-07", amountCents: -20_000, category: "Shopping > General" });
    setSplits(bundle.db, txnId, [
      { categoryId: catId("Food > Groceries"), amountCents: -15_000 },
      { categoryId: catId("Housing > Home Supplies"), amountCents: -5_000 },
    ]);

    const day = dailySpendHeatmap(bundle.db, "2026-07").days.find((d) => d.iso === "2026-07-07")!;
    // the bank recorded ONE purchase; the day sheet links to a ledger that lists one row
    expect(day.txnCount).toBe(1);
    // ...while the money still splits across both destinations
    expect(day.spentCents).toBe(20_000);
    expect(day.topCategories).toEqual([
      { name: "Food", cents: 15_000 },
      { name: "Housing", cents: 5_000 },
    ]);
  });

  test("an unlinked merchant is grouped and named the way the Top merchants card names it", () => {
    // the same payee, with a per-swipe store number — the stripped key collapses them
    insertTxn({ postedOn: "2026-07-08", amountCents: -1_000, category: "Food > Coffee", normalized: "STARBUCKS STORE 47213 NEW YORK NY" });
    insertTxn({ postedOn: "2026-07-08", amountCents: -1_500, category: "Food > Coffee", normalized: "STARBUCKS STORE 88104 NEW YORK NY" });

    const day = dailySpendHeatmap(bundle.db, "2026-07").days.find((d) => d.iso === "2026-07-08")!;
    // one entry, not two fragments — and the humanized label, not the raw bank string
    expect(day.topMerchants).toHaveLength(1);
    expect(day.topMerchants[0]!.cents).toBe(2_500);
    expect(day.topMerchants[0]!.name).not.toContain("47213");
  });

  test("a refund is not a spending row — it neither counts nor names a category", () => {
    insertTxn({ postedOn: "2026-07-06", amountCents: 2_500, category: "Food > Dining" }); // refund only
    const heat = dailySpendHeatmap(bundle.db, "2026-07");
    const day = heat.days.find((d) => d.iso === "2026-07-06");
    // the day has no outflow and no income, so it carries no heat at all
    expect(day === undefined || (day.txnCount === 0 && day.topCategories.length === 0)).toBe(true);
  });

  test("the month's biggest INFLOW is reported too, so spent and earned can share one bar scale", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: 300_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-09", amountCents: 120_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-09", amountCents: -4_000, category: "Food > Dining" });

    const heat = dailySpendHeatmap(bundle.db, "2026-07");
    expect(heat.maxInflowCents).toBe(300_000);
    expect(heat.maxOutflowCents).toBe(4_000);
    // a day can carry both sides at once
    expect(heat.days.find((d) => d.iso === "2026-07-09")).toMatchObject({
      spentCents: 4_000,
      incomeCents: 120_000,
    });
  });

  test("a month with no income at all reports a zero inflow max (no divide-by-zero for the bar)", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    expect(dailySpendHeatmap(bundle.db, "2026-07").maxInflowCents).toBe(0);
  });

  test("dayLedgerHref is from===to", () => {
    expect(dayLedgerHref("2026-07-04")).toBe("/transactions?from=2026-07-04&to=2026-07-04");
  });
});

describe("topMerchants", () => {
  test("groups by merchant and by stripped key, with coverage and drill hrefs", () => {
    const dunkin = makeMerchant("Dunkin'");
    insertTxn({ postedOn: "2026-07-02", amountCents: -500, category: "Food > Coffee", merchantId: dunkin, normalized: "DUNKIN Q35" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -500, category: "Food > Coffee", merchantId: dunkin, normalized: "DUNKIN Q35" });
    insertTxn({ postedOn: "2026-07-06", amountCents: -500, category: "Food > Coffee", merchantId: dunkin, normalized: "DUNKIN Q35" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -800, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -800, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });

    const top = topMerchants(bundle.db, JULY);
    expect(top.coveragePct).toBe(60); // 3 of 5 linked
    expect(top.linkedCount).toBe(3);
    expect(top.unlinkedCount).toBe(2);
    expect(top.entries[0]).toMatchObject({ kind: "unlinked", name: "NEW BEST GOURMET DELI", spentCents: 1_600, txnCount: 2 });
    expect(top.entries[0]!.href).toContain("key=NEW+BEST+GOURMET+DELI");
    expect(top.entries[1]).toMatchObject({ kind: "merchant", id: dunkin, name: "Dunkin'", spentCents: 1_500, txnCount: 3 });
    expect(top.entries[1]!.href).toBe(
      `/transactions?category=spending&merchant=${dunkin}&from=2026-07-01&to=2026-07-31`,
    );
  });

  /*
   * 🔴 THE LINK DROPPED THE SCOPE THE FIGURE WAS COMPUTED UNDER. These numbers
   * come from `spendingRowsInRange` — spending rows only, and on a category
   * page only that category's subtree — while the href carried the merchant and
   * the window alone. Measured 2026-09-11 across /spending and every category
   * page for ten months: 34 of 497 rows disagreed with the list their own link
   * opens. `/spending?period=2026-05` said "Zelle · 1 transaction · $1,495.00"
   * and opened 23 rows; the scoped link opens 1.
   */
  test("the drill carries the SPENDING scope, so a merchant's transfers stay out of it", () => {
    const zelle = makeMerchant("Zelle");
    insertTxn({ postedOn: "2026-07-02", amountCents: -149_500, category: "Housing > Rent", merchantId: zelle });
    insertTxn({ postedOn: "2026-07-03", amountCents: -50_000, category: "Transfers > Internal Transfer", merchantId: zelle });
    insertTxn({ postedOn: "2026-07-04", amountCents: 20_000, category: "Transfers > Credit Card Payment", merchantId: zelle });

    const row = topMerchants(bundle.db, JULY).entries.find((e) => e.id === zelle)!;
    // the figure already excludes the transfers …
    expect(row).toMatchObject({ spentCents: 149_500, txnCount: 1 });
    // … and now so does the link
    expect(row.href).toContain("category=spending");
    expect(row.href).toBe(`/transactions?category=spending&merchant=${zelle}&from=2026-07-01&to=2026-07-31`);
  });

  test("on a category page the drill carries THAT category, not the whole spending set", () => {
    const shop = makeMerchant("Vape N Smoke Shop");
    insertTxn({ postedOn: "2026-07-02", amountCents: -11_370, category: "Food > Coffee", merchantId: shop });
    insertTxn({ postedOn: "2026-07-03", amountCents: -22_198, category: "Shopping > General", merchantId: shop });

    const food = catId("Food");
    const row = topMerchants(bundle.db, JULY, 8, { categoryId: food }).entries.find((e) => e.id === shop)!;
    expect(row).toMatchObject({ spentCents: 11_370, txnCount: 1 });
    expect(row.href).toBe(
      `/transactions?category=${food}&merchant=${shop}&from=2026-07-01&to=2026-07-31`,
    );
  });

  test("a row filed on the system Uncategorized category is spending here too", () => {
    // 🔴 owner decision 2026-09-03: the system category IS the NULL bucket. These
    // rows come straight from the table, not through activeTxnsInRange, so the
    // allocation guard has to know the rule itself. Killed by mutation: a
    // NULL-only guard drops the row and the merchant vanishes from the list.
    const m = makeMerchant("Conrad Hotel");
    insertTxn({ postedOn: "2026-07-02", amountCents: -762, category: "Uncategorized", merchantId: m });
    insertTxn({ postedOn: "2026-07-03", amountCents: 24, category: "Uncategorized", merchantId: m }); // a credit is not spending
    const top = topMerchants(bundle.db, JULY);
    expect(top.entries.find((e) => e.kind === "merchant" && e.id === m)).toMatchObject({ spentCents: 762, txnCount: 1 });
  });

  test("refunds net within a merchant group", () => {
    const m = makeMerchant("Zeta Test Emporium");
    insertTxn({ postedOn: "2026-07-02", amountCents: -10_000, category: "Shopping > General", merchantId: m });
    insertTxn({ postedOn: "2026-07-09", amountCents: 3_000, category: "Shopping > General", merchantId: m }); // refund
    expect(topMerchants(bundle.db, JULY).entries[0]!.spentCents).toBe(7_000);
  });
});

/**
 * The drill-down contract: a displayed number is a visitable list. An unlinked
 * group is defined by its stripped KEY, and two literal links failed it in
 * turn: the derived name occurs in no row (an empty ledger), and the longest
 * literal run that does occur also matches every neighbour containing it (an
 * over-full one). The link now carries the key itself. These follow the
 * generated href through the REAL ledger filter layer.
 */
describe("topMerchants unlinked drill-downs", () => {
  /** rows the ledger actually shows for a generated href */
  function rowsBehind(href: string): number {
    const params = Object.fromEntries(new URL(href, "http://localhost").searchParams);
    const filters = parseFilters(params);
    return countMatching(bundle.db, filters, filters.view);
  }

  test("a group whose display name never occurs in a row still lands on its rows", () => {
    // the embedded date is stripped out of the key, so the derived name
    // ("AMAZON MKTPLACE PMTS") is contiguous in NEITHER row
    insertTxn({ postedOn: "2026-07-02", amountCents: -4_000, category: "Shopping > General", normalized: "AMAZON MKTPLACE 07/02 PMTS" });
    insertTxn({ postedOn: "2026-07-19", amountCents: -6_000, category: "Shopping > General", normalized: "AMAZON MKTPLACE 07/19 PMTS" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry).toMatchObject({ kind: "unlinked", name: "AMAZON MKTPLACE PMTS", txnCount: 2 });
    // the name itself would have searched for text no row contains
    expect(rowsBehind(`/transactions?q=${encodeURIComponent(entry.name)}&from=2026-07-01&to=2026-07-31`)).toBe(0);
    expect(rowsBehind(entry.href)).toBe(2);
  });

  test("a brokerage ticker group links by its identity, not by the humanized label", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -25_000, category: null, normalized: "RECURRING INVESTMENT CUSIP: 81762P102 07/02 (KO)" });
    insertTxn({ postedOn: "2026-07-16", amountCents: -25_000, category: null, normalized: "RECURRING INVESTMENT CUSIP: 81762P102 07/16 (KO)" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry.name).toBe("KO recurring buys"); // synthetic label — no row says this
    expect(rowsBehind(`/transactions?q=${encodeURIComponent(entry.name)}&from=2026-07-01&to=2026-07-31`)).toBe(0);
    expect(rowsBehind(entry.href)).toBe(2);
  });

  test("a group whose name extends a neighbour's opens only its own rows, and so does the neighbour", () => {
    // 🔴 the real ledger's Fees 2023: the longest run in every MADRID row is
    // "FOREIGN EXCH RT ADJ FEE" (the date splits the rest off), and that run
    // is also inside the IBERIA row — so "2 transactions" opened 3
    insertTxn({ postedOn: "2026-07-03", amountCents: -120, category: "Shopping > General", normalized: "FOREIGN EXCH RT ADJ FEE 07/02 MADRID CARD 7782" });
    insertTxn({ postedOn: "2026-07-09", amountCents: -80, category: "Shopping > General", normalized: "FOREIGN EXCH RT ADJ FEE 07/08 MADRID CARD 7782" });
    insertTxn({ postedOn: "2026-07-11", amountCents: -95, category: "Shopping > General", normalized: "FOREIGN EXCH RT ADJ FEE IBERIA 07/10 MADRID CARD 7782" });

    const entries = topMerchants(bundle.db, JULY).entries;
    expect(entries.map((e) => [e.name, e.txnCount])).toEqual([
      ["FOREIGN EXCH RT ADJ FEE MADRID CARD 7782", 2],
      ["FOREIGN EXCH RT ADJ FEE IBERIA MADRID CARD 7782", 1],
    ]);
    for (const e of entries) expect(rowsBehind(e.href)).toBe(e.txnCount);
  });

  test("noise between every identity token still lands, carrying the whole identity", () => {
    // VENMO / CASHOUT / REF are each separated by stripped noise, so no literal
    // run longer than one token occurs in the row
    insertTxn({ postedOn: "2026-07-05", amountCents: -3_000, category: null, normalized: "VENMO 07/05 CASHOUT 12.34 REF" });
    // a neighbour that CONTAINS "VENMO" — a one-token literal took it in too
    insertTxn({ postedOn: "2026-07-06", amountCents: -1_000, category: null, normalized: "VENMO PAYMENT" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry.name).toBe("VENMO CASHOUT REF");
    // the SPENDING scope rides along: these groups come from the same row set
    // ⛔ …and `merchant=none`: an unlinked group IS "rows with no merchant" (this
    // assertion went red on 52e0a98, committed without the suite's tally read)
    expect(entry.href).toBe("/transactions?category=spending&merchant=none&key=VENMO+CASHOUT+REF&from=2026-07-01&to=2026-07-31");
    expect(rowsBehind(entry.href)).toBe(1);
  });

  test("a clean descriptor lands on its rows and not on a neighbour sharing its first token", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -800, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -900, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });
    insertTxn({ postedOn: "2026-07-06", amountCents: -100, category: "Food > Groceries", normalized: "NEW JERSEY TOLLS" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry.name).toBe("NEW BEST GOURMET DELI");
    expect(rowsBehind(entry.href)).toBe(2);
  });
});

describe("largestTransactions", () => {
  test("ranks actual outflows by magnitude, excluding refunds", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -20_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-07-03", amountCents: -12_000, category: "Travel > Flights" });
    insertTxn({ postedOn: "2026-07-04", amountCents: 99_000, category: "Food > Dining" }); // refund — not a purchase

    const largest = largestTransactions(bundle.db, JULY, 2);
    expect(largest.map((t) => t.amountCents)).toEqual([-20_000, -12_000]);
    expect(largest[0]!.accountName).toBe("Card");
  });
});

describe("honestyBuckets", () => {
  test("uncategorized spend and excluded rows stay explicit and clickable", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -3_000, category: null }); // uncat spend
    insertTxn({ postedOn: "2026-07-06", amountCents: -4_000, category: null }); // uncat spend
    insertTxn({ postedOn: "2026-07-07", amountCents: -9_000, category: "Food > Dining", status: "excluded" });

    const h = honestyBuckets(bundle.db, JULY);
    expect(h.uncategorized).toMatchObject({ spentCents: 7_000, txnCount: 2 });
    expect(h.uncategorized.href).toBe(
      "/transactions?category=uncategorized&from=2026-07-01&to=2026-07-31&flow=out",
    );
    expect(h.excluded).toMatchObject({ txnCount: 1 });
    expect(h.excluded.href).toBe("/transactions?view=excluded&from=2026-07-01&to=2026-07-31");
  });
});

/**
 * A row that proves the ledger was shown the card on this day and adds nothing
 * to spending or income: an uncategorized CREDIT is the review queue's, not a
 * bucket's. It opens the ledger on a day, or carries its frontier to one.
 */
function shownOn(day: string): void {
  insertTxn({ postedOn: day, amountCents: 1, category: null });
}

/** a day after July has finished, so July is a whole window and not a running one */
const AFTER_JULY = "2026-08-15";
const JULY_DONE = resolvePeriod({ period: "2026-07" }, AFTER_JULY);
const JUNE = resolvePeriod({ period: "2026-06" }, TODAY);

describe("spendingProjection", () => {
  test("in-progress period: pace projection with a visible basis", () => {
    // July spends (today = 2026-07-08 → two before it, one after)
    insertTxn({ postedOn: "2026-07-01", amountCents: -10_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-20", amountCents: -5_000, category: "Food > Dining" }); // after today

    const flow = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const proj = spendingProjection(bundle.db, JULY, TODAY, flow.pace, flow.totals.spentCents);

    // actual-to-date = 30_000 (Jul 1 + Jul 5); pace × 31/8 = 116_250 (matches the chart readout)
    expect(proj.projectedSpendCents).toBe(116_250);
    expect(proj.paceBasis).toBe("pace from 8 of 31 days elapsed");
    expect(proj.paceConfidence).toBe(0.52);
  });

  /**
   * 🔴 S12. The readout printed "On pace for ~$3,066.54 · $1,431.05 so far" over
   * September 2026 on 2026-09-14, two of its fourteen elapsed days unimported,
   * while the dashboard tile beside the link here said "at least" of the same
   * figures. The pace MATH stays (the tile reads the same `cashFlow.pace`); what
   * the readout needs is how many days the figure has not seen.
   *
   * ⚠️ The test above has a row dated 07-20, past today, so the ledger reaches
   * beyond today and this can never be anything but zero there.
   */
  test("the pace counts the elapsed days no import reaches, without changing its math", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: -10_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" }); // the newest row

    const flow = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const proj = spendingProjection(bundle.db, JULY, TODAY, flow.pace, flow.totals.spentCents);
    expect(proj.paceUncoveredDays).toBe(3); // Jul 6, 7 and 8
    expect(proj.projectedSpendCents).toBe(116_250); // the same pace as above
    expect(proj.paceBasis).toBe("pace from 8 of 31 days elapsed");
  });

  test("a row ON today leaves no elapsed day unimported", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    shownOn(TODAY);
    const flow = cashFlowByPeriod(bundle.db, JULY, TODAY);
    expect(spendingProjection(bundle.db, JULY, TODAY, flow.pace, flow.totals.spentCents).paceUncoveredDays).toBe(0);
  });

  test("a finished period has no pace, so no unimported days to count", () => {
    insertTxn({ postedOn: "2026-06-10", amountCents: -12_000, category: "Food > Dining" });
    const flow = cashFlowByPeriod(bundle.db, JUNE, TODAY);
    expect(spendingProjection(bundle.db, JUNE, TODAY, flow.pace, flow.totals.spentCents).paceUncoveredDays).toBeNull();
  });

  test("a whole period's prior is drawn as a ghost, day under day", () => {
    shownOn("2026-06-01"); // the ledger holds all of June
    insertTxn({ postedOn: "2026-06-10", amountCents: -12_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-25", amountCents: -18_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    shownOn("2026-07-31"); // …and all of July

    const flow = cashFlowByPeriod(bundle.db, JULY_DONE, AFTER_JULY);
    const proj = spendingProjection(bundle.db, JULY_DONE, AFTER_JULY, flow.pace, flow.totals.spentCents);

    expect(proj.prior).not.toBeNull();
    expect(proj.prior!.label).toBe("June 2026");
    expect(proj.prior!.spentCents).toBe(30_000); // reconciles to June's gross spend
    expect(proj.prior!.aligned).toHaveLength(31); // one entry per July day-bucket
    expect(proj.prior!.aligned[24]).toBe(18_000); // June 25 sits under July 25, not beside it
  });

  /**
   * 🔴 THE GHOST IS TWO SERIES, AND ONLY ONE OF THEM NAMES A DAY.
   *
   * `ghost` is a shape resample: on June(30) → July(31) it slides every bucket
   * from June 19 up, so the table column headed `Spent, June 2026` printed the
   * wrong calendar day beside 610 of 1,539 day numbers on the real ledger, and
   * the graph's cumulative dashed line ended at a total June never spent.
   * `aligned` is the per-bucket fact both of those surfaces were claiming.
   */
  test("prior.aligned names the same day the current bucket does", () => {
    shownOn("2026-06-01"); // the ledger holds all of June
    shownOn("2026-07-31"); // …and all of July
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-10", amountCents: -12_000, category: "Food > Dining" });
    // ⛔ June 16 is the one bucket a 30→31 resample DUPLICATES. Without a row on it
    // the fixture cannot express the cumulative half of this defect at all.
    insertTxn({ postedOn: "2026-06-16", amountCents: -7_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-25", amountCents: -18_000, category: "Food > Groceries" });

    const flow = cashFlowByPeriod(bundle.db, JULY_DONE, AFTER_JULY);
    const proj = spendingProjection(bundle.db, JULY_DONE, AFTER_JULY, flow.pace, flow.totals.spentCents);
    const aligned = proj.prior!.aligned;

    expect(aligned).toHaveLength(31); // one entry per July day-bucket
    // June 10 and June 25 sit under July 10 and July 25 — index 9 and index 24
    expect(aligned[9]).toBe(12_000);
    expect(aligned[24]).toBe(18_000);
    // …and NOT one index later, which is where the resample put June 25's peak
    expect(aligned[25]).toBe(0);
    // the June 16 row is its own bucket, not duplicated into two
    expect(aligned[15]).toBe(7_000);
    expect(aligned[16]).toBe(0);

    // there is no June 31: the last cell is "—", never a borrowed value
    expect(aligned[30]).toBeNull();
    // and a running total over it lands exactly on the page's own prior readout
    expect(aligned.reduce((a: number, v) => a + (v ?? 0), 0)).toBe(proj.prior!.spentCents);
  });

  test("a completed (past) period gets no fabricated pace projection", () => {
    insertTxn({ postedOn: "2026-06-10", amountCents: -12_000, category: "Food > Dining" });
    const june = resolvePeriod({ period: "2026-06" }, TODAY);
    const flow = cashFlowByPeriod(bundle.db, june, TODAY);
    const proj = spendingProjection(bundle.db, june, TODAY, flow.pace, flow.totals.spentCents);
    expect(proj.projectedSpendCents).toBeNull();
    expect(proj.paceBasis).toBeNull();
    expect(proj.paceConfidence).toBeNull();
  });

  test("a prior period with no spend yields no ghost (never a flat-zero line)", () => {
    // ⚠️ June is IMPORTED and empty. Without the row opening the ledger on June 1
    // the comparison would be refused at the opening edge instead, and this test
    // would pass without ever reaching the emptiness guard it is about.
    shownOn("2026-06-01");
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    shownOn("2026-07-31");
    const flow = cashFlowByPeriod(bundle.db, JULY_DONE, AFTER_JULY);
    const proj = spendingProjection(bundle.db, JULY_DONE, AFTER_JULY, flow.pace, flow.totals.spentCents);
    expect(proj.prior).toBeNull();
  });

  test("the projection is floored at the full-period committed spend (future-dated charges)", () => {
    // small to-date spend, then a large ACTIVE charge dated after today (still in July)
    insertTxn({ postedOn: "2026-07-01", amountCents: -1_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-25", amountCents: -50_000, category: "Housing > Rent" }); // future-dated
    const flow = cashFlowByPeriod(bundle.db, JULY, TODAY);
    // to-date pace alone would project ~round(1_000 × 31/8) = 3_875, well BELOW the
    // 51_000 already booked for the period; the floor keeps it honest.
    expect(flow.totals.spentCents).toBe(51_000);
    const proj = spendingProjection(bundle.db, JULY, TODAY, flow.pace, flow.totals.spentCents);
    expect(proj.projectedSpendCents).toBe(51_000); // floored at committed, never below the visible "Spent"
  });
});

/**
 * 🔴 S8 / S13 / Q8 — A PRIOR WINDOW THE LEDGER DOES NOT FULLY HOLD.
 *
 * The ghost's only guard was `prevFlow.totals.spentCents > 0`: emptiness, not
 * coverage. Measured on the owner's ledger 2026-09-14: `?period=2023` drew
 * "$4,528.51 in 2022" over a 2022 the ledger holds Aug 25 – Dec 31 of, and
 * `?period=2022-09` "$46.44 in August 2022" over 7 of its 31 days.
 *
 * ⚠️ The older no-ghost test could not tell these apart: it had no row on or
 * before June, so "empty" and "not imported" were the same fixture.
 */
describe("a prior window the ledger does not fully hold", () => {
  test("a prior month the ledger opens partway through draws no ghost", () => {
    insertTxn({ postedOn: "2026-05-20", amountCents: -18_000, category: "Food > Groceries" }); // the first row
    insertTxn({ postedOn: "2026-06-05", amountCents: -20_000, category: "Food > Groceries" });
    shownOn("2026-07-05");

    const flow = cashFlowByPeriod(bundle.db, JUNE, TODAY);
    expect(spendingProjection(bundle.db, JUNE, TODAY, flow.pace, flow.totals.spentCents).prior).toBeNull();
  });

  test("a prior month whose first day IS the ledger's first day keeps its ghost", () => {
    insertTxn({ postedOn: "2026-05-01", amountCents: -18_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-05", amountCents: -20_000, category: "Food > Groceries" });
    shownOn("2026-07-05");

    const flow = cashFlowByPeriod(bundle.db, JUNE, TODAY);
    expect(spendingProjection(bundle.db, JUNE, TODAY, flow.pace, flow.totals.spentCents).prior).toMatchObject({
      label: "May 2026",
      spentCents: 18_000,
    });
  });

  test("periodComparison names the edge that refused, and reads ACTIVE rows for it", () => {
    insertTxn({ postedOn: "2026-05-20", amountCents: -18_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-05", amountCents: -20_000, category: "Food > Groceries" });
    shownOn("2026-07-05");
    // a quarantined row older than every active one: "All time" STARTS from it
    // (`ledgerFirstDay` counts it) while coverage does not (`ledgerOpens`)
    insertTxn({ postedOn: "2026-04-01", amountCents: -500, category: "Food > Dining", status: "quarantined" });

    const all = resolvePeriod({ period: "ALL" }, TODAY, ledgerFirstDay(bundle.db)!);
    expect(all.from).toBe("2026-04-01");
    expect(periodComparison(bundle.db, all, TODAY)).toMatchObject({ kind: "refused", reason: "before-records" });
    expect(periodComparison(bundle.db, JUNE, TODAY)).toMatchObject({ kind: "refused", reason: "partly-covered" });
  });
});

/**
 * 🔴 BOTH ENDS OF THE ONLY WINDOW BEHIND TWO SURFACES.
 *
 * `spendingRowsInRange` is the single row source under Top merchants and
 * Largest purchases, and NOTHING pinned either end of its `[from, to]`. Both
 * mutations survive the suite: dropping the row posted ON `from` and dropping
 * the row posted ON `to`. Every fixture in this file puts its rows comfortably
 * inside the month, which is the same blindness that let three live boundary
 * bugs ship — `TODAY` here is 2026-07-08 and no fixture row sits on the 1st or
 * the 31st.
 *
 * A month is INCLUSIVE of both its ends: spend on 1 July belongs to July, and so
 * does spend on the 31st.
 */
describe("the spending window includes both of its ends", () => {
  test("a purchase on the first day of the period, and on the last, are both in it", () => {
    insertTxn({ postedOn: "2026-06-30", amountCents: -11_000, category: "Food > Dining", normalized: "JUNE" });
    insertTxn({ postedOn: "2026-07-01", amountCents: -12_000, category: "Food > Dining", normalized: "FIRST" });
    insertTxn({ postedOn: "2026-07-31", amountCents: -13_000, category: "Food > Dining", normalized: "LAST" });
    insertTxn({ postedOn: "2026-08-01", amountCents: -14_000, category: "Food > Dining", normalized: "AUGUST" });

    const largest = largestTransactions(bundle.db, JULY, 5);
    expect(largest.map((l) => l.rawDescription).sort()).toEqual(["FIRST", "LAST"]);
    expect(largest.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-13_000, -12_000]);

    const top = topMerchants(bundle.db, JULY, 8);
    expect(top.entries.map((e) => e.name).sort()).toEqual(["FIRST", "LAST"]);
  });
});
