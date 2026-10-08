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
import { postedSpreadReading } from "@/components/recurring/labels";
import { addDays } from "@/lib/dates";
import { spreadResidualCents } from "@/lib/per-payday";
import { incomeExpectation } from "./budgets";
import { noticesCard } from "./notices-card";
import { paydaySettlement } from "./payday-settlement";
import { provenanceFor } from "./provenance";
import { listSeries, populationStddev } from "./recurring";
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
 * the history the guarded write will set. `anchor` is Jul 23 on his ledger; either way his paydays open on Jun 4, the
 * first payday (`firstPaydayOn`, §6A 55 step B).
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

describe("his ledger as it stands — anchored Jul 23, his paydays open on Jun 4", () => {
  const TODAY = "2026-10-08";
  let ids: ReturnType<typeof hisFour>;
  beforeEach(() => {
    addPaySeries("2026-07-23");
    ids = hisFour();
  });

  /* ⚖️ Step B: the walk opens on Jun 4, so Jun 4's cash week is paid by its own deposit — 🔴 drawn from the Jul 23
     anchor, it read "toward no payday" beside an income card that had earned it. */
  test("settlement: Jun 4 pays Jun 4; Sep 23 pays Sep 24, 17, 10, 3; Sep 24 pays Aug 27; Jun 5's $400 nothing", () => {
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.portions.map((p) => `${p.paydayOn} ← ${p.depositOn}`).sort()).toEqual([
      "2026-06-04 ← 2026-06-04",
      "2026-08-27 ← 2026-09-24",
      "2026-09-03 ← 2026-09-23",
      "2026-09-10 ← 2026-09-23",
      "2026-09-17 ← 2026-09-23",
      "2026-09-24 ← 2026-09-23",
    ]);
    expect(s.unallocatedCents).toBe(40_000);
  });

  /* ⛔ No "toward the payday of Aug 27" anywhere in June: Jun 4 pays its own payday, Jun 5 none — ungraded. */
  test("June's deposits stay in June — Jun 4 paid its own payday, Jun 5 toward no payday", () => {
    expect(rowOf("2026-06", "2026-06-04", ids.jun4, TODAY)).toMatchObject({
      state: "paid",
      amountCents: CASH,
      settlesPaydaysOn: [],
      towardNoPayday: false,
      expectedAmountCents: CASH,
    });
    // held to no week's rate: it answers none (`PaydayReading.expectedCents`)
    expect(rowOf("2026-06", "2026-06-05", ids.jun5, TODAY)).toMatchObject({
      state: "paid",
      amountCents: 40_000,
      settlesPaydaysOn: [],
      towardNoPayday: true,
      expectedAmountCents: null,
    });
  });

  /*
   * ⛔ ONE READING OF THE ROW, on both surfaces that draw it. 🔴 Measured on a copy of his ledger with the history
   * set (2026-10-08): the series page's table lens read "Jun 5, 2026 +$400.00 -$647.00" and its bar's tooltip
   * "expected $1,047.00", while the calendar drew the same row "paid (toward no payday) $400.00", ungraded.
   */
  test("the series page reads Jun 5's $400.00 toward no payday, held to nothing — as the calendar draws it", () => {
    const point = seriesDetail(bundle.db, PAY, TODAY).amountHistory.find((p) => p.date === "2026-06-05")!;
    expect(point).toMatchObject({ amountCents: 40_000, expectedCents: null, towardNoPayday: true });
    expect(rowOf("2026-06", "2026-06-05", ids.jun5, TODAY)?.towardNoPayday).toBe(true);
    // a payday paid is still held to its own era's rate, and reads toward a payday
    const jun4 = seriesDetail(bundle.db, PAY, TODAY).amountHistory.find((p) => p.date === "2026-06-04")!;
    expect(jun4).toMatchObject({ expectedCents: CASH, towardNoPayday: false });
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
 * The same ledger anchored on Jun 4 itself — the same paydays, since step B of §6A 55 opens every reader on the first
 * payday whichever anchor detection stored. Jun 4's cash week is a payday paid, and a sample of a cash week's pay.
 */
describe("his ledger anchored on his first payday — Jun 4 is a cash week paid in full", () => {
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

  /* The series page draws each row against its own time's rate, as the calendar grades it — Jun 5 against none. */
  test("the series page holds Jun 4 to $1,047.00, the payroll rows to $1,141.92, and Jun 5 to nothing", () => {
    const history = seriesDetail(bundle.db, PAY, TODAY).amountHistory;
    expect(history.map((p) => [p.date, p.expectedCents, p.towardNoPayday])).toEqual([
      ["2026-06-04", CASH, false],
      ["2026-06-05", null, true],
      ["2026-09-23", WEEK, false],
      ["2026-09-24", WEEK, false],
    ]);
  });
});

/**
 * ⚖️ THE POSTED AVERAGE, ONE READING (§6A 55, §2): the series page's Per charge, the All tab's "posted avg" and the
 * amount popover name the same figure — for a pay series, what a PAYDAY paid, in the rate era in force now.
 *
 * 🔴 Measured on a copy of his ledger 2026-10-08: under "+$1,141.92" the page printed "posted avg +$1,789.15 ±
 * 1881.46", the All tab "posted avg +$1,789.15", and the popover "⚠️ The ledger's own average of what actually posted
 * is $1,789.15, which is not what you set." — the raw mean of a cash week, $400.00, a four-week lump and a week, an
 * amount no payday ever paid.
 */
describe("the posted average — his series page, the All tab and the popover read one figure", () => {
  const TODAY = "2026-10-08";
  const surfaces = () => {
    const d = seriesDetail(bundle.db, PAY, TODAY);
    return {
      pageAvg: d.postedAvgCents,
      page: postedSpreadReading(d.nextExpectedAmountCents, d.postedAvgCents, d.postedStddevCents),
      allTab: listSeries(bundle.db, TODAY).find((s) => s.id === PAY)!.postedAvgCents,
      popover: provenanceFor(bundle.db, { kind: "recurringSeries", id: PAY, today: TODAY })!.headline,
    };
  };
  const NOTHING_TO_ADD = { text: null, attachedToHeadline: false, avgLine: null };

  test("with his history set: $1,141.92 on all three — no average line, no ±, no disagreement", () => {
    addPaySeries("2026-07-23");
    hisFour();
    const s = surfaces();
    expect([s.pageAvg, s.allTab]).toEqual([WEEK, WEEK]);
    expect(s.page).toEqual(NOTHING_TO_ADD);
    expect(s.popover).not.toContain("$1,789.15");
    expect(s.popover).not.toContain("which is not what you set");
  });

  /*
   * ⚠️ Before the history is written, Jun 4's cash week — a payday his own deposit paid since step B opens his paydays
   * there — is a week of the ONE rate the series has, paid $94.92 short: $1,047.00, the lump's weeks and Sep 24
   * average $1,110.28 ± $54.80. That is the reading the history exists to correct; with it set (above), nothing.
   */
  test("his ledger as it stands, before the history is written — Jun 4 is a short week of the one rate", () => {
    addPaySeries("2026-07-23");
    bundle.db.update(recurringSeries).set({ userAmountHistory: null }).where(eq(recurringSeries.id, PAY)).run();
    hisFour();
    const s = surfaces();
    expect([s.pageAvg, s.allTab]).toEqual([111_028, 111_028]);
    expect(s.page).toEqual({ text: "± $54.80", attachedToHeadline: false, avgLine: 111_028 });
    expect(s.popover).toContain("average of what actually posted is $1,110.28, which is not what you set.");
  });

  /* ⛔ Drawn from his first deposit, Jun 4 pays its cash week in full — a payday of the cash era, not of today's. */
  test("Jun 4's cash week, paid in full, is not averaged with the payroll weeks", () => {
    addPaySeries("2026-06-04");
    hisFour();
    const s = surfaces();
    expect([s.pageAvg, s.allTab]).toEqual([WEEK, WEEK]);
    expect(s.page).toEqual(NOTHING_TO_ADD);
  });

  /* A third weekly deposit, then a $1,200.00 week: the lump, Sep 24, Oct 1 and Oct 8 average $1,156.44 ± $29.04. */
  test("a $1,200.00 week: all three name $1,156.44, the page with its ± as money", () => {
    addPaySeries("2026-07-23");
    hisFour();
    deposit("2026-10-01", WEEK);
    deposit("2026-10-08", 120_000);
    const s = surfaces();
    expect(s.page).toEqual({ text: "± $29.04", attachedToHeadline: false, avgLine: 115_644 });
    expect(s.allTab).toBe(115_644);
    expect(s.popover).toContain("average of what actually posted is $1,156.44, which is not what you set.");
  });

  /* The popover reads the evidence on the day the page asks, as the page does: on Oct 7 the $1,200.00 is not in. */
  test("the popover reads what had arrived by the day it is asked", () => {
    addPaySeries("2026-07-23");
    hisFour();
    deposit("2026-10-01", WEEK);
    deposit("2026-10-08", 120_000);
    const asked = (today: string) => provenanceFor(bundle.db, { kind: "recurringSeries", id: PAY, today })!.headline;
    expect(asked("2026-10-07")).not.toContain("which is not what you set");
    expect(asked("2026-10-08")).toContain("$1,156.44, which is not what you set");
  });
});

/* ⛔ At a constant rate the residuals' spread is the samples' own — no series without a history reads differently. */
test("residual spread equals the raw spread when the rate never changed", () => {
  const samples = [WEEK, 115_000, 113_000, WEEK, 120_000];
  const residuals = samples.map((c) => spreadResidualCents(c, undefined, WEEK)!);
  expect(populationStddev(residuals)).toBeCloseTo(populationStddev(samples), 9);
});
