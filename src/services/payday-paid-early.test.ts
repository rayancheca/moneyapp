import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { dashboardData } from "./dashboard";
import { forecastForMonth } from "./forecast";
import { upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * 🔴 A PAYDAY PAID EARLY WAS STILL LISTED AS COMING (§6A 29 review, second surface).
 *
 * Settle backwards (his decision of 2026-09-28) lets a deposit pay the payday
 * it lands just before: Wed Sep 30's $1,141.92 pays Thu Oct 1. The forecast
 * drops that payday ("A payday a deposit has already paid down is not still to
 * come") and the calendar draws it paid by the deposit of Sep 30 — but
 * `upcomingOccurrences` projected from today without asking settlement, so
 * /recurring's Upcoming tab, the dashboard's upcoming strip and its "before
 * your next paycheck" line still waited on Oct 1's pay, and so did the series
 * page's "Next expected". Read on Sep 30, the dashboard said nothing was due
 * before that paycheck — while the $2,000.00 rent due Oct 5 falls before the
 * pay that will actually come, on Oct 8.
 */

let dir: string;
let bundle: DbBundle;
const WELLS = "acct-wells";
const PAY = "series-it-america";
const RENT = "series-rent";
const WEEK = 114_192;
const TODAY = "2026-09-30";
const now = (): string => new Date().toISOString();

function salaryCategoryId(): string {
  const top = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Income"), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Salary"), eq(categories.parentId, top.id)))
    .get()!.id;
}

let seq = 0;
/** A deposit ATTRIBUTED to the pay series — `series_link_source = 'user'` on his ledger. */
function deposit(postedOn: string, amountCents: number): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: "It America LLC Payroll",
      normalizedDescription: "IT AMERICA LLC PAYROLL",
      categoryId: salaryCategoryId(),
      recurringSeriesId: PAY,
      seriesLinkSource: "user",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-paid-early-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: WELLS,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  seq = 0;
  // his series: weekly Thursdays, confirmed, $1,141.92 typed by him
  bundle.db
    .insert(recurringSeries)
    .values({
      id: PAY,
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: WEEK,
      userAmountCents: WEEK,
      nextExpectedOn: "2026-09-03",
      nextExpectedAmountCents: WEEK,
      lastMatchedOn: "2026-09-30",
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      id: RENT,
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      amountCentsAvg: -200_000,
      nextExpectedOn: "2026-10-05",
      nextExpectedAmountCents: -200_000,
      lastMatchedOn: "2026-09-05",
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  for (const day of ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-09-30"]) deposit(day, WEEK);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const payDays = (occurrences: readonly { seriesId: string; date: string }[]): string[] =>
  occurrences.filter((o) => o.seriesId === PAY).map((o) => o.date);

describe("a payday the deposit of Sep 30 paid early", () => {
  test("is not upcoming — the Upcoming tab and every reader of upcomingOccurrences", () => {
    expect(payDays(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual([
      "2026-10-08",
      "2026-10-15",
      "2026-10-22",
      "2026-10-29",
    ]);
  });

  test("is not the next paycheck: the rent due Oct 5 falls before the pay that will come, on Oct 8", () => {
    const { upcoming } = dashboardData(bundle.db, TODAY);
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-10-08", cents: -200_000 });
    expect(upcoming.items.filter((i) => i.seriesId === PAY).map((i) => i.date)).toEqual(["2026-10-08"]);
  });

  test("is not the series page's next expected", () => {
    expect(seriesDetail(bundle.db, PAY, TODAY).nextExpected.map((o) => o.date)).toEqual([
      "2026-10-08",
      "2026-10-15",
      "2026-10-22",
    ]);
  });

  /* One answer, so the surfaces agree: the calendar draws Oct 1 paid, and the forecast counts four Octobers paydays. */
  test("and every surface says so alike — the calendar, the forecast and the upcoming list", () => {
    const october = recurringCalendar(bundle.db, "2026-10", TODAY);
    expect(october.entriesByDay["2026-10-01"]?.find((e) => e.seriesId === PAY)).toMatchObject({
      state: "paid",
      settledByDepositsOn: ["2026-09-30"],
    });
    const drawnUpcoming = Object.entries(october.entriesByDay)
      .filter(([, es]) => es.some((e) => e.seriesId === PAY && e.state === "upcoming"))
      .map(([day]) => day)
      .sort();
    const listed = payDays(upcomingOccurrences(bundle.db, TODAY, 31)).filter((d) => d.startsWith("2026-10-"));
    expect(listed).toEqual(drawnUpcoming);
    const pay = forecastForMonth(bundle.db, "2026-10", TODAY)?.components.find((c) => c.label === "It America LLC (weekly pay)");
    expect(pay?.cents).toBe(WEEK * listed.length);
  });

  /*
   * Settlement reaches `toleranceDays` past today. With eight days a deposit
   * answers the payday a week after it, so Sep 30's pays Oct 8 and Sep 24's Oct
   * 1: two paydays ahead are paid, and a window sized for one would list two.
   */
  test("the series page still lists three, however far ahead settlement reaches", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 8 }).where(eq(recurringSeries.id, PAY)).run();
    const ahead = ["2026-10-15", "2026-10-22", "2026-10-29"];
    expect(payDays(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual(ahead);
    expect(seriesDetail(bundle.db, PAY, TODAY).nextExpected.map((o) => o.date)).toEqual(ahead);
  });

  test("a bill is still listed whatever lands near it — settlement speaks only about paydays", () => {
    expect(upcomingOccurrences(bundle.db, TODAY, 30).filter((o) => o.seriesId === RENT).map((o) => o.date)).toEqual([
      "2026-10-05",
    ]);
  });
});
