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
  current: null as null | {
    useState(init: unknown): unknown;
    useTransition(): unknown;
    useRef(init: unknown): unknown;
  },
}));
/*
 * ⛔ EVERY hook the two components call, or a call reaches the real React with no component rendering and throws.
 * 🔴 5d156a4 gave `RecurringCalendar` a `useRef` (the month last asked for) and the paging test below failed on
 * "Cannot read properties of null (reading 'useRef')" from then on — at main aa23d34 and on every branch merged from it
 * (review of 7458684): the guard on the Calendar badge following the grid had stopped running.
 */
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => (hookHost.current ? hookHost.current.useState(init) : real.useState(init)),
    useTransition: () => (hookHost.current ? hookHost.current.useTransition() : real.useTransition()),
    useRef: (init: unknown) => (hookHost.current ? hookHost.current.useRef(init) : real.useRef(init)),
  };
});

// server actions pull in next/cache and the database client; the view-state
// hook needs an app router that a static render does not mount
vi.mock("@/app/recurring/actions", () => ({ loadMonthForecastAction: vi.fn(), loadRecurringMonthAction: vi.fn() }));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  // the tab strip's links build on the URL on screen
  usePathname: () => "/recurring",
  useSearchParams: () => new URLSearchParams("tab=calendar"),
}));
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

  /** one object per slot, kept across renders — what a ref IS */
  useRef(init: unknown): { current: unknown } {
    const slot = this.cursor++;
    if (!(slot in this.values)) this.values[slot] = { current: init };
    return this.values[slot] as { current: unknown };
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

  /*
   * 🔴 5d156a4: the grid steps from the month it SHOWS, so a second press while October was still loading asked for
   * October again and was lost — e2e's 24 presses back stopped short of July 2024. The calendar steps from the month
   * last ASKED for, and only the newest answer draws. Two presses before the first answer: November is asked for and
   * drawn, and October's late answer moves nothing.
   */
  test("a second press while October loads asks for November — and October's late answer does not draw", async () => {
    vi.mocked(actions.loadMonthForecastAction).mockResolvedValue({ ok: false, error: "not under test" });
    const load = vi.mocked(actions.loadRecurringMonthAction);
    load.mockReset();
    // October's answer is held back until November's has drawn — the order a slow month's read arrives in
    let answerOctober!: (answer: Awaited<ReturnType<typeof actions.loadRecurringMonthAction>>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (answerOctober = resolve)));
    load.mockResolvedValueOnce({ ok: true, data: month("2026-11", 13) });
    const page = new HookSlots();
    const grid = new HookSlots();
    const props = {
      initialForecast: { monthKey: "2026-09" } as MonthForecast,
      initialMonth: month("2026-09", 12),
      today: "2026-09-15",
      view: {},
      tab: "calendar" as const,
      counts: { upcoming: 10, all: 15, calendar: 12 },
    };
    const press = (): void => {
      const calendar = findElement(page.render(ForecastAndCalendar, props), RecurringCalendar)!;
      const cells = findElement(
        grid.render(RecurringCalendar, calendar.props as unknown as Parameters<typeof RecurringCalendar>[0]),
        CalendarGrid,
      )!;
      // the grid still shows September, so its "next" is October both times
      (cells.props.onMonthChange as (key: string) => void)("2026-10");
    };
    press();
    press();
    // November answers and draws first…
    await new Promise((resolve) => setTimeout(resolve, 0));
    // …then October's stale answer arrives
    answerOctober({ ok: true, data: month("2026-10", 14) });
    await grid.settle();
    await page.settle();
    expect(load.mock.calls.map(([arg]) => arg.monthKey)).toEqual(["2026-10", "2026-11"]);
    const strip = findElement(page.render(ForecastAndCalendar, props), RecurringTabs)!;
    expect((strip.props.counts as Record<string, number>).calendar).toBe(13);
  });
});
