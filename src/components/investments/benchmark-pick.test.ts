import { createElement, useCallback, useLayoutEffect, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACK_SAVE_WAIT_MS } from "@/lib/page-asks";
import { resolveViewState, type ViewState } from "@/lib/view-state";
import { idle, World, type HarnessPage } from "@/hooks/useViewState.harness";
import { PORTFOLIO_VIEW_SPEC } from "./investments-view-spec";

/** the reason the server refuses a symbol it cannot price, by symbol; every other pick is kept */
const refusals = vi.hoisted((): Record<string, string> => ({}));
vi.mock("next/navigation", async () => (await import("@/hooks/useViewState.harness")).nextNavigation);
vi.mock("@/app/settings/actions", async () => (await import("@/hooks/useViewState.harness")).settingsActions);
// the pick's own action, queued in the router like every server action — behind a save of Back's view
vi.mock("@/app/investments/actions", async () => {
  const { heldServerAction } = await import("@/hooks/useViewState.harness");
  return {
    setBenchmarkAction: (symbol: string): Promise<unknown> =>
      heldServerAction(
        "benchmark",
        { symbol },
        refusals[symbol] === undefined ? { ok: true, data: { symbol } } : { ok: false, error: refusals[symbol] },
      ),
  };
});

const { useViewState } = await import("@/hooks/useViewState");
const { PageAsksProvider } = await import("@/hooks/usePageAsks");
const { useBenchmarkPick } = await import("./BenchmarkPicker");

/*
 * /investments' benchmark picker, in real React over Next's action queue (useViewState.harness.ts): its action
 * persists the symbol, then the panel's switcher navigates to the chart with it (`setParam`), as PortfolioChartPanel
 * wires it. The server holds every write and render until the test serves it.
 */
interface PortfolioRsc {
  view: ViewState;
  baseParams: Record<string, string>;
  bench: string;
}
const portfolioPage: HarnessPage<PortfolioRsc> = {
  server: (url, persisted) => {
    const range = url.searchParams.get("range") ?? "ALL";
    // URL > persisted > SPY (`resolveBenchmarkSymbol`)
    const bench = url.searchParams.get("bench") ?? persisted.benchmark?.symbol ?? "SPY";
    return {
      view: resolveViewState(PORTFOLIO_VIEW_SPEC, Object.fromEntries(url.searchParams), persisted.investments),
      baseParams: { ...(range === "ALL" ? {} : { range }), ...(bench === "SPY" ? {} : { bench }) },
      bench,
    };
  },
  Client: ({ rsc }) => {
    const api = useViewState({
      surface: "investments",
      spec: PORTFOLIO_VIEW_SPEC,
      state: rsc.view,
      basePath: "/investments",
      baseParams: rsc.baseParams,
    });
    const { setParam } = api;
    const showBenchmark = useCallback(
      (symbol: string) => setParam("bench", symbol === "SPY" ? null : symbol),
      [setParam],
    );
    const picker = useBenchmarkPick(showBenchmark);
    useLayoutEffect(() => {
      on.page = { api, picker, rsc };
    });
    return null;
  },
};

const on: {
  page: {
    api: ReturnType<typeof useViewState>;
    picker: ReturnType<typeof useBenchmarkPick>;
    rsc: PortfolioRsc;
  } | null;
} = { page: null };
const drawn = () => on.page!;

const layout = (children: ReactNode): ReactNode => createElement(PageAsksProvider, null, children);
let mounted: World<unknown> | null = null;
async function open(url: string): Promise<World<PortfolioRsc>> {
  const world = new World(portfolioPage, url, {}, layout);
  mounted = world as World<unknown>;
  await world.mount();
  return world;
}
afterEach(async () => {
  await mounted?.settle().catch(() => {});
  await mounted?.unmount();
  mounted = null;
  on.page = null;
  for (const key of Object.keys(refusals)) delete refusals[key];
  vi.useRealTimers();
});

const BACK_SAVE = { kind: "write", label: 'investments {"view":"value","unit":"dollar","lens":"chart"}' };

/** /investments?range=1Y, Return pressed and drawn, then Back to the Value: Back's save of it, held by the server */
async function backWithItsSaveHeld(): Promise<World<PortfolioRsc>> {
  const page = await open("/investments?range=1Y");
  drawn().api.setView("view", "returns");
  await page.settle();
  page.back();
  await idle();
  expect(page.pending).toEqual([BACK_SAVE]);
  return page;
}

describe("a benchmark pick — persisted by its own action, then drawn", () => {
  test("the control: with nothing in flight it goes once its action has kept the symbol", async () => {
    const page = await open("/investments?range=1Y");
    drawn().picker.pick("QQQ");
    await idle();
    expect(page.pending).toEqual([{ kind: "write", label: 'benchmark {"symbol":"QQQ"}' }]);
    await page.settle();

    expect(page.url).toBe("/investments?range=1Y&bench=QQQ");
    expect(drawn().rsc.bench).toBe("QQQ");
    expect(drawn().picker.isPending).toBe(false);
  });

  test("the control: once Back's save lands in time, it waits on its own action however long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    await page.serve("write"); // Back's save, in time
    expect(page.pending).toEqual([{ kind: "write", label: 'benchmark {"symbol":"QQQ"}' }]); // its own, behind it

    await vi.advanceTimersByTimeAsync(3 * BACK_SAVE_WAIT_MS); // a slow fetch of a ticker's closes
    await idle();
    expect(page.pending.map((work) => work.kind)).toEqual(["write"]); // nothing drawn before it is kept
    await page.settle();
    expect(page.url).toBe("/investments?range=1Y&bench=QQQ");
    expect(drawn().rsc.view).toMatchObject({ view: "value" });
  });

  /**
   * 🔴 ab13868 bounded a view press queued behind a save of Back's view that hangs; the benchmark pick, whose own
   * action Next queues behind that save the same way, waited on it without a bound (review of ab13868, 2026-10-13):
   * the pick was never drawn, and the picker stayed disabled. Bounded as a press is (`pressWriteLanding`): cut short,
   * it goes to the symbol he picked, which its URL carries — at its own BACK_SAVE_WAIT_MS and then the URL writer's
   * (`setParam` waits on Back's saves too) — and once its action is answered, again.
   */
  test("picked while Back's save hangs, it is drawn by its bound — and drawn again once its action lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    expect(page.pending).toEqual([BACK_SAVE]); // its own action, queued behind Back's save

    await vi.advanceTimersByTimeAsync(BACK_SAVE_WAIT_MS - 1);
    await idle();
    expect(page.pending).toEqual([BACK_SAVE]); // never before Back's save could have landed
    await vi.advanceTimersByTimeAsync(BACK_SAVE_WAIT_MS + 1);
    await idle();
    await page.serve("render");
    expect(page.url).toBe("/investments?range=1Y&bench=QQQ");
    // its URL carries no view, so the saved one draws — his Return, until Back's save lands, as under a range pill
    expect(drawn().rsc).toMatchObject({ bench: "QQQ", view: { view: "returns" } });
    expect(drawn().picker.isPending).toBe(false);
    // Back's save, still held, and the pick's own action behind it: sent, landing whenever the server answers
    expect(page.pending).toEqual([BACK_SAVE, { kind: "write", label: 'benchmark {"symbol":"QQQ"}' }]);

    await page.serve("write"); // Back's save, late
    await page.serve("write"); // and the pick's, behind it
    await page.settle();
    expect(page.persisted).toMatchObject({ benchmark: { symbol: "QQQ" }, investments: { view: "value" } });
    expect(page.url).toBe("/investments?range=1Y&bench=QQQ");
    expect(drawn().rsc).toMatchObject({ bench: "QQQ", view: { view: "value" } }); // the view Back showed
    expect(drawn().picker.error).toBeNull();
  });

  /**
   * ⛔ The pick waits inside its transition, and React holds every navigation made meanwhile until that settles: with
   * Back's save hung, a link he followed after a pick was never drawn — the press's own lesson (measured 2026-10-13).
   */
  test("a link followed while a pick waits on Back's hung save is drawn by BACK_SAVE_WAIT_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    page.router.push("/investments?view=returns&unit=percent"); // a link that carries a view
    await idle();
    await page.serve("render");
    await vi.advanceTimersByTimeAsync(BACK_SAVE_WAIT_MS);
    await idle();

    expect(page.url).toBe("/investments?view=returns&unit=percent");
    expect(drawn().rsc.view).toMatchObject({ view: "returns", unit: "percent" });
  });

  test("cut short, a symbol its action then refuses says why, and nothing is kept", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    refusals.ZZZZ = "No price history found for ZZZZ";
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("ZZZZ");
    await idle();
    await vi.advanceTimersByTimeAsync(2 * BACK_SAVE_WAIT_MS);
    await idle();
    await page.serve("render");
    expect(drawn().picker.error).toBeNull();

    await page.settle();
    expect(drawn().picker.error).toBe("No price history found for ZZZZ");
    expect(page.persisted.benchmark).toBeUndefined();
  });
});
