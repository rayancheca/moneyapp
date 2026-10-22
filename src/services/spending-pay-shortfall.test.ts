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
import { formatDayLong } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import { passedPaydaysWords } from "@/lib/unbanked-income";
import { cashEarningsReadings } from "./cash-earnings";
import { forecastCurrentMonth } from "./forecast";
import { incomeCard } from "./income-card";
import { paydaySettlement } from "./payday-settlement";

/**
 * /spending's pay notes, composed as the page composes them — `cashEarningsReadings(…, withChecked)` into
 * `cashEarningsSectionNotes` — over a temp ledger.
 *
 * 🔴 Read on his ledger 2026-10-13: the only sentence about a window's unbanked paydays was gated on a STALE series, and
 * his pay was "Awaiting statements" — so August (Aug 6, 13, 20 paid by no deposit, Aug 27 by Sep 24's) read "INCOME
 * $54.12" with no note, while September's surplus note named the lump that paid Aug 27.
 *
 * ⛔ The fixture is his shape at one rate: a Thursday schedule ANCHORED (an unanchored series projects no payday for
 * the settlement to walk), a deposit that pays its own payday, and a later one whose money walks back over the month
 * line — Thu Sep 3's $2,000.00 pays Sep 3 and Aug 27. Today is Mon Sep 14, one payday (Sep 10) since: not stale.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-14";
const WF = "acct-wf";
const SERIES = "series-pay";

function salaryId(): string {
  const income = bundle.db.select().from(categories).where(and(eq(categories.name, "Income"), isNull(categories.parentId))).get()!;
  return bundle.db.select().from(categories).where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id))).get()!.id;
}

function deposit(id: string, postedOn: string, amountCents: number): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: WF,
      postedOn,
      amountCents,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryId(),
      recurringSeriesId: SERIES,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function coverThrough(to: string): void {
  for (let day = "2026-07-01"; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WF, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pay-shortfall-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WF,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      id: SERIES,
      name: "Cash job (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      nextExpectedOn: "2026-09-17",
      accountId: WF,
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  deposit("t-jul", "2026-07-30", 100_000);
  deposit("t-sep", "2026-09-03", 200_000);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const notesFor = (from: string, to: string, today = TODAY) =>
  cashEarningsSectionNotes({
    rows: cashEarningsReadings(bundle.db, { from, to, today, withChecked: true }),
    formatDay: formatDayLong,
  });

describe("/spending — a window whose read paydays were not banked inside it", () => {
  test("a shortfall a later deposit paid: that payday is named with its deposit, the rest never reached a bank", () => {
    coverThrough("2026-09-12");
    expect(notesFor("2026-08-01", "2026-08-31")).toEqual([
      {
        id: "cash-earnings-shortfall-Cash job (weekly pay)",
        body:
          "Cash job (weekly pay)'s paydays over Aug 6 – 27, 2026 came to $4,000.00, and none of it was banked inside " +
          "the window: $1,000.00 (Aug 27) was paid by the deposit of Thu, Sep 3, 2026 and $3,000.00 never reached a " +
          "bank.",
      },
    ]);
  });

  test("a window ending on the day the lump landed: that day's payday is read and its deposit banked inside", () => {
    // 🔴 found in review 2026-10-13: the last day could fall out of the window with every test green — then this read
    // "Aug 6 – 27 … $1,000.00 (Aug 27) was paid by the deposit of Thu, Sep 3, 2026", a deposit inside its own window
    coverThrough("2026-09-12");
    expect(notesFor("2026-08-01", "2026-09-03").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – Sep 3, 2026 came to $5,000.00, of which $2,000.00 was banked " +
        "inside the window and $3,000.00 never reached a bank.",
    ]);
  });

  test("a shortfall no deposit ever paid", () => {
    coverThrough("2026-09-12");
    expect(notesFor("2026-08-01", "2026-08-21").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – 20, 2026 came to $3,000.00, and none of it reached a bank.",
    ]);
  });

  test("a window mixing read and unread paydays: the unread one is not looked for, never unbanked", () => {
    coverThrough("2026-09-05");
    expect(notesFor("2026-08-01", "2026-09-30").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – Sep 3, 2026 came to $5,000.00, of which $2,000.00 was banked " +
        "inside the window and $3,000.00 never reached a bank; 1 more payday in the window falls after Sat, Sep 5, " +
        "2026, the last day every account that pay lands in has been checked through — so the ledger has not looked " +
        "for its deposit.",
    ]);
  });

  test("a series that is not stale, its window banked in full: no note", () => {
    coverThrough("2026-09-12");
    expect(notesFor("2026-07-01", "2026-07-31")).toEqual([]);
  });

  test("a payday paid early, by a deposit before the window began (§6A 29)", () => {
    // Wed Sep 9 pays Thu Sep 10 — inside its tolerance — and the window opens on Sep 10
    deposit("t-early", "2026-09-09", 100_000);
    coverThrough("2026-09-12");
    expect(notesFor("2026-09-10", "2026-09-13").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s payday on Sep 10, 2026 came to $1,000.00, and none of it was banked inside the " +
        "window: $1,000.00 (Sep 10) was paid early, by the deposit of Wed, Sep 9, 2026.",
    ]);
  });

  test("a stale series keeps its own note — never both", () => {
    // Mon Oct 5: Sep 10, 17, 24 and Oct 1 have passed since Sep 3, all on checked days
    coverThrough("2026-10-03");
    expect(notesFor("2026-08-01", "2026-08-31", "2026-10-05").map((n) => n.id)).toEqual([
      "cash-earnings-unbanked-Cash job (weekly pay)",
    ]);
  });
});

/** Replaces the fixture's deposits with these — a window's shape, stated whole. */
function onlyDeposits(rows: readonly (readonly [string, number])[]): void {
  bundle.db.delete(transactions).where(eq(transactions.recurringSeriesId, SERIES)).run();
  rows.forEach(([postedOn, cents], i) => deposit(`t-${i}`, postedOn, cents));
}

/**
 * 🔴 Review of a4b0fca (HIGH): two definitions of "never reached a bank". On his ledger copy 2026-10-13 /spending ALL
 * and YTD said "$11,517.00 never reached a bank" (the settlement's eleven unpaid cash weeks) while the dashboard's
 * Earned vs banked said "$11,117.00 of it never reached a bank" of the same nineteen paydays — $400.00 apart, the Jun 5
 * deposit that paid no payday. ⚖️ Decision 55 approved the dashboard's figure: what the paydays imply less what was
 * banked, so money banked inside the window toward no payday nets it. /spending now reads it from the same arithmetic.
 */
describe("/spending — what no deposit made up is Earned vs banked's figure, split as it splits it", () => {
  /*
   * ⚖️ …and of that figure, Thu Sep 10 — checked through Sat Sep 12, its days to land running to Sun Sep 13, and
   * settled by no deposit — is "not banked yet" on both surfaces too, as the forecast's note says it
   * (`unbankedSplit`). 🔴 Both said "$3,600.00 never reached a bank" of it (review of 878c3d5).
   */
  test("ALL: the $400.00 that paid no payday nets it on both — $2,600.00 never, $1,000.00 not banked yet", () => {
    // Fri Jul 31's $400.00 finds Jul 30 paid by its own deposit and reaches no other payday: toward no payday
    deposit("t-change", "2026-07-31", 40_000);
    coverThrough("2026-09-12");
    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.totals.gapMagnitudeCents).toBe(360_000);
    expect(card.totals.gapLabel).toBe(
      "$2,600.00 of it never reached a bank; $1,000.00 is for paydays whose days to land run past Sep 12, the last " +
        "day every account that pay lands in has been checked through — so it is not banked yet.",
    );
    expect(notesFor("2026-01-01", TODAY).map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Jul 30 – Sep 10, 2026 came to $7,000.00, of which $3,400.00 was banked " +
        "inside the window ($400.00 of it, from the deposit of Fri, Jul 31, 2026, went toward no payday), $1,000.00 " +
        "is not banked yet, and $2,600.00 never reached a bank; Sep 10's days to land run past Sat, Sep 12, 2026, " +
        "the last day every account that pay lands in has been checked through.",
    ]);
  });
});

/**
 * 🔴 Review of a4b0fca (MEDIUM): a short-paid payday read "never reached a bank" though its window banked the whole
 * schedule, and variable pay printed the surplus AND the shortfall note in one window. Weekly $1,000.00 on Thursdays,
 * Wells Fargo checked through Sat Sep 26, today Mon Sep 28.
 */
describe("/spending — a window that banked its whole schedule is not short", () => {
  const SEPTEMBER = ["2026-09-01", "2026-09-30", "2026-09-28"] as const;

  test("$1,000.00 / $950.00 / $1,050.00 / $1,000.00 over four $1,000.00 weeks: no note at all", () => {
    onlyDeposits([
      ["2026-09-03", 100_000],
      ["2026-09-10", 95_000],
      ["2026-09-17", 105_000],
      ["2026-09-24", 100_000],
    ]);
    coverThrough("2026-09-26");
    expect(notesFor(...SEPTEMBER)).toEqual([]);
  });

  test("$900.00 then $1,300.00: the surplus note alone — a window never prints both", () => {
    onlyDeposits([
      ["2026-09-03", 100_000],
      ["2026-09-10", 90_000],
      ["2026-09-17", 130_000],
      ["2026-09-24", 100_000],
    ]);
    coverThrough("2026-09-26");
    expect(notesFor(...SEPTEMBER).map((n) => n.id)).toEqual(["cash-earnings-catchup-Cash job (weekly pay)"]);
  });
});

/**
 * 🔴 Review of a4b0fca (MEDIUM): the surplus note called ALL of a window's surplus "earlier pay arriving late" when part
 * of it paid a LATER window's payday early — his §6A 29 shape, payroll landing the Wednesday before the Thursday it
 * pays, so Wed Sep 30 pays Thu Oct 1. ⚖️ Decisions 29/32 name that money "paid early", read from the payday itself.
 * September's note and October's must agree about the same $1,141.92.
 */
describe("/spending — money that paid a later window's payday early", () => {
  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ userAmountCents: 114_192, amountCentsAvg: 114_192 }).run();
    // payroll lands the Wednesday before the Thursday it pays
    const wednesdays = ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07"];
    onlyDeposits(wednesdays.map((d) => [d, 114_192]));
    coverThrough("2026-10-10");
  });

  test("September names the $1,141.92 that paid Oct 1's payday early — not a backlog clearing", () => {
    expect(notesFor("2026-09-01", "2026-09-30", "2026-10-13").map((n) => n.body)).toEqual([
      "Cash job (weekly pay) banked $1,141.92 more than its paydays over Sep 3 – 24, 2026 came to. $1,141.92 of it, " +
        "from the deposit of Wed, Sep 30, 2026, paid Oct 1's payday early.",
    ]);
  });

  test("October names the same $1,141.92: Oct 1 paid early, by the deposit of Sep 30", () => {
    expect(notesFor("2026-10-01", "2026-10-31", "2026-10-13").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Oct 1 – 8, 2026 came to $2,283.84, of which $1,141.92 was banked inside " +
        "the window and $1,141.92 (Oct 1) was paid early, by the deposit of Wed, Sep 30, 2026.",
    ]);
  });
});

/**
 * 🔴 Review of 2a415d5 (HIGH): the window's net counted money that crossed its line twice. "Never reached a bank" was
 * the read paydays less EVERY deposit inside the window — so money that paid ANOTHER window's payday also made up this
 * window's own unbanked one, while the other window's note named the same money paying its payday. A month with a
 * payday no deposit paid went silent, and the months stopped adding up to the window over both. ⛔ Money that paid
 * another window's payday is that window's, named here by its deposit; only money that paid no payday nets the
 * shortfall (decision 55). Weekly $1,141.92 on Thursdays, Wells Fargo checked through Sat Oct 10, today Tue Oct 13.
 */
describe("/spending — money that crossed the window line is counted once", () => {
  const OCT_13 = "2026-10-13";
  const bodies = (from: string, to: string): string[] => notesFor(from, to, OCT_13).map((n) => n.body);

  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ userAmountCents: 114_192, amountCentsAvg: 114_192 }).run();
    coverThrough("2026-10-10");
  });

  test("(A) Wed Sep 30 paid Thu Oct 1 early and Sep 17 was never banked: September says so, October agrees", () => {
    onlyDeposits(["2026-09-02", "2026-09-09", "2026-09-23", "2026-09-30", "2026-10-07"].map((d) => [d, 114_192]));
    expect(bodies("2026-09-01", "2026-09-30")).toEqual([
      "Cash job (weekly pay)'s paydays over Sep 3 – 24, 2026 came to $4,567.68, of which $3,425.76 was banked " +
        "inside the window and $1,141.92 never reached a bank; another $1,141.92 banked inside the window, from the " +
        "deposit of Wed, Sep 30, 2026, paid Oct 1's payday early.",
    ]);
    expect(bodies("2026-10-01", "2026-10-31")).toEqual([
      "Cash job (weekly pay)'s paydays over Oct 1 – 8, 2026 came to $2,283.84, of which $1,141.92 was banked inside " +
        "the window and $1,141.92 (Oct 1) was paid early, by the deposit of Wed, Sep 30, 2026.",
    ]);
    // the window over both, and the dashboard: the same $1,141.92 — once
    expect(bodies("2026-09-01", OCT_13)).toEqual([
      "Cash job (weekly pay)'s paydays over Sep 3 – Oct 8, 2026 came to $6,851.52, of which $5,709.60 was banked " +
        "inside the window and $1,141.92 never reached a bank.",
    ]);
    const card = incomeCard(bundle.db, OCT_13)!;
    expect([card.totals.gapMagnitudeCents, card.totals.gapLabel]).toEqual([114_192, "never reached a bank"]);
  });

  /*
   * ⚖️ Oct 8 is checked through Sat Oct 10 and its days to land run to Sun Oct 11: no deposit settled it, so it is
   * "not banked yet" — on /spending, on Earned vs banked and on the forecast's note alike. 🔴 The first two said it
   * "never reached a bank" (review of 878c3d5).
   */
  test("(D) Thu Oct 1's lump paid Sep 24 late and Oct 8 was not banked: October says so, September agrees", () => {
    onlyDeposits([
      ["2026-09-03", 114_192],
      ["2026-09-10", 114_192],
      ["2026-09-17", 114_192],
      ["2026-10-01", 228_384],
    ]);
    expect(bodies("2026-09-01", "2026-09-30")).toEqual([
      "Cash job (weekly pay)'s paydays over Sep 3 – 24, 2026 came to $4,567.68, of which $3,425.76 was banked " +
        "inside the window and $1,141.92 (Sep 24) was paid by the deposit of Thu, Oct 1, 2026.",
    ]);
    expect(bodies("2026-10-01", "2026-10-31")).toEqual([
      "Cash job (weekly pay)'s paydays over Oct 1 – 8, 2026 came to $2,283.84, of which $1,141.92 was banked inside " +
        "the window and $1,141.92 is not banked yet; Oct 8's days to land run past Sat, Oct 10, 2026, the last day " +
        "every account that pay lands in has been checked through; another $1,141.92 banked inside the window, from " +
        "the deposit of Thu, Oct 1, 2026, paid Sep 24's payday.",
    ]);
    const card = incomeCard(bundle.db, OCT_13)!;
    expect([card.totals.gapMagnitudeCents, card.totals.gapLabel]).toEqual([
      114_192,
      "all of it is for paydays whose days to land run past Oct 10, the last day every account that pay lands in " +
        "has been checked through — so it is not banked yet.",
    ]);
    const forecast = forecastCurrentMonth(bundle.db, OCT_13).unbankedIncome;
    expect(passedPaydaysWords(forecast, formatDayLong).notProjected).toBe(
      "Pay not banked yet cannot be projected as arriving",
    );
  });

  test("money paid each side of the window — a payday before it and one after it — each named once", () => {
    // Sep 16 never banked: Wed Sep 23 pays Thu Sep 24 early, so Thu Sep 24's own deposit finds Sep 24 settled and
    // walks back to Sep 17; Wed Sep 30 pays Oct 1. 🔴 Sep 24 – Sep 30 read "banked $1,141.92 more than its paydays on
    // Sep 24, 2026 came to" — beside a payday it banked none of
    const wednesdays = ["2026-09-02", "2026-09-09", "2026-09-23", "2026-09-30", "2026-10-07"];
    onlyDeposits([...wednesdays, "2026-09-24"].map((d) => [d, 114_192]));
    expect(bodies("2026-09-24", "2026-09-30")).toEqual([
      "Cash job (weekly pay)'s payday on Sep 24, 2026 came to $1,141.92, and none of it was banked inside the " +
        "window: $1,141.92 (Sep 24) was paid early, by the deposit of Wed, Sep 23, 2026; another $2,283.84 banked " +
        "inside the window paid none of them: $1,141.92, from the deposit of Thu, Sep 24, 2026, paid Sep 17's " +
        "payday and $1,141.92, from the deposit of Wed, Sep 30, 2026, paid Oct 1's payday early.",
    ]);
  });
});

/**
 * 🔴 Review of 3dc6527 (MEDIUM): money was taken out of a window's own for ANY passed payday outside it, but a passed
 * payday after the checked day is read by no window and by no Earned vs banked, which nets that deposit. With the
 * frontier between Wednesday's deposit and the Thursday it pays, September said a week "never reached a bank" while
 * the window over it, the year and the dashboard said nothing of it — and the dashboard said the ledger had not looked
 * for the payday September said the deposit paid. ⛔ Money crosses the window line only into a payday another window
 * READS; money for one no window reads stays netted, as the dashboard nets it. Weekly $1,141.92, today Tue Oct 13.
 */
describe("/spending — the frontier between a Wednesday deposit and the Thursday it pays", () => {
  const OCT_13 = "2026-10-13";
  const bodies = (from: string, to: string): string[] => notesFor(from, to, OCT_13).map((n) => n.body);

  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ userAmountCents: 114_192, amountCentsAvg: 114_192 }).run();
  });

  test("read through Wed Sep 30, Sep 17 never banked, Sep 30 paying Oct 1: every window says what the dashboard does", () => {
    onlyDeposits(["2026-09-02", "2026-09-09", "2026-09-23", "2026-09-30"].map((d) => [d, 114_192]));
    coverThrough("2026-09-30");
    const card = incomeCard(bundle.db, OCT_13)!;
    expect([card.totals.gapMagnitudeCents, card.totals.unreadGapCents]).toEqual([228_384, 228_384]);
    expect(card.totals.gapLabel).toMatch(/^all of it is for paydays after Sep 30, /);
    // 🔴 September read "…$1,141.92 never reached a bank; another $1,141.92 banked inside the window, from the
    // deposit of Wed, Sep 30, 2026, paid Oct 1's payday early" — a payday the dashboard says was not looked for
    expect(bodies("2026-09-01", "2026-09-30")).toEqual([]);
    expect(bodies("2026-10-01", "2026-10-31")).toEqual([]);
    expect(bodies("2026-09-01", OCT_13)).toEqual([]);
    expect(bodies("2026-01-01", OCT_13)).toEqual([]);
  });

  test("read through Thu Sep 24, Sep 30 imported past it: the quarter and the year read the dashboard's figure", () => {
    // Wed Jul 1 pays Thu Jul 2, then no deposit until Wed Sep 2; each Wednesday pays the Thursday after it
    const wednesdays = ["2026-07-01", "2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30"];
    onlyDeposits(wednesdays.map((d) => [d, 114_192]));
    coverThrough("2026-09-24");
    const card = incomeCard(bundle.db, OCT_13)!;
    expect(card.totals.gapLabel).toMatch(/^\$7,993\.44 of it never reached a bank; the other \$2,283\.84 /);
    // 🔴 Q3 read "$5,709.60 … and $9,135.36 never reached a bank; another $1,141.92 …, from the deposit of Wed, Sep
    // 30, 2026, paid Oct 1's payday early" — and the year, which nets that deposit as the dashboard does, $7,993.44
    expect(bodies("2026-07-01", "2026-09-30")).toEqual([
      "Cash job (weekly pay)'s paydays over Jul 2 – Sep 24, 2026 came to $14,844.96, of which $6,851.52 was banked " +
        "inside the window and $7,993.44 never reached a bank.",
    ]);
    expect(bodies("2026-01-01", OCT_13)).toEqual([
      "Cash job (weekly pay)'s paydays over Jul 2 – Sep 24, 2026 came to $14,844.96, of which $6,851.52 was banked " +
        "inside the window and $7,993.44 never reached a bank; 1 more payday in the window falls after Thu, Sep 24, " +
        "2026, the last day every account that pay lands in has been checked through — so the ledger has not looked " +
        "for its deposit.",
    ]);
    // the months: July's and August's weeks, and September's money for Oct 1 — the $1,141.92 the quarter nets
    expect(bodies("2026-07-01", "2026-07-31")).toEqual([
      "Cash job (weekly pay)'s paydays over Jul 2 – 30, 2026 came to $5,709.60, of which $1,141.92 was banked inside " +
        "the window and $4,567.68 never reached a bank.",
    ]);
    expect(bodies("2026-08-01", "2026-08-31")).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – 27, 2026 came to $4,567.68, and none of it reached a bank.",
    ]);
    expect(bodies("2026-09-01", "2026-09-30")).toEqual([
      "Cash job (weekly pay) banked $1,141.92 more than its paydays over Sep 3 – 24, 2026 came to. $1,141.92 of it, " +
        "from the deposit of Wed, Sep 30, 2026, paid Oct 1's payday early.",
    ]);
    expect(bodies("2026-10-01", "2026-12-31")).toEqual([]);
  });
});

/**
 * 🔴 Review of 2a415d5 (MEDIUM): when deposits outside a window paid more of its paydays than its NET shortfall —
 * money inside it paid no payday — the note gave the outside deposit the net figure, less than it paid, and left the
 * rest unnamed. ⛔ Each deposit is named with the money it put in (the header's "NO SECOND ALLOCATION"); money that
 * paid no payday beyond what it could net is named after the paydays, toward no payday.
 */
describe("/spending — outside money that paid more than the net shortfall is named whole", () => {
  test("Wed Sep 9 paid Thu Sep 10 early and Fri Sep 11's $400.00 paid no payday: each named with its own money", () => {
    onlyDeposits([
      ["2026-09-03", 100_000],
      ["2026-09-09", 100_000],
      ["2026-09-11", 40_000],
    ]);
    coverThrough("2026-09-12");
    expect(notesFor("2026-09-10", "2026-09-13").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s payday on Sep 10, 2026 came to $1,000.00, and none of it was banked inside the " +
        "window: $1,000.00 (Sep 10) was paid early, by the deposit of Wed, Sep 9, 2026; another $400.00 banked " +
        "inside the window, from the deposit of Fri, Sep 11, 2026, went toward no payday.",
    ]);
  });
});

/**
 * ⚖️ Decision 75 on the note: settlement hands its readers the money that BANKED, a day at a time (its `deposits`,
 * `daysThatBanked`) — never the rows linked to the pay. A payroll returned the same day banked nothing, so it is no
 * deposit of the note's, toward a payday or toward none. 🔴 The guard (e1172ab) had no test: read as the rows, the note
 * said "…$1,000.00 of it, from the deposit of Thu, Sep 10, 2026, went toward no payday." of a payroll that went back
 * out the day it landed, and every test passed (review of e1172ab; hypothetical: no money out is linked to his pay).
 */
describe("/spending — a payroll returned the same day is no deposit of the note's", () => {
  test("Sep 10's $1,000.00 back out the same day: the note names Sep 3's money alone", () => {
    deposit("t-sep10", "2026-09-10", 100_000);
    deposit("t-sep10-back", "2026-09-10", -100_000);
    coverThrough("2026-09-12");
    expect(paydaySettlement(bundle.db, SERIES, "2026-09-10").deposits).toEqual([
      { postedOn: "2026-07-30", amountCents: 100_000 },
      { postedOn: "2026-09-03", amountCents: 200_000 },
    ]);
    expect(notesFor("2026-09-01", "2026-09-10", "2026-09-10").map((n) => n.body)).toEqual([
      "Cash job (weekly pay) banked $1,000.00 more than its payday on Sep 3, 2026 came to. One deposit can bank " +
        "several paydays at once, so the surplus is earlier pay arriving late — read it as a backlog clearing rather " +
        "than as a period that earned more.",
    ]);
  });
});

/**
 * 🔴 Review of 36f212f on the integration (two MEDIUMs), re-measured on his ledger copy 2026-10-21 (Wells Fargo checked
 * through Thu Sep 24): with Wed Sep 30's $1,141.92 returned on Fri Oct 2, October and Q4 read "paydays came to $0.00,
 * and none of it reached a bank"; with Wed Sep 30 and Wed Oct 7 imported past the statement, YTD, ALL and the
 * dashboard said $8,833.16 never reached a bank, June $2,741.00 and Q3 $7,234.08 — and October and Q4 said nothing of
 * the $1,141.92 the year nets. ⛔ A window with no read payday names the money a window over it counts; money out on
 * a day of its own (decision 75) is named on its day and never takes a paid payday back. Weekly $1,141.92 on Thursdays.
 */
describe("/spending — money out on a day of its own, and a window whose paydays the ledger has not read", () => {
  const OCT_13 = "2026-10-13";
  const bodies = (from: string, to: string, today = OCT_13): string[] => notesFor(from, to, today).map((n) => n.body);

  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ userAmountCents: 114_192, amountCentsAvg: 114_192 }).run();
  });

  test("Wed Sep 30's payroll returned on Fri Oct 2: October names it, and the quarter and the year add up", () => {
    // Sep 17 never banked; each Wednesday pays the Thursday after it, and Sep 30's money is back out two days later
    const wednesdays = ["2026-09-02", "2026-09-09", "2026-09-23", "2026-09-30"];
    onlyDeposits([...wednesdays.map((d) => [d, 114_192] as const), ["2026-10-02", -114_192]]);
    coverThrough("2026-09-24");
    const october =
      "Of Cash job (weekly pay)'s pay, $1,141.92 went back out on Fri, Oct 2, 2026; 1 payday in the window falls " +
      "after Thu, Sep 24, 2026, the last day every account that pay lands in has been checked through — so the " +
      "ledger has not looked for its deposit.";
    // 🔴 "Cash job (weekly pay)'s paydays came to $0.00, and none of it reached a bank; 2 more paydays …"
    expect(bodies("2026-10-01", "2026-10-31")).toEqual([october]);
    expect(bodies("2026-10-01", "2026-12-31")).toEqual([october]);
    // Q3 nets Sep 30's money against Sep 17, a payday it read; the year nets the return against Sep 30 — the dashboard
    expect(bodies("2026-07-01", "2026-09-30")).toEqual([]);
    expect(bodies("2026-01-01", OCT_13)).toEqual([
      "Cash job (weekly pay)'s paydays over Sep 3 – 24, 2026 came to $4,567.68, of which $3,425.76 was banked " +
        "inside the window and $1,141.92 never reached a bank; 1 more payday in the window falls after Thu, Sep 24, " +
        "2026, the last day every account that pay lands in has been checked through — so the ledger has not looked " +
        "for its deposit.",
    ]);
    // ⛔ …and the dashboard reads the one rule (`moneyOutOfWindow`): the year nets it, so the card names no day either
    const card = incomeCard(bundle.db, OCT_13)!;
    expect(card.totals.gapLabel).toMatch(/^\$1,141\.92 of it never reached a bank; /);
    expect(card.pay.map((l) => l.wentBackOut)).toEqual([[]]);
  });

  test("a payroll returned two days after the payday it paid: the payday stays banked, the money out is named", () => {
    const wednesdays = ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"];
    onlyDeposits([...wednesdays.map((d) => [d, 114_192] as const), ["2026-09-25", -114_192]]);
    coverThrough("2026-09-26");
    // 🔴 the week read "came to $1,141.92, and none of it reached a bank" — the calendar draws Sep 24 paid by Sep 23
    expect(bodies("2026-09-21", "2026-09-27", "2026-09-28")).toEqual([
      "Cash job (weekly pay)'s payday on Sep 24, 2026 came to $1,141.92, and all of it was banked inside the " +
        "window; $1,141.92 went back out on Fri, Sep 25, 2026.",
    ]);
  });

  /*
   * ⚖️ DEFAULT (A), BUILT, NOT ASKED (2026-10-21): Earned vs banked names a later-day return as /spending does, on its
   * day — and both read one rule (`moneyOutOfWindow`), so they agree with the calendar on which paydays were paid.
   * 🔴 On his ledger copy 2026-10-21 with a hypothetical $1,141.92 of pay back out on Fri Sep 25, YTD (bde27f3) named it
   * beside "$11,117.00 never reached a bank" while the card said only "$11,117.00 of it never reached a bank; the other
   * $3,425.76 is for paydays after Sep 24 …" — the money out on no page of the dashboard.
   */
  test("…and Earned vs banked names it in the same words, the year's and the card's figures one", () => {
    const wednesdays = ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"];
    onlyDeposits([...wednesdays.map((d) => [d, 114_192] as const), ["2026-09-25", -114_192]]);
    coverThrough("2026-09-26");
    const card = incomeCard(bundle.db, "2026-09-28")!;
    expect(card.pay.map((l) => l.wentBackOut)).toEqual([[{ postedOn: "2026-09-25", cents: 114_192 }]]);
    // four Wednesdays banked the four Thursdays — Sep 24 paid by Sep 23, as the calendar draws it — and none taken back
    expect([card.totals.impliedCents, card.totals.bankedCents, card.totals.gapLabel]).toEqual([
      4 * 114_192,
      4 * 114_192,
      "exactly what this window implies you earned; $1,141.92 went back out on Fri, Sep 25, 2026",
    ]);
    // …the figure /spending reads of the same window, by the same rule
    const [reading] = cashEarningsReadings(bundle.db, {
      from: card.windowFrom,
      to: card.today,
      today: card.today,
      withChecked: true,
    });
    expect([reading!.bankedCents, reading!.wentBackOut]).toEqual([card.totals.bankedCents, card.pay[0]!.wentBackOut]);
  });

  test("Wed Oct 7 imported past the statement pays Oct 8: October and Q4 name it, and the quarters add up", () => {
    const wednesdays = ["2026-07-01", "2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30"];
    onlyDeposits([...wednesdays, "2026-10-07"].map((d) => [d, 114_192]));
    coverThrough("2026-09-24");
    const october =
      "Of Cash job (weekly pay)'s pay, $1,141.92 banked inside the window, from the deposit of Wed, Oct 7, 2026, " +
      "paid Oct 8's payday.";
    // 🔴 nothing: the year netted Oct 7's money, and no month or quarter named it
    expect(bodies("2026-10-01", "2026-10-31")).toEqual([october]);
    expect(bodies("2026-10-01", "2026-12-31")).toEqual([october]);
    // Q3's $7,993.44, less the $1,141.92 Q4 banked, is the year's $6,851.52 — and the dashboard's
    expect(bodies("2026-07-01", "2026-09-30")).toEqual([
      "Cash job (weekly pay)'s paydays over Jul 2 – Sep 24, 2026 came to $14,844.96, of which $6,851.52 was banked " +
        "inside the window and $7,993.44 never reached a bank.",
    ]);
    expect(bodies("2026-01-01", OCT_13)).toEqual([
      "Cash job (weekly pay)'s paydays over Jul 2 – Sep 24, 2026 came to $14,844.96, of which $7,993.44 was banked " +
        "inside the window and $6,851.52 never reached a bank.",
    ]);
    expect(incomeCard(bundle.db, OCT_13)!.totals.gapLabel).toMatch(/^\$6,851\.52 of it never reached a bank; /);
  });
});

/**
 * 🔴 Review of f6da264 (MEDIUM): money that paid a payday no window has read — not one of the window's own passed
 * paydays — went unnamed. On his ledger copy 2026-10-21 with Wed Sep 30 and Wed Oct 7 imported past the Sep 24
 * statement, on Wed Oct 7, /spending October (the default month) and Q4 read "Of It America LLC (weekly pay)'s pay,
 * $1,141.92 banked inside the window went toward no payday on or before Thu, Sep 24, 2026", while the week of
 * Oct 5 – 11 said "$1,141.92 of it, from the deposit of Wed, Oct 7, 2026, paid Oct 8's payday early" — the
 * settlement's portion, which the calendar draws. ⚖️ Decisions 29/32's word, from the payday's side: paid early.
 * Weekly $1,141.92 on Thursdays, each Wednesday paying the Thursday after it, Wells Fargo checked through Thu Sep 24.
 */
describe("/spending — money that paid a payday no window has read is named with that payday", () => {
  const WEDNESDAYS = ["2026-07-01", "2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30"];
  const bodies = (from: string, to: string, today: string): string[] => notesFor(from, to, today).map((n) => n.body);

  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ userAmountCents: 114_192, amountCentsAvg: 114_192 }).run();
    coverThrough("2026-09-24");
  });

  test("payroll Wednesday Oct 7: October and Q4 say Oct 7's money paid Oct 8's payday early, as the week does", () => {
    onlyDeposits([...WEDNESDAYS, "2026-10-07"].map((d) => [d, 114_192]));
    const october =
      "Of Cash job (weekly pay)'s pay, $1,141.92 banked inside the window, from the deposit of Wed, Oct 7, 2026, " +
      "paid Oct 8's payday early.";
    // 🔴 "…$1,141.92 banked inside the window went toward no payday on or before Thu, Sep 24, 2026."
    expect(bodies("2026-10-01", "2026-10-31", "2026-10-07")).toEqual([october]);
    expect(bodies("2026-10-01", "2026-12-31", "2026-10-07")).toEqual([october]);
    expect(bodies("2026-10-05", "2026-10-11", "2026-10-07")).toEqual([
      "Cash job (weekly pay) banked $1,141.92 in a window where none of its paydays has passed. $1,141.92 of it, " +
        "from the deposit of Wed, Oct 7, 2026, paid Oct 8's payday early.",
    ]);
  });

  test("a week on, Oct 14 imported too: Oct 8 paid, and Oct 15 paid early — each with its own deposit", () => {
    onlyDeposits([...WEDNESDAYS, "2026-10-07", "2026-10-14"].map((d) => [d, 114_192]));
    // 🔴 "…paid Oct 8's payday and $1,141.92 banked inside the window went toward no payday on or before Thu, Sep 24"
    expect(bodies("2026-10-01", "2026-10-31", "2026-10-14")).toEqual([
      "Of Cash job (weekly pay)'s pay, $1,141.92 banked inside the window, from the deposit of Wed, Oct 7, 2026, " +
        "paid Oct 8's payday and $1,141.92 banked inside the window, from the deposit of Wed, Oct 14, 2026, paid " +
        "Oct 15's payday early.",
    ]);
  });

  test("a window reading a payday: money for one after it is paid early, never 'toward none of these paydays'", () => {
    // Sep 21 – Oct 7 on Wed Oct 14: Sep 24 read and paid by Sep 23, Oct 1 past the checked day and never banked, and
    // Oct 7 pays Oct 8 — after the window, past the checked day: the year nets it, so this window names it
    onlyDeposits(["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-10-07"].map((d) => [d, 114_192]));
    expect(bodies("2026-09-21", "2026-10-07", "2026-10-14")).toEqual([
      "Cash job (weekly pay)'s payday on Sep 24, 2026 came to $1,141.92, and all of it was banked inside the " +
        "window; another $1,141.92 banked inside the window, from the deposit of Wed, Oct 7, 2026, paid Oct 8's " +
        "payday early; 1 more payday in the window falls after Thu, Sep 24, 2026, the last day every account that pay " +
        "lands in has been checked through — so the ledger has not looked for its deposit.",
    ]);
  });

  /*
   * ⚖️ Default built, not asked (2026-10-21): change over a payday's worth is said as what it is, in one sentence on
   * every window — "was more than the paydays its deposits paid came to". 🔴 On his ledger copy with Wed Oct 7
   * +$1,500.00 imported, on Oct 14, October said its $358.08 "went toward no payday on or before Thu, Sep 24, 2026"
   * and the week of Oct 5 – 11 called the same money "earlier pay arriving late — … a backlog clearing"; it paid no
   * earlier payday, and the calendar draws the deposit paying Oct 8 (review of the shortfall batch).
   */
  test("Wed Oct 7's $1,500.00 pays Oct 8 with $358.08 over: October and the week say the same of the $358.08", () => {
    onlyDeposits([...WEDNESDAYS.map((d) => [d, 114_192] as const), ["2026-10-07", 150_000]]);
    const over = "$358.08 banked inside the window was more than the paydays its deposits paid came to";
    expect(bodies("2026-10-01", "2026-10-31", "2026-10-14")).toEqual([
      "Of Cash job (weekly pay)'s pay, $1,141.92 banked inside the window, from the deposit of Wed, Oct 7, 2026, " +
        `paid Oct 8's payday and ${over}.`,
    ]);
    expect(bodies("2026-10-05", "2026-10-11", "2026-10-14")).toEqual([
      "Cash job (weekly pay) banked $358.08 more than its payday on Oct 8, 2026 came to. $358.08 of it was more " +
        "than the paydays its deposits paid came to.",
    ]);
  });

  test("a lump that walked back before the window to an unread payday: paid with its own payday, never early", () => {
    // no Sep 30: Wed Oct 7's two weeks pay Oct 8 and walk back to Oct 1; Oct 15 is past the checked day, unbanked
    onlyDeposits([
      ...["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"].map((d) => [d, 114_192] as const),
      ["2026-10-07", 228_384],
    ]);
    expect(bodies("2026-10-05", "2026-10-18", "2026-10-20")).toEqual([
      "Of Cash job (weekly pay)'s pay, $2,283.84 banked inside the window, from the deposit of Wed, Oct 7, 2026, " +
        "paid the paydays of Oct 1 and Oct 8; 1 payday in the window falls after Thu, Sep 24, 2026, the last day " +
        "every account that pay lands in has been checked through — so the ledger has not looked for its deposit.",
    ]);
  });
});
