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
import { dedupeHash } from "@/lib/hash";
import { resolvePeriod } from "@/lib/period";
import { createAccount } from "./accounts";
import {
  cashFlowByPeriod,
  cashFlowSegmentHref,
  dailySpendHeatmap,
  dayLedgerHref,
  honestyBuckets,
  largestTransactions,
  periodTotals,
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
  test("earned/spent/net/savings, with refund netting and exclusions", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-03", amountCents: -5_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-12", amountCents: 2_000, category: "Food > Dining" }); // refund nets
    insertTxn({ postedOn: "2026-07-15", amountCents: -3_000, category: null }); // uncategorized spend
    insertTxn({ postedOn: "2026-07-16", amountCents: 9_999, category: null }); // uncat credit — review queue, excluded
    insertTxn({ postedOn: "2026-07-05", amountCents: -50_000, category: "Transfers > Internal Transfer" }); // excluded

    expect(periodTotals(bundle.db, JULY)).toEqual({
      earnedCents: 500_000,
      spentCents: 5_000 + 10_000 - 2_000 + 3_000, // 16_000
      netCents: 500_000 - 16_000,
      savingsRatePct: Math.round(((500_000 - 16_000) / 500_000) * 1000) / 10, // 96.8
    });
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
    expect(heat.days.find((d) => d.iso === "2026-07-03")).toEqual({ iso: "2026-07-03", spentCents: 7_000, incomeCents: 0 });
    expect(heat.days.find((d) => d.iso === "2026-07-01")).toEqual({ iso: "2026-07-01", spentCents: 0, incomeCents: 500_000 });
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
