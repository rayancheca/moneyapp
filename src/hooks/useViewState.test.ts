import { beforeEach, describe, expect, test, vi } from "vitest";
import { HOLDING_VIEW_SPEC } from "@/components/investments/investments-view-spec";
import type { ViewState } from "@/lib/view-state";

/*
 * `useViewState` stepped by hand. There is no jsdom in this project, so the React hooks it
 * calls are routed to `Panel` below — which re-renders exactly the way React does around a
 * press: `isPending` turns true as soon as a press starts, and the server-resolved `state`
 * prop does not move until the test says the press's navigation has committed.
 */
const host = vi.hoisted(() => ({
  current: null as null | {
    useRef(init: unknown): { current: unknown };
    useTransition(): [boolean, (fn: () => unknown) => void];
  },
}));
vi.mock("react", () => ({
  useCallback: <T>(fn: T): T => fn,
  useRef: (init: unknown) => host.current!.useRef(init),
  useTransition: () => host.current!.useTransition(),
}));

type Save = { surface: string; state: Record<string, string> };
const saves = vi.hoisted(() => [] as Save[]);
const pushes = vi.hoisted(() => [] as string[]);
vi.mock("@/app/settings/actions", () => ({
  saveViewPreferenceAction: async (surface: string, state: Record<string, string>) => {
    saves.push({ surface, state });
    return { ok: true };
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => pushes.push(href) }),
}));

const { useViewState } = await import("./useViewState");
type Options = Parameters<typeof useViewState>[0];

class Panel {
  private readonly slots: unknown[] = [];
  private cursor = 0;
  private pending = false;
  private readonly inFlight: Promise<unknown>[] = [];

  render(opts: Options): ReturnType<typeof useViewState> {
    this.cursor = 0;
    host.current = this;
    try {
      return useViewState(opts);
    } finally {
      host.current = null;
    }
  }

  useRef(init: unknown): { current: unknown } {
    const slot = this.cursor++;
    if (!(slot in this.slots)) this.slots[slot] = { current: init };
    return this.slots[slot] as { current: unknown };
  }

  useTransition(): [boolean, (fn: () => unknown) => void] {
    this.cursor++;
    return [
      this.pending,
      (fn) => {
        this.pending = true;
        this.inFlight.push(Promise.resolve(fn()));
      },
    ];
  }

  /** every press's write and push has run, and its navigation has committed */
  async settle(): Promise<void> {
    while (this.inFlight.length > 0) await this.inFlight.shift();
    this.pending = false;
  }
}

const AAPL = "/investments/stock/AAPL";
const PRICE_CHART: ViewState = { view: "value", unit: "dollar", lens: "chart" };
const holding = (state: ViewState): Options => ({
  surface: "holding",
  spec: HOLDING_VIEW_SPEC,
  state,
  basePath: AAPL,
  baseParams: {},
});

beforeEach(() => {
  saves.length = 0;
  pushes.length = 0;
});

/**
 * 🔴 A press made while another is still in flight was built on the view the server resolved
 * BEFORE the first press — and a press persists and navigates to the WHOLE view, so it wrote
 * the first press's dimension straight back and navigated away from it. On a holding: Return,
 * then Table before the page re-rendered, wrote `view: "value"` over the Return just saved and
 * landed on `?lens=table` — the Price table. Nothing said so.
 */
describe("a press made while another is in flight", () => {
  test("builds on the view that press asked for, so neither press is undone", async () => {
    const panel = new Panel();
    panel.render(holding(PRICE_CHART)).setView("view", "returns");
    // React re-renders with isPending; the first press's navigation has not committed, so
    // the server-resolved view is still Price
    panel.render(holding(PRICE_CHART)).setView("lens", "table");
    await panel.settle();

    expect(saves.map((s) => s.state)).toEqual([
      { view: "returns", unit: "dollar", lens: "chart" },
      { view: "returns", unit: "dollar", lens: "table" },
    ]);
    expect(pushes).toEqual([`${AAPL}?view=returns`, `${AAPL}?view=returns&lens=table`]);
  });

  test("is not sent again when it repeats the press in flight, and never toggles", async () => {
    const panel = new Panel();
    panel.render(holding(PRICE_CHART)).setView("view", "returns");
    panel.render(holding(PRICE_CHART)).setView("view", "returns");
    await panel.settle();

    expect(saves.map((s) => s.state)).toEqual([{ view: "returns", unit: "dollar", lens: "chart" }]);
    expect(pushes).toEqual([`${AAPL}?view=returns`]);
  });
});

describe("a press made once nothing is in flight", () => {
  test("builds on the view the server resolved, not on the last one asked for", async () => {
    const panel = new Panel();
    panel.render(holding(PRICE_CHART)).setView("view", "returns");
    await panel.settle();
    // the server resolved Price again (Back, or a link): that is the view on screen
    panel.render(holding(PRICE_CHART)).setView("lens", "table");
    await panel.settle();

    expect(saves.at(-1)?.state).toEqual({ view: "value", unit: "dollar", lens: "table" });
    expect(pushes.at(-1)).toBe(`${AAPL}?lens=table`);
  });
});
