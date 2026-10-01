import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { CalendarEntry, RecurringCalendarMonth } from "@/services/recurring-calendar";

// the server action pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ loadRecurringMonthAction: vi.fn() }));

const { RecurringCalendar } = await import("./RecurringCalendar");

function entry(over: Partial<CalendarEntry> & Pick<CalendarEntry, "seriesId" | "name" | "state" | "amountCents">): CalendarEntry {
  return {
    kind: "bill",
    expectedAmountCents: over.amountCents,
    transactionId: null,
    settledByDepositsOn: [],
    settlesPaydaysOn: [],
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
