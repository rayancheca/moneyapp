import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { CalendarEntry, RecurringCalendarMonth } from "@/services/recurring-calendar";

// the server action pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ loadRecurringMonthAction: vi.fn() }));

const { DaySheetBody, RecurringCalendar } = await import("./RecurringCalendar");

function entry(over: Partial<CalendarEntry> & Pick<CalendarEntry, "seriesId" | "name" | "state" | "amountCents">): CalendarEntry {
  return {
    kind: "bill",
    expectedAmountCents: over.amountCents,
    transactionId: null,
    settledByDepositsOn: [],
    settlesPaydaysOn: [],
    perPayday: null,
    settledCents: null,
    unsettledReason: null,
    confidence: null,
    isStale: false,
    neverBilled: false,
    hue: null,
    ...over,
  };
}

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The words each day cell's accessible name carries — the same sentence the
 * Day Sheet prints — for the real ledger's September 2026, as this branch's
 * calendar service returned it at today = 2026-09-14 on the ledger as it stood
 * BEFORE another session's write at 2026-09-14T19:38:33Z. Re-measured read-only
 * from data/backups/pre-2026-09-14T153833-manual-backup.db, the snapshot taken
 * just before that write. Amounts are that ledger's: Car insurance -$361.49
 * (user amount), Car lease -$695.04, Rocket Money -$6.00, Gym -$100.00.
 *
 * ⚠️ That write set Car insurance's typed next date to 2026-12-11 and its user
 * amount to -$357.58. Since then the live calendar draws nothing on Sep 11, and
 * no occurrence in 2023-01..2027-08 carries `schedule_unproven` (1 before the
 * write, 0 after). Sep 15 and Sep 22 still read exactly as pinned here. The
 * Sep 11 entry is a state the service really returned, not today's reading —
 * it stays because the reason's WORD is what is under test.
 */
describe("RecurringCalendar cell names", () => {
  const month: RecurringCalendarMonth = {
    monthKey: "2026-09",
    today: "2026-09-14",
    entriesByDay: {
      "2026-09-11": [
        entry({ seriesId: "ins", name: "Car insurance", state: "unsettled", amountCents: -36149, unsettledReason: "schedule_unproven" }),
      ],
      "2026-09-15": [
        entry({ seriesId: "lease", name: "Car lease", state: "upcoming", amountCents: -69504, confidence: "scheduled", neverBilled: true }),
        entry({ seriesId: "rm", name: "Rocket Money", kind: "subscription", state: "upcoming", amountCents: -600, confidence: "predicted", isStale: true }),
      ],
      "2026-09-22": [
        entry({ seriesId: "gym", name: "Gym", state: "upcoming", amountCents: -10000, confidence: "scheduled", neverBilled: true }),
      ],
    },
    entryCount: 4,
    postedNetCents: 0,
    upcomingNetCents: -80104,
    missedCount: 0,
    unsettledCount: 1,
    unsettledGrossCents: 36149,
  };
  const html = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: "2026-09-14" })));

  /*
   * 🔴 Owner decision 2026-09-14: a commitment the bank has never charged says
   * so, in the word the All tab files it under — not "evidence stale", which
   * the same page's "3 have never charged" contradicted.
   */
  test("a commitment that has never charged reads 'never billed', and one running late still reads 'evidence stale'", () => {
    expect(html).toContain(
      'aria-label="Sep 15, 2026 — 2 items: Car lease upcoming (scheduled, never billed) -$695.04; Rocket Money upcoming (predicted, evidence stale) -$6.00"',
    );
    expect(html).toContain('aria-label="Sep 22, 2026 — 1 item: Gym upcoming (scheduled, never billed) -$100.00"');
  });

  /*
   * 🔴 Owner decision 2026-09-14 (keep the posting-count check, fix its word):
   * Car insurance's Sep 11 read "due date not established" over a date he typed.
   */
  test("a schedule with too few charges says so, not that its due date is unknown", () => {
    expect(html).toContain(
      'aria-label="Sep 11, 2026 — 1 item: Car insurance not yet known (too few charges to grade yet) -$361.49"',
    );
    expect(html).not.toContain("due date not established");
  });
});

/**
 * 🔴 A DAY WITH NO DEPOSIT ON IT READ "paid $1,141.92".
 *
 * The settled payday is the first entry in this codebase with no transaction
 * and a `paid` state — his decision of 2026-09-28, where a deposit pays down the
 * paydays behind it. It borrows a word the legend defines as "a charge for this
 * bill turned up on the expected day", and nothing turned up on Aug 27: the
 * money landed on Sep 24. The cell has to name the day it landed, or the chip
 * asserts something the ledger will not support.
 */
describe("RecurringCalendar — a payday paid by a deposit on another day", () => {
  const month: RecurringCalendarMonth = {
    monthKey: "2026-08",
    today: "2026-09-28",
    entriesByDay: {
      "2026-08-20": [
        entry({ seriesId: "pay", name: "It America LLC (weekly pay)", kind: "income", state: "unsettled", amountCents: 114192, unsettledReason: "unbanked" }),
      ],
      "2026-08-27": [
        entry({
          seriesId: "pay",
          name: "It America LLC (weekly pay)",
          kind: "income",
          state: "paid",
          amountCents: 114192,
          settledByDepositsOn: ["2026-09-24"],
          settledCents: 114192,
        }),
      ],
    },
    entryCount: 2,
    postedNetCents: 114192,
    upcomingNetCents: 0,
    missedCount: 0,
    unsettledCount: 1,
    unsettledGrossCents: 114192,
  };
  const html = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: "2026-09-28" })));

  test("the day names the deposit that paid it, rather than claiming a payment turned up", () => {
    expect(html).toContain(
      'aria-label="Aug 27, 2026 — 1 item: It America LLC (weekly pay) paid (paid by the deposit of Sep 24, 2026) $1,141.92"',
    );
  });
});

/**
 * 🔴 ONE DEPOSIT DREW AS PAYING TWO PAYDAYS (§6A 29 review).
 *
 * Wed Sep 30's lump paid Thu Oct 1, and the Oct 1 deposit — its own payday
 * already paid — paid Aug 27. October drew the Oct 1 row as Oct 1's pay while
 * August's chip named the same deposit for Aug 27. The month below is what the
 * calendar service returns for October, read 2026-10-02, on that ledger
 * (`recurring-calendar-payer.test`): the payday names the lump, and the row
 * names the payday its money went to.
 */
describe("RecurringCalendar — a deposit that paid another month's payday", () => {
  const pay = { seriesId: "pay", name: "It America LLC (weekly pay)", kind: "income" as const };
  const week = { ...pay, amountCents: 114192 };
  const upcoming = (): CalendarEntry[] => [entry({ ...week, state: "upcoming", confidence: "scheduled" })];
  const month: RecurringCalendarMonth = {
    monthKey: "2026-10",
    today: "2026-10-02",
    entriesByDay: {
      "2026-10-01": [
        entry({ ...week, state: "paid", transactionId: "t-oct1", settlesPaydaysOn: ["2026-08-27"], settledCents: 0 }),
        entry({ ...week, state: "paid", settledByDepositsOn: ["2026-09-30"], settledCents: 114192 }),
      ],
      "2026-10-08": upcoming(),
      "2026-10-15": upcoming(),
      "2026-10-22": upcoming(),
      "2026-10-29": upcoming(),
    },
    entryCount: 6,
    postedNetCents: 114192,
    upcomingNetCents: 456768,
    missedCount: 0,
    unsettledCount: 0,
    unsettledGrossCents: 0,
  };
  const html = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: "2026-10-02" })));

  test("the payday names the deposit that paid it, and the deposit names the payday it paid", () => {
    expect(html).toContain(
      'aria-label="Oct 1, 2026 — 2 items: It America LLC (weekly pay) paid (toward the payday of Aug 27, 2026) $1,141.92; ' +
        'It America LLC (weekly pay) paid (paid by the deposit of Sep 30, 2026) $1,141.92"',
    );
  });

  /* The strip above the grid sums the same `settledCents` the footer does: one week settled, five scheduled. */
  test("the flow strip lands on the footer's Settled figure and on the month's five paydays", () => {
    expect(html).toContain("October 2026: posted $1,141.92, as scheduled $5,709.60");
  });

  test("money from several days is named by every day it came from", () => {
    const pooled: RecurringCalendarMonth = {
      ...month,
      monthKey: "2026-08",
      entriesByDay: {
        "2026-08-27": [
          entry({ ...week, state: "paid", settledByDepositsOn: ["2026-06-04", "2026-06-05"], settledCents: 114192 }),
        ],
      },
      entryCount: 1,
      upcomingNetCents: 0,
    };
    const out = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: pooled, today: "2026-10-02" })));
    expect(out).toContain(
      'aria-label="Aug 27, 2026 — 1 item: It America LLC (weekly pay) paid (paid by the deposits of Jun 4, 2026 and Jun 5, 2026) $1,141.92"',
    );
  });
});

/**
 * 🔴 A DAY DREW ONE WEEK OF PAY TWICE (§6A 29 review).
 *
 * His September 2026 as the calendar service draws it, read 2026-10-01
 * (`recurring-calendar-payer.test`): the lump of Sep 23 paid Sep 3 through Sep
 * 24, and the deposit dated Sep 24 — its own payday already paid — paid Aug 20.
 * Sep 24 holds that deposit beside its payday, and the cell, the heat scale and
 * the Day Sheet's "Day total" summed each mark's amount: "2.3k" on a day that
 * adds nothing to September, beneath a strip and over a footer that did not
 * count it. They read what the footer reads now, mark by mark.
 *
 * The lump is drawn as the service has drawn it since 2026-10-07 (`lib/per-payday`): `paid`, four paydays at
 * $1,141.92 each. Written on 10-01 it was fixtured `paid_different` — the amber "rose by $3,425.76" that fix removed.
 */
describe("RecurringCalendar — a deposit and a payday on one day, each paid from another", () => {
  const week = { seriesId: "pay", name: "It America LLC (weekly pay)", kind: "income" as const, amountCents: 114192 };
  const sep24: CalendarEntry[] = [
    entry({ ...week, state: "paid", transactionId: "t-sep24", settlesPaydaysOn: ["2026-08-20"], settledCents: 0 }),
    entry({ ...week, state: "paid", settledByDepositsOn: ["2026-09-23"], settledCents: 0 }),
  ];
  const month: RecurringCalendarMonth = {
    monthKey: "2026-09",
    today: "2026-10-01",
    entriesByDay: {
      "2026-09-03": [entry({ ...week, state: "paid", settledByDepositsOn: ["2026-09-23"], settledCents: 0 })],
      "2026-09-23": [
        entry({
          ...week,
          state: "paid",
          amountCents: 456768,
          transactionId: "t-lump",
          perPayday: { paydays: 4, cents: 114192 },
          settledCents: 456768,
        }),
      ],
      "2026-09-24": sep24,
    },
    entryCount: 4,
    postedNetCents: 456768,
    upcomingNetCents: 0,
    missedCount: 0,
    unsettledCount: 0,
    unsettledGrossCents: 0,
  };
  const html = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: "2026-10-01" })));

  /** The figure a day's cell prints — the first `figures` span after that day's accessible name. */
  const cellFigure = (label: string): string | undefined =>
    html.slice(html.indexOf(`aria-label="${label}`)).match(/class="figures whitespace-nowrap[^"]*"[^>]*>([^<]*)</)?.[1];

  test("the cell prints what the day adds to the month, not a week of pay twice", () => {
    expect(cellFigure("Sep 24, 2026 — 2 items")).toBe("0");
    expect(cellFigure("Sep 3, 2026 — 1 item")).toBe("0");
    expect(cellFigure("Sep 23, 2026 — 1 item")).toBe("4.6k");
  });

  test("the Day Sheet's total is the cell's figure, and each mark says how much of it is counted that day", () => {
    const sheet = decode(renderToStaticMarkup(createElement(DaySheetBody, { entries: sep24 })));
    expect(sheet).toMatch(/Day total<\/span><span class="figures text-ink-muted font-semibold">\$0\.00<\/span>/);
    expect(sheet.match(/\$0\.00 counted on this day/g)).toHaveLength(2);
  });

  test("a mark whose money is all counted on its own day says nothing more", () => {
    const sheet = decode(renderToStaticMarkup(createElement(DaySheetBody, { entries: month.entriesByDay["2026-09-23"]! })));
    expect(sheet).not.toContain("counted on this day");
    expect(sheet).not.toContain("Day total");
  });
});

/**
 * ⚖️ A transfer moves money between his own accounts, so its mark is DRAWN and counted in no total
 * (`seriesIsIncomeOrSpending`): the strip's "as scheduled" is the forecast card's net printed above it, and the
 * card leaves transfer series out. The cell, its caption and the Day Sheet read the same `flowEntryOf`.
 *
 * 🔴 Summed, a one-legged transfer — the card autopay out of checking, no PAYMENT THANK YOU imported to cancel it —
 * moved the strip, the cell and the sheet's "Day total" by its whole amount. The amounts are the synthetic Chase
 * fixture's autopay and the e2e seed's rent and Netflix.
 */
describe("RecurringCalendar — a transfer is drawn and counted in no total", () => {
  const autopay = entry({
    seriesId: "autopay",
    name: "CHASE CREDIT CRD AUTOPAY",
    kind: "transfer",
    state: "upcoming",
    amountCents: -99302,
    confidence: "expected",
  });
  const netflix = entry({
    seriesId: "netflix",
    name: "Netflix",
    kind: "subscription",
    state: "upcoming",
    amountCents: -1549,
    confidence: "expected",
  });
  const month: RecurringCalendarMonth = {
    monthKey: "2026-08",
    today: "2026-07-08",
    entriesByDay: {
      "2026-08-09": [entry({ seriesId: "rent", name: "Rent", state: "upcoming", amountCents: -180000, confidence: "expected" })],
      "2026-08-24": [autopay, netflix],
    },
    entryCount: 3,
    postedNetCents: 0,
    upcomingNetCents: -181549,
    missedCount: 0,
    unsettledCount: 0,
    unsettledGrossCents: 0,
  };
  const html = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: "2026-07-08" })));
  const afterLabel = html.slice(html.indexOf('aria-label="Aug 24, 2026 — 2 items'));

  test("the strip's \"as scheduled\" leaves the transfer out, and the cell prints and names what the day adds", () => {
    expect(html.match(/as scheduled<span[^>]*>([^<]*)</)?.[1]).toBe("-$1,815.49");
    expect(afterLabel.match(/class="figures whitespace-nowrap[^"]*"[^>]*>([^<]*)</)?.[1]).toBe("-15");
    expect(afterLabel.match(/class="min-w-0 truncate">([^<]*)</)?.[1]).toBe("Netflix");
    // still drawn: the day's accessible name reads the transfer at its own amount
    expect(html).toContain("CHASE CREDIT CRD AUTOPAY upcoming (expected) -$993.02");
  });

  test("the Day Sheet lists the transfer at its amount, counts none of it, and totals the rest", () => {
    const sheet = decode(renderToStaticMarkup(createElement(DaySheetBody, { entries: [autopay, netflix] })));
    expect(sheet).toContain("-$993.02");
    expect(sheet.match(/\$0\.00 counted on this day/g)).toHaveLength(1);
    expect(sheet).toMatch(/Day total<\/span><span class="figures text-negative font-semibold">-\$15\.49<\/span>/);
  });

  const render = (over: Partial<RecurringCalendarMonth>): string =>
    decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: { ...month, ...over }, today: "2026-07-08" })));

  /*
   * 🔴 A month whose ONLY mark is a transfer adds nothing at all, and the strip read "adds nothing" as "nothing is
   * there": it printed "Nothing recurring lands in August 2026." over a grid drawing the autopay on the 24th.
   */
  test("a month whose only mark is a transfer says what lands adds nothing, not that nothing lands", () => {
    const html = render({ entriesByDay: { "2026-08-24": [autopay] }, entryCount: 1, upcomingNetCents: 0 });
    expect(html).toContain("Aug 24, 2026 — 1 item: CHASE CREDIT CRD AUTOPAY upcoming (expected) -$993.02");
    expect(html).not.toContain("Nothing recurring lands");
    expect(html).toContain("What lands in August 2026 adds nothing to the month's total.");
  });

  test("a month with no mark at all still says nothing lands in it", () => {
    const html = render({ entriesByDay: {}, entryCount: 0, upcomingNetCents: 0 });
    expect(html).toContain("Nothing recurring lands in August 2026.");
    expect(html).not.toContain("What lands in");
  });
});

/**
 * A lump says how many paydays it paid. His Sep 23 deposit of $4,567.68 is drawn
 * `paid` because it is four weeks at $1,141.92 — and read aloud without that, the
 * cell said "paid $4,567.68" on a series whose week is $1,141.92.
 */
describe("RecurringCalendar — a lump names the paydays it paid", () => {
  const lump = entry({
    seriesId: "pay",
    name: "It America LLC (weekly pay)",
    kind: "income",
    state: "paid",
    amountCents: 456768,
    expectedAmountCents: 114192,
    transactionId: "t-lump",
    perPayday: { paydays: 4, cents: 114192 },
    settledCents: 456768,
  });
  const month: RecurringCalendarMonth = {
    monthKey: "2026-09",
    today: "2026-10-07",
    entriesByDay: { "2026-09-23": [lump] },
    entryCount: 1,
    postedNetCents: 456768,
    upcomingNetCents: 0,
    missedCount: 0,
    unsettledCount: 0,
    unsettledGrossCents: 0,
  };

  test("the cell's accessible name and the Day Sheet both say four paydays at a week each", () => {
    const html = decode(renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: "2026-10-07" })));
    expect(html).toContain(
      'aria-label="Sep 23, 2026 — 1 item: It America LLC (weekly pay) paid (4 paydays at $1,141.92 each) $4,567.68"',
    );
    const sheet = decode(renderToStaticMarkup(createElement(DaySheetBody, { entries: [lump] })));
    expect(sheet).toContain("paid — 4 paydays at $1,141.92 each");
  });
});
