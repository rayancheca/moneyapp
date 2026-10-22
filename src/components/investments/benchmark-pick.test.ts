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
// the pick's own action, queued in the router like every server action — behind a save of Back's view — and, as
// setBenchmarkAction does once it keeps a symbol, revalidating /investments (a refusal returns before it)
vi.mock("@/app/investments/actions", async () => {
  const { heldServerAction } = await import("@/hooks/useViewState.harness");
  return {
    setBenchmarkAction: (symbol: string): Promise<unknown> =>
      heldServerAction(
        "benchmark",
        { symbol },
        refusals[symbol] === undefined ? { ok: true, data: { symbol } } : { ok: false, error: refusals[symbol] },
        refusals[symbol] === undefined,
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
   * action Next queues behind that save the same way, waited on it without a bound (review of ab13868, 2026-10-13).
   * Bounded as a press is (`pressWriteLanding`), it holds no navigation past BACK_SAVE_WAIT_MS (the link tests below)
   * — and is drawn once its action has kept the symbol, never before: 🔴 drawn at its bound (0acc9b5), a URL carried a
   * symbol the server had neither priced nor kept (review of 10852ef, 2026-10-14).
   */
  test("picked while Back's save hangs, nothing is drawn before its action keeps the symbol — then it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    expect(page.pending).toEqual([BACK_SAVE]); // its own action, queued behind Back's save
    const before = page.navigations.length;

    await vi.advanceTimersByTimeAsync(2 * BACK_SAVE_WAIT_MS);
    await idle();
    expect(page.navigations.slice(before)).toEqual([]);
    expect(page.pending).toEqual([BACK_SAVE]);
    expect(page.url).toBe("/investments?range=1Y");
    // still "fetching…": its action is queued behind Back's save, and the router's state waits on it
    expect(drawn().picker.isPending).toBe(true);

    await page.serve("write"); // Back's save, late
    await page.serve("write"); // and the pick's, behind it
    await page.settle();
    expect(page.persisted).toMatchObject({ benchmark: { symbol: "QQQ" }, investments: { view: "value" } });
    expect(page.url).toBe("/investments?range=1Y&bench=QQQ");
    expect(drawn().rsc).toMatchObject({ bench: "QQQ", view: { view: "value" } }); // the view Back showed
    expect(drawn().picker).toMatchObject({ isPending: false, error: null });
  });

  /**
   * ⛔ The pick waits inside its transition, and React holds every navigation made meanwhile until that settles: with
   * Back's save hung, a link he followed after a pick was never drawn — the press's own lesson (measured 2026-10-13).
   * ⚖️ Owner 2026-10-05: and once the pick is answered he stays where the link took him. 🔴 It went to the symbol at
   * its bound and again once answered, each time to a URL it asked for anew, always the newest: off his link's view to
   * /investments?range=1Y&bench=QQQ at 10 s, with the server still hung (review of 10852ef, 2026-10-14).
   */
  test("a link followed while a pick waits on Back's hung save is drawn by BACK_SAVE_WAIT_MS — and stays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    page.router.push("/investments?view=returns&unit=percent"); // a link that carries a view
    await idle();
    await page.serve("render");
    const at = page.navigations.length;
    await vi.advanceTimersByTimeAsync(BACK_SAVE_WAIT_MS);
    await idle();

    expect(page.url).toBe("/investments?view=returns&unit=percent");
    expect(drawn().rsc.view).toMatchObject({ view: "returns", unit: "percent" });

    await vi.advanceTimersByTimeAsync(2 * BACK_SAVE_WAIT_MS);
    await idle();
    await page.settle(); // Back's save, late, and the pick's action behind it
    expect(page.navigations.slice(at)).toEqual([]);
    expect(page.url).toBe("/investments?view=returns&unit=percent");
    // kept, and the page he is on drawn with it
    expect(page.persisted.benchmark).toMatchObject({ symbol: "QQQ" });
    expect(drawn().rsc).toMatchObject({ bench: "QQQ", view: { view: "returns", unit: "percent" } });
  });

  /** 🔴 Answered after he left by a link to another page: he was taken back to /investments (review of 10852ef). */
  test("a link to another page after a pick let go: once it is kept he stays there", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    await vi.advanceTimersByTimeAsync(2 * BACK_SAVE_WAIT_MS);
    await idle();
    // 0acc9b5 drew QQQ here, at its bound (the review's P1); nothing does now
    while (page.pending.some((work) => work.kind === "render")) await page.serve("render");
    page.router.push("/budgets"); // the sidebar's
    await idle();
    await page.serve("render");
    const at = page.navigations.length;

    while (page.pending.some((work) => work.kind === "write")) await page.serve("write"); // Back's save; the pick's
    await page.settle();
    expect(page.navigations.slice(at)).toEqual([]);
    expect(page.url).toBe("/budgets");
    expect(page.persisted.benchmark).toMatchObject({ symbol: "QQQ" });
  });

  /**
   * ⚖️ Owner 2026-10-05: Back/Forward shows the page he went to; he is not dragged anywhere. 🔴 A pick answered after
   * Forward asked for a URL anew and went there: the isNewest guard of a URL writer cannot stop an ask made after the
   * move (review of 10852ef, 2026-10-14). Queued behind Back's save, the pick's action runs AFTER Forward and is kept:
   * Next's reducer redraws the page from its response, but into the state the action was dispatched with, and the
   * restore's own state came after it — so React shows the page as Forward drew it (measured with the harness modelling
   * revalidation, 2026-10-22; the in-flight case, which Next refreshes, is the test below).
   */
  test("Forward after a pick let go: once it is kept nothing is drawn — he stays on the page he went to", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = await backWithItsSaveHeld();
    drawn().picker.pick("QQQ");
    await idle();
    await vi.advanceTimersByTimeAsync(BACK_SAVE_WAIT_MS + 1); // let go at its bound
    await idle();
    page.forward(); // to his Return
    await idle();
    const at = page.navigations.length;

    await vi.advanceTimersByTimeAsync(2 * BACK_SAVE_WAIT_MS);
    await idle();
    const served: string[] = [];
    while (page.pending.length > 0) served.push((await page.serve()).kind);
    expect(served).not.toContain("render"); // the page Forward showed, as it showed it — not even drawn again
    expect(page.navigations.slice(at)).toEqual([]);
    expect(page.url).toBe("/investments?range=1Y&view=returns");
    expect(page.persisted.benchmark).toMatchObject({ symbol: "QQQ" });
    expect(drawn().rsc).toMatchObject({ bench: "SPY", view: { view: "returns" } });
  });

  /**
   * Back while the pick's action is IN FLIGHT discards it, and an action that revalidates and is discarded has Next
   * refresh the page once it completes (app-router-instance.js `needsRefresh`): the page Back showed is drawn again in
   * place, with the symbol kept — never a navigation, so he is not dragged. 🔴 Review of b37a250: the harness modelled
   * no revalidation, so it read this page as never drawn again.
   */
  test("Back while its action is in flight: once it is kept, the page Back showed is drawn again in place, with it", async () => {
    const page = await open("/investments?range=1Y");
    drawn().api.setParam("range", "1M");
    await page.settle();
    drawn().picker.pick("QQQ");
    await idle();
    expect(page.pending).toEqual([{ kind: "write", label: 'benchmark {"symbol":"QQQ"}' }]);
    page.back(); // to 1Y, the pick's action still in flight
    await idle();
    const at = page.navigations.length;

    const served: string[] = [];
    while (page.pending.length > 0) {
      const work = await page.serve();
      served.push(`${work.kind} ${work.kind === "render" ? work.label : ""}`.trim());
    }
    expect(served.filter((s) => s.startsWith("render"))).toEqual(["render /investments?range=1Y"]);
    expect(page.navigations.slice(at)).toEqual([]);
    expect(page.url).toBe("/investments?range=1Y");
    expect(page.persisted.benchmark).toMatchObject({ symbol: "QQQ" });
    expect(drawn().rsc.bench).toBe("QQQ");
  });

  test("the control: a range pressed while its action fetches is no move — the pick is drawn on it", async () => {
    const page = await open("/investments?range=1Y");
    drawn().picker.pick("QQQ");
    await idle();
    drawn().api.setParam("range", "1M"); // a URL writer, as the range pill is: it asks for its URL first
    await idle();
    await page.settle();
    expect(page.url).toBe("/investments?range=1M&bench=QQQ");
    expect(drawn().rsc.bench).toBe("QQQ");
  });

  /**
   * With nothing in flight it waits on its action inside its transition, so a link followed meanwhile commits once it
   * is answered: 🔴 the pick then went to /investments?range=1Y&bench=QQQ — the page he had left (before 0acc9b5 too).
   * The link's page was drawn before the symbol was kept, so it is drawn again where he is — by Next: the link
   * discarded an action that revalidates, and Next refreshes the page once it completes. 🔴 Review of b37a250: the pick
   * asked for a `router.refresh()` of its own on top, one more server render of the page he is on.
   */
  test("with nothing in flight, a link followed while its action fetches: he stays there, drawn with it once", async () => {
    const page = await open("/investments?range=1Y");
    drawn().picker.pick("QQQ");
    await idle();
    page.router.push("/investments"); // the sidebar's link
    await idle();
    await page.serve("render"); // drawn before the symbol is kept
    const at = page.navigations.length;

    await page.serve("write"); // its action keeps QQQ
    const renders: string[] = [];
    while (page.pending.length > 0) renders.push((await page.serve("render")).label);
    expect(renders).toEqual(["/investments"]);
    expect(page.navigations.slice(at)).toEqual([]);
    expect(page.url).toBe("/investments");
    expect(page.persisted.benchmark).toMatchObject({ symbol: "QQQ" });
    expect(drawn().rsc.bench).toBe("QQQ");
  });

  /**
   * 🔴 Cut short, the pick went to the symbol he typed and closed the custom box before its action answered; refused,
   * the URL, the select and the chart stayed on ZZZZ while the alert said it has no history, a reload offered to
   * fetch its closes, and his typed text was gone (review of 10852ef, 2026-10-14). A refused pick changes nothing.
   */
  test("let go, a symbol its action then refuses says why, and nothing is kept or drawn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    refusals.ZZZZ = "No price history found for ZZZZ";
    const page = await backWithItsSaveHeld();
    const kept = vi.fn();
    drawn().picker.pick("ZZZZ", kept);
    await idle();
    await vi.advanceTimersByTimeAsync(2 * BACK_SAVE_WAIT_MS);
    await idle();
    expect(drawn().picker.error).toBeNull();

    await page.settle();
    expect(drawn().picker.error).toBe("No price history found for ZZZZ");
    expect(page.persisted.benchmark).toBeUndefined();
    expect(page.url).toBe("/investments?range=1Y");
    expect(drawn().rsc.bench).toBe("SPY");
    expect(kept).not.toHaveBeenCalled(); // the custom box stays open, his text in it
  });
});
