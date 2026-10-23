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
import { createAccount } from "./accounts";
import { checkedThrough } from "./checked-days-fixture";
import { forecastCurrentMonth, forecastForMonth, incomePaceMonths, type MonthForecast } from "./forecast";
import { ledgerOpenedOn } from "./imported-through-fixture";

/*
 * ⚖️ Default built, not asked (2026-10-23) — his decision 71 (2026-10-13) carried to the INCOME pace, option (A) of
 * batch 6's forecast fixer (he said "no more questions, follow the instructions"): the income pace ends at the last
 * month every account his income lands in has been read through to the END of, as spending's three end at the last
 * one every account he spends from has (`paceMonths`). "A month read to its 12th is not a twelfth of a measurement."
 *
 * 🔴 Measured on his ledger copy (batch 6, at 2026-10-21; re-measured at 2026-10-23): every Dividends and Interest row
 * the pace reads lands on Robinhood Cash, whose rows run to Sep 9, and the pace averaged the calendar's Jul–Sep —
 * September's $0.07 of dividends counted as a whole month's. Read in full, Jun–Aug: the rest of October $11.49 →
 * $18.02 at 2026-10-21 ($9.40 → $14.74 at 2026-10-23, Oct 23–31), November $32.38 → $50.79.
 *
 * Here Brokerage Cash is paid $30.00 of Dividends on the 15th of Jan–Aug and $0.07 on Sep 9, its newest row; Checking
 * spends $100.00 on Groceries on the 5th of every month and is read into October, so spending's own three are the
 * calendar's and say nothing.
 */
const TODAY = "2026-10-23"; // October: 31 days, 9 remaining including today

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cashId: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-income-pace-read-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  checkingId = account("Checking", "checking");
  cashId = account("Brokerage Cash", "checking");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function account(name: string, type: "checking" | "savings" | "credit"): string {
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return createAccount(bundle.db, { institutionId: chase.id, name, type });
}

/** A row filed under `category` — or, with null, the one-cent uncategorised credit that only says a day was read. */
function row(accountId: string, postedOn: string, amountCents: number, category: string | null): void {
  seq += 1;
  const rawDescription = `FIXTURE ${seq}`;
  const categoryId =
    category === null ? null : bundle.db.select().from(categories).where(eq(categories.name, category)).get()!.id;
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

function categoryIdOf(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

/** An account shown through `day` with nothing on it that day. */
function readThrough(accountId: string, day: string): void {
  row(accountId, day, 1, null);
}

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

/** His ledger's shape: Brokerage Cash paid Dividends to Sep 9; Checking spending and read into October. */
function ledger(): void {
  ledgerOpenedOn(bundle.db, "2026-01-01");
  for (const m of [...MONTHS, "2026-09", "2026-10"]) row(checkingId, `${m}-05`, -10000, "Groceries");
  readThrough(checkingId, "2026-10-20");
  for (const m of MONTHS) row(cashId, `${m}-15`, 3000, "Dividends");
  row(cashId, "2026-09-09", 7, "Dividends");
}

const line = (f: MonthForecast, label: string) => f.components.find((c) => c.kind === "variable" && c.label === label);

/** The card's text, tags dropped. */
function cardText(f: MonthForecast): string {
  return renderToStaticMarkup(createElement(ForecastCard, { forecast: f }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

/*
 * 🔴 Review of af84411 (MEDIUM): the day was named "the last day every account your income lands in has been imported
 * through" while it is read off the accounts the PACE reads — never the payroll's, which a live series projects by its
 * schedule. With Robinhood Cash shown through Oct 9 and Wells Fargo (his pay) read to Sep 24, at 2026-11-10 one card
 * read "Oct 9 is the last day every account your income lands in has been imported through" two lines under "It falls
 * after Thu, Sep 24, 2026, the last day every account that pay lands in has been checked through". So it names them.
 */
const JUN_TO_AUG =
  "Money in's pace is averaged over 3 complete months, Jun 2026 to Aug 2026. Sep 2026 is left out: Sep 9 is the last " +
  "day Brokerage Cash has been imported through.";

describe("the income pace averages only months every account its income lands in is read to its end", () => {
  test("Brokerage Cash read to Sep 9 leaves September out: Jun–Aug, never the calendar's Jul–Sep", () => {
    ledger();
    expect(incomePaceMonths(bundle.db, TODAY)).toEqual({
      windows: [
        { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
        { start: "2026-07-01", end: "2026-07-31", key: "2026-07" },
        { start: "2026-08-01", end: "2026-08-31", key: "2026-08" },
      ],
      unread: { months: ["2026-09"], through: "2026-09-09", accounts: ["Brokerage Cash"] },
    });

    // $30.00 a month read in full — never Jul–Sep's (30.00 + 30.00 + 0.07) / 3, nine days of it $5.81
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(line(f, "Dividends")).toMatchObject({
      cents: Math.round((3000 * 9) / 31),
      detail: "avg of last 3 periods, present 3/3 mo, × 9/31 days",
    });
    expect(f.incomePaceMonths).toBe(3);
    expect(f.spendPaceNote).toBeNull();
    expect(f.incomePaceNote).toBe(JUN_TO_AUG);
  });

  test("a later month's forecast reads the same three months, and says so", () => {
    ledger();
    const november = forecastForMonth(bundle.db, "2026-11", TODAY)!;
    expect(line(november, "Dividends")).toMatchObject({
      cents: 3000,
      detail: "avg of last 3 periods, present 3/3 mo, × 30/30 days",
    });
    expect(november.incomePaceNote).toBe(JUN_TO_AUG);
  });

  test("the card's pace row names Money in's months and why", () => {
    ledger();
    const card = cardText(forecastCurrentMonth(bundle.db, TODAY));
    const pace = card.slice(card.indexOf("If you also spend"), card.indexOf("Show the math"));
    expect(pace).toContain(JUN_TO_AUG);
  });

  /*
   * ⚖️ The accounts that date it are the ones its own income comes in on HABITUALLY — in at least the presence gate's
   * two of the pace's three months before the month asked (`spendingCoverageThrough`'s live spenders, asked in the
   * income pace's own terms). 🔴 On his ledger SoFi Savings earned Interest in Mar, Apr and May and nothing since, and
   * is read through Jul 31: by spending's six-month habit (three of Mar–Aug) it would have held Money in's months back
   * to May–Jul.
   */
  test("a dormant account that last earned in May, read through Jul 31, does not hold the months back", () => {
    ledger();
    const savingsId = account("Savings", "savings");
    for (const m of ["2026-03", "2026-04", "2026-05"]) row(savingsId, `${m}-28`, 200, "Interest");
    readThrough(savingsId, "2026-07-31");

    expect(incomePaceMonths(bundle.db, TODAY).unread).toEqual({
      months: ["2026-09"],
      through: "2026-09-09",
      accounts: ["Brokerage Cash"],
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.incomePaceNote).toBe(JUN_TO_AUG);
    // Jun–Aug held no Interest: May's is no part of the pace
    expect(line(f, "Interest")).toBeUndefined();
  });

  test("a live account read only to Aug 12 holds them back to May–Jul, and the row says why", () => {
    ledger();
    const savingsId = account("Savings", "savings");
    for (const m of MONTHS) row(savingsId, `${m}-03`, 500, "Interest");
    readThrough(savingsId, "2026-08-12");

    expect(incomePaceMonths(bundle.db, TODAY).unread).toEqual({
      months: ["2026-08", "2026-09"],
      through: "2026-08-12",
      accounts: ["Brokerage Cash", "Savings"],
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(line(f, "Interest")).toMatchObject({ cents: Math.round((500 * 9) / 31) });
    expect(line(f, "Dividends")).toMatchObject({ cents: Math.round((3000 * 9) / 31) });
    expect(f.incomePaceNote).toBe(
      "Money in's pace is averaged over 3 complete months, May 2026 to Jul 2026. Aug 2026 and Sep 2026 are left out: " +
        "Aug 12 is the last day both Brokerage Cash and Savings have been imported through.",
    );
  });

  test("once September is read to its end the calendar's three return by themselves, and no note", () => {
    ledger();
    readThrough(cashId, "2026-09-30");
    expect(incomePaceMonths(bundle.db, TODAY)).toMatchObject({ unread: null });
    expect(incomePaceMonths(bundle.db, TODAY).windows.map((w) => w.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    const f = forecastCurrentMonth(bundle.db, TODAY);
    // Jul–Sep's mean to the cent, then nine days of it — the engine's order
    expect(line(f, "Dividends")).toMatchObject({ cents: Math.round((Math.round((3000 + 3000 + 7) / 3) * 9) / 31) });
    expect(f.incomePaceNote).toBeNull();
  });

  /*
   * ⛔ The pace's OWN rows date it (`hisIncomePaceRows`): a payday a live series owns projects by its schedule, and a
   * refund or a gift never projects (`EVENT_DRIVEN_INCOME`). 🔴 On his ledger the payroll lands on Wells Fargo (read to
   * Sep 24) and Chase Checking's one-offs (read to Aug 12): counted, either would hold Money in's months back for
   * money the pace never averages.
   */
  test("only the pace's own income dates it: never a payday a series owns, nor a refund", () => {
    ledger();
    const payId = account("Pay Checking", "checking");
    const series = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Payroll",
        kind: "income",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-10-28",
        nextExpectedAmountCents: 300000,
        status: "confirmed",
        toleranceDays: 3,
        lastMatchedOn: "2026-07-28",
        accountId: payId,
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    for (const m of ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]) {
      row(payId, `${m}-28`, 300000, "Salary");
      row(payId, `${m}-10`, 2500, "Other Income");
    }
    bundle.db.update(transactions).set({ recurringSeriesId: series }).where(eq(transactions.accountId, payId)).run();
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: null })
      .where(eq(transactions.categoryId, categoryIdOf("Other Income")))
      .run();
    readThrough(payId, "2026-08-12");

    expect(incomePaceMonths(bundle.db, TODAY).unread).toEqual({
      months: ["2026-09"],
      through: "2026-09-09",
      accounts: ["Brokerage Cash"],
    });
    // …and the row names the account it reads, never the one the pay lands in
    expect(forecastCurrentMonth(bundle.db, TODAY).incomePaceNote).toBe(JUN_TO_AUG);
  });

  test("an account he only spends from never cuts Money in's months", () => {
    ledger();
    const cardId = account("Card", "credit");
    for (const m of MONTHS) row(cardId, `${m}-01`, -50000, "Groceries");
    readThrough(cardId, "2026-08-12");
    const f = forecastCurrentMonth(bundle.db, TODAY);
    // spending's three slide back to May–Jul behind the Card; Money in's stay Jun–Aug behind Brokerage Cash
    expect(f.spendPaceNote).toBe(
      "Spending's pace is averaged over 3 complete months, May 2026 to Jul 2026. Aug 2026 and Sep 2026 are left out: " +
        "Aug 12 is the last day every account you spend from has been imported through.",
    );
    expect(f.incomePaceNote).toBe(JUN_TO_AUG);
  });
});

/*
 * …and never before the ledger's first whole month (`averagedMonths`' floor), with no habit to read yet: on a young
 * ledger no account has had its income in two of three months, so EVERY account its income has come in on dates it —
 * spending's own fallback ("none may be assumed current"), asked of the accounts that ever paid him.
 */
const YOUNG_TODAY = "2026-08-27"; // August: 31 days, 5 remaining including today

describe("…where the ledger is young", () => {
  const gate =
    "Money in has no recent pace yet: a kind of income counts toward it once it has come in 2 complete months, so a " +
    "one-off never does.";

  test("an earner read only to Jun 12 on a ledger opening Jun 1 leaves Money in no month, and says why", () => {
    const cardId = account("Card", "credit");
    for (const m of ["2026-06", "2026-07", "2026-08"]) row(cardId, `${m}-01`, -40000, "Groceries");
    row(checkingId, "2026-06-02", 300000, "Salary");
    readThrough(checkingId, "2026-06-12");

    const f = forecastCurrentMonth(bundle.db, YOUNG_TODAY);
    expect(incomePaceMonths(bundle.db, YOUNG_TODAY)).toEqual({
      windows: [],
      unread: { months: ["2026-06", "2026-07"], through: "2026-06-12", accounts: ["Checking"] },
    });
    expect(f.incomePaceMonths).toBe(0);
    expect(f.incomePaceNote).toBe(
      `${gate} Jun 2026 and Jul 2026 are left out: Jun 12 is the last day Checking has been imported through.`,
    );
  });

  test("a July read only to its 12th is no month of pay: Jun alone, never Jun–Jul's $3,000.00 a month", () => {
    const cardId = account("Card", "credit");
    for (const m of ["2026-06", "2026-07", "2026-08"]) row(cardId, `${m}-01`, -40000, "Groceries");
    row(checkingId, "2026-06-02", 300000, "Salary");
    row(checkingId, "2026-07-02", 300000, "Salary");
    readThrough(checkingId, "2026-07-12");

    const september = forecastForMonth(bundle.db, "2026-09", YOUNG_TODAY)!;
    for (const f of [forecastCurrentMonth(bundle.db, YOUNG_TODAY), september]) {
      expect(line(f, "Salary")).toBeUndefined();
      expect(f.incomePaceMonths).toBe(1);
      expect(f.incomePaceNote).toBe(
        `${gate} Jun 2026 is the only complete month Money in has so far. Jul 2026 is left out: Jul 12 is the last ` +
          "day Checking has been imported through.",
      );
    }
  });
});

/*
 * 🔴 Review of af84411 (MEDIUM): an earner was judged by months nobody had read. Its habit — the presence gate's two of
 * the pace's three months — was asked of the three calendar months before each candidate month whatever its own import
 * day, so a month no statement had covered counted as a month it earned nothing in: an earner three months behind
 * stopped holding Money in's months back and its unread months were averaged as $0, and before any habit an earner
 * that stayed stale aged out of the rows the habit loads. Each account's habit is judged over the months it has been
 * read for (`ownLastMonth`), and it holds the months back until a statement says otherwise.
 */
describe("an earner is judged over the months it has been read for, never over months no import has read", () => {
  const NOV_TODAY = "2026-11-23"; // November: 30 days, 8 remaining including today
  const JANUARY = "2027-01-23";

  /**
   * Savings: $50.00 of Interest on the 28th of `earns` (Jan–Jul unless given), read to Jul 31; Brokerage Cash: $30.00 a
   * month, to Oct 31
   */
  function staleSavings(earns: readonly string[] = MONTHS.slice(0, 7)): void {
    ledgerOpenedOn(bundle.db, "2026-01-01");
    for (const m of [...MONTHS, "2026-09", "2026-10", "2026-11"]) row(checkingId, `${m}-05`, -10000, "Groceries");
    readThrough(checkingId, "2026-11-20");
    const savingsId = account("Savings", "savings");
    for (const m of earns) row(savingsId, `${m}-28`, 5000, "Interest");
    readThrough(savingsId, "2026-07-31");
    for (const m of [...MONTHS, "2026-09", "2026-10"]) row(cashId, `${m}-15`, 3000, "Dividends");
    readThrough(cashId, "2026-10-31");
  }

  const MAY_TO_JUL = [
    { start: "2026-05-01", end: "2026-05-31", key: "2026-05" },
    { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
    { start: "2026-07-01", end: "2026-07-31", key: "2026-07" },
  ];

  test("Savings read through Jul 31 holds Money in's months to May–Jul", () => {
    staleSavings();
    expect(incomePaceMonths(bundle.db, TODAY)).toEqual({
      windows: MAY_TO_JUL,
      unread: { months: ["2026-08", "2026-09"], through: "2026-07-31", accounts: ["Brokerage Cash", "Savings"] },
    });
  });

  test("a month on, with nothing imported, it still does: its Aug–Oct are unread, never months of no Interest", () => {
    staleSavings();
    expect(incomePaceMonths(bundle.db, NOV_TODAY)).toEqual({
      windows: MAY_TO_JUL,
      unread: {
        months: ["2026-08", "2026-09", "2026-10"],
        through: "2026-07-31",
        accounts: ["Brokerage Cash", "Savings"],
      },
    });
    const f = forecastCurrentMonth(bundle.db, NOV_TODAY);
    expect(line(f, "Interest")).toMatchObject({
      cents: Math.round((5000 * 8) / 30),
      detail: "avg of last 3 periods, present 3/3 mo, × 8/30 days",
    });
    expect(line(f, "Dividends")).toMatchObject({ cents: Math.round((3000 * 8) / 30) });
    expect(f.incomePaceNote).toBe(
      "Money in's pace is averaged over 3 complete months, May 2026 to Jul 2026. Aug 2026 to Oct 2026 are left out: " +
        "Jul 31 is the last day both Brokerage Cash and Savings have been imported through.",
    );
  });

  /*
   * ⛔ Its OWN three months: the three ending at its own last one, never a month later. 🔴 Review of ee969b2 (MEDIUM,
   * mutation-checked): a month later — Jun–Aug for an account read through Jul 31 — all 290 targeted tests passed, an
   * earner paid every month being habitual over either. Interest in May and Jun, none in Jul, read through Jul 31:
   * over its May–Jul it earns in two and holds Money in's months there; over Jun–Aug, once, it went dormant, and Money
   * in's months were the calendar's Aug–Oct with no Interest line — Savings' three unread months averaged as $0, review
   * of af84411's MEDIUM over again. On his ledger copy, today moved to 2027-03-23 with no import, the shift left no
   * earner habitual and read May–Jul behind SoFi's Jul 31: $13.26 for Mar 23–31, where it reads Jun–Aug, $14.74.
   */
  test("over its own three months, never a month later: Interest in May and Jun, read to Jul 31, holds them", () => {
    staleSavings(["2026-05", "2026-06"]);
    expect(incomePaceMonths(bundle.db, NOV_TODAY)).toEqual({
      windows: MAY_TO_JUL,
      unread: {
        months: ["2026-08", "2026-09", "2026-10"],
        through: "2026-07-31",
        accounts: ["Brokerage Cash", "Savings"],
      },
    });
    // May–Jul's mean to the cent, then eight days of it — the engine's order
    expect(line(forecastCurrentMonth(bundle.db, NOV_TODAY), "Interest")).toMatchObject({
      cents: Math.round((Math.round((5000 + 5000) / 3) * 8) / 30),
      detail: "avg of last 3 periods, present 2/3 mo, × 8/30 days",
    });
  });

  /*
   * His ledger's shape, only today moved: no Robinhood import after Sep 9. 🔴 Measured on his ledger copy (2026-10-23,
   * today moved): at 2027-02-23 Jun–Aug and "Sep 2026 to Jan 2027 are left out: Sep 9 …"; at 2027-03-23 the calendar's
   * Dec–Feb, no sentence, and no Dividends or Interest line — Robinhood Cash's rows had aged out of the span the habit
   * loads, so its unread months read as months of nothing.
   */
  test("an earner that stays stale never ages out: Brokerage Cash's Sep 9 still dates the months in March", () => {
    ledger();
    const MARCH = "2027-03-23"; // March: 31 days, 9 remaining including today
    expect(incomePaceMonths(bundle.db, MARCH)).toEqual({
      windows: [
        { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
        { start: "2026-07-01", end: "2026-07-31", key: "2026-07" },
        { start: "2026-08-01", end: "2026-08-31", key: "2026-08" },
      ],
      unread: {
        months: ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"],
        through: "2026-09-09",
        accounts: ["Brokerage Cash"],
      },
    });
    const f = forecastCurrentMonth(bundle.db, MARCH);
    expect(line(f, "Dividends")).toMatchObject({ cents: Math.round((3000 * 9) / 31) });
    expect(f.incomePaceNote).toBe(
      "Money in's pace is averaged over 3 complete months, Jun 2026 to Aug 2026. Sep 2026 to Feb 2027 are left out: " +
        "Sep 9 is the last day Brokerage Cash has been imported through.",
    );
  });

  /*
   * ⛔ The gate's TWO of the pace's three months, and a row in a month read only partly counts: it came in that month.
   * Interest in Jun and Aug, none in Jul, read through Aug 20 — habitual, so its Aug 20 holds the months to May–Jul.
   * (Asked for three of three, or over two months, it would be dormant, and an August read to its 20th averaged whole.)
   */
  test("an earner in two of its three months, read short, holds them back", () => {
    ledger();
    const savingsId = account("Savings", "savings");
    row(savingsId, "2026-06-10", 500, "Interest");
    row(savingsId, "2026-08-10", 500, "Interest");
    readThrough(savingsId, "2026-08-20");
    expect(incomePaceMonths(bundle.db, TODAY)).toEqual({
      windows: MAY_TO_JUL,
      unread: { months: ["2026-08", "2026-09"], through: "2026-08-20", accounts: ["Brokerage Cash", "Savings"] },
    });
  });

  /** His ledger's shape, and Savings: Interest on May 28 and Jul 28, nothing yet in an August read to its 20th. */
  function savingsReadShortWithNoRow(): void {
    ledger();
    const savingsId = account("Savings", "savings");
    row(savingsId, "2026-05-28", 500, "Interest");
    row(savingsId, "2026-07-28", 500, "Interest");
    readThrough(savingsId, "2026-08-20");
  }

  const AUG_20 = { through: "2026-08-20", accounts: ["Brokerage Cash", "Savings"] };

  /*
   * ⛔ …and its own last month is the last it was read to the END of, unless a row came in a later one: an August read
   * to its 20th with nothing in it yet is no month of no Interest. 🔴 Review of ee969b2 (MEDIUM, mutation-checked):
   * with the import day's own month as its last, all 290 targeted tests passed — the one partly read month in them held
   * a row. Interest in May and Jul, read to Aug 20: over its May–Jul it earns in two and holds Money in's months there;
   * over Jun–Aug, once, it went dormant — Jun–Aug, "Sep 2026 is left out: Sep 9 is the last day Brokerage Cash has
   * been imported through.", no Interest line (present 1/3), and the August Savings was read only to its 20th averaged
   * whole.
   */
  test("a month read to its 20th with no row in it is not its own: Interest in May and Jul holds them back", () => {
    savingsReadShortWithNoRow();
    expect(incomePaceMonths(bundle.db, TODAY)).toEqual({
      windows: MAY_TO_JUL,
      unread: { months: ["2026-08", "2026-09"], ...AUG_20 },
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(line(f, "Interest")).toMatchObject({
      cents: Math.round((Math.round((500 + 500) / 3) * 9) / 31),
      detail: "avg of last 3 periods, present 2/3 mo, × 9/31 days",
    });
    expect(f.incomePaceNote).toBe(
      "Money in's pace is averaged over 3 complete months, May 2026 to Jul 2026. Aug 2026 and Sep 2026 are left out: " +
        "Aug 20 is the last day both Brokerage Cash and Savings have been imported through.",
    );
  });

  /*
   * ⛔ …and its rows load back to the first of those months (`habitRowsFrom`): its last fully read month's three, never
   * its import day's. 🔴 Review of ee969b2 (mutation-checked): loaded from the import day's month's three, all 290
   * targeted tests passed. A month on with nothing imported the candidates load Jun–Nov, so May's Interest is there
   * only for Savings' own May–Jul; without it Savings earned once, went dormant, and Money in's months were Jun–Aug.
   */
  test("a month on, its May row before the span the candidates load still counts toward its own May–Jul", () => {
    savingsReadShortWithNoRow();
    expect(incomePaceMonths(bundle.db, NOV_TODAY)).toEqual({
      windows: MAY_TO_JUL,
      unread: { months: ["2026-08", "2026-09", "2026-10"], ...AUG_20 },
    });
  });

  /*
   * Before any habit (a young ledger), the accounts the pace's rows came in on date the months — those still coming in
   * when last read: a row in the pace's three months up to their own last one. 🔴 It was every account with a row in
   * the span the habit loads, measured back from TODAY, so a stale earner aged out of it.
   */
  test("before any habit, an earner that stays stale still dates them, and one read for months since does not", () => {
    ledgerOpenedOn(bundle.db, "2026-06-01");
    for (const m of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]) {
      row(checkingId, `${m}-05`, -10000, "Groceries");
    }
    readThrough(checkingId, "2027-01-20");
    readThrough(cashId, "2027-01-20");
    const savingsId = account("Savings", "savings");
    row(savingsId, "2026-06-28", 5000, "Interest");
    readThrough(savingsId, "2026-07-31");
    // paid once in June too, and read through Dec 31 since: three whole months with nothing, it is not still earning
    const oldId = account("Old Savings", "savings");
    row(oldId, "2026-06-03", 700, "Interest");
    readThrough(oldId, "2026-12-31");

    expect(incomePaceMonths(bundle.db, JANUARY)).toEqual({
      windows: [
        { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
        { start: "2026-07-01", end: "2026-07-31", key: "2026-07" },
      ],
      unread: {
        months: ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
        through: "2026-07-31",
        accounts: ["Savings"],
      },
    });
    expect(forecastCurrentMonth(bundle.db, JANUARY).incomePaceNote).toBe(
      "Money in's pace is averaged over 2 complete months, Jun 2026 to Jul 2026. Aug 2026 to Dec 2026 are left out: " +
        "Jul 31 is the last day Savings has been imported through.",
    );
  });

  /*
   * ⛔ Still coming in is a row in ANY of the three months up to its own last, the oldest included. 🔴 Review of ee969b2
   * (mutation-checked): asked for a row after the oldest, all 290 targeted tests passed; asked over four months, so did
   * they. Interest once, on Jun 28: read through Aug 31, June is the oldest of its own Jun–Aug and it still dates Money
   * in's months; read through Sep 30 — Jul, Aug and Sep with nothing — it is not still earning, and the calendar's
   * months stand.
   */
  test("before any habit, a row in the oldest of its own three months is still coming in; a month on it is not", () => {
    ledgerOpenedOn(bundle.db, "2026-06-01");
    for (const m of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]) {
      row(checkingId, `${m}-05`, -10000, "Groceries");
    }
    readThrough(checkingId, "2027-01-20");
    const savingsId = account("Savings", "savings");
    row(savingsId, "2026-06-28", 5000, "Interest");
    readThrough(savingsId, "2026-08-31");

    expect(incomePaceMonths(bundle.db, JANUARY)).toEqual({
      windows: [
        { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
        { start: "2026-07-01", end: "2026-07-31", key: "2026-07" },
        { start: "2026-08-01", end: "2026-08-31", key: "2026-08" },
      ],
      unread: {
        months: ["2026-09", "2026-10", "2026-11", "2026-12"],
        through: "2026-08-31",
        accounts: ["Savings"],
      },
    });

    readThrough(savingsId, "2026-09-30");
    expect(incomePaceMonths(bundle.db, JANUARY)).toMatchObject({ unread: null });
    expect(incomePaceMonths(bundle.db, JANUARY).windows.map((w) => w.key)).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
});

/*
 * 🔴 Review of af84411 (MEDIUM), the card the reviewer read on a copy of his ledger with one probe row: Robinhood Cash
 * shown through Oct 9 (a September statement whose rows run nine days past its end, as August's ran to Sep 9) and Wells
 * Fargo, where his weekly pay lands, read to Sep 24. At 2026-11-10 the same card said "It falls after Thu, Sep 24,
 * 2026, the last day every account that pay lands in has been checked through" and "Oct 9 is the last day every
 * account your income lands in has been imported through" — the second false, and the first's contradiction.
 */
describe("the pace row names the accounts Money in's pace reads, beside the passed payday's own day", () => {
  test("Brokerage Cash is named, never every account the income lands in", () => {
    ledger();
    readThrough(cashId, "2026-10-09");
    const payId = account("Pay Checking", "checking");
    const series = bundle.db
      .insert(recurringSeries)
      .values({
        name: "It America LLC (weekly pay)",
        kind: "income",
        cadence: "weekly",
        userCadence: "weekly",
        intervalDaysAvg: 7,
        nextExpectedOn: "2026-10-01",
        nextExpectedAmountCents: 114192,
        amountCentsAvg: 114192,
        status: "confirmed",
        toleranceDays: 3,
        lastMatchedOn: "2026-09-24",
        accountId: payId,
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    for (const day of ["2026-09-10", "2026-09-17", "2026-09-24"]) row(payId, day, 114192, "Salary");
    bundle.db.update(transactions).set({ recurringSeriesId: series }).where(eq(transactions.accountId, payId)).run();
    checkedThrough(bundle.db, payId, "2026-09-24", "2026-06-01");

    const f = forecastCurrentMonth(bundle.db, "2026-11-10");
    expect(f.incomePaceNote).toBe(
      "Money in's pace is averaged over 3 complete months, Jul 2026 to Sep 2026. Oct 2026 is left out: Oct 9 is the " +
        "last day Brokerage Cash has been imported through.",
    );
    const card = cardText(f);
    expect(card).toContain(
      "It falls after Thu, Sep 24, 2026, the last day every account that pay lands in has been checked through",
    );
    expect(card).not.toContain("every account your income lands in");
  });
});
