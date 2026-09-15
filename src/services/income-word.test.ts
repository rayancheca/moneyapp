import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { spendingStatCards } from "@/lib/spending-stat-cards";
import { YEAR_SECTION_TITLE } from "@/lib/year-summary";
import { createAccount } from "./accounts";
import { createCategory } from "./category-edit";
import { periodTotals } from "./spending";
import { yearSummaryView } from "./year-summary";

/**
 * 🔴 S22 — why /spending's figure and /summary's cannot share the word "Earned".
 *
 * `periodTotals.earnedCents` is every positive row in an income-kind category.
 * /summary's "Earned" is wages, tutoring and savings interest, and puts financial
 * aid under "Money in that you did not earn". Measured on the real ledger
 * 2026-09-15: /spending?period=2024 printed "Earned $32,717.06" and a savings
 * rate "of $32,717.06 earned" over a year holding a $14,171.00 financial-aid
 * refund, while /summary/2024 printed a far smaller Earned beside it.
 *
 * Owner decision 2026-09-14: /spending's population is "Income" everywhere it is
 * printed; /summary keeps its narrow "Earned". This pins the reason, so a later
 * pass that "restores consistency" by renaming one to match the other has to
 * make the two populations equal first.
 */

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let seq = 0;

function addTxn(categoryId: string, cents: number, day: string, description: string): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: checkingId,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: description,
      normalizedDescription: description,
      categoryId,
      merchantId: null,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-income-word-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("/spending's Income holds money /summary does not call earned, so the two carry different words", () => {
  const income = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Income"), isNull(categories.parentId)))
    .get()!.id;
  const tutoring = createCategory(bundle.db, { name: "Tutoring", parentId: income }).id;
  const aid = createCategory(bundle.db, { name: "Financial Aid", parentId: income }).id;
  addTxn(tutoring, 100_000, "2025-03-01", "KNACK TUTORING PAYOUT");
  addTxn(aid, 50_000, "2025-08-20", "FINANCIAL AID REFUND");

  const year = { from: "2025-01-01", to: "2025-12-31" };
  const summary = yearSummaryView(bundle.db, 2025, "2026-09-15").summary;
  const totals = periodTotals(bundle.db, year);

  // two populations: /summary's earned leaves the aid out, /spending's figure holds it
  expect(summary.earnedCents).toBe(100_000);
  expect(summary.notEarnedCents).toBe(50_000);
  expect(totals.earnedCents).toBe(150_000);

  // …so they are two words
  const card = spendingStatCards(totals, year).find((c) => c.key === "earned")!;
  expect(card.label).toBe("Income");
  expect(YEAR_SECTION_TITLE.earned).toBe("What you earned");
  expect(`${card.label} ${card.ariaLabel}`).not.toMatch(/earn/i);
});
