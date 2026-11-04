import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { budgetNoteRow, budgetSectionNotes } from "@/lib/section-notes";
import { createAccount } from "@/services/accounts";
import { budgetPaceStatuses, createBudget, setBudgetRollover } from "@/services/budgets";

/**
 * ⛔ What /budgets hands its note is the row's own status, built by one rule (`lib/section-notes::budgetNoteRow`).
 *
 * 🔴 The page built each row inline, field by field, and no test read that build: `rolloverMayAddCents` set to 0 there
 * left every unit and e2e test green, and no e2e fixture row has a line that can rise (review of ca938320, L25). A
 * source gate, like the category page's: the page is an async server component that reads the database, and the rule
 * is one argument — plus the note itself, from statuses `budgetPaceStatuses` returned.
 */
describe("/budgets hands its note the row's own status", () => {
  test("the note's rows are built by `budgetNoteRow`, and by nothing else on the page", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/budgets/page.tsx"), "utf8");
    expect(src).toMatch(/budgetSectionNotes\(\{\s*rows:\s*statuses\.map\(budgetNoteRow\)\s*\}\)/);
    // ⛔ no second, inline build beside it
    expect(src).not.toContain("rolloverMayAddCents");
  });

  describe("from statuses `budgetPaceStatuses` returned", () => {
    const TODAY = "2026-08-11";
    let dir: string;
    let bundle: DbBundle;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-budgets-page-"));
      bundle = createDatabase(path.join(dir, "t.db"));
      seedDatabase(bundle.db);
    });

    afterEach(() => {
      bundle.sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function catId(name: string): string {
      const row = bundle.db
        .select()
        .from(categories)
        .where(and(eq(categories.name, name), isNull(categories.parentId)))
        .get();
      if (!row) throw new Error(`missing category ${name}`);
      return row.id;
    }

    /*
     * Food $30.00 a month rolling from Jul 1: spent from a stale card read through Jun 30, so July is held back with
     * $0.00 of it found and can still bank $30.00 — and $40.00 of August on a fresh one, over its line. Shopping, on
     * both cards, is graded on August read in part.
     */
    test("an over row whose line can still rise is said to have more to roll over, not to be over by at least", () => {
      const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
      const stale = createAccount(bundle.db, { institutionId: chase.id, name: "Stale", type: "credit" });
      const fresh = createAccount(bundle.db, { institutionId: chase.id, name: "Fresh", type: "credit" });
      const spend = (accountId: string, postedOn: string, cents: number, category: string): void => {
        const rawDescription = `SPEND ${postedOn} ${category} ${cents}`;
        const row = { accountId, postedOn, amountCents: -cents, rawDescription };
        bundle.db
          .insert(transactions)
          .values({
            ...row,
            normalizedDescription: rawDescription,
            categoryId: catId(category),
            dedupeHash: dedupeHash({ ...row, occurrenceIndex: 0 }),
          })
          .run();
      };
      spend(stale, "2026-06-15", 1_000, "Food");
      spend(stale, "2026-06-30", 500, "Shopping");
      spend(fresh, "2026-08-02", 4_000, "Food");
      spend(fresh, TODAY, 500, "Shopping");
      const food = createBudget(bundle.db, {
        categoryId: catId("Food"),
        period: "monthly",
        amountCents: 3_000,
        startsOn: "2026-07-01",
      });
      setBudgetRollover(bundle.db, food, { enabled: true });
      createBudget(bundle.db, {
        categoryId: catId("Shopping"),
        period: "monthly",
        amountCents: 10_000,
        startsOn: "2026-08-01",
      });

      const statuses = budgetPaceStatuses(bundle.db, TODAY);
      // the conditions under which the note spoke a false floor — without them this test could not fail
      const rolling = statuses.find((s) => s.categoryName === "Food")!;
      expect([rolling.pace, rolling.uncoveredDays, rolling.rolloverMayAddCents]).toEqual(["over", 11, 3_000]);

      const note = budgetSectionNotes({ rows: statuses.map(budgetNoteRow) }).find((n) => n.id === "budgets-coverage");
      expect(note?.body).toBe(
        "1 of 2 budgets show no verdict because they are grading days the ledger has not reached — up to 11 days on " +
          "Shopping. Their spend and percentages are lower bounds, not measurements. The one over its plan is " +
          "grading such days too, so it has spent at least what it shows, though more can still roll over into it.",
      );
    });
  });
});
