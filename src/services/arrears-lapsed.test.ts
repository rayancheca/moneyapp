import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { arrearsSentence } from "@/lib/committed";
import { addDays } from "@/lib/dates";
import { createAccount } from "./accounts";
import { budgetPaceStatuses, createBudget } from "./budgets";
import { seriesInCategory } from "./category-detail";
import { committedBook, runwayCard } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { upcomingOccurrences } from "./recurring";
import { seriesDetail } from "./recurring-detail";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * 🔴 A SERIES THE FORECAST HAS LET GO WAS STILL OWED. Read on the owner's ledger 2026-10-08, one dashboard:
 *
 *     RUNWAY          "A further $2,296.20 came due earlier this month and no import has covered it yet."
 *                     = rent $2,109.00 + Rent utilities & fees $182.21 + Amazon Prime $4.99
 *     SUBSCRIPTIONS   "STOPPED BEING FORECAST — Amazon Prime, last seen Jul 5 · 47 days past tolerance"
 *
 * and /recurring's October forecast counted the same $4.99 in "Committed $3,574.97 (9 lines)" and "$69.86 of it
 * running late", while its 30-day Upcoming list and /budgets' "due by today" left it out. Amazon lapsed THAT day:
 * `seriesHasLapsed` is true on Oct 8 and false on Oct 7, and every arrears caller but /budgets handed
 * `overdueForSeries` the window's last day — yesterday — as the day to judge it on.
 *
 * ⛔ The fixture is that shape: a $4.99 subscription last seen 94 days before TODAY on a 30-day step (its lapse line
 * is 93 days, so it lapses ON today), due on the 5th, and a rent that is merely late beside it so no assertion here
 * can pass by every surface being empty.
 */
const TODAY = "2026-10-08";

let dir: string;
let bundle: DbBundle;
let checking: string;
let prime: string;
let rent: string;

function categoryId(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

function addSeries(opts: {
  name: string;
  kind: SeriesKind;
  nextExpectedOn: string;
  amountCents: number;
  lastMatchedOn: string;
  categoryName: string;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind,
      cadence: "monthly",
      status: "confirmed",
      intervalDaysAvg: 30,
      toleranceDays: 3,
      nextExpectedOn: opts.nextExpectedOn,
      nextExpectedAmountCents: opts.amountCents,
      lastMatchedOn: opts.lastMatchedOn,
      userCategoryId: categoryId(opts.categoryName),
      accountId: checking,
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-arrears-lapsed-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checking = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  // Jul 6 → Oct 8 is 94 days: past the 93-day lapse line today, on it (not past) yesterday
  prime = addSeries({
    name: "Prime",
    kind: "subscription",
    nextExpectedOn: "2026-08-05",
    amountCents: -499,
    lastMatchedOn: "2026-07-06",
    categoryName: "Streaming",
  });
  rent = addSeries({
    name: "Rent",
    kind: "bill",
    nextExpectedOn: "2026-10-01",
    amountCents: -210900,
    lastMatchedOn: "2026-09-01",
    categoryName: "Rent",
  });
  for (const name of ["Streaming", "Rent"]) {
    createBudget(bundle.db, { categoryId: categoryId(name), period: "monthly", amountCents: 300000, startsOn: "2026-01-01" });
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every surface that says a series is owed this month, asked about one series on one day. */
function owedOn(seriesId: string, name: string, categoryName: string, today: string): Record<string, boolean> {
  const forecast = forecastCurrentMonth(bundle.db, today);
  return {
    runway: (committedBook(bundle.db, today).lines.find((l) => l.seriesId === seriesId)?.overdueCents ?? 0) > 0,
    forecast: forecast.components.some((c) => c.label === name && /came due/.test(c.detail ?? "")),
    seriesPage: seriesDetail(bundle.db, seriesId, today).overdue !== null,
    categoryPage: seriesInCategory(bundle.db, categoryId(categoryName), today).find((r) => r.id === seriesId)?.overdue != null,
    budgets: budgetPaceStatuses(bundle.db, today).some((s) => s.overdue.some((o) => o.id === seriesId)),
  };
}

const NOWHERE = { runway: false, forecast: false, seriesPage: false, categoryPage: false, budgets: false };

describe("a series the forecast has stopped forecasting is not owed this month either", () => {
  test("his dashboard on 2026-10-08: the day it lapses, it leaves every arrears figure", () => {
    // the premise, from the two surfaces that already agreed: the forecast has let it go
    expect(subscriptionsCard(bundle.db, TODAY)!.lapsed.map((l) => l.name)).toEqual(["Prime"]);
    expect(upcomingOccurrences(bundle.db, TODAY, 30).some((o) => o.seriesId === prime)).toBe(false);

    const book = committedBook(bundle.db, TODAY);
    expect(book.lines.map((l) => l.name)).toEqual(["Rent"]);
    expect(book.overdueCents).toBe(210900);
    expect(book.overdueCount).toBe(1);
    expect(arrearsSentence(book)).toBe("A further $2,109.00 came due earlier this month and no import has covered it yet.");
    // the card's "Committed bills come to $X a month — A, B, and N more" names `lines`
    expect(runwayCard(bundle.db, TODAY).committed.lines.map((l) => l.name)).toEqual(["Rent"]);

    // /recurring's October: "Committed" and its "running late" are these lines — the rent that came due Oct 1, alone
    const forecast = forecastCurrentMonth(bundle.db, TODAY);
    expect(forecast.components.filter((c) => c.kind === "fixed").map((c) => c.label)).toEqual(["Rent"]);
    expect(forecast.committed.spendCents).toBe(-210900);

    expect(owedOn(prime, "Prime", "Streaming", TODAY)).toEqual(NOWHERE);
    // …and the late rent beside it is owed on every one, so the line above is not five empty surfaces agreeing
    expect(owedOn(rent, "Rent", "Rent", TODAY)).toEqual({
      runway: true,
      forecast: true,
      seriesPage: true,
      categoryPage: true,
      budgets: true,
    });
  });

  test("swept across the lapse: owed while it is forecast, nowhere from the day it is not", () => {
    for (let day = "2026-10-06"; day <= "2026-10-12"; day = addDays(day, 1)) {
      const stopped = subscriptionsCard(bundle.db, day)!.lapsed.some((l) => l.name === "Prime");
      const owed = owedOn(prime, "Prime", "Streaming", day);
      if (stopped) {
        expect({ day, ...owed }).toEqual({ day, ...NOWHERE });
      } else {
        // Oct 5 came and went unpaid, and the forecast still projects it: every surface owes it
        expect({ day, ...owed }).toEqual({
          day,
          runway: true,
          forecast: true,
          seriesPage: true,
          categoryPage: true,
          budgets: true,
        });
      }
    }
  });
});

describe("money in never lapses, in arrears as in the forecast", () => {
  /*
   * ⛔ `lapsedSeriesShouldStopForecasting`: an income series going quiet is evidence about the IMPORTS, so the forward
   * leg keeps projecting it whatever its sign (`forecast.ts`, the $4,233.69 → $45.69 collapse). One detected as income
   * that bills money out and has gone quiet is therefore still forecast after today — and so still owed for the day
   * before it. 🔴 The arrears walk asked `seriesHasLapsed` alone and let it go, so its future was owed and its past
   * was not.
   */
  test("an income-kind series with a money-out schedule stays owed after its evidence runs out", () => {
    // weekly on Wednesdays, last seen in July — long past its 23-day lapse line — filed under a budgeted category
    const clawback = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Clawback",
        kind: "income",
        cadence: "weekly",
        status: "confirmed",
        intervalDaysAvg: 7,
        toleranceDays: 2,
        nextExpectedOn: "2026-07-08",
        nextExpectedAmountCents: -2500,
        lastMatchedOn: "2026-07-01",
        userCategoryId: categoryId("Rent"),
        accountId: checking,
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    // still forecast going forward…
    expect(upcomingOccurrences(bundle.db, TODAY, 30).some((o) => o.seriesId === clawback)).toBe(true);
    // …so still owed for the Wednesday that came and went, on every surface that says so
    const line = forecastCurrentMonth(bundle.db, TODAY).components.find(
      (c) => c.label === "Clawback" && /came due/.test(c.detail ?? ""),
    );
    expect(line).toMatchObject({ kind: "fixed", cents: -2500 });
    expect(seriesDetail(bundle.db, clawback, TODAY).overdue).toMatchObject({ date: "2026-10-07", amountCents: -2500 });
    // /budgets asks it of both its legs: owed by today, and still to come after it
    const row = budgetPaceStatuses(bundle.db, TODAY).find((s) => s.categoryName === "Rent")!;
    expect(row.overdue.find((o) => o.id === clawback)).toMatchObject({ nextDate: "2026-10-07", amountCents: 2500 });
    expect(row.tail.find((o) => o.id === clawback)).toMatchObject({ nextDate: "2026-10-14", occurrenceCount: 3 });
  });
});
