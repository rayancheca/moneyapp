import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { recentLedgerRows } from "./ledger-rows";

let dir: string;
let bundle: DbBundle;
let acctA: string;
let acctB: string;
let groceriesId: string;

function insertTxn(opts: {
  accountId: string;
  postedOn: string;
  amountCents: number;
  desc: string;
  categoryId?: string | null;
  needsReview?: boolean;
  status?: "active" | "excluded";
  confidence?: number | null;
  recurringSeriesId?: string | null;
}) {
  bundle.db
    .insert(transactions)
    .values({
      accountId: opts.accountId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.desc,
      normalizedDescription: opts.desc,
      categoryId: opts.categoryId ?? null,
      categorizationConfidence: opts.confidence ?? null,
      needsReview: opts.needsReview ?? false,
      status: opts.status ?? "active",
      recurringSeriesId: opts.recurringSeriesId ?? null,
      dedupeHash: `${opts.accountId}-${opts.desc}-${opts.postedOn}-${opts.amountCents}`,
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-ledgerrows-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  acctA = createAccount(bundle.db, { institutionId: instId, name: "Checking", type: "checking" });
  acctB = createAccount(bundle.db, { institutionId: instId, name: "Savings", type: "savings" });
  groceriesId = bundle.db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, "Food"), isNull(categories.parentId)))
    .get()!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("recentLedgerRows", () => {
  test("returns the N newest active rows, newest first", () => {
    insertTxn({ accountId: acctA, postedOn: "2026-07-01", amountCents: -100, desc: "OLD" });
    insertTxn({ accountId: acctA, postedOn: "2026-07-03", amountCents: -200, desc: "NEW" });
    insertTxn({ accountId: acctA, postedOn: "2026-07-02", amountCents: -300, desc: "MID" });
    const rows = recentLedgerRows(bundle.db, { limit: 2 });
    expect(rows.map((r) => r.rawDescription)).toEqual(["NEW", "MID"]);
  });

  test("scopes to an account when accountId is given", () => {
    insertTxn({ accountId: acctA, postedOn: "2026-07-03", amountCents: -100, desc: "A1" });
    insertTxn({ accountId: acctB, postedOn: "2026-07-04", amountCents: -100, desc: "B1" });
    const rows = recentLedgerRows(bundle.db, { accountId: acctA, limit: 10 });
    expect(rows.map((r) => r.rawDescription)).toEqual(["A1"]);
  });

  test("needsReviewOnly filters to the review backlog", () => {
    insertTxn({ accountId: acctA, postedOn: "2026-07-03", amountCents: -100, desc: "FLAG", needsReview: true });
    insertTxn({ accountId: acctA, postedOn: "2026-07-04", amountCents: -100, desc: "CLEAN" });
    const rows = recentLedgerRows(bundle.db, { limit: 10, needsReviewOnly: true });
    expect(rows.map((r) => r.rawDescription)).toEqual(["FLAG"]);
  });

  test("excludes non-active rows", () => {
    insertTxn({ accountId: acctA, postedOn: "2026-07-03", amountCents: -100, desc: "GONE", status: "excluded" });
    expect(recentLedgerRows(bundle.db, { limit: 10 })).toHaveLength(0);
  });

  test("maps category name and flags low confidence below the threshold", () => {
    insertTxn({
      accountId: acctA,
      postedOn: "2026-07-03",
      amountCents: -100,
      desc: "TJ",
      categoryId: groceriesId,
      confidence: 0.5,
    });
    const [row] = recentLedgerRows(bundle.db, { limit: 1 });
    expect(row!.categoryName).toBe("Food");
    expect(row!.lowConfidence).toBe(true);
  });

  test("high confidence is not flagged low", () => {
    insertTxn({ accountId: acctA, postedOn: "2026-07-03", amountCents: -100, desc: "TJ", confidence: 0.95 });
    expect(recentLedgerRows(bundle.db, { limit: 1 })[0]!.lowConfidence).toBe(false);
  });

  /*
   * 🔴 THE "R" BADGE READ "IS THERE A LINK?", NOT "WHAT IS THE SERIES?".
   * Measured on the real ledger 2026-09-14: 60 active rows are linked to the 10
   * series the owner dismissed ("Not recurring"), and every one wore the
   * Recurring badge — `/transactions?q=PURA VIDA BAY ROAD` badged 10 of its 13
   * rows. The link must stay (a dismissed series is the detector's re-detection
   * sink, and the sheet needs to know the row is taken); only the badge built
   * from it was wrong.
   *
   * ENDED is the other end of the rule: 194 rows of work-study and tutoring
   * really were recurring, and keep the badge.
   */
  test("a row linked to a dismissed series is not badged Recurring, and keeps its link", () => {
    const statuses = ["confirmed", "detected", "ended", "dismissed"] as const;
    for (const [i, status] of statuses.entries()) {
      const seriesId = bundle.db
        .insert(recurringSeries)
        .values({ name: `Series ${status}`, kind: "subscription", cadence: "weekly", status })
        .returning({ id: recurringSeries.id })
        .get().id;
      insertTxn({ accountId: acctA, postedOn: `2026-07-0${i + 1}`, amountCents: -540, desc: status.toUpperCase(), recurringSeriesId: seriesId });
    }
    insertTxn({ accountId: acctA, postedOn: "2026-07-06", amountCents: -540, desc: "UNLINKED" });

    const byDesc = new Map(recentLedgerRows(bundle.db, { limit: 10 }).map((r) => [r.rawDescription, r]));
    expect(byDesc.size).toBe(5);
    const flags = (desc: string) => ({ isRecurring: byDesc.get(desc)!.isRecurring, hasSeriesLink: byDesc.get(desc)!.hasSeriesLink });
    expect(flags("CONFIRMED")).toEqual({ isRecurring: true, hasSeriesLink: true });
    expect(flags("DETECTED")).toEqual({ isRecurring: true, hasSeriesLink: true });
    expect(flags("ENDED")).toEqual({ isRecurring: true, hasSeriesLink: true });
    expect(flags("DISMISSED")).toEqual({ isRecurring: false, hasSeriesLink: true });
    expect(flags("UNLINKED")).toEqual({ isRecurring: false, hasSeriesLink: false });
  });
});
