import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ForecastCard } from "@/components/recurring/ForecastCard";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { predictCategory } from "./category-forecast";
import { forecastCurrentMonth, forecastForMonth, paceMonths } from "./forecast";

/*
 * ⚖️ His decision 71 (2026-10-13, asked as an either/or, the recommended option): an AVERAGE uses only months EVERY
 * account he spends from has been read through to the END of — `spendingCoverageThrough`, the day /spending's
 * What-moved and the year summary already cut at. The dashboard's six months (`baselineWindow`) and /budgets' guide
 * obeyed it; the two 3-month paces did not.
 *
 * 🔴 Review of cbee36b, measured on his ledger copy at 2026-10-13 (Chase Checking read through Aug 12): /recurring's
 * month forecast printed "Food | 3-mo avg $1,030.43 + trend -$827.43, × 19/31 days" over Jul–Sep, where the fully read
 * May–Jul read "3-mo avg $2,008.41 + trend -$176.57" — about $1,000 of Food missing from October's last 19 days and
 * from month-end cash; and /spending's "November 2026 ≈ $466.84" for Food (Predict budgets' too) stood on the same
 * three months — beside a /budgets guide reading "6-mo avg ≈ $2,216.50" that says Aug and Sep are left out unread.
 *
 * Here Checking spends $300.00 on Groceries on the 10th of every month and is read into July; the Card spends $500.00
 * on the 1st and is read only through May 12, where it spent $200.00 more. Both are live spenders, so the Card's May 12
 * is the day every account you spend from has been imported through: the pace reads Feb–Apr, $800.00 a month flat,
 * where the calendar's Apr–Jun read $800.00, $1,000.00 (May's part) and $300.00 (June without the Card).
 */
const TODAY = "2026-07-08"; // July: 31 days, 24 remaining including today

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;
let brokerageId: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pace-read-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  brokerageId = createAccount(bundle.db, { institutionId: chase.id, name: "Brokerage", type: "investment" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function groceries(accountId: string, postedOn: string, amountCents: number): void {
  seq += 1;
  const rawDescription = `FIXTURE ${seq}`;
  const categoryId = bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!.id;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId,
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: seq }),
    })
    .run();
}

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

/** Checking: $300.00 on the 10th of Jan–Jun, read into July. The Card: $500.00 on the 1st of each month to `cardTo`. */
function ledger(cardThrough: string): void {
  for (const m of MONTHS) groceries(checkingId, `${m}-10`, -30000);
  groceries(checkingId, "2026-07-02", -1000);
  for (const m of MONTHS) if (`${m}-01` <= cardThrough) groceries(cardId, `${m}-01`, -50000);
  if (!cardThrough.endsWith("-01")) groceries(cardId, cardThrough, -20000);
}

const food = (f: { components: { label: string; detail: string; cents: number }[] }) =>
  f.components.find((c) => c.label === "Food");

describe("the spending pace averages only months every account you spend from is read to its end (decision 71)", () => {
  test("a month the Card is read only part of the way through is left out, and the three months slide back", () => {
    ledger("2026-05-12");
    const pace = paceMonths(bundle.db, TODAY);
    expect(pace.windows.map((w) => w.key)).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(pace.unread).toEqual({ months: ["2026-05", "2026-06"], through: "2026-05-12" });

    // Feb–Apr: $800.00 each — never Apr–Jun's "3-mo avg $700.00 + trend -$250.00", whose June holds no Card at all
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(food(f)?.detail).toBe("3-mo avg $800.00 + trend $0.00, × 24/31 days");
    expect(food(f)?.cents).toBe(-Math.round((80000 * 24) / 31));
  });

  test("a later month's forecast reads the same three months", () => {
    ledger("2026-05-12");
    expect(food(forecastForMonth(bundle.db, "2026-08", TODAY)!)?.detail).toBe(
      "3-mo avg $800.00 + trend $0.00, × 31/31 days",
    );
  });

  test("…and so does the category forecast /spending and Predict budgets read", () => {
    ledger("2026-05-12");
    const p = predictCategory(bundle.db, categoryIdOf("Food"), "Food", TODAY);
    // three flat months of $800.00: no trend, and no same-month-last-year (Aug 2025 predates the ledger)
    expect(p.forecast.discretionaryCents).toBe(80000);
    expect(p.forecast.expectedTotalCents).toBe(80000);
  });

  test("the card says which months its spending pace averaged, and why the later ones are left out", () => {
    ledger("2026-05-12");
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const note =
      "Spending's pace is averaged over 3 complete months, Feb 2026 to Apr 2026. May 2026 and Jun 2026 are left out: " +
      "May 12 is the last day every account you spend from has been imported through.";
    expect(f.spendPaceNote).toBe(note);
    expect(forecastForMonth(bundle.db, "2026-08", TODAY)!.spendPaceNote).toBe(note);
    const card = renderToStaticMarkup(createElement(ForecastCard, { forecast: f }))
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    expect(card).toContain(note);
  });

  test("an account read through a month's own last day reads that month: the calendar's three, and no note", () => {
    ledger("2026-06-01");
    groceries(cardId, "2026-06-30", -20000);
    expect(paceMonths(bundle.db, TODAY)).toMatchObject({ unread: null });
    expect(paceMonths(bundle.db, TODAY).windows.map((w) => w.key)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(forecastCurrentMonth(bundle.db, TODAY).spendPaceNote).toBeNull();
  });

  test("a day inside the running month leaves the pace as the calendar has it", () => {
    ledger("2026-06-01");
    groceries(cardId, "2026-07-03", -20000);
    const f = forecastCurrentMonth(bundle.db, TODAY);
    // Apr–Jun at $800.00 each, the Card's July row in the running month
    expect(food(f)?.detail).toBe("3-mo avg $800.00 + trend $0.00, × 24/31 days");
    expect(f.spendPaceNote).toBeNull();
  });

  test("no account you spend from at all is the calendar's three months", () => {
    groceries(brokerageId, "2026-05-03", -1000);
    expect(paceMonths(bundle.db, TODAY)).toEqual({
      windows: [
        { start: "2026-04-01", end: "2026-04-30", key: "2026-04" },
        { start: "2026-05-01", end: "2026-05-31", key: "2026-05" },
        { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
      ],
      unread: null,
    });
  });
});

function categoryIdOf(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}
