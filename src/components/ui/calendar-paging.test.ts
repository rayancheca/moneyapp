import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { ActionResult } from "@/app/transactions/action-types";
import { findElement, HookSlots } from "@/hooks/hook-slots.harness";
import type { PnlCalendarMonth } from "@/services/portfolio";
import type { RecurringCalendarMonth } from "@/services/recurring-calendar";
import type { SpendHeatmap as SpendHeatmapData } from "@/services/spending";

vi.mock("react", async (importOriginal) =>
  (await import("@/hooks/hook-slots.harness")).routeHooks(await importOriginal<typeof import("react")>()),
);
// each calendar loads its month through a server action, which pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ loadRecurringMonthAction: vi.fn() }));
vi.mock("@/app/investments/actions", () => ({ loadPnlMonthAction: vi.fn(), loadPnlDayAction: vi.fn() }));
vi.mock("@/app/spending/actions", () => ({ loadSpendHeatmap: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/Toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/Toast")>()),
  toast: vi.fn(),
}));

const { CalendarGrid } = await import("./CalendarGrid");
const { IconButton } = await import("./Button");
const { Sheet } = await import("./Sheet");
const { toast } = await import("./Toast");
const { RecurringCalendar } = await import("@/components/recurring/RecurringCalendar");
const { PnlCalendar } = await import("@/components/investments/PnlCalendar");
const { SpendHeatmap } = await import("@/components/spending/SpendHeatmap");
const recurringActions = await import("@/app/recurring/actions");
const investmentActions = await import("@/app/investments/actions");
const spendingActions = await import("@/app/spending/actions");

const TODAY = "2026-10-12";
const SHOWN = "2026-10";

/** A calendar on CalendarGrid: the page that draws it, the action its ‹ › load through, and a month of it. */
interface Caller {
  name: string;
  draw(slots: HookSlots): ReactNode;
  load: Mock;
  /** the month one call of `load` asked for */
  askedFor(args: unknown[]): string;
  month(monthKey: string): unknown;
}

const recurringMonth = (monthKey: string): RecurringCalendarMonth => ({
  monthKey,
  today: TODAY,
  entriesByDay: {},
  entryCount: 0,
  postedNetCents: 0,
  upcomingNetCents: 0,
  missedCount: 0,
  unsettledCount: 0,
  unsettledGrossCents: 0,
});
// only what the calendar itself reads: its footer and cells are elements this test never calls
const pnlMonth = (monthKey: string) => ({ monthKey, cellsByDay: {}, scaleCents: 0 }) as unknown as PnlCalendarMonth;
const heatMonth = (monthKey: string): SpendHeatmapData => ({ monthKey, days: [], maxOutflowCents: 0, maxInflowCents: 0 });
const keyOf = (args: unknown[]): string => (args[0] as { monthKey: string }).monthKey;

const RECURRING: Caller = {
  name: "/recurring's calendar",
  draw: (slots) => slots.render(RecurringCalendar, { initialMonth: recurringMonth(SHOWN), today: TODAY }),
  load: vi.mocked(recurringActions.loadRecurringMonthAction),
  askedFor: keyOf,
  month: recurringMonth,
};
const PNL: Caller = {
  name: "/investments' P/L calendar",
  draw: (slots) => slots.render(PnlCalendar, { initialMonth: pnlMonth(SHOWN), today: TODAY }),
  load: vi.mocked(investmentActions.loadPnlMonthAction),
  askedFor: keyOf,
  month: pnlMonth,
};
const HEATMAP: Caller = {
  name: "/spending's heatmap",
  draw: (slots) =>
    slots.render(SpendHeatmap, {
      initial: heatMonth(SHOWN),
      today: TODAY,
      ledgerOpens: "2024-07-01",
      ledgerReaches: TODAY,
    }),
  load: vi.mocked(spendingActions.loadSpendHeatmap),
  askedFor: (args) => args[0] as string,
  month: heatMonth,
};

interface Ask {
  monthKey: string;
  answer(result: ActionResult<unknown>): void;
}

/** One calendar on screen, whose loads wait for the test to answer them — so a press can land mid-load. */
function onScreen(caller: Caller) {
  const page = new HookSlots();
  const asks: Ask[] = [];
  caller.load.mockImplementation(
    (...args: unknown[]) =>
      new Promise((resolve) => asks.push({ monthKey: caller.askedFor(args), answer: resolve })),
  );
  const grid = () => findElement(caller.draw(page), CalendarGrid)!;
  return {
    page,
    asks,
    asked: () => asks.map((ask) => ask.monthKey),
    drawn: () => grid().props.monthKey as string,
    /** a press of the grid's own ‹ or › button, on the calendar as it is drawn right now */
    press(label: "Previous month" | "Next month"): void {
      const header = new HookSlots().render(CalendarGrid, grid().props as unknown as Parameters<typeof CalendarGrid>[0]);
      (findElement(header, IconButton, { "aria-label": label })!.props.onClick as () => void)();
    },
    answer(ask: Ask): void {
      ask.answer({ ok: true, data: caller.month(ask.monthKey) });
    },
  };
}

beforeEach(() => {
  vi.mocked(toast).mockClear();
});

/**
 * 🔴 One rule, three callers. 5d156a4 made /recurring's calendar step from the month last ASKED for, because the grid
 * steps from the month it shows and a press landing while the last month was still loading asked for that same month
 * again (e2e's 24 presses back from July 2026 stopped short, 3 of 3 re-runs). The review of f978583 (2026-10-13)
 * found the other two calendars on the same grid still lost that press: on 2026-10, ‹ ‹ asked the P/L calendar for
 * 2026-09 twice and drew 2026-09; the heatmap did the same, had no guard against a late answer, and a quick ‹ › asked
 * it for September and then NOVEMBER.
 */
const CALLERS = [RECURRING, PNL, HEATMAP].map((caller) => [caller.name, caller] as const);
describe.each(CALLERS)("%s — a press while a month loads steps from the month last asked for", (_name, caller) => {
  test("‹ ‹ before the first month lands asks for September and then August, and draws August", async () => {
    const calendar = onScreen(caller);
    calendar.press("Previous month");
    calendar.press("Previous month");
    expect(calendar.asked()).toEqual(["2026-09", "2026-08"]);

    for (const ask of calendar.asks) calendar.answer(ask);
    await calendar.page.settle();
    expect(calendar.drawn()).toBe("2026-08");
  });

  test("‹ › before either lands asks for September and then October — the month he started on, not November", async () => {
    const calendar = onScreen(caller);
    calendar.press("Previous month");
    calendar.press("Next month");
    expect(calendar.asked()).toEqual(["2026-09", "2026-10"]);

    for (const ask of calendar.asks) calendar.answer(ask);
    await calendar.page.settle();
    expect(calendar.drawn()).toBe("2026-10");
  });

  test("a month that lands after a newer one was asked for is never drawn", async () => {
    const calendar = onScreen(caller);
    calendar.press("Previous month");
    calendar.press("Previous month");
    const [september, august] = calendar.asks;

    calendar.answer(august!);
    await calendar.page.settle();
    expect(calendar.drawn()).toBe("2026-08");
    calendar.answer(september!);
    await calendar.page.settle();
    expect(calendar.drawn()).toBe("2026-08");
  });

  test("a month that fails to load says so, keeps the month on screen, and the next press steps from that", async () => {
    const calendar = onScreen(caller);
    calendar.press("Previous month");
    calendar.asks[0]!.answer({ ok: false, error: "Failed to load month" });
    await calendar.page.settle();
    expect(toast).toHaveBeenCalledWith({ title: "Failed to load month", tone: "negative" });
    expect(calendar.drawn()).toBe(SHOWN);

    // October is still on screen, so ‹ is September again — not August, a step from the month that never came
    calendar.press("Previous month");
    expect(calendar.asked()).toEqual(["2026-09", "2026-09"]);
  });

  test("a month he has already pressed past fails without a word — the newer month draws", async () => {
    const calendar = onScreen(caller);
    calendar.press("Previous month");
    calendar.press("Previous month");
    const [september, august] = calendar.asks;

    september!.answer({ ok: false, error: "Failed to load month" });
    calendar.answer(august!);
    await calendar.page.settle();
    expect(toast).not.toHaveBeenCalled();
    expect(calendar.drawn()).toBe("2026-08");
    // and the press after it steps from August
    calendar.press("Previous month");
    expect(calendar.asked()).toEqual(["2026-09", "2026-08", "2026-07"]);
  });
});

describe("/spending's heatmap — what it draws around a load", () => {
  const tree = (calendar: ReturnType<typeof onScreen>) => HEATMAP.draw(calendar.page);
  const busy = (calendar: ReturnType<typeof onScreen>) =>
    findElement(tree(calendar), "div")!.props["aria-busy"] as boolean;

  test("stays busy until the newest month lands, not the first", async () => {
    const calendar = onScreen(HEATMAP);
    calendar.press("Previous month");
    calendar.press("Previous month");
    expect(busy(calendar)).toBe(true);

    calendar.answer(calendar.asks[0]!);
    await calendar.page.settle();
    expect(busy(calendar)).toBe(true);
    calendar.answer(calendar.asks[1]!);
    await calendar.page.settle();
    expect(busy(calendar)).toBe(false);
  });

  test("a day's sheet open on the old month closes when the new month lands", async () => {
    const calendar = onScreen(HEATMAP);
    const grid = findElement(tree(calendar), CalendarGrid)!;
    (grid.props.onDayActivate as (iso: string) => void)("2026-10-05");
    expect(findElement(tree(calendar), Sheet)!.props.open).toBe(true);

    calendar.press("Previous month");
    calendar.answer(calendar.asks[0]!);
    await calendar.page.settle();
    expect(findElement(tree(calendar), Sheet)!.props.open).toBe(false);
  });
});
