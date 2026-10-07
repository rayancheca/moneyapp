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
import { addDays } from "@/lib/dates";
import { noticesCard } from "./notices-card";
import { recurringCalendar, type CalendarEntry } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * 🔴 A LUMP OF FOUR WEEKS' PAY WAS DRAWN AS A PRICE CHANGE.
 *
 * Measured on a copy of his ledger, 2026-10-07: one deposit of $4,567.68 on
 * 2026-09-23 banked exactly four weeks of "It America LLC (weekly pay)" at
 * $1,141.92. Settlement (his decision of 2026-09-28, settle backwards) spends
 * it on Sep 24, 17, 10 and 3, and the calendar's own chips say so — yet the row
 * was graded against ONE payday's amount, drawn amber `paid_different`, and the
 * dashboard's "Worth a look" card printed "It America LLC (weekly pay) rose by
 * $3,425.76 between its usual amount and Sep 23." beside an Earned-vs-banked
 * card counting the same money as four paydays.
 *
 * A pay row is a price change only when what it paid PER PAYDAY differs from
 * the expectation. A raise (one $1,200.00 week) still is, and so is a lump that
 * is not a whole number of weeks.
 */

let dir: string;
let bundle: DbBundle;
const WELLS = "acct-wells";
const PAY = "series-it-america";
const PAY_NAME = "It America LLC (weekly pay)";
const WEEK = 114_192;
const TODAY = "2026-10-07";
const now = (): string => new Date().toISOString();

function categoryId(top: string, child?: string): string {
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, top), isNull(categories.parentId)))
    .get()!;
  if (!child) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, child), eq(categories.parentId, parent.id)))
    .get()!.id;
}

/**
 * His series: weekly Thursdays at $1,141.92 typed by him — with a MEASURED
 * spread, because a series with none makes no amount claim at all
 * (`classifyPostedAmount`), and a fixture without one tests silence.
 */
function addPaySeries(amountCentsStddev: number | null = 1_000): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id: PAY,
      name: PAY_NAME,
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: WEEK,
      amountCentsStddev,
      userAmountCents: WEEK,
      nextExpectedOn: "2026-07-23",
      nextExpectedAmountCents: WEEK,
      lastMatchedOn: "2026-07-23",
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let seq = 0;
function addRow(seriesId: string, postedOn: string, amountCents: number, category: string): string {
  seq += 1;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: category,
      recurringSeriesId: seriesId,
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

/** A deposit ATTRIBUTED to the pay series, as he linked them. */
const deposit = (postedOn: string, amountCents: number): string =>
  addRow(PAY, postedOn, amountCents, categoryId("Income", "Salary"));

/** The pay series' posted row on a day — the deposit itself, not a payday chip. */
function rowOn(month: string, day: string, transactionId: string): CalendarEntry | undefined {
  return (recurringCalendar(bundle.db, month, TODAY).entriesByDay[day] ?? []).find(
    (e) => e.transactionId === transactionId,
  );
}

const payNotices = (): string[] =>
  (noticesCard(bundle.db, TODAY)?.notices ?? []).map((n) => n.text).filter((t) => t.includes(PAY_NAME));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-lump-pay-"));
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
  seq = 0;
  addPaySeries();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("his ledger — Sep 23's $4,567.68 is four weeks of pay, not a raise", () => {
  let lump: string;
  beforeEach(() => {
    lump = deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
  });

  test("the calendar draws the lump paid: what it paid per payday is the week he expects", () => {
    const row = rowOn("2026-09", "2026-09-23", lump);
    expect(row).toMatchObject({ amountCents: WEEK * 4, expectedAmountCents: WEEK });
    expect(row?.state).toBe("paid");
  });

  test("the paydays it paid are chipped to it — the four the row is now measured over", () => {
    const september = recurringCalendar(bundle.db, "2026-09", TODAY);
    for (const payday of ["2026-09-03", "2026-09-10", "2026-09-17"]) {
      const chip = september.entriesByDay[payday]?.find((e) => e.seriesId === PAY && e.transactionId === null);
      expect(chip).toMatchObject({ state: "paid", settledByDepositsOn: ["2026-09-23"] });
    }
  });

  test("the dashboard's Worth a look card says nothing about his pay rising", () => {
    expect(payNotices()).toEqual([]);
  });
});

describe("what still reads as a price change", () => {
  test("a raise — one $1,200.00 week against $1,141.92 — is drawn paid_different and noticed", () => {
    deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
    const raise = deposit("2026-10-01", 120_000);
    expect(rowOn("2026-10", "2026-10-01", raise)?.state).toBe("paid_different");
    expect(payNotices()).toEqual([expect.stringContaining(`${PAY_NAME} rose by $58.08`)]);
  });

  test("a lump that is not a whole number of weeks — $4,000.00, three weeks and change — is drawn paid_different", () => {
    const partial = deposit("2026-09-23", 400_000);
    expect(rowOn("2026-09", "2026-09-23", partial)?.state).toBe("paid_different");
    expect(payNotices()).toHaveLength(1);
  });

  test("four weeks at a raised rate — $4,800.00 — is drawn paid_different", () => {
    const raisedLump = deposit("2026-09-23", 480_000);
    expect(rowOn("2026-09", "2026-09-23", raisedLump)?.state).toBe("paid_different");
  });

  test("a short week — $1,047.00 — is still drawn paid_different, as before", () => {
    const short = deposit("2026-09-24", 104_700);
    expect(rowOn("2026-09", "2026-09-24", short)?.state).toBe("paid_different");
  });

  test("a bill that posted three months at once is untouched — settlement does not speak about bills", () => {
    const rent = "series-rent";
    bundle.db
      .insert(recurringSeries)
      .values({
        id: rent,
        name: "Zzz Rent",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: -200_000,
        amountCentsStddev: 500,
        userAmountCents: -200_000,
        nextExpectedOn: "2026-10-05",
        lastMatchedOn: "2026-09-05",
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    const triple = addRow(rent, "2026-09-05", -600_000, categoryId("Housing"));
    expect(rowOn("2026-09", "2026-09-05", triple)?.state).toBe("paid_different");
  });
});

/*
 * ⛔ ONLY A LUMP IS MEASURED PER WEEK. Settlement pools change, so a week's
 * leftover cents can finish an older payday another deposit mostly paid. Sep 3's
 * $1,150.00 pays Sep 3 and carries $8.08; Sep 23's $4,560.00 pays Sep 24, 17 and
 * 10 and, with $7.68 of that change, Aug 27. Sep 3's money touched two paydays —
 * divided by two it would read as half a week, amber, "rose by $8.08". It paid one.
 */
test("a week whose change later finished another payday is still the one week it paid", () => {
  const week = deposit("2026-09-03", 115_000);
  deposit("2026-09-23", 456_000);
  expect(rowOn("2026-09", "2026-09-03", week)?.state).toBe("paid");
});

test("two weekly deposits on one day are each measured as the week they are", () => {
  // settlement names money by its deposit's DAY, so neither row's own spending
  // can be told apart from the other's — each is measured on its own amount
  const a = deposit("2026-09-24", WEEK);
  const b = deposit("2026-09-24", WEEK);
  expect(rowOn("2026-09", "2026-09-24", a)?.state).toBe("paid");
  expect(rowOn("2026-09", "2026-09-24", b)?.state).toBe("paid");
});

/**
 * 🔴 HIS SERIES HAS NO CACHED SPREAD, so the calendar measures one from the
 * rows — and measured on RAW amounts, the lump itself was in it. On a copy of
 * his ledger that read σ $1,629.39, a band of ±$3,258.78, inside which a
 * $1,200.00 raise, a $4,000.00 partial lump and a $4,800.00 four-week lump all
 * read `paid`. The spread is measured the way each row is held to it — per
 * payday — so the lump is one week's pay four times over, not one wild sample.
 */
describe("a series with no cached spread — the spread is measured per payday too", () => {
  /** Six weeks of ordinary Thursday pay, Jul 23 → Aug 27, each paying its own payday. */
  function weeklyHistory(): void {
    for (let day = "2026-07-23"; day <= "2026-08-27"; day = addDays(day, 7)) deposit(day, WEEK);
  }

  beforeEach(() => {
    bundle.db.delete(recurringSeries).where(eq(recurringSeries.id, PAY)).run();
    addPaySeries(null);
    weeklyHistory();
  });

  test("the lump of four weeks is drawn paid, and the card says nothing", () => {
    const lump = deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
    expect(rowOn("2026-09", "2026-09-23", lump)?.state).toBe("paid");
    expect(payNotices()).toEqual([]);
  });

  test("a $1,200.00 week is a raise — drawn paid_different and noticed", () => {
    deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
    const raise = deposit("2026-10-01", 120_000);
    expect(rowOn("2026-10", "2026-10-01", raise)?.state).toBe("paid_different");
    expect(payNotices()).toEqual([expect.stringContaining(`${PAY_NAME} rose by $58.08`)]);
  });

  test("a $4,000.00 lump — not a whole number of weeks — is drawn paid_different", () => {
    const partial = deposit("2026-09-23", 400_000);
    deposit("2026-09-24", WEEK);
    expect(rowOn("2026-09", "2026-09-23", partial)?.state).toBe("paid_different");
  });

  /*
   * And the sentence says what changed PER WEEK. Four weeks at $1,200.00 is a
   * raise of $58.08 a week; "rose by $3,658.08" would compare four weeks with one.
   */
  test("four weeks at $1,200.00 is drawn paid_different, and noticed as the $58.08 a week it rose", () => {
    const raisedLump = deposit("2026-09-23", 480_000);
    expect(rowOn("2026-09", "2026-09-23", raisedLump)).toMatchObject({
      state: "paid_different",
      perPayday: { paydays: 4, cents: 120_000 },
    });
    expect(payNotices()).toEqual([
      expect.stringContaining(`${PAY_NAME} rose by $58.08 between its usual amount and Sep 23`),
    ]);
  });

  /* The series page's history draws the same reading the calendar grades. */
  test("the series page draws the lump as four paydays at $1,141.92, as the calendar reads it", () => {
    deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
    const history = seriesDetail(bundle.db, PAY, TODAY).amountHistory;
    expect(history.find((p) => p.date === "2026-09-23")).toMatchObject({
      amountCents: WEEK * 4,
      perPayday: { paydays: 4, cents: WEEK },
    });
    expect(history.filter((p) => p.date !== "2026-09-23").every((p) => p.perPayday === null)).toBe(true);
  });
});

test("the calendar's lump row says how many paydays it paid, and what each", () => {
  const lump = deposit("2026-09-23", WEEK * 4);
  expect(rowOn("2026-09", "2026-09-23", lump)?.perPayday).toEqual({ paydays: 4, cents: WEEK });
});
