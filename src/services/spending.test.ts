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
    expect(top.entries[0]!.href).toContain("q=NEW+BEST+GOURMET+DELI");
    expect(top.entries[1]).toMatchObject({ kind: "merchant", id: dunkin, name: "Dunkin'", spentCents: 1_500, txnCount: 3 });
    expect(top.entries[1]!.href).toBe(`/transactions?merchant=${dunkin}&from=2026-07-01&to=2026-07-31`);
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
 * group's NAME is a derived string (the stripped key), while the ledger's `q` is
 * a literal LIKE against the raw/normalized descriptor — so linking to the name
 * used to search for text that exists in no row and open an empty ledger.
 * These follow the generated href through the REAL ledger filter layer.
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
    // ...so the link carries the longest run that really occurs, and lands on BOTH rows
    expect(entry.href).toContain("q=AMAZON+MKTPLACE");
    expect(rowsBehind(entry.href)).toBe(2);
  });

  test("a brokerage ticker group links by its symbol, not by the humanized label", () => {
    insertTxn({ postedOn: "2026-07-02", amountCents: -25_000, category: null, normalized: "RECURRING INVESTMENT CUSIP: 81762P102 07/02 (KO)" });
    insertTxn({ postedOn: "2026-07-16", amountCents: -25_000, category: null, normalized: "RECURRING INVESTMENT CUSIP: 81762P102 07/16 (KO)" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry.name).toBe("KO recurring buys"); // synthetic label — no row says this
    expect(rowsBehind(`/transactions?q=${encodeURIComponent(entry.name)}&from=2026-07-01&to=2026-07-31`)).toBe(0);
    expect(rowsBehind(entry.href)).toBe(2);
  });

  test("noise between every identity token falls back to a single token, never to nothing", () => {
    // VENMO / CASHOUT / REF are each separated by stripped noise, so no adjacent
    // pair survives — the link still has to land
    insertTxn({ postedOn: "2026-07-05", amountCents: -3_000, category: null, normalized: "VENMO 07/05 CASHOUT 12.34 REF" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry.name).toBe("VENMO CASHOUT REF");
    expect(entry.href).toBe("/transactions?from=2026-07-01&to=2026-07-31&q=VENMO");
    expect(rowsBehind(entry.href)).toBe(1);
  });

  test("a clean descriptor still links by its whole name (no needless narrowing)", () => {
    insertTxn({ postedOn: "2026-07-03", amountCents: -800, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });
    insertTxn({ postedOn: "2026-07-04", amountCents: -900, category: "Food > Groceries", normalized: "NEW BEST GOURMET DELI" });
    // a neighbour that shares only the first token — the narrowed link must not swallow it
    insertTxn({ postedOn: "2026-07-06", amountCents: -100, category: "Food > Groceries", normalized: "NEW JERSEY TOLLS" });

    const entry = topMerchants(bundle.db, JULY).entries[0]!;
    expect(entry.href).toContain("q=NEW+BEST+GOURMET+DELI");
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

describe("spendingProjection", () => {
  test("in-progress period: pace projection with a visible basis + a prior-period ghost", () => {
    // July spends (today = 2026-07-08 → two before it, one after)
    insertTxn({ postedOn: "2026-07-01", amountCents: -10_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-20", amountCents: -5_000, category: "Food > Dining" }); // after today
    // June spends → the prior-period ghost
    insertTxn({ postedOn: "2026-06-10", amountCents: -12_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-25", amountCents: -18_000, category: "Food > Groceries" });

    const flow = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const proj = spendingProjection(bundle.db, JULY, TODAY, flow.pace, flow.totals.spentCents);

    // actual-to-date = 30_000 (Jul 1 + Jul 5); pace × 31/8 = 116_250 (matches the chart readout)
    expect(proj.projectedSpendCents).toBe(116_250);
    expect(proj.paceBasis).toBe("pace from 8 of 31 days elapsed");
    expect(proj.paceConfidence).toBe(0.52);

    expect(proj.prior).not.toBeNull();
    expect(proj.prior!.label).toBe("June 2026");
    expect(proj.prior!.spentCents).toBe(30_000); // reconciles to June's gross spend
    expect(proj.prior!.ghost).toHaveLength(31); // re-indexed onto July's 31 day-buckets
    expect(Math.max(...proj.prior!.ghost)).toBe(18_000); // the June 25 peak survives the resample
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
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Food > Groceries" });
    const flow = cashFlowByPeriod(bundle.db, JULY, TODAY);
    const proj = spendingProjection(bundle.db, JULY, TODAY, flow.pace, flow.totals.spentCents);
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
