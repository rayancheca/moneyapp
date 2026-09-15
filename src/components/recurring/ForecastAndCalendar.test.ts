import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import type { RecurringCalendarMonth } from "@/services/recurring-calendar";

// server actions pull in next/cache and the database client; the view-state
// hook needs an app router that a static render does not mount
vi.mock("@/app/recurring/actions", () => ({ loadMonthForecastAction: vi.fn(), loadRecurringMonthAction: vi.fn() }));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
// the card is not what is under test, and its own fixture is a month of forecast math
vi.mock("./ForecastCard", () => ({ ForecastCard: () => null }));

const { ForecastAndCalendar } = await import("./ForecastAndCalendar");

/**
 * 🔴 The Calendar tab's badge was rendered once on the server with the CURRENT
 * month's count and handed in as a finished node, so paging the grid could not
 * move it. Measured on the real ledger 2026-09-15: September holds 12 entries
 * and October 14, and paged to October the page read "Forecast · October 2026"
 * over "Calendar 12" over a 14-entry grid.
 *
 * ⚠️ A static render cannot page. What it CAN pin is where the badge reads its
 * number from: the month the grid was handed, not a count computed beside it —
 * which is the state `followMonth` replaces when a month loads.
 */
describe("ForecastAndCalendar — the Calendar badge counts the month on screen", () => {
  const october: RecurringCalendarMonth = {
    monthKey: "2026-10",
    today: "2026-09-15",
    entriesByDay: {},
    entryCount: 14,
    postedNetCents: 0,
    upcomingNetCents: 0,
    missedCount: 0,
    unsettledCount: 0,
    unsettledGrossCents: 0,
  };
  const html = renderToStaticMarkup(
    createElement(ForecastAndCalendar, {
      initialForecast: { monthKey: "2026-10" } as MonthForecast,
      initialMonth: october,
      today: "2026-09-15",
      view: {},
      tab: "calendar",
      // what the page computed for SEPTEMBER, beside a grid showing October
      counts: { upcoming: 10, all: 15, calendar: 12 },
    }),
  );
  const badge = (label: string): string | undefined =>
    new RegExp(`>${label}<span[^>]*>(\\d+)</span>`).exec(html)?.[1];

  test("the badge is the grid's month, not the count handed in beside it", () => {
    expect(badge("Calendar")).toBe("14");
  });

  test("the other tabs keep the page's counts", () => {
    expect(badge("Upcoming")).toBe("10");
    expect(badge("All")).toBe("15");
  });
});
