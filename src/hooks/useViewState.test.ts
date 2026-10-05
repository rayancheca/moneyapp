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

/**
 * A press made the moment the next page is drawn: in the commit that draws it, after its
 * switchers, before React runs a single passive effect — the soonest anyone could press.
 */
let pressOnDraw: (() => void) | null = null;
function usePressOnDraw(drawn: unknown): void {
  useLayoutEffect(() => {
    const press = pressOnDraw;
    pressOnDraw = null;
    press?.();
  }, [drawn]);
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
  pressOnDraw = null;
});

// ---------------------------------------------------------------- a holding: one switcher
interface HoldingRsc {
  view: ViewState;
  basePath: string;
}
const NO_PARAMS: Record<string, string> = {};
/** every holding's page (/h, /h/b, …) is one surface, as every /investments/[symbol] is */
const holdingPage: HarnessPage<HoldingRsc> = {
  server: (url, persisted) => ({
    view: resolveViewState(HOLDING_VIEW_SPEC, Object.fromEntries(url.searchParams), persisted.holding),
    basePath: url.pathname,
  }),
  Client: ({ rsc }) => {
    const api = useViewState({ surface: "holding", spec: HOLDING_VIEW_SPEC, state: rsc.view, basePath: rsc.basePath, baseParams: NO_PARAMS });
    useRegister("holding", api);
    return null;
  },
};

/** a holding, or a page with no view pills: the holding's switcher mounts and unmounts with it */
const holdingOrElsewhere: HarnessPage<HoldingRsc> = {
  server: holdingPage.server,
  Client: ({ rsc }) => (rsc.basePath === "/elsewhere" ? null : createElement(holdingPage.Client, { rsc })),
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
    usePressOnDraw(rsc);
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

describe("a press on a page whose other view came only from its URL", () => {
  /**
   * 🔴 A shared link holds a view he has not saved. Each switcher built its URL from the params
   * the server handed IT, and the cards were handed none: Grid on `/?chart=bridge` went to
   * `/?cards=grid`, and the hero, read from his saved preference, went back to Net worth.
   */
  test("a cards press keeps the hero's view the link opened", async () => {
    const page = await open(dashboardPage, "/?chart=bridge", { dashboard: { chart: "combined" } });
    pills.cards!("grid");
    await page.settle();

    expect(page.url).toBe("/?chart=bridge&cards=grid");
    expect(page.shown).toMatchObject({ state: { chart: "bridge" }, cards: { cards: "grid" } });
    expect(page.persisted.dashboard).toEqual({ chart: "combined", cards: "grid" }); // the link saved nothing
  });

  test("a hero press keeps the cards' view the link opened", async () => {
    const page = await open(dashboardPage, "/?cards=grid", { dashboard: { cards: "deck" } });
    pills.chart!("split");
    await page.settle();

    expect(page.url).toBe("/?cards=grid&chart=split");
    expect(page.shown).toMatchObject({ state: { chart: "split" }, cards: { cards: "grid" } });
    expect(page.persisted.dashboard).toMatchObject({ chart: "split", cards: "deck" });
  });

  test("a second press made while the first is in flight keeps it too", async () => {
    const page = await open(dashboardPage, "/?chart=bridge", { dashboard: { chart: "combined" } });
    pills.cards!("grid");
    pills.cards!("deck");
    await page.settle();

    expect(page.url).toBe("/?chart=bridge");
    expect(page.shown).toMatchObject({ state: { chart: "bridge" }, cards: { cards: "deck" } });
  });

  /**
   * The server hands each /spending card the other's lens only when it is not the default (a
   * clean link): a link's explicit List over a saved Relief was dropped, and Relief came back.
   */
  test("another card's lens the link holds at its default, over a saved one, is kept", async () => {
    const page = await open(spendingPage, "/spending?where=list", { spending: { where: "relief" } });
    ui.cash!.setView("cash", "table");
    await page.settle();

    expect(page.url).toBe("/spending?where=list&cash=table");
    expect(page.shown).toMatchObject({ cash: { cash: "table" }, where: { where: "list" } });
  });

  /** the URL a press builds on is the one on screen: a link's, then Back's */
  test("after a link and after Back, the view each one's URL holds is kept", async () => {
    const page = await open(dashboardPage, "/", { dashboard: { chart: "combined" } });
    page.router.push("/?chart=bridge");
    await page.settle();
    page.router.push("/?chart=split");
    await page.settle();
    page.back();
    await idle();
    expect(page.url).toBe("/?chart=bridge");

    pills.cards!("grid");
    await page.settle();
    expect(page.url).toBe("/?chart=bridge&cards=grid");
    expect(page.shown).toMatchObject({ state: { chart: "bridge" } });
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
    expect(page.shown).toMatchObject({ cash: { cash: "table" } }); // the cash press's write stood

    ui.where!.setView("where", "relief");
    await page.settle();
    // June, never back to July, built on June as drawn: its table, as when the write lands first
    expect(page.url).toBe("/spending?period=2026-06&cash=table&where=relief");
    expect(page.shown).toMatchObject({ cash: { cash: "table" }, where: { where: "relief" } });
  });
});

describe("a link followed while a press is being written", () => {
  /**
   * 🔴 The period picker followed while the cash press was being written. The link carries no
   * view, so the page it opens draws the SAVED one — and when the server drew it before the
   * write landed, it drew the view from before the press, and nothing drew it again: the Table
   * pill un-pressed, Table saved, a reload showing it. Had the write landed first, the same
   * click drew June with the table; which of two requests the server answers first must not
   * decide what he sees.
   */
  test("on the same page: once the write lands, the page the link opened draws the press", async () => {
    const page = await open(spendingPage, "/spending?period=2026-07");
    ui.cash!.setView("cash", "table");
    page.router.push("/spending?period=2026-06"); // the period picker's ‹
    expect(await page.serve("render")).toEqual({ kind: "render", label: "/spending?period=2026-06" });
    expect(page.shown).toMatchObject({ cash: { cash: "chart" } }); // June, drawn before the write
    await page.settle(); // …then the write lands

    expect(page.persisted.spending).toMatchObject({ cash: "table" }); // saved
    expect(page.shown).toMatchObject({ cash: { cash: "table" } }); // the pill pressed
    expect(page.url).toBe("/spending?period=2026-06"); // the link's URL as it wrote it: the saved view
    expect(page.history.map((entry) => entry.url)).toEqual(["/spending?period=2026-07", "/spending?period=2026-06"]);
  });

  test("on the same page, when the write lands first: the same page, one history entry", async () => {
    const page = await open(spendingPage, "/spending?period=2026-07");
    ui.cash!.setView("cash", "table");
    page.router.push("/spending?period=2026-06");
    await page.serve("write");
    await page.settle();

    expect(page.shown).toMatchObject({ cash: { cash: "table" } });
    expect(page.url).toBe("/spending?period=2026-06");
    expect(page.history.map((entry) => entry.url)).toEqual(["/spending?period=2026-07", "/spending?period=2026-06"]);
  });

  /** a /recurring tab he is already on: a link to the URL on screen, which commits nothing new */
  test("to the URL on screen, the same", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    page.router.push("/h");
    await page.serve("render");
    await page.settle();

    expect(page.shown).toMatchObject({ view: { view: "returns" } });
    expect(page.url).toBe("/h");
  });

  /**
   * Every holding is one surface: the next one opened draws the press made on the last. The
   * link is made again as he made it — a Link scrolls to the page it opens, where a press's
   * own URL keeps a mid-page chart under the cursor.
   */
  test("to another page of the same surface, the same, made as the link was", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    page.router.push("/h/b");
    await page.serve("render");
    await page.settle();

    expect(page.shown).toMatchObject({ view: { view: "returns" } });
    expect(page.url).toBe("/h/b");
    expect(page.navigations).toEqual([
      { url: "/h/b", history: "push", scroll: true },
      { url: "/h/b", history: "push", scroll: true },
    ]);
  });

  test("a press with no link meanwhile goes to its own URL, keeping the scroll", async () => {
    const page = await open(holdingPage, "/h");
    ui.holding!.setView("view", "returns");
    await page.settle();

    expect(page.navigations).toEqual([{ url: "/h?view=returns", history: "push", scroll: false }]);
  });

  test("with two presses in flight, the page it opened draws both", async () => {
    const page = await open(spendingPage, "/spending?period=2026-07");
    ui.cash!.setView("cash", "table");
    ui.where!.setView("where", "relief");
    page.router.push("/spending?period=2026-06");
    await page.serve("render");
    await page.settle();

    expect(page.shown).toMatchObject({ cash: { cash: "table" }, where: { where: "relief" } });
    expect(page.url).toBe("/spending?period=2026-06");
  });

  /**
   * ⚖️ Owner 2026-10-05: Back shows the page he went back to, and he is not dragged anywhere.
   * A link followed first changes nothing: Back is newer. The press's write still lands, and
   * (B2) Back's save of the view it shows lands after it.
   */
  test("then Back: the page Back restored stays, and the link is not redone", async () => {
    const page = await open(holdingPage, "/h");
    page.router.push("/h/b");
    await page.settle();
    ui.holding!.setView("view", "returns");
    page.router.push("/h/c");
    page.back(); // to /h, before the link's page or the write has landed
    await page.settle();

    expect(page.url).toBe("/h");
    expect(page.shown).toMatchObject({ view: { view: "value" } });
    expect(page.writes.map((write) => write.state.view)).toEqual(["returns", "value"]);
    expect(page.persisted.holding).toMatchObject({ view: "value" });
  });
});

describe("Back/Forward to a page with view pills", () => {
  /**
   * ⚖️ Owner 2026-10-05 (B2): Back/Forward RE-SAVES the view of the page he returns to. Back
   * draws that history entry as it was drawn — the view from before the press he walked away
   * from — while his saved preference is still that press's. 🔴 So the next thing he pressed
   * that carries no view in its URL drew the SAVED one, the view he had left: a range pill
   * landed on Return after Back showed Price.
   */
  test("a range pill pressed after Back keeps the view Back showed", async () => {
    const page = await open(portfolioPage, "/investments?range=1Y");
    ui.portfolio!.setView("view", "returns");
    await page.settle();
    expect(page.url).toBe("/investments?range=1Y&view=returns");

    page.back();
    await page.settle();
    expect(page.shown).toMatchObject({ view: { view: "value" } }); // Price, as he left it
    pills.range!("1M");
    await page.settle();

    expect(page.url).toBe("/investments?range=1M");
    expect(page.shown).toMatchObject({ view: { view: "value" } });
    expect(page.persisted.investments).toMatchObject({ view: "value" });
  });

  /** 🔴 The same across /spending's two cards: the lens press drew the cash card he had left. */
  test("another card's press after Back keeps the view Back showed on this one", async () => {
    const page = await open(spendingPage, "/spending");
    ui.cash!.setView("cash", "table");
    await page.settle();

    page.back();
    await page.settle();
    expect(page.shown).toMatchObject({ cash: { cash: "chart" } });
    ui.where!.setView("where", "relief");
    await page.settle();

    expect(page.url).toBe("/spending?where=relief");
    expect(page.shown).toMatchObject({ cash: { cash: "chart" }, where: { where: "relief" } });
    expect(page.persisted.spending).toMatchObject({ cash: "chart", where: "relief" });
  });

  test("Forward re-saves the view of the page it returns to, the same", async () => {
    const page = await open(spendingPage, "/spending");
    ui.cash!.setView("cash", "table");
    await page.settle();
    page.back();
    await page.settle();

    page.forward();
    await page.settle();
    expect(page.url).toBe("/spending?cash=table");
    page.router.push("/spending?period=2026-06"); // the period picker: no view in its URL
    await page.settle();

    expect(page.shown).toMatchObject({ cash: { cash: "table" } });
    expect(page.persisted.spending).toMatchObject({ cash: "table" });
  });

  /** one best-effort save per switcher per Back, like a press's own, and nothing after it */
  test("each switcher on the page saves the view it shows, once", async () => {
    const page = await open(spendingPage, "/spending?period=2026-07");
    ui.cash!.setView("cash", "table");
    await page.settle();
    const before = page.writes.length;

    page.back();
    await page.settle();
    expect(page.writes.slice(before)).toEqual([
      { surface: "spending", state: { cash: "chart" } },
      { surface: "spending", state: { where: "list", massifView: "quarter" } },
    ]);

    ui.where!.setView("where", "relief"); // a press after it: its own write, and no other
    await page.settle();
    expect(page.writes.slice(before + 2)).toEqual([
      { surface: "spending", state: { where: "relief", massifView: "quarter" } },
    ]);
  });

  /**
   * Back's save is sent from the commit that draws its page, so it is queued ahead of anything
   * he presses next: a press's write lands after it, and is the one that stays.
   */
  test("a press made the moment Back's page is drawn is saved over Back's save", async () => {
    const page = await open(spendingPage, "/spending");
    ui.cash!.setView("cash", "table");
    await page.settle();

    pressOnDraw = () => ui.where!.setView("where", "relief");
    page.back();
    await page.settle();

    expect(page.url).toBe("/spending?where=relief");
    expect(page.shown).toMatchObject({ cash: { cash: "chart" }, where: { where: "relief" } });
    expect(page.persisted.spending).toMatchObject({ cash: "chart", where: "relief" });
  });

  /** a page drawn again with no navigation (`router.refresh`, the prices button) is not a Back */
  test("a refresh after Back saves nothing more", async () => {
    const page = await open(spendingPage, "/spending");
    ui.cash!.setView("cash", "table");
    await page.settle();
    page.back();
    await page.settle();
    const after = page.writes.length;

    page.router.refresh();
    await page.settle();
    expect(page.writes).toHaveLength(after);
  });

  /**
   * The spec's dimensions only, as a view press saves them. The hero's `accts` rides its URL as
   * every account when nothing is curated: saving it would make "every account" a curation.
   */
  test("the hero and the cards save their views, and never the account selection", async () => {
    const page = await open(dashboardPage, "/?chart=accounts", { dashboard: { chart: "accounts" } });
    pills.cards!("grid");
    await page.settle();
    expect(page.url).toBe("/?chart=accounts&cards=grid");

    page.back();
    await page.settle();
    expect(page.persisted.dashboard).toMatchObject({ chart: "accounts", cards: "deck" });
    expect(page.persisted.dashboard).not.toHaveProperty("accts");
  });

  /** Back to a page from another: its switchers are drawn anew, by Back, and save as above */
  test("a switcher Back draws anew saves its view; one a link draws anew, nothing", async () => {
    const page = await open(holdingOrElsewhere, "/h?view=returns", { holding: { view: "value" } });
    page.router.push("/elsewhere");
    await page.settle();
    page.back();
    await page.settle();
    expect(page.writes).toEqual([
      { surface: "holding", state: { view: "returns", unit: "dollar", lens: "chart" } },
    ]);

    page.router.push("/elsewhere");
    await page.settle();
    page.router.push("/h");
    await page.settle();
    expect(page.writes).toHaveLength(1);
  });

  /** ⛔ the URL alone outranks the saved view; a load or a link he followed saves nothing */
  test("a first load and a link save nothing", async () => {
    const page = await open(holdingPage, "/h?view=returns", { holding: { view: "value" } });
    page.router.push("/h/b?unit=percent");
    await page.settle();
    page.router.push("/h");
    await page.settle();

    expect(page.writes).toEqual([]);
    expect(page.persisted.holding).toEqual({ view: "value" });
  });

  /**
   * A press still being written when he goes Back: its write was sent first and lands first,
   * and Back's save of the view he returned to lands after it.
   */
  test("with a press still being written, the view Back showed is the one saved", async () => {
    const page = await open(spendingPage, "/spending");
    ui.cash!.setView("cash", "table");
    await page.settle();
    ui.where!.setView("where", "relief"); // in flight…
    page.back(); // …when he goes back to /spending
    await page.settle();
    expect(page.url).toBe("/spending");

    page.router.push("/spending?period=2026-06");
    await page.settle();
    expect(page.shown).toMatchObject({ cash: { cash: "chart" }, where: { where: "list" } });
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
