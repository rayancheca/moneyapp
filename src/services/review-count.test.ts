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
import { needsReviewCount, unreviewedByAccount } from "./review-count";

let dir: string;
let bundle: DbBundle;
let acctA: string;
let acctB: string;

function insertTxn(accountId: string, opts: { needsReview?: boolean; status?: "active" | "excluded"; hash: string }) {
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
