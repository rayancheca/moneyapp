import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { budgets, type BudgetPeriodKind } from "@/db/schema/budgets";
import { categories } from "@/db/schema/categories";
import { seedDatabase } from "@/db/seed";
import { budgetInsights } from "./budget-insights";

/**
 * Which budgets belong in the ranking, and what the sentences are allowed to
 * claim about a number nobody measured.
 *
 * The plan amounts are not tested here — `budgets` owns them. What is new is
 * the SET: monthly only, overlapping children excluded from both the ranking
 * and the denominator, and a proof that grades a decision rather than a sum.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-08-27";

const now = () => new Date().toISOString();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-budget-insights-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addCategory(id: string, name: string, parentId: string | null = null): string {
  bundle.db
    .insert(categories)
    .values({ id, name, parentId, kind: "expense", sortOrder: 0, createdAt: now(), updatedAt: now() })
    .run();
  return id;
}

let budgetSeq = 0;
function addBudget(categoryId: string, amountCents: number, period: BudgetPeriodKind = "monthly"): string {
  budgetSeq += 1;
  const id = `b-${budgetSeq}`;
  bundle.db
    .insert(budgets)
    .values({
      id,
      categoryId,
      period,
      amountCents,
      startsOn: "2026-01-01",
      endsOn: null,
      isActive: true,
      rolloverEnabled: false,
      rolloverStartsOn: null,
      rolloverCapCents: null,
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: now(),
    })
    .run();
  return id;
}

const texts = (): string[] => (budgetInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);

describe("budgetInsights — where the biggest plan sits", () => {
  test("ranks by amount and carries the basis inside the sentence", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 200_000);
    addBudget(addCategory("c-food", "Fix Food"), 50_000);
    addBudget(addCategory("c-fun", "Fix Fun"), 25_000);

    expect(texts()).toEqual([
      "Fix Housing is the largest of your 3 monthly budgets, by what you planned to spend, at $2,000.00.",
      "Fix Housing is more than half of everything you have budgeted for a month, at 72.7%.",
    ]);
  });

  test("under half, the plain share is the only honest form", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    addBudget(addCategory("c-food", "Fix Food"), 90_000);
    addBudget(addCategory("c-fun", "Fix Fun"), 80_000);

    expect(texts()[1]).toBe("Fix Housing is 37.0% of everything you have budgeted for a month.");
  });

  /**
   * ⛔ A daily $5 and an annual $400 are not comparable magnitudes. The page
   * already decided this for its income comparison — monthly budgets are "the
   * ones whose window matches a pay cycle" — and this borrows that set rather
   * than defining a second one.
   */
  test("budgets on other cadences are in neither the ranking nor the denominator", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    addBudget(addCategory("c-food", "Fix Food"), 50_000);
    // far larger than either, and on a different cadence
    addBudget(addCategory("c-trip", "Fix Travel"), 900_000, "annual");
    addBudget(addCategory("c-cab", "Fix Transport"), 400_000, "weekly");

    const r = budgetInsights(bundle.db, TODAY)!;
    expect(r.insights[0]!.text).toContain("Fix Housing is the largest of your 2 monthly budgets");
    // 100,000 / 150,000 — the annual and weekly plans are not in the whole
    expect(r.insights[1]!.text).toContain("66.7%");
    expect(r.windowNote).toContain("Ranked against the 2 monthly budgets");
  });

  /**
   * ⛔ A child budget inside a budgeted parent is counted in NEITHER the total
   * nor the ranking. Ranked but not counted, its share could exceed 1 — which
   * `shareFact` refuses outright rather than clamping, so the failure would be
   * a throw on his budgets page.
   */
  test("a child budget inside a budgeted parent is excluded from both sides", () => {
    const food = addCategory("c-food", "Fix Food");
    addCategory("c-dining", "Fix Dining", food);
    addBudget(food, 60_000);
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    addBudget("c-dining", 40_000);

    const r = budgetInsights(bundle.db, TODAY)!;
    expect(r.insights[0]!.text).toContain("largest of your 2 monthly budgets");
    // 100,000 / 160,000 — Dining's 40,000 is in neither the set nor the whole
    expect(r.insights[1]!.text).toContain("62.5%");
    expect(r.windowNote).toContain("1 budget sits inside another budgeted category and is counted in neither");
  });

  test("the overlap note is silent when nothing overlaps", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    addBudget(addCategory("c-food", "Fix Food"), 50_000);
    expect(budgetInsights(bundle.db, TODAY)!.windowNote).not.toMatch(/counted in neither/);
  });

  /**
   * ⛔ A plan is a DECISION, so it takes `budgetPlan` — not the `categorySpend`
   * the page already mounts beside each row's actual. Proving a plan with the
   * spending underneath it is the `merchant-insights` mistake: the rows a proof
   * names have to be the rows the figure came from, and a plan came from none.
   */
  test("the proof grades the plan, not the spending beside it", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    addBudget(addCategory("c-food", "Fix Food"), 50_000);

    for (const insight of budgetInsights(bundle.db, TODAY)!.insights) {
      expect(insight.provenance.verdict).toBe("manual");
      expect(insight.provenance.badgeWord).toBe("a plan");
      expect(insight.provenance.headline).toMatch(/This is a plan, not a record: \$1,000\.00 a month for Fix Housing/);
      // a summed-rows proof would say this; a plan's must not
      expect(insight.provenance.headline).not.toMatch(/sum of \d+ rows/);
    }
  });

  /**
   * ⛔ A share is REFUSED outside 0–1 rather than clamped, so a plan larger than
   * the total it is a share of throws inside a server component — a 500 on his
   * budgets page rather than a missing sentence. Cannot happen through the
   * schema (`budgetInputSchema` requires a positive amount) and the column is a
   * bare `integer notNull` with no CHECK, so it is guarded rather than assumed.
   */
  test("a plan larger than the whole drops the share instead of throwing", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    // written around the schema, exactly as a script could
    bundle.db.run(
      sql`INSERT INTO budgets (id, category_id, period, amount_cents, starts_on, is_active, rollover_enabled, created_at, updated_at)
          VALUES ('b-neg', ${addCategory("c-food", "Fix Food")}, 'monthly', -40000, '2026-01-01', 1, 0, '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z')`,
    );

    const r = budgetInsights(bundle.db, TODAY)!;
    // the rank still stands — it needs no denominator
    expect(r.insights[0]!.text).toContain("Fix Housing is the largest of your 2 monthly budgets");
    // …and the share, whose denominator is now smaller than its numerator, is gone
    expect(r.insights).toHaveLength(1);
  });

  /** One budget is not a ranking, and it is 100% of itself. */
  test("a single monthly budget says nothing rather than ranking itself first", () => {
    addBudget(addCategory("c-house", "Fix Housing"), 100_000);
    expect(budgetInsights(bundle.db, TODAY)).toBeNull();
  });

  test("no budgets at all says nothing", () => {
    expect(budgetInsights(bundle.db, TODAY)).toBeNull();
  });

  /**
   * Two plans set to the same amount must not swap places between renders and
   * make one of them "the largest" only sometimes.
   *
   * ⚠️ This test cannot currently FAIL by deletion of the tie-break, and that is
   * measured, not overlooked: `budgetStatuses` already ends its sort the same
   * way and JS sort is stable, so the guarantee is inherited. It is asserted
   * here because the day that upstream ordering changes for the page's benefit,
   * this is the only thing that notices.
   */
  test("equal plans are ordered by category path, every time", () => {
    addBudget(addCategory("c-z", "Fix Zebra"), 100_000);
    addBudget(addCategory("c-a", "Fix Aardvark"), 100_000);
    addBudget(addCategory("c-food", "Fix Food"), 10_000);

    for (let i = 0; i < 3; i++) expect(texts()[0]).toContain("Fix Aardvark is the largest");
  });
});
