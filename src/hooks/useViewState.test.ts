import { createElement, useLayoutEffect, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DASHBOARD_VIEW_SPEC, DECISIONS_VIEW_SPEC } from "@/components/dashboard/dashboard-view-spec";
import { HOLDING_VIEW_SPEC, PORTFOLIO_VIEW_SPEC } from "@/components/investments/investments-view-spec";
import type { DashboardAccountOption } from "@/services/dashboard-series";
import { CASH_VIEW_SPEC } from "@/components/spending/spending-view-spec";
import { WHERE_VIEW_SPEC } from "@/lib/massif-layout";
import { resolveViewState, viewStateToParams, type ViewState } from "@/lib/view-state";
import { idle, World, type HarnessPage } from "./useViewState.harness";

vi.mock("next/navigation", async () => (await import("./useViewState.harness")).nextNavigation);
vi.mock("@/app/settings/actions", async () => (await import("./useViewState.harness")).settingsActions);

const { useViewState } = await import("./useViewState");
const { PageAsksProvider } = await import("./usePageAsks");
const { useRangeParam } = await import("@/components/charts/ChartFocus");
const { useHeroViews } = await import("@/components/dashboard/DashboardChartSection");

/*
 * The switchers of one page, pressed faster than the server answers. Each scenario is a real
 * page's wiring (the props its RSC resolves, the hooks its client renders) in real React over
 * Next's action queue — see useViewState.harness.ts — with the server holding every write and
 * every render until the test serves it.
 */

type Api = ReturnType<typeof useViewState>;
/** the committed switchers of the mounted page, by name */
const ui: Record<string, Api> = {};
function useRegister(name: string, api: Api): void {
  useLayoutEffect(() => {
    ui[name] = api;
  });
}
/** the page's other controls (a range pill, an account pill), by name */
const pills: Record<string, (value: string) => void> = {};
function usePill(name: string, press: (value: string) => void): void {
  useLayoutEffect(() => {
    pills[name] = press;
  });
}

/** the root layout's wrapper, as the app mounts it */
const layout = (children: ReactNode): ReactNode => createElement(PageAsksProvider, null, children);

let mounted: World<unknown> | null = null;
async function open<P>(page: HarnessPage<P>, url: string, persisted: Record<string, ViewState> = {}) {
  const world = new World(page, url, persisted, layout);
  mounted = world as World<unknown>;
  await world.mount();
  return world;
}
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  for (const key of Object.keys(ui)) delete ui[key];
  for (const key of Object.keys(pills)) delete pills[key];
});

// ---------------------------------------------------------------- a holding: one switcher
interface HoldingRsc {
  view: ViewState;
}
const NO_PARAMS: Record<string, string> = {};
const holdingPage: HarnessPage<HoldingRsc> = {
  server: (url, persisted) => ({
    view: resolveViewState(HOLDING_VIEW_SPEC, Object.fromEntries(url.searchParams), persisted.holding),
  }),
  Client: ({ rsc }) => {
    const api = useViewState({ surface: "holding", spec: HOLDING_VIEW_SPEC, state: rsc.view, basePath: "/h", baseParams: NO_PARAMS });
    useRegister("holding", api);
    return null;
  },
};

// ---------------------------------------------------------------- /spending: two switchers, one URL
interface SpendingRsc {
  cash: ViewState;
  where: ViewState;
  cashBase: Record<string, string>;
  whereBase: Record<string, string>;
}
/** spending/page.tsx: each card's switch keeps the period and the OTHER card's lens */
const spendingPage: HarnessPage<SpendingRsc> = {
  server: (url, persisted) => {
    const params = Object.fromEntries(url.searchParams);
    const cash = resolveViewState(CASH_VIEW_SPEC, params, persisted.spending);
    const where = resolveViewState(WHERE_VIEW_SPEC, params, persisted.spending);
    const period: Record<string, string> = params.period ? { period: params.period } : {};
    return {
      cash,
      where,
      cashBase: { ...period, ...viewStateToParams(WHERE_VIEW_SPEC, where) },
      whereBase: { ...period, ...viewStateToParams(CASH_VIEW_SPEC, cash) },
    };
  },
  Client: ({ rsc }) => {
    const cash = useViewState({ surface: "spending", spec: CASH_VIEW_SPEC, state: rsc.cash, basePath: "/spending", baseParams: rsc.cashBase });
    const where = useViewState({ surface: "spending", spec: WHERE_VIEW_SPEC, state: rsc.where, basePath: "/spending", baseParams: rsc.whereBase });
    useRegister("cash", cash);
    useRegister("where", where);
    return null;
  },
};

// ---------------------------------------------------------------- /investments: a switcher and a range pill
interface PortfolioRsc {
  view: ViewState;
  baseParams: Record<string, string>;
}
/**
 * investments/page.tsx: a view switch keeps a non-default range and benchmark; ChartFocus mirrors
 * its range pill; the benchmark picker (once its own action has persisted the symbol) navigates
 * through the panel's switcher, as PortfolioChartPanel wires it
 */
const portfolioPage: HarnessPage<PortfolioRsc> = {
  server: (url, persisted) => {
    const range = url.searchParams.get("range") ?? "ALL";
    const bench = url.searchParams.get("bench") ?? "SPY";
    const baseParams: Record<string, string> = {
      ...(range === "ALL" ? {} : { range }),
      ...(bench === "SPY" ? {} : { bench }),
    };
    return {
      view: resolveViewState(PORTFOLIO_VIEW_SPEC, Object.fromEntries(url.searchParams), persisted.investments),
      baseParams,
    };
  },
  Client: ({ rsc }) => {
    const api = useViewState({ surface: "investments", spec: PORTFOLIO_VIEW_SPEC, state: rsc.view, basePath: "/investments", baseParams: rsc.baseParams });
    useRegister("portfolio", api);
    usePill("range", useRangeParam("range") as (value: string) => void);
    usePill("bench", (symbol) => api.setParam("bench", symbol === "SPY" ? null : symbol));
    return null;
  },
};

// ---------------------------------------------------------------- the dashboard: a view and its account pills
interface HeroRsc {
  state: ViewState;
  accounts: DashboardAccountOption[];
  selectedAccountIds: string[];
  acctsParam: string;
  cards: ViewState;
}
const ACCOUNTS: DashboardAccountOption[] = ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase() }) as DashboardAccountOption);
/** page.tsx: the selection is URL > persisted, validated in accounts mode (none → every account) */
const dashboardPage: HarnessPage<HeroRsc> = {
  server: (url, persisted) => {
    const state = resolveViewState(DASHBOARD_VIEW_SPEC, Object.fromEntries(url.searchParams), persisted.dashboard);
    const acctsParam = url.searchParams.get("accts") ?? persisted.dashboard?.accts ?? "";
    const valid = acctsParam.split(",").filter((id) => ACCOUNTS.some((a) => a.id === id));
    const selected = state.chart === "accounts" ? (valid.length > 0 ? valid : ACCOUNTS.map((a) => a.id)) : [];
    return {
      state,
      accounts: ACCOUNTS,
      selectedAccountIds: selected,
      acctsParam: state.chart === "accounts" ? selected.join(",") : acctsParam,
      cards: resolveViewState(DECISIONS_VIEW_SPEC, Object.fromEntries(url.searchParams), persisted.dashboard),
    };
  },
  Client: ({ rsc }) => {
    const { setView, toggleAccount } = useHeroViews(rsc);
    usePill("chart", (value) => setView("chart", value));
    usePill("account", toggleAccount);
    // the decision cards' switcher, wired as DecisionCards wires it
    const cards = useViewState({ surface: "dashboard", spec: DECISIONS_VIEW_SPEC, state: rsc.cards, basePath: "/", baseParams: NO_PARAMS });
    usePill("cards", (value) => cards.setView("cards", value));
    return null;
  },
};

describe("a press made while another is in flight", () => {
  /**
   * 🔴 Built on the view the server resolved BEFORE the first press, the second wrote the first
   * one's dimension straight back and navigated away from it: Return, then Table before the
   * page re-rendered, saved `view: "value"` over the Return and landed on the Price table.
   */
  test("on one switcher, keeps the first press", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    await page.serve("write"); // Return is written; its page is rendering
    ui.holding!.setView("lens", "table");
    await page.settle();

    expect(page.persisted.holding).toEqual({ view: "returns", unit: "dollar", lens: "table" });
    expect(page.url).toBe("/h?view=returns&lens=table");
  });

  test("three presses in a row each keep the ones before", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    ui.holding!.setView("lens", "table");
    await page.serve("write");
    ui.holding!.setView("unit", "percent");
    await page.settle();

    expect(page.persisted.holding).toEqual({ view: "returns", unit: "percent", lens: "table" });
    expect(page.url).toBe("/h?view=returns&unit=percent&lens=table");
  });

  test("before the first one's write has landed, keeps it too", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    ui.holding!.setView("lens", "table");
    await page.settle();

    expect(page.persisted.holding).toEqual({ view: "returns", unit: "dollar", lens: "table" });
    expect(page.url).toBe("/h?view=returns&lens=table");
  });

  /**
   * 🔴 The same lost press across TWO switchers: /spending's cash card and its "Where it went"
   * card share one URL, and each one's switch carried the other's lens as the server resolved
   * it. The second press's URL dropped the first press's view.
   */
  test("on another switcher of the same page, keeps the first press", async () => {
    const page = await open(spendingPage, "/spending?period=2026-07");
    ui.cash!.setView("cash", "table");
    await page.serve("write");
    ui.where!.setView("where", "relief");
    await page.settle();

    expect(page.url).toBe("/spending?period=2026-07&cash=table&where=relief");
    expect(page.persisted.spending).toMatchObject({ cash: "table", where: "relief" });
  });

  test("taking another switcher back to its default, keeps the first press", async () => {
    const page = await open(spendingPage, "/spending?where=relief", { spending: { where: "relief" } });
    ui.where!.setView("where", "list");
    ui.cash!.setView("cash", "table");
    await page.settle();

    expect(page.url).toBe("/spending?cash=table");
    expect(page.persisted.spending).toMatchObject({ cash: "table", where: "list" });
  });
});

describe("a page's other URL writers, while a press is in flight", () => {
  /**
   * 🔴 ChartFocus mirrors its range pill into the URL from the URL the router last committed.
   * A pill pressed while a view press was in flight navigated without the view — and the view
   * press, landing after, navigated to a URL without the range.
   */
  test("a range pill pressed after a view press keeps both", async () => {
    const page = await open(portfolioPage, "/investments?view=returns", { investments: { view: "returns" } });
    ui.portfolio!.setView("view", "value");
    pills.range!("1M");
    await page.settle();

    expect(page.url).toBe("/investments?range=1M");
    expect(page.persisted.investments).toMatchObject({ view: "value" });
  });

  test("a view press made while a range pill is in flight keeps the range", async () => {
    const page = await open(portfolioPage, "/investments");
    pills.range!("1M");
    ui.portfolio!.setView("view", "returns");
    await page.settle();

    expect(page.url).toBe("/investments?range=1M&view=returns");
  });

  /**
   * 🔴 The dashboard's account pills persisted and navigated on their own, from the selection
   * the server resolved before any press in flight: a second pill put the first one's account
   * straight back, and a view pill navigated to the old selection.
   */
  test("a second account pill keeps the first", async () => {
    const page = await open(dashboardPage, "/?chart=accounts");
    pills.account!("a");
    pills.account!("b");
    await page.settle();

    expect(page.url).toBe("/?accts=c&chart=accounts");
    expect(page.persisted.dashboard).toMatchObject({ accts: "c" });
  });

  test("a view pill made after an account pill keeps the selection", async () => {
    const page = await open(dashboardPage, "/?chart=accounts");
    pills.account!("a");
    pills.chart!("split");
    await page.settle();

    expect(page.url).toBe("/?accts=b%2Cc&chart=split");
    expect(page.persisted.dashboard).toMatchObject({ chart: "split", accts: "b,c" });
  });

  /** the decision cards and the hero are two switchers of one surface, on one URL */
  test("a cards press made while a hero press is in flight keeps the hero's view", async () => {
    const page = await open(dashboardPage, "/");
    pills.chart!("split");
    pills.cards!("grid");
    await page.settle();

    expect(page.url).toBe("/?chart=split&cards=grid");
    expect(page.persisted.dashboard).toMatchObject({ chart: "split", cards: "grid" });
  });

  /**
   * 🔴 The benchmark picker navigated to an href its panel built from the view the server
   * resolved: a symbol picked while a view press was in flight landed without the view.
   */
  test("a benchmark picked after a view press keeps the view", async () => {
    const page = await open(portfolioPage, "/investments");
    ui.portfolio!.setView("view", "returns");
    pills.bench!("QQQ");
    await page.settle();

    expect(page.url).toBe("/investments?bench=QQQ&view=returns");
  });

  test("a view press made after a benchmark pick keeps the benchmark", async () => {
    const page = await open(portfolioPage, "/investments?range=1M");
    pills.bench!("QQQ");
    ui.portfolio!.setView("view", "returns");
    await page.settle();

    expect(page.url).toBe("/investments?range=1M&bench=QQQ&view=returns");
  });
});

describe("a press made once the page has moved under the one in flight", () => {
  /**
   * ⛔ The regression that reverted 3c5d3ea. Back commits with a bare setState, outside any
   * transition, so a press still in flight keeps the page's transition pending: a press built
   * on the view the newest press ASKED for brought back the view he had just left.
   */
  test("after Back, builds on the view Back restored", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("unit", "percent");
    await page.settle();
    expect(page.url).toBe("/h?unit=percent");

    ui.holding!.setView("view", "returns"); // in flight…
    page.back(); // …when he goes back to /h
    await page.serve("write");
    ui.holding!.setView("lens", "table");
    await page.settle();

    expect(page.url).toBe("/h?lens=table");
    expect(page.persisted.holding).toMatchObject({ unit: "dollar", lens: "table" });
  });

  /**
   * 🔴 A press he walked away from dragged him back: its write lands after he has gone, and it
   * then navigated to the page he left.
   */
  test("after Back, the press he left does not take him forward again", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("unit", "percent");
    await page.settle();

    ui.holding!.setView("view", "returns");
    page.back();
    await page.settle();

    expect(page.url).toBe("/h");
  });

  /**
   * ⛔ Back can land on the very URL the newest press asked for — here /h, every dimension at
   * its default — and the URL alone cannot tell that apart from the press landing. What Back
   * shows is that history entry's own render (the % view he opened on); a press made next must
   * build on THAT, not on the $ and Chart he pressed and then went back from.
   */
  test("after Back lands on the URL a press asked for, builds on the view Back restored", async () => {
    const page = await open(holdingPage, "/h", { holding: { unit: "percent" } });
    ui.holding!.setView("lens", "table");
    await page.settle();
    expect(page.url).toBe("/h?unit=percent&lens=table");

    ui.holding!.setView("unit", "dollar"); // in flight, asks /h?lens=table…
    ui.holding!.setView("lens", "chart"); // …then /h
    page.back(); // to /h, as he opened it: Price, %, chart
    await idle();
    ui.holding!.setView("view", "returns");
    await page.settle();

    expect(page.url).toBe("/h?view=returns&unit=percent");
    expect(page.persisted.holding).toEqual({ view: "returns", unit: "percent", lens: "chart" });
  });

  /** 🔴 The same after a link whose page lands before the press's write does. */
  test("after a link, the press he left does not take him back", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    page.router.push("/elsewhere");
    await page.serve("render"); // the link's page lands…
    await page.settle(); // …then the press's write

    expect(page.url).toBe("/elsewhere");
    expect(page.persisted.holding).toMatchObject({ view: "returns" }); // the write stands
  });

  /**
   * Once a press lands, the URLs asked before it are forgotten: a link back to one of them is a
   * move like any other, not a press landing late.
   */
  test("after a link back to a URL an earlier press asked for, builds on that page", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    await page.settle();
    ui.holding!.setView("view", "value");
    await page.settle();
    expect(page.url).toBe("/h");

    page.router.push("/h?view=returns"); // Return, by link
    await page.settle();
    ui.holding!.setView("unit", "percent");
    await page.settle();

    expect(page.url).toBe("/h?view=returns&unit=percent");
  });

  test("after a link on the same page, builds on the page the link opened", async () => {
    const page = await open(spendingPage, "/spending?period=2026-07");
    ui.cash!.setView("cash", "table");
    page.router.push("/spending?period=2026-06"); // the period picker
    await page.serve("render");
    await page.settle();
    expect(page.url).toBe("/spending?period=2026-06");

    ui.where!.setView("where", "relief");
    await page.settle();
    // June, never back to July; and the cash press's write stood, so June draws its table
    expect(page.url).toBe("/spending?period=2026-06&where=relief");
    expect(page.shown).toMatchObject({ cash: { cash: "table" }, where: { where: "relief" } });
  });
});

describe("a press repeated while the first is in flight", () => {
  /**
   * e2e's pressView retries a press until its pill says it took, as anyone would. A retry is
   * sent again, exactly as before this hook knew about presses in flight — the same write and
   * the same URL, never a toggle. (3c5d3ea made it a no-op, and the first gate it met failed
   * with the Value pill pressed ten times in 30 s and never taking.)
   */
  test("is sent again, the same, and never toggles", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    ui.holding!.setView("view", "returns");
    await page.settle();

    expect(page.writes).toEqual([
      { surface: "holding", state: { view: "returns", unit: "dollar", lens: "chart" } },
      { surface: "holding", state: { view: "returns", unit: "dollar", lens: "chart" } },
    ]);
    expect(page.url).toBe("/h?view=returns");
  });

  test("once it is drawn, is nothing", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    await page.settle();
    ui.holding!.setView("view", "returns");
    await page.settle();

    expect(page.writes).toHaveLength(1);
  });
});
