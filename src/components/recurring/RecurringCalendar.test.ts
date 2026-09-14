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
 * Day Sheet prints — for the real ledger's September 2026, as the calendar
 * service returns it at today = 2026-09-14 on this branch. Amounts are the
 * ledger's: Car insurance -$361.49 (user amount), Car lease -$695.04, Rocket
 * Money -$6.00, Gym -$100.00.
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
