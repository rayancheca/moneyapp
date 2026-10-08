import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { spreadResidualCents } from "@/lib/per-payday";
import { incomeExpectation } from "./budgets";
import { noticesCard } from "./notices-card";
import { paydaySettlement } from "./payday-settlement";
import { populationStddev } from "./recurring";
import { recurringCalendar, type CalendarEntry } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ HIS RATE HISTORY, READ BY THE CALENDAR, THE NOTICES AND THE SERIES PAGE (owner decisions 2026-10-08, §6A 55,
 * 55a, 55b): the cash weeks through Aug 26 at $1,047.00, Aug 27 on at $1,141.92 — money pays only paydays of its own
 * era, never a payday past its own deposit's date plus the tolerance, and each row is held to the rate of the payday
 * its money paid.
 *
 * 🔴 Measured on a copy of his ledger with the history set, 2026-10-08: June's $1,047.00 and $400.00 read "paid
 * (toward the payday of Aug 27, 2026)"; the payroll week of Sep 24 paid the CASH week of Aug 20 at $1,047.00; and on a
 * schedule drawn from his first deposit, Jun 4's cash week — exactly a cash week's pay — read $94.92 short.
 */

let dir: string;
let bundle: DbBundle;
const WELLS = "acct-wells";
const PAY = "series-it-america";
const PAY_NAME = "It America LLC (weekly pay)";
const WEEK = 114_192;
const CASH = 104_700;
const HISTORY = [{ throughOn: "2026-08-26", amountCents: CASH }];
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

/**
 * His series as his ledger stores it — weekly Thursdays, his $1,141.92, no cached spread, detection's anchor — with
 * the history the guarded write will set. `anchor` is Jul 23 on his ledger; Jun 4 draws the paydays from his first
 * deposit on, as one payday universe will.
 */
function addPaySeries(anchor: string): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id: PAY,
      name: PAY_NAME,
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 104_600,
      userAmountCents: WEEK,
      userAmountHistory: HISTORY,
      nextExpectedOn: anchor,
      nextExpectedAmountCents: 104_600,
      lastMatchedOn: anchor,
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let seq = 0;
function deposit(postedOn: string, amountCents: number): string {
  seq += 1;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
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
  return id;
}

function readThrough(from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WELLS, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

/** His four deposits, as he linked them. */
function hisFour(): { jun4: string; jun5: string; lump: string; sep24: string } {
  return {
    jun4: deposit("2026-06-04", CASH),
    jun5: deposit("2026-06-05", 40_000),
    lump: deposit("2026-09-23", WEEK * 4),
    sep24: deposit("2026-09-24", WEEK),
  };
}

const marks = (month: string, day: string, today: string): CalendarEntry[] =>
  (recurringCalendar(bundle.db, month, today).entriesByDay[day] ?? []).filter((e) => e.seriesId === PAY);
const rowOf = (month: string, day: string, id: string, today: string): CalendarEntry | undefined =>
  marks(month, day, today).find((e) => e.transactionId === id);
const paydayOf = (month: string, day: string, today: string): CalendarEntry | undefined =>
  marks(month, day, today).find((e) => e.transactionId === null);
const payNotices = (today: string): string[] =>
  (noticesCard(bundle.db, today)?.notices ?? []).map((n) => n.text).filter((t) => t.includes(PAY_NAME));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rate-history-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  readThrough("2026-06-01", "2026-09-24");
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("his ledger as it stands — the paydays drawn from his anchor, Jul 23", () => {
  const TODAY = "2026-10-08";
  let ids: ReturnType<typeof hisFour>;
  beforeEach(() => {
    addPaySeries("2026-07-23");
    ids = hisFour();
  });

  test("settlement: Sep 23 pays Sep 24, 17, 10 and 3; Sep 24 pays Aug 27; June's money pays nothing", () => {
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.portions.map((p) => `${p.paydayOn} ← ${p.depositOn}`).sort()).toEqual([
      "2026-08-27 ← 2026-09-24",
      "2026-09-03 ← 2026-09-23",
      "2026-09-10 ← 2026-09-23",
      "2026-09-17 ← 2026-09-23",
      "2026-09-24 ← 2026-09-23",
    ]);
    expect(s.unallocatedCents).toBe(CASH + 40_000);
  });

  /* ⛔ No "toward the payday of Aug 27" anywhere in June: both rows read toward no payday, ungraded. */
  test("June's two deposits read toward no payday — not toward Aug 27", () => {
    for (const [day, id, cents] of [
      ["2026-06-04", ids.jun4, CASH],
      ["2026-06-05", ids.jun5, 40_000],
    ] as const) {
      expect(rowOf("2026-06", day, id, TODAY)).toMatchObject({
        state: "paid",
        amountCents: cents,
        settlesPaydaysOn: [],
        towardNoPayday: true,
        expectedAmountCents: CASH,
      });
    }
  });

  /* 55a: the cash week of Aug 20 is not paid by payroll money — it stands unpaid, at its own rate. */
  test("Aug 20 is unpaid at $1,047.00; Aug 27 is paid by the deposit of Sep 24", () => {
    expect(paydayOf("2026-08", "2026-08-20", TODAY)).toMatchObject({ amountCents: CASH, settledByDepositsOn: [] });
    expect(paydayOf("2026-08", "2026-08-20", TODAY)?.state).not.toBe("paid");
    expect(paydayOf("2026-08", "2026-08-27", TODAY)).toMatchObject({
      state: "paid",
      amountCents: WEEK,
      settledByDepositsOn: ["2026-09-24"],
    });
  });

  test("September: the lump is four paydays at $1,141.92 each; Sep 24's row went toward Aug 27", () => {
    expect(rowOf("2026-09", "2026-09-23", ids.lump, TODAY)).toMatchObject({
      state: "paid",
      perPayday: { paydays: 4, cents: WEEK },
      expectedAmountCents: WEEK,
    });
    expect(rowOf("2026-09", "2026-09-24", ids.sep24, TODAY)).toMatchObject({
      state: "paid",
      settlesPaydaysOn: ["2026-08-27"],
      towardNoPayday: false,
    });
  });

  /* Every cent once: money no payday reached stays in its own month's Settled figure, as /budgets counts it. */
  test("the months' Settled figures add up to the money he was paid, and agree with /budgets", () => {
    const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const settled = months.map((m) => recurringCalendar(bundle.db, m, TODAY).postedNetCents);
    expect(settled).toEqual([CASH + 40_000, 0, WEEK, WEEK * 4, 0]);
    for (const m of ["2026-06", "2026-08", "2026-09"]) {
      const end = m === "2026-06" ? "2026-06-30" : m === "2026-08" ? "2026-08-31" : "2026-09-30";
      const i = incomeExpectation(bundle.db, `${m}-01`, end, TODAY);
      expect(recurringCalendar(bundle.db, m, TODAY).postedNetCents).toBe(
        i.postedCents - i.paidForAnotherMonthCents + i.paidByAnotherMonthCents,
      );
    }
  });

  test("the Worth a look card says nothing about his pay", () => {
    expect(payNotices(TODAY)).toEqual([]);
  });

  /* 55a, through the service: six payroll weeks' worth on Sep 23 retire the five payroll weeks back to Aug 27, and
     the sixth week's money never pays the cash week of Aug 20 — it stands unpaid at $1,047.00. */
  test("leftover payroll money never pays a cash week", () => {
    deposit("2026-09-23", WEEK * 2);
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.settledBy.has("2026-08-20")).toBe(false);
    expect(paydayOf("2026-08", "2026-08-20", TODAY)).toMatchObject({ amountCents: CASH, settledByDepositsOn: [] });
  });

  /*
   * A third weekly deposit, then a $1,200.00 week: the samples are the lump, Sep 24, Oct 1 and Oct 8 — residuals 0,
   * 0, 0 and $58.08, a band of ±$50.30 — and the $1,200.00 week is a raise of $58.08 over the payroll rate.
   */
  test("a $1,200.00 week after a third weekly deposit reads 'rose by $58.08'", () => {
    deposit("2026-10-01", WEEK);
    const raise = deposit("2026-10-08", 120_000);
    expect(rowOf("2026-10", "2026-10-08", raise, TODAY)).toMatchObject({
      state: "paid_different",
      expectedAmountCents: WEEK,
    });
    expect(payNotices(TODAY)).toEqual([expect.stringContaining(`${PAY_NAME} rose by $58.08`)]);
  });
});

/**
 * The same ledger, drawn from his first deposit's payday (Jun 4) — the universe step B of §6A 55 gives every reader.
 * Here Jun 4's cash week is a payday paid, and it is a sample of a cash week's pay.
 */
describe("his ledger drawn from his first deposit — Jun 4 is a cash week paid in full", () => {
  const TODAY = "2026-10-08";
  let ids: ReturnType<typeof hisFour>;
  beforeEach(() => {
    addPaySeries("2026-06-04");
    ids = hisFour();
  });

  /* 🔴 Held to $1,141.92, on a spread measured from raw samples (σ $44.75), it read amber, "fell by $94.92". */
  test("Jun 4 is paid, held to the cash rate — not $94.92 short", () => {
    expect(rowOf("2026-06", "2026-06-04", ids.jun4, TODAY)).toMatchObject({
      state: "paid",
      expectedAmountCents: CASH,
      towardNoPayday: false,
    });
    expect(payNotices(TODAY)).toEqual([]);
  });

  test("Jun 5's $400.00 reads toward no payday; Jun 11, 18 and 25 stand unpaid at $1,047.00", () => {
    expect(rowOf("2026-06", "2026-06-05", ids.jun5, TODAY)).toMatchObject({ state: "paid", towardNoPayday: true });
    for (const day of ["2026-06-11", "2026-06-18", "2026-06-25"]) {
      expect(paydayOf("2026-06", day, TODAY)).toMatchObject({ amountCents: CASH, settledByDepositsOn: [] });
    }
  });

  /*
   * ⚖️ The spread on RESIDUALS. Samples Jun 4 ($1,047.00 against $1,047.00), the lump, Sep 24, Oct 1 and a $1,200.00
   * Oct 8: residuals 0, 0, 0, 0, $58.08 — a band of ±$46.46 — so the $1,200.00 week is a raise. 🔴 On raw samples
   * the cash week widened the band to ±$98.43 and the raise read `paid`.
   */
  test("a $1,200.00 week reads 'rose by $58.08' — the cash week is no variance", () => {
    deposit("2026-10-01", WEEK);
    const raise = deposit("2026-10-08", 120_000);
    expect(rowOf("2026-10", "2026-10-08", raise, TODAY)?.state).toBe("paid_different");
    expect(rowOf("2026-06", "2026-06-04", ids.jun4, TODAY)?.state).toBe("paid");
    expect(payNotices(TODAY)).toEqual([expect.stringContaining(`${PAY_NAME} rose by $58.08`)]);
  });

  /* The series page draws each row against its own time's rate, as the calendar grades it. */
  test("the series page holds Jun 4 to $1,047.00 and the payroll rows to $1,141.92", () => {
    const history = seriesDetail(bundle.db, PAY, TODAY).amountHistory;
    expect(history.map((p) => [p.date, p.expectedCents])).toEqual([
      ["2026-06-04", CASH],
      ["2026-06-05", CASH],
      ["2026-09-23", WEEK],
      ["2026-09-24", WEEK],
    ]);
  });
});

/* ⛔ At a constant rate the residuals' spread is the samples' own — no series without a history reads differently. */
test("residual spread equals the raw spread when the rate never changed", () => {
  const samples = [WEEK, 115_000, 113_000, WEEK, 120_000];
  const residuals = samples.map((c) => spreadResidualCents(c, undefined, WEEK)!);
  expect(populationStddev(residuals)).toBeCloseTo(populationStddev(samples), 9);
});
