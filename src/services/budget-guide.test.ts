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
import { addCalendarMonths, monthKey } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { budgetGuidanceCents, budgetGuides } from "./budget-guide";
import { createBudget } from "./budgets";
import { baselineWindow, spendBaseline } from "./committed";
import { importedThrough } from "./imported-through-fixture";

let dir: string;
let bundle: DbBundle;
let cardId: string;
let checkingId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-budget-guide-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
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
function spend(postedOn: string, amountCents: number, categoryPath: string, accountId: string = cardId): void {
  seq += 1;
  const rawDescription = `SPEND ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: catId(categoryPath),
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
    })
    .run();
}

/** the 1st of every month from `fromMonth` to `toMonth`, inclusive */
function monthsFrom(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  for (let m = fromMonth; m <= toMonth; m = monthKey(addCalendarMonths(`${m}-01`, 1))) out.push(m);
  return out;
}

describe("budgetGuidanceCents — 6-month daily rate, period-agnostic", () => {
  test("expresses trailing spend at the budget period's length; refunds clamp to 0", () => {
    // 18,100 over 181 days (Jan–Jun 2026) = 100/day exactly
    spend("2026-01-01", -18_100, "Food > Dining");
    // ⚖️ the import reaches into the running month (decision 71): Jan–Jun are each read to their end
    importedThrough(bundle.db, "2026-07-10");
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "monthly", "2026-07-15")).toBe(3_100); // 100 × 31
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "weekly", "2026-07-15")).toBe(700); // 100 × 7
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "daily", "2026-07-15")).toBe(100); // 100 × 1

    // a net-refund history never suggests a negative budget
    spend("2026-02-10", 30_000, "Travel > Flights");
    expect(budgetGuidanceCents(bundle.db, catId("Travel"), "monthly", "2026-07-15")).toBe(0);
  });
});

/*
 * ⚖️ His decision 71 (2026-10-13, asked as an either/or, the recommended option): an AVERAGE uses only months EVERY
 * account he spends from has been read through to the END of — `baselineWindow`, the dashboard's window. 🔴 Review of
 * cf8f8dc, measured on his ledger copy that day: the editor's "6-mo avg ≈" still averaged the calendar's Apr–Sep —
 * Food $1,517.03 where the fully read Feb–Jul make it $2,216.50, below the dashboard's own Eating out ($1,963.24 a
 * month over Feb–Jul), which is part of Food; Housing $2,762.43 vs $2,161.72; Car $347.71 vs nothing — while the same
 * rows printed "Spent — · Left —" for the days nobody had read (decision 64).
 *
 * Here the Card is a live spender — $100 of Food on the 1st of every month from January — read only through `through`;
 * Checking spends $200 of Food on the 5th of every month and is read on into August, with $3,000 more in July.
 */
describe("the budget guide averages only months every account you spend from is read to the end of (decision 71)", () => {
  const TODAY = "2026-08-15"; // August: 31 days

  function ledger(cardThrough: string, opensMonth = "2026-01"): void {
    for (const m of monthsFrom(opensMonth, "2026-08")) spend(`${m}-05`, -20_000, "Food > Groceries", checkingId);
    spend("2026-07-20", -300_000, "Food > Groceries", checkingId);
    for (const m of monthsFrom(opensMonth, monthKey(cardThrough))) spend(`${m}-01`, -10_000, "Food > Dining");
    if (!cardThrough.endsWith("-01")) spend(cardThrough, -10_000, "Food > Dining");
  }

  function guideOf(categoryPath: string) {
    const categoryId = catId(categoryPath);
    const id = createBudget(bundle.db, { categoryId, period: "monthly", amountCents: 50_000, startsOn: "2026-01-01" });
    return budgetGuides(bundle.db, [{ id, categoryId, period: "monthly" }], TODAY).get(id) ?? null;
  }

  test("a month an account you spend from is read only part of the way through is left out, and the guide slides back", () => {
    ledger("2026-07-12");
    // Jan–Jun: the Card's $100 and Checking's $200 in each, over their 181 days, at August's 31 — July's $3,000 is out
    expect(guideOf("Food")).toEqual({
      cents: Math.round((180_000 / 181) * 31),
      lead: "6-mo avg",
      note:
        "Averaged over 6 complete months, Jan 2026 to Jun 2026. Jul 2026 is left out: Jul 12 is the last day every " +
        "account you spend from has been imported through.",
    });
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "monthly", TODAY)).toBe(Math.round((180_000 / 181) * 31));
  });

  /** ONE WINDOW: the guide's months are the runway's, the window every dashboard card quotes */
  test("the guide's months are the dashboard's", () => {
    ledger("2026-07-12");
    const w = baselineWindow(bundle.db, TODAY);
    expect(w).toMatchObject({ fromMonth: "2026-01", toMonth: "2026-06", months: 6 });
    expect(spendBaseline(bundle.db, TODAY)).toMatchObject({ fromMonth: "2026-01", toMonth: "2026-06" });
    expect(guideOf("Food")?.note).toContain("Jan 2026 to Jun 2026");
  });

  test("an account read through a month's own last day reads that month", () => {
    ledger("2026-07-31");
    // Feb–Jul (181 days): the Card's $100 a month and the Jul 31 row, Checking's $200 a month and July's $3,000
    expect(guideOf("Food")).toEqual({
      cents: Math.round(((10_000 * 7 + 20_000 * 6 + 300_000) / 181) * 31),
      lead: "6-mo avg",
      note: null,
    });
  });

  test("a day inside the running month leaves the guide as the calendar has it", () => {
    ledger("2026-08-10");
    expect(guideOf("Food")).toEqual({
      cents: Math.round(((10_000 * 6 + 20_000 * 6 + 300_000) / 181) * 31),
      lead: "6-mo avg",
      note: null,
    });
  });

  /** ⛔ a month before the ledger opens is not a month of nothing spent: the guide keeps `baselineWindow`'s floor */
  test("a young ledger's guide averages only the months it holds whole, and says how many", () => {
    ledger("2026-08-02", "2026-04");
    // Apr–Jul (122 days): $300 a month and July's $3,000 — not spread over the six months a calendar would ask for
    expect(guideOf("Food")).toEqual({
      cents: Math.round(((30_000 * 4 + 300_000) / 122) * 31),
      lead: "4-mo avg",
      note: null,
    });
  });

  /** ⛔ a month nobody has read in full is not a measurement — with none, there is no guide to print, not a $0 one */
  test("a frontier before every whole month leaves no guide", () => {
    ledger("2026-06-12", "2026-06");
    expect(baselineWindow(bundle.db, TODAY).months).toBe(0);
    expect(guideOf("Food")).toBeNull();
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "monthly", TODAY)).toBe(0);
  });

  test("a category with nothing spent over the window has no guide", () => {
    ledger("2026-07-12");
    expect(guideOf("Travel")).toBeNull();
  });
});
