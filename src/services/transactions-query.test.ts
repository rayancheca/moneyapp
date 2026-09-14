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
import { createAccount } from "./accounts";
import { countMatching, matchingTransactionIds } from "./transactions-query";
import { filtersToQuery, parseFilters, type TxnFilters } from "@/components/transactions/query";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-txq-"));
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
    .get()!;
  if (!subName) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get()!.id;
}

let seq = 0;
function insertTxn(overrides: {
  accountId?: string;
  postedOn?: string;
  amountCents?: number;
  rawDescription?: string;
  categoryId?: string | null;
  status?: TransactionStatus;
  needsReview?: boolean;
  merchantId?: string | null;
}): string {
  seq += 1;
  const accountId = overrides.accountId ?? checkingId;
  const postedOn = overrides.postedOn ?? "2026-06-15";
  const amountCents = overrides.amountCents ?? -1_000;
  const rawDescription = overrides.rawDescription ?? `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription.toUpperCase(),
      categoryId: overrides.categoryId ?? null,
      merchantId: overrides.merchantId ?? null,
      status: overrides.status ?? "active",
      needsReview: overrides.needsReview ?? false,
      dedupeHash: dedupeHash({
        accountId,
        postedOn,
        amountCents,
        rawDescription: `${rawDescription}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function filters(overrides: Partial<TxnFilters> = {}): TxnFilters {
  return {
    view: "all",
    account: null,
    category: null,
    merchant: null,
    key: null,
    from: null,
    to: null,
    q: null,
    amountMinCents: null,
    amountMaxCents: null,
    flow: null,
    page: 1,
    ...overrides,
  };
}

describe("countMatching — view conditions", () => {
  test("each view counts exactly its status/review slice", () => {
    // Arrange
    insertTxn({});
    insertTxn({ needsReview: true });
    insertTxn({ status: "excluded" });
    insertTxn({ status: "quarantined" });

    // Act + Assert
    expect(countMatching(bundle.db, filters(), "all")).toBe(2);
    expect(countMatching(bundle.db, filters(), "review")).toBe(1);
    expect(countMatching(bundle.db, filters(), "excluded")).toBe(1);
    expect(countMatching(bundle.db, filters(), "quarantined")).toBe(1);
  });
});

describe("countMatching — filter conditions", () => {
  test("account filter", () => {
    insertTxn({ accountId: checkingId });
    insertTxn({ accountId: cardId });
    expect(countMatching(bundle.db, filters({ account: cardId }), "all")).toBe(1);
  });

  test("category filter includes the subtree (parent matches children)", () => {
    insertTxn({ categoryId: catId("Food > Groceries") });
    insertTxn({ categoryId: catId("Food > Dining") });
    insertTxn({ categoryId: catId("Transport") });
    expect(countMatching(bundle.db, filters({ category: catId("Food") }), "all")).toBe(2);
    expect(
      countMatching(bundle.db, filters({ category: catId("Food > Dining") }), "all"),
    ).toBe(1);
  });

  test("the 'uncategorized' honesty bucket lands on category-less rows, not an empty ledger", () => {
    insertTxn({ categoryId: catId("Food > Groceries") });
    insertTxn({ categoryId: null });
    insertTxn({ categoryId: null });
    const f = filters({ category: "uncategorized" });
    expect(countMatching(bundle.db, f, "all")).toBe(2);
    expect(matchingTransactionIds(bundle.db, f, "all")).toHaveLength(2);
  });

  test("the 'spending' StatCard token = expense rows (either sign) + uncategorized outflows", () => {
    insertTxn({ categoryId: catId("Food > Dining"), amountCents: -5_000 }); // expense purchase
    insertTxn({ categoryId: catId("Food > Dining"), amountCents: 2_000 }); // expense refund (nets, still spending)
    insertTxn({ categoryId: null, amountCents: -3_000 }); // uncategorized outflow → spending
    insertTxn({ categoryId: null, amountCents: 9_000 }); // uncategorized credit → NOT spending (review queue)
    insertTxn({ categoryId: catId("Income > Salary"), amountCents: 500_000 }); // income → NOT spending
    insertTxn({ categoryId: catId("Transfers > Internal Transfer"), amountCents: -1_000 }); // transfer → NOT spending
    expect(countMatching(bundle.db, filters({ category: "spending" }), "all")).toBe(3);
  });

  /**
   * 🔴 THE DRILL-DOWN CONTRACT, BROKEN ON THE CARD THAT SUMS THE OTHER THREE.
   * `Net`'s link carried the window and NOTHING ELSE, so on the real ledger
   * 2026-09-11 `/spending?period=2026` printed "Net -$31,733.19" over a list of
   * **2,682 rows summing to +$27,961.36** — the whole year, transfers, card
   * payments and investment flows included. Earned, Spent and Refunds all
   * opened exactly the rows behind them. Scoped: 1,601 rows, -$31,733.19, to
   * the cent.
   */
  test("the 'cashflow' token is spending ∪ income — the population Net is a figure over", () => {
    insertTxn({ categoryId: catId("Food > Dining"), amountCents: -5_000 }); // spending
    insertTxn({ categoryId: catId("Food > Dining"), amountCents: 2_000 }); // a refund — spending, netting
    insertTxn({ categoryId: null, amountCents: -3_000 }); // uncategorized outflow → spending
    insertTxn({ categoryId: catId("Income > Salary"), amountCents: 500_000 }); // earned
    insertTxn({ categoryId: null, amountCents: 9_000 }); // uncategorized credit → in NEITHER half
    insertTxn({ categoryId: catId("Income > Salary"), amountCents: -50 }); // negative income → neither
    insertTxn({ categoryId: catId("Transfers > Internal Transfer"), amountCents: -1_000 }); // neither
    const spending = countMatching(bundle.db, filters({ category: "spending" }), "all");
    const income = countMatching(bundle.db, filters({ category: "income" }), "all");
    const cashflow = countMatching(bundle.db, filters({ category: "cashflow" }), "all");
    expect([spending, income]).toEqual([3, 1]);
    expect(cashflow).toBe(4); // exactly the union — the transfer and the two strays stay out
    // and the window alone would have opened all seven
    expect(countMatching(bundle.db, filters({}), "all")).toBe(7);
  });

  /**
   * 🔴 AN "UNLINKED" ROW IS DEFINED BY HAVING NO MERCHANT, AND ITS LINK COULD
   * NOT SAY SO. `topMerchants` builds those groups by skipping every row that
   * HAS a merchant; the drill carried the category, the window and a literal
   * description anchor, and /transactions had no filter for the other half.
   * On the real ledger 2026-09-11, "LA PISCINE MIAMI BEACH · 26 transactions ·
   * unlinked · $730.15" opened 29 rows / $857.06 — three of them LINKED rows
   * that share the description. 33 of 616 rendered unlinked rows over-matched.
   */
  test("the 'none' merchant token = rows with NO merchant, the mirror of uncategorized", () => {
    const m = bundle.db
      .insert(merchants)
      .values({ canonicalName: "La Piscine" })
      .returning({ id: merchants.id })
      .get().id;
    insertTxn({ merchantId: m, amountCents: -1_000, rawDescription: "LA PISCINE MIAMI BEACH" });
    insertTxn({ merchantId: null, amountCents: -2_000, rawDescription: "LA PISCINE MIAMI BEACH" });
    insertTxn({ merchantId: null, amountCents: -3_000, rawDescription: "LA PISCINE MIAMI BEACH" });
    // the text anchor alone opens all three — the linked row included
    expect(countMatching(bundle.db, filters({ q: "LA PISCINE MIAMI BEACH" }), "all")).toBe(3);
    // …with the other half of the definition, exactly the two the group counted
    expect(
      countMatching(bundle.db, filters({ q: "LA PISCINE MIAMI BEACH", merchant: "none" }), "all"),
    ).toBe(2);
    // and it is a sentinel, not an id: a real id still means that merchant
    expect(countMatching(bundle.db, filters({ merchant: m }), "all")).toBe(1);
  });

  test("the 'income' StatCard token = income-kind positive rows only", () => {
    insertTxn({ categoryId: catId("Income > Salary"), amountCents: 500_000 });
    insertTxn({ categoryId: catId("Income > Interest"), amountCents: 1_200 });
    insertTxn({ categoryId: catId("Income > Salary"), amountCents: -50 }); // negative income row → excluded
    insertTxn({ categoryId: catId("Food > Dining"), amountCents: -5_000 }); // expense → excluded
    expect(countMatching(bundle.db, filters({ category: "income" }), "all")).toBe(2);
  });

  test("the flow filter scopes by direction — 'out' keeps outflows, 'in' keeps inflows", () => {
    insertTxn({ categoryId: null, amountCents: -400 }); // uncategorized outflow
    insertTxn({ categoryId: null, amountCents: 48 }); // uncategorized inflow (interest)
    // uncategorized honesty drill: category-less AND money-out only
    expect(countMatching(bundle.db, filters({ category: "uncategorized", flow: "out" }), "all")).toBe(1);
    expect(countMatching(bundle.db, filters({ category: "uncategorized", flow: "in" }), "all")).toBe(1);
    // a zero-amount row is neither in nor out
    insertTxn({ categoryId: null, amountCents: 0 });
    expect(countMatching(bundle.db, filters({ category: "uncategorized" }), "all")).toBe(3);
    expect(countMatching(bundle.db, filters({ category: "uncategorized", flow: "out" }), "all")).toBe(1);
  });

  test("date range is inclusive on both ends", () => {
    insertTxn({ postedOn: "2026-06-01" });
    insertTxn({ postedOn: "2026-06-15" });
    insertTxn({ postedOn: "2026-06-30" });
    expect(
      countMatching(bundle.db, filters({ from: "2026-06-15", to: "2026-06-30" }), "all"),
    ).toBe(2);
  });

  test("search matches raw and normalized descriptions", () => {
    insertTxn({ rawDescription: "Trader Joe's #402" });
    insertTxn({ rawDescription: "SHELL GAS" });
    expect(countMatching(bundle.db, filters({ q: "trader" }), "all")).toBe(1);
    expect(countMatching(bundle.db, filters({ q: "TRADER" }), "all")).toBe(1);
  });

  test("stale/deleted category id scopes to EMPTY, never the whole ledger", () => {
    // Arrange — active rows exist, but the filtered category id resolves to none
    // (e.g. a bookmarked ?category= URL pointing at a since-deleted category).
    insertTxn({ categoryId: catId("Food > Groceries") });
    insertTxn({ categoryId: catId("Transport") });
    insertTxn({});

    // Act + Assert — blast-radius honesty: a shown filter must scope the set.
    const f = filters({ category: "nonexistent-id" });
    expect(countMatching(bundle.db, f, "all")).toBe(0);
    expect(matchingTransactionIds(bundle.db, f, "all")).toEqual([]);
  });

  test("LIKE wildcards in q are literal — '_' does not match everything", () => {
    // Arrange
    const underscore = insertTxn({ rawDescription: "A_B" });
    insertTxn({ rawDescription: "AXB" });
    insertTxn({ rawDescription: "SHELL GAS" });

    // Act + Assert — a bare underscore must match only the literal-underscore row,
    // not every row (SQLite LIKE would otherwise treat '_' as any single char).
    expect(countMatching(bundle.db, filters({ q: "_" }), "all")).toBe(1);
    const literal = filters({ q: "A_B" });
    expect(countMatching(bundle.db, literal, "all")).toBe(1);
    expect(matchingTransactionIds(bundle.db, literal, "all")).toEqual([underscore]);
  });

  test("amount filters are magnitude filters — sign never matters", () => {
    insertTxn({ amountCents: -500 });
    insertTxn({ amountCents: -1_500 });
    insertTxn({ amountCents: 2_500 });
    expect(countMatching(bundle.db, filters({ amountMinCents: 1_000 }), "all")).toBe(2);
    expect(countMatching(bundle.db, filters({ amountMaxCents: 1_500 }), "all")).toBe(2);
    expect(
      countMatching(
        bundle.db,
        filters({ amountMinCents: 1_000, amountMaxCents: 2_000 }),
        "all",
      ),
    ).toBe(1);
  });
});

describe("matchingTransactionIds", () => {
  test("returns exactly the countMatching set", () => {
    // Arrange
    const a = insertTxn({ accountId: cardId, amountCents: -9_000 });
    insertTxn({ accountId: checkingId, amountCents: -9_000 });
    insertTxn({ accountId: cardId, amountCents: -100 });

    // Act
    const f = filters({ account: cardId, amountMinCents: 5_000 });
    const ids = matchingTransactionIds(bundle.db, f, "all");

    // Assert
    expect(ids).toEqual([a]);
    expect(ids.length).toBe(countMatching(bundle.db, f, "all"));
  });
});

describe("TxnFilters parse/serialize round-trip (query.ts extension)", () => {
  test("amountMin/amountMax survive the round trip in cents", () => {
    const parsed = parseFilters({ amountMin: "1500", amountMax: "6000", view: "review" });
    expect(parsed.amountMinCents).toBe(1_500);
    expect(parsed.amountMaxCents).toBe(6_000);
    const query = filtersToQuery(parsed);
    expect(query).toBe("?view=review&amountMin=1500&amountMax=6000");
    const reparsed = parseFilters(Object.fromEntries(new URLSearchParams(query.slice(1))));
    expect(reparsed).toEqual(parsed);
  });

  test("malformed, negative, and fractional amounts parse to null and serialize to nothing", () => {
    const parsed = parseFilters({ amountMin: "abc", amountMax: "-5" });
    expect(parsed.amountMinCents).toBeNull();
    expect(parsed.amountMaxCents).toBeNull();
    expect(parseFilters({ amountMin: "12.5" }).amountMinCents).toBeNull();
    expect(filtersToQuery(parsed)).toBe("");
  });

  test("existing behavior is intact — defaults omitted, filters preserved", () => {
    const parsed = parseFilters({ account: "acc-1", q: "coffee", page: "3" });
    expect(filtersToQuery(parsed)).toBe("?account=acc-1&q=coffee&page=3");
    expect(parsed.amountMinCents).toBeNull();
  });
});

describe("the system Uncategorized category is the NULL bucket", () => {
  test("the Uncategorized filter and the spending filter both reach a row filed on it", () => {
    const sys = (bundle.sqlite.prepare("SELECT id FROM categories WHERE kind = 'system'").get() as { id: string }).id;
    const onSystem = insertTxn({ amountCents: -762, categoryId: sys });
    const onNull = insertTxn({ amountCents: -1200 });
    const credit = insertTxn({ amountCents: 24, categoryId: sys });
    insertTxn({ amountCents: -500, categoryId: catId("Food > Groceries") });

    const uncat = matchingTransactionIds(bundle.db, filters({ category: "uncategorized" }), "all");
    expect(new Set(uncat)).toEqual(new Set([onSystem, onNull, credit]));
    // spending = expense rows plus uncategorized OUTFLOWS, on either shape of uncategorized
    const spending = matchingTransactionIds(bundle.db, filters({ category: "spending" }), "all");
    expect(spending).toContain(onSystem);
    expect(spending).toContain(onNull);
    expect(spending).not.toContain(credit);
  });
});

