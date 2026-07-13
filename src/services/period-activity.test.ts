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
import { createAccount } from "./accounts";
import { periodActivity } from "./period-activity";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-period-activity-"));
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

let seq = 0;
interface TxnSpec {
  accountId?: string;
  postedOn: string;
  amountCents: number;
  category?: string | null;
  transfer?: boolean;
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
      transferGroupId: spec.transfer ? "grp-1" : null,
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

const FROM = "2026-06-01";
const TO = "2026-06-30";

describe("periodActivity — cash-flow summary", () => {
  test("income and gross spending follow the /spending classification (transfers + investments excluded)", () => {
    insertTxn({ postedOn: "2026-06-03", amountCents: 500_000, category: "Income > Salary" });
    insertTxn({ postedOn: "2026-06-05", amountCents: -2_500, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-10", amountCents: -10_000, category: "Housing > Rent" });
    // a transfer is net-worth-neutral — excluded from in/out but still a txn
    insertTxn({ postedOn: "2026-06-12", amountCents: -30_000, category: "Transfers > Internal Transfer", transfer: true });

    const { summary } = periodActivity(bundle.db, FROM, TO, 10);
    expect(summary.inCents).toBe(500_000);
    expect(summary.outCents).toBe(12_500);
    expect(summary.txnCount).toBe(4); // ALL active txns, including the transfer
  });

  test("a refund/credit in an expense category does NOT reduce gross spending (never goes negative)", () => {
    insertTxn({ postedOn: "2026-06-05", amountCents: -4_000, category: "Shopping" });
    // a big statement credit / return in the same category — real data carries
    // tens of thousands of these; gross out must stay the debit total, not net down
    insertTxn({ postedOn: "2026-06-06", amountCents: 30_000, category: "Shopping" });

    const { summary } = periodActivity(bundle.db, FROM, TO, 10);
    expect(summary.outCents).toBe(4_000); // debit only
    expect(summary.topCategories).toEqual([
      expect.objectContaining({ name: "Shopping", spentCents: 4_000 }),
    ]);
  });

  test("only counts transactions inside the window", () => {
    insertTxn({ postedOn: "2026-05-31", amountCents: -1_000, category: "Food > Dining" }); // before
    insertTxn({ postedOn: "2026-06-15", amountCents: -2_000, category: "Food > Dining" }); // in
    insertTxn({ postedOn: "2026-07-01", amountCents: -3_000, category: "Food > Dining" }); // after

    const { summary } = periodActivity(bundle.db, FROM, TO, 10);
    expect(summary.txnCount).toBe(1);
    expect(summary.outCents).toBe(2_000);
  });

  test("excludes non-active transactions", () => {
    insertTxn({ postedOn: "2026-06-05", amountCents: -2_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-06", amountCents: -9_999, category: "Food > Dining", status: "excluded" });

    const { summary } = periodActivity(bundle.db, FROM, TO, 10);
    expect(summary.txnCount).toBe(1);
    expect(summary.outCents).toBe(2_000);
  });
});

describe("periodActivity — top categories", () => {
  test("returns the top 3 spending categories by magnitude, enriched with hue/icon", () => {
    insertTxn({ postedOn: "2026-06-02", amountCents: -85_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-06-04", amountCents: -10_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-06-06", amountCents: -3_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-08", amountCents: -500, category: null }); // uncategorized negative

    const { summary } = periodActivity(bundle.db, FROM, TO, 10);
    expect(summary.topCategories.map((c) => [c.name, c.spentCents])).toEqual([
      ["Housing", 85_000],
      ["Food", 13_000], // Groceries + Dining rolled to top-level Food
      ["Uncategorized", 500],
    ]);
    const housing = summary.topCategories[0]!;
    expect(housing.categoryId).toBe(catId("Housing"));
    expect(housing.hue).not.toBeNull(); // seeded categories carry a color
    // uncategorized bucket has no category record → neutral chip
    const uncategorized = summary.topCategories[2]!;
    expect(uncategorized.categoryId).toBeNull();
    expect(uncategorized.hue).toBeNull();
  });

  test("caps at three even with more categories", () => {
    insertTxn({ postedOn: "2026-06-02", amountCents: -40_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-06-03", amountCents: -30_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-06-04", amountCents: -20_000, category: "Shopping" });
    insertTxn({ postedOn: "2026-06-05", amountCents: -10_000, category: "Transport" });

    const { summary } = periodActivity(bundle.db, FROM, TO, 10);
    expect(summary.topCategories).toHaveLength(3);
    expect(summary.topCategories.map((c) => c.name)).toEqual(["Housing", "Food", "Shopping"]);
  });
});

describe("periodActivity — rows + href", () => {
  test("returns the newest rows in the window, capped at the limit", () => {
    for (let d = 1; d <= 6; d += 1) {
      insertTxn({ postedOn: `2026-06-0${d}`, amountCents: -1_000, category: "Food > Dining" });
    }
    const { rows } = periodActivity(bundle.db, FROM, TO, 3);
    expect(rows).toHaveLength(3);
    // newest first
    expect(rows.map((r) => r.postedOn)).toEqual(["2026-06-06", "2026-06-05", "2026-06-04"]);
  });

  test("href carries the exact window", () => {
    const { href } = periodActivity(bundle.db, FROM, TO, 10);
    expect(href).toBe("/transactions?from=2026-06-01&to=2026-06-30");
  });
});
