import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import type { RecurringCalendarMonth } from "@/services/recurring-calendar";

/*
 * The hooks two components on this page call, routed to `HookSlots` (below)
 * while a test is stepping a component by hand, and to React otherwise — so
 * the static renders in this file are real renders.
 */
const hookHost = vi.hoisted(() => ({
  current: null as null | { useState(init: unknown): unknown; useTransition(): unknown },
}));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => (hookHost.current ? hookHost.current.useState(init) : real.useState(init)),
    useTransition: () => (hookHost.current ? hookHost.current.useTransition() : real.useTransition()),
  };
});

// server actions pull in next/cache and the database client; the view-state
// hook needs an app router that a static render does not mount
vi.mock("@/app/recurring/actions", () => ({ loadMonthForecastAction: vi.fn(), loadRecurringMonthAction: vi.fn() }));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
// the density switcher's URL state is not what is under test, and its hook calls
// React hooks the stepping harness below does not provide
vi.mock("@/hooks/useViewState", () => ({ useViewState: () => ({ state: {}, setView: vi.fn(), isPending: false }) }));
// the card is not what is under test, and its own fixture is a month of forecast math
vi.mock("./ForecastCard", () => ({ ForecastCard: () => null }));

const { ForecastAndCalendar } = await import("./ForecastAndCalendar");
const { RecurringCalendar } = await import("./RecurringCalendar");
const { RecurringTabs } = await import("./RecurringTabs");
const { CalendarGrid } = await import("@/components/ui/CalendarGrid");
const actions = await import("@/app/recurring/actions");

function month(monthKey: string, entryCount: number): RecurringCalendarMonth {
  return {
    monthKey,
    today: "2026-09-15",
    entriesByDay: {},
    entryCount,
    postedNetCents: 0,
    upcomingNetCents: 0,
    missedCount: 0,
    unsettledCount: 0,
    unsettledGrossCents: 0,
  };
}

/**
 * 🔴 The Calendar tab's badge was rendered once on the server with the CURRENT
 * month's count and handed in as a finished node, so paging the grid could not
 * move it. Measured on the real ledger 2026-09-15: September holds 12 entries
 * and October 14, and paged to October the page read "Forecast · October 2026"
 * over "Calendar 12" over a 14-entry grid.
 *
 * This half pins where the FIRST render reads the number from: the month the
 * grid was handed, not a count computed beside it. The paging half is below.
 */
describe("ForecastAndCalendar — the Calendar badge counts the month on screen", () => {
  const html = renderToStaticMarkup(
    createElement(ForecastAndCalendar, {
      initialForecast: { monthKey: "2026-10" } as MonthForecast,
      initialMonth: month("2026-10", 14),
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

/**
 * One component's hook state, held across calls, so a test can call a function
 * component, fire a prop its output wires up, let the transition settle, and
 * call it again — which is what paging IS, and what a static render cannot do.
 * The repo has no DOM environment; this steps the two components' own code
 * rather than a copy of it.
 */
class HookSlots {
  private readonly values: unknown[] = [];
  private cursor = 0;
  private readonly transitions: Promise<unknown>[] = [];

  render<P>(component: (props: P) => ReactNode, props: P): ReactNode {
    this.cursor = 0;
    hookHost.current = this;
    try {
      return component(props);
    } finally {
      hookHost.current = null;
    }
  }

  useState(init: unknown): [unknown, (next: unknown) => void] {
    const slot = this.cursor++;
    if (!(slot in this.values)) this.values[slot] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (next: unknown): void => {
      this.values[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(this.values[slot]) : next;
    };
    return [this.values[slot], set];
  }

  useTransition(): [boolean, (fn: () => unknown) => void] {
    this.cursor++;
    return [
      false,
      (fn) => {
        const result = fn();
        if (result instanceof Promise) this.transitions.push(result);
      },
    ];
  }

  async settle(): Promise<void> {
    while (this.transitions.length > 0) await this.transitions.shift();
  }
}

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children as ReactNode, type);
}

/**
 * 🔴 THE TRANSITION ITSELF — the defect was that the badge did not move when
 * the grid paged. The fix is two lines in two components: `followMonth` sets
 * the count, and `RecurringCalendar` hands up the month it LOADED. A review of
 * the fix deleted either line and every test above stayed green, because a
 * first render cannot page (2026-09-15). This drives the real paging path:
 * the grid's own `onMonthChange`, the mocked load resolving October, the
 * page's own `onMonthLoaded`, and the strip it renders afterwards.
 */
describe("ForecastAndCalendar — the Calendar badge follows the grid when it pages", () => {
  test("paging to October and then November moves the badge to 14 and then 13", async () => {
    vi.mocked(actions.loadMonthForecastAction).mockResolvedValue({ ok: false, error: "not under test" });
    const page = new HookSlots();
    const grid = new HookSlots();
    // the page as it really loads on 2026-09-15: September, counted beside the grid
    const props = {
      initialForecast: { monthKey: "2026-09" } as MonthForecast,
      initialMonth: month("2026-09", 12),
      today: "2026-09-15",
      view: {},
      tab: "calendar" as const,
      counts: { upcoming: 10, all: 15, calendar: 12 },
    };
    const strip = () => findElement(page.render(ForecastAndCalendar, props), RecurringTabs)!;
    const calendarBadge = () => (strip().props.counts as Record<string, number>).calendar;
    expect(calendarBadge()).toBe(12);

    for (const [monthKey, entryCount] of [
      ["2026-10", 14],
      ["2026-11", 13],
    ] as const) {
      vi.mocked(actions.loadRecurringMonthAction).mockResolvedValueOnce({ ok: true, data: month(monthKey, entryCount) });
      const calendar = findElement(page.render(ForecastAndCalendar, props), RecurringCalendar)!;
      const cells = findElement(
        // the props the page really handed the grid, onMonthLoaded included
        grid.render(RecurringCalendar, calendar.props as unknown as Parameters<typeof RecurringCalendar>[0]),
        CalendarGrid,
      )!;
      (cells.props.onMonthChange as (key: string) => void)(monthKey);
      await grid.settle();
      await page.settle();
      expect(calendarBadge(), monthKey).toBe(entryCount);
    }

    // the other badges are the page's, and the strip prints what it was handed
    const html = renderToStaticMarkup(strip());
    expect(html).toMatch(/>Calendar<span[^>]*>13<\/span>/);
    expect(html).toMatch(/>Upcoming<span[^>]*>10<\/span>/);
  });
});
