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
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { baselineCaption } from "@/lib/committed";
import { createAccount } from "./accounts";
import { predictCategory } from "./category-forecast";
import { spendBaseline } from "./committed";
import { forecastCurrentMonth, forecastForMonth, paceMonths, type MonthForecast } from "./forecast";

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
  filed(accountId, postedOn, amountCents, "Groceries");
}

function filed(accountId: string, postedOn: string, amountCents: number, category: string): void {
  seq += 1;
  const rawDescription = `FIXTURE ${seq}`;
  const categoryId = bundle.db.select().from(categories).where(eq(categories.name, category)).get()!.id;
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
    // the ledger opens in March, so its first whole month (April) floors none of them
    groceries(brokerageId, "2026-03-03", -1000);
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

/*
 * 🔴 Review of 6d11c4d: `paceMonths` slid its three months back behind the frontier with no floor, so on a young ledger
 * they could slide ENTIRELY before its first record. Measured with this fixture's shape at 2026-08-27 (the ledger opens
 * Jun 1; Checking spends $400.00 on Groceries and banks $3,000.00 of Salary in each of Jun, Jul and Aug; the Card is
 * read only to Jun 12, where it spent $100.00): /recurring read "Income +$322.58 Spending $0.00 Net +$322.58 EOM cash
 * $322.58 … Spending's pace is averaged over 3 complete months, Mar 2026 to May 2026. Jun 2026 and Jul 2026 are left
 * out: Jun 12 is …" — three months before the first record, a month-end cash with no spending in it — beside a runway
 * saying "No month has been read in full yet". Its parent commit read the same ledger's Spending at the pace as
 * −$80.65, with no note.
 */
const YOUNG_TODAY = "2026-08-27"; // August: 31 days, 5 remaining including today

/** What the pace row says where the income pace has fewer months than its presence gate needs (`incomePaceNote`). */
const NO_INCOME_PACE =
  "Money in has no recent pace yet: a kind of income counts toward it once it has come in 2 complete months, so a " +
  "one-off never does.";

/** The ledger opens Jun 1: Checking spends $400.00 on Groceries on the 1st and banks $3,000.00 of Salary on the 2nd. */
function youngLedger(): void {
  for (const m of ["2026-06", "2026-07", "2026-08"]) {
    groceries(checkingId, `${m}-01`, -40000);
    filed(checkingId, `${m}-02`, 300000, "Salary");
  }
}

/** A confirmed monthly series on Checking, next due `due`, last matched a month before. */
function confirmedMonthly(name: string, kind: "bill" | "income", cents: number, due: string): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      name,
      kind,
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: due,
      nextExpectedAmountCents: cents,
      status: "confirmed",
      toleranceDays: 3,
      lastMatchedOn: `2026-07-${due.slice(8)}`,
      accountId: checkingId,
    })
    .run();
}

/** The card's text, tags dropped. */
function cardText(f: MonthForecast): string {
  return renderToStaticMarkup(createElement(ForecastCard, { forecast: f }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

describe("…and never from before the ledger's first whole month (`baselineWindow`'s floor)", () => {
  const unreadNote =
    "No month has been read in full yet, so there is no spending average to stand on. Jun 2026 and Jul 2026 are " +
    "left out: Jun 12 is the last day every account you spend from has been imported through.";

  test("a frontier before the first whole month leaves the pace no month, never three before the first record", () => {
    youngLedger();
    groceries(cardId, "2026-06-12", -10000);
    expect(paceMonths(bundle.db, YOUNG_TODAY)).toEqual({
      windows: [],
      unread: { months: ["2026-06", "2026-07"], through: "2026-06-12" },
    });

    const f = forecastCurrentMonth(bundle.db, YOUNG_TODAY);
    expect(food(f)).toBeUndefined();
    expect(f.spendPaceMonths).toBe(0);
    expect(f.spendPaceNote).toBe(unreadNote);
    // ⛔ the dashboard's caption over the same window, word for word
    expect(baselineCaption(spendBaseline(bundle.db, YOUNG_TODAY))).toBe(unreadNote);
    expect(forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!.spendPaceNote).toBe(unreadNote);
  });

  test("the card holds the pace row's figures back and says why — never Spending $0.00 and its EOM cash", () => {
    youngLedger();
    groceries(cardId, "2026-06-12", -10000);
    const card = cardText(forecastCurrentMonth(bundle.db, YOUNG_TODAY));
    const pace = card.slice(card.indexOf("If you also spend"), card.indexOf("Show the math")).trim();
    expect(pace).toBe(`If you also spend at your recent pace ${unreadNote}`);
  });

  /*
   * 🔴 Review of 06a5d3e: the fix held back the pace ROW alone, and the composition band directly above it read the
   * same empty pace the old way: "Money out · Committed $1,500.00 (1 line) · Recent pace $0.00 (0 lines)", its bar
   * drawn 100% committed, over the row's sentence saying there is no spending average to stand on. A part of no month
   * is not a part of nothing: the band says "—" there and draws no share it cannot know.
   */
  test('the band holds the spending pace back too: never "Recent pace $0.00" over the sentence saying there is none', () => {
    youngLedger();
    groceries(cardId, "2026-06-12", -10000);
    confirmedMonthly("Rent", "bill", -150000, "2026-08-30");
    const f = forecastCurrentMonth(bundle.db, YOUNG_TODAY);
    const card = cardText(f);
    const band = (from: string, to: string) => card.slice(card.indexOf(from), card.indexOf(to)).trim();
    expect(band("Money out", "If you also spend")).toBe("Money out Committed $1,500.00 (1 line) Recent pace —");
    // ⚖️ the income pace is measured (decision 71 exempts it from the frontier), so its part prints, as in the math
    expect(band("Money in", "Money out")).toBe("Money in Scheduled $0.00 (0 lines) Recent pace $483.87 (1 line)");

    // …and the Money out bar draws no share: 100% committed would say nothing discretionary is coming
    const html = renderToStaticMarkup(createElement(ForecastCard, { forecast: f }));
    const outHtml = html.slice(html.indexOf("Money out"), html.indexOf("If you also spend"));
    expect(outHtml).not.toContain("width:");
  });

  test("a ledger younger than one whole month says no complete month has been imported, as the runway does", () => {
    groceries(checkingId, "2026-08-05", -40000);
    filed(checkingId, "2026-08-06", 300000, "Salary");
    const f = forecastCurrentMonth(bundle.db, YOUNG_TODAY);
    expect(paceMonths(bundle.db, YOUNG_TODAY)).toEqual({ windows: [], unread: null });
    expect(f.spendPaceNote).toBe(
      "No complete month has been imported yet, so there is no spending average to stand on.",
    );
    expect(f.spendPaceNote).toBe(baselineCaption(spendBaseline(bundle.db, YOUNG_TODAY)));
  });

  test("the category forecast reads no month either: nothing stands on months before the first record", () => {
    youngLedger();
    groceries(cardId, "2026-06-12", -10000);
    const p = predictCategory(bundle.db, categoryIdOf("Food"), "Food", YOUNG_TODAY);
    expect(p.forecast.parts.find((x) => x.key === "discretionary")).toMatchObject({
      cents: 0,
      basis: "no prior periods",
    });
  });

  test("a floor that shortens the window averages the months the ledger has: two as two, not three with a zero", () => {
    youngLedger();
    expect(paceMonths(bundle.db, YOUNG_TODAY)).toEqual({
      windows: [
        { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
        { start: "2026-07-01", end: "2026-07-31", key: "2026-07" },
      ],
      unread: null,
    });
    // never "3-mo avg $266.67 + trend $200.00": May, before the ledger opened, is not a month of nothing
    const f = forecastCurrentMonth(bundle.db, YOUNG_TODAY);
    expect(food(f)?.detail).toBe("2-mo avg $400.00 + trend $0.00, × 5/31 days");
    expect(f.spendPaceMonths).toBe(2);
    expect(f.spendPaceNote).toBeNull();
    const p = predictCategory(bundle.db, categoryIdOf("Food"), "Food", YOUNG_TODAY);
    expect(p.forecast.parts.find((x) => x.key === "discretionary")).toMatchObject({
      cents: 40000,
      basis: "avg of last 2 periods",
    });
  });

  /*
   * 🔴 Review of 06a5d3e: decision 71 exempts the income pace from the FRONTIER (it is the day every account he spends
   * from is read to), never from the FLOOR. `variableIncomeComponents` still averaged the calendar's three months with
   * none, and on this ledger at 2026-08-27 the card's math read "Salary | avg of last 3 periods, present 2/3 mo, × 5/31
   * days | +$322.58" — May, before the ledger opened, averaged as a month of no pay: a third of the pace gone, and the
   * band's "Money in · Recent pace $322.58" and the components' net with it.
   */
  test("the income pace floors at the first whole month too: Salary over Jun–Jul as two, never May as $0", () => {
    youngLedger();
    groceries(cardId, "2026-06-12", -10000);
    const salary = (f: MonthForecast) => f.components.find((c) => c.label === "Salary");

    // the calendar's Jun–Jul (Aug is the running month), not cut by the Card's Jun 12: $3,000.00 each
    expect(salary(forecastCurrentMonth(bundle.db, YOUNG_TODAY))).toMatchObject({
      kind: "variable",
      cents: Math.round((300000 * 5) / 31),
      detail: "avg of last 2 periods, present 2/2 mo, × 5/31 days",
    });
    // a later month's forecast reads the same two
    expect(salary(forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!)).toMatchObject({
      cents: 300000,
      detail: "avg of last 2 periods, present 2/2 mo, × 30/30 days",
    });
  });

  test("a ledger younger than one whole month projects no income pace, never one over months before it", () => {
    groceries(checkingId, "2026-08-05", -40000);
    filed(checkingId, "2026-08-06", 300000, "Salary");
    filed(checkingId, "2026-08-20", 300000, "Salary");
    const f = forecastCurrentMonth(bundle.db, YOUNG_TODAY);
    expect(f.components.filter((c) => c.kind === "variable")).toEqual([]);
    expect(forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!.components.filter((c) => c.kind === "variable")).toEqual(
      [],
    );
  });

  /*
   * 🔴 Review of f1a0180: the band withheld Money OUT's pace alone. On a ledger opening Aug 5 there is no whole month
   * to average either side over, and Money in still read "Scheduled $2,000.00 (1 line) Recent pace $0.00 (0 lines)",
   * its bar drawn 100% scheduled, beside Money out's "Recent pace —" — one cause, two treatments. An income pace of no
   * month is no more a pace of nothing than a spending one.
   */
  test('the band holds the income pace back where it has no month: "Recent pace —" on both sides, no bar drawn', () => {
    groceries(checkingId, "2026-08-05", -40000);
    filed(checkingId, "2026-08-06", 300000, "Salary");
    filed(checkingId, "2026-08-20", 300000, "Salary");
    confirmedMonthly("Pay", "income", 200000, "2026-08-29");
    confirmedMonthly("Rent", "bill", -150000, "2026-08-30");

    for (const f of [forecastCurrentMonth(bundle.db, YOUNG_TODAY), forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!]) {
      const card = cardText(f);
      const band = (from: string, to: string) => card.slice(card.indexOf(from), card.indexOf(to)).trim();
      expect(band("Money in", "Money out")).toBe("Money in Scheduled $2,000.00 (1 line) Recent pace —");
      expect(band("Money out", "If you also spend")).toBe("Money out Committed $1,500.00 (1 line) Recent pace —");
      // …and neither bar draws a share: "100% scheduled" would say no other money is coming
      const html = renderToStaticMarkup(createElement(ForecastCard, { forecast: f }));
      expect(html.slice(html.indexOf("Money in"), html.indexOf("If you also spend"))).not.toContain("width:");
      expect(f.incomePaceMonths).toBe(0);
    }
  });

  test("…and the pace row says why Money in has none, after the spending sentence it shares a cause with", () => {
    groceries(checkingId, "2026-08-05", -40000);
    filed(checkingId, "2026-08-06", 300000, "Salary");
    filed(checkingId, "2026-08-20", 300000, "Salary");
    confirmedMonthly("Rent", "bill", -150000, "2026-08-30");
    const card = cardText(forecastCurrentMonth(bundle.db, YOUNG_TODAY));
    expect(card.slice(card.indexOf("If you also spend"), card.indexOf("Show the math")).trim()).toBe(
      "If you also spend at your recent pace No complete month has been imported yet, so there is no spending " +
        `average to stand on. ${NO_INCOME_PACE}`,
    );
  });

  /*
   * 🔴 Review of 0795a2a: the band withheld Money in's pace only where it had NO month, and an income pace needs two —
   * a kind of income counts as ongoing once it has come in `MIN_INCOME_MONTHS_PRESENT` of the months averaged, so over
   * one month every income pace is $0.00 by construction. On a ledger opening Jul 1 (Groceries $400.00 on the 1st and
   * Salary $3,000.00 on the 2nd of Jul and Aug), at 2026-08-27 Money in read "Scheduled $2,000.00 (1 line) Recent pace
   * $0.00 (0 lines)", drawn 100% scheduled, beside Money out's "Recent pace $64.52 (1 line)" over the same July: a
   * $0.00 its one month cannot measure, not one it did.
   */
  test('one complete month is no income pace either: Money in reads "Recent pace —" and the pace row says why', () => {
    for (const m of ["2026-07", "2026-08"]) {
      groceries(checkingId, `${m}-01`, -40000);
      filed(checkingId, `${m}-02`, 300000, "Salary");
    }
    confirmedMonthly("Pay", "income", 200000, "2026-08-29");
    confirmedMonthly("Rent", "bill", -150000, "2026-08-30");
    const why = `${NO_INCOME_PACE} Jul 2026 is the only complete month imported so far.`;

    const months: [MonthForecast, string][] = [
      [forecastCurrentMonth(bundle.db, YOUNG_TODAY), "$64.52"],
      [forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!, "$400.00"],
    ];
    for (const [f, spendPace] of months) {
      const card = cardText(f);
      const band = (from: string, to: string) => card.slice(card.indexOf(from), card.indexOf(to)).trim();
      expect(band("Money in", "Money out")).toBe("Money in Scheduled $2,000.00 (1 line) Recent pace —");
      expect(f.incomePaceMonths).toBe(1);
      expect(f.incomePaceNote).toBe(why);
      // ⚖️ spending's one month is a measurement — spending projects every bucket — so Money out's pace still prints
      expect(band("Money out", "If you also spend")).toBe(
        `Money out Committed $1,500.00 (1 line) Recent pace ${spendPace} (1 line)`,
      );
      // the Money in bar draws no share ("100% scheduled" would say no other money is coming); Money out's still does
      const html = renderToStaticMarkup(createElement(ForecastCard, { forecast: f }));
      expect(html.slice(html.indexOf("Money in"), html.indexOf("Money out"))).not.toContain("width:");
      expect(html.slice(html.indexOf("Money out"), html.indexOf("If you also spend"))).toContain("width:");
      // the pace row prints its figures — its Income is the scheduled $2,000.00 alone — and says why
      const pace = band("If you also spend", "Show the math");
      expect(pace).toContain("Income +$2,000.00");
      expect(pace.endsWith(why)).toBe(true);
    }
  });

  test("the income pace's month count is the months it averaged: two on a ledger opening Jun 1", () => {
    youngLedger();
    groceries(cardId, "2026-06-12", -10000);
    expect(forecastCurrentMonth(bundle.db, YOUNG_TODAY).incomePaceMonths).toBe(2);
    expect(forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!.incomePaceMonths).toBe(2);
  });
});

function categoryIdOf(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}
