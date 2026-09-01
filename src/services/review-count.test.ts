import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { categories } from "@/db/schema/categories";
import { needsReviewCount, uncategorizedCount, unreviewedByAccount } from "./review-count";

let dir: string;
let bundle: DbBundle;
let acctA: string;
let acctB: string;

function insertTxn(
  accountId: string,
  opts: {
    needsReview?: boolean;
    status?: "active" | "excluded" | "superseded";
    hash: string;
    categoryId?: string | null;
  },
) {
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: "2026-07-01",
      amountCents: -1000,
      rawDescription: opts.hash,
      normalizedDescription: opts.hash,
      needsReview: opts.needsReview ?? false,
      status: opts.status ?? "active",
      categoryId: opts.categoryId ?? null,
      dedupeHash: `${accountId}-${opts.hash}`,
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-review-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  acctA = createAccount(bundle.db, { institutionId: instId, name: "A", type: "checking" });
  acctB = createAccount(bundle.db, { institutionId: instId, name: "B", type: "savings" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("needsReviewCount", () => {
  test("counts only active rows awaiting review", () => {
    insertTxn(acctA, { needsReview: true, hash: "1" });
    insertTxn(acctA, { needsReview: true, hash: "2" });
    insertTxn(acctA, { needsReview: false, hash: "3" });
    insertTxn(acctA, { needsReview: true, status: "excluded", hash: "4" }); // not active → excluded
    expect(needsReviewCount(bundle.db)).toBe(2);
  });
});

describe("unreviewedByAccount", () => {
  test("groups the review backlog by account, omitting zero-backlog accounts", () => {
    insertTxn(acctA, { needsReview: true, hash: "1" });
    insertTxn(acctA, { needsReview: true, hash: "2" });
    insertTxn(acctB, { needsReview: true, hash: "3" });
    insertTxn(acctB, { needsReview: false, hash: "4" });

    const map = unreviewedByAccount(bundle.db);
    expect(map.get(acctA)).toBe(2);
    expect(map.get(acctB)).toBe(1);
  });

  test("an account with no backlog is absent from the map", () => {
    insertTxn(acctA, { needsReview: true, hash: "1" });
    const map = unreviewedByAccount(bundle.db);
    expect(map.has(acctB)).toBe(false);
  });

  test("excluded review rows never count toward a dot", () => {
    insertTxn(acctA, { needsReview: true, status: "excluded", hash: "1" });
    expect(unreviewedByAccount(bundle.db).has(acctA)).toBe(false);
  });
});

/*
 * 🔴 THE DASHBOARD'S ALL-CLEAR WAS BUILT FROM THE WRONG COUNT.
 *
 * `ToReviewCard` reads `needsReviewCount` and, when it is zero, prints
 * "Nothing to review — every transaction is categorized and confirmed."
 * Measured on the real ledger at today = 2026-09-01: **0 rows flagged for
 * review, and 9 active rows with no category at all** — nine real Wells Fargo
 * purchases from early August, sitting in the Uncategorized bucket that
 * /spending prints one page over. A flag count cannot know a category fact, and
 * the sentence claimed one.
 */
describe("uncategorizedCount", () => {
  const groceries = (): string =>
    bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!.id;

  test("counts active rows with no category, and ignores the review flag", () => {
    insertTxn(acctA, { hash: "c1", categoryId: groceries() });
    insertTxn(acctA, { hash: "u1", categoryId: null });
    insertTxn(acctB, { hash: "u2", categoryId: null });
    // flagged for review AND categorized — the two counts are independent
    insertTxn(acctB, { hash: "r1", needsReview: true, categoryId: groceries() });

    expect(uncategorizedCount(bundle.db)).toBe(2);
    expect(needsReviewCount(bundle.db)).toBe(1);
  });

  test("a superseded row is not a backlog item", () => {
    insertTxn(acctA, { hash: "s1", categoryId: null, status: "superseded" });
    expect(uncategorizedCount(bundle.db)).toBe(0);
  });

  test("zero is zero, not null", () => {
    expect(uncategorizedCount(bundle.db)).toBe(0);
  });
});
