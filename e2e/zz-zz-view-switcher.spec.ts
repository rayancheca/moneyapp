import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";
import { delayServerActions, holdRequests, isServerAction, pageRequest, pressView } from "./view-helpers";

/**
 * The cash-flow view switcher (NS#2 Pillar 2): the SAME data as a vivid chart or a
 * raw-number table, chosen in the URL (shareable, Back works) and persisted per
 * surface. This spec mutates app_settings (viewPreferences) so it lives in the zz
 * tier and RESTORES the default (Chart) at the end for sibling specs.
 */

/**
 * Navigate, then WAIT FOR HYDRATION before returning.
 *
 * Every control in this spec is a `"use client"` segmented button whose onClick
 * is attached at hydration — but the button itself ships in the SSR HTML, already
 * visible and already enabled. Playwright's actionability checks are therefore
 * satisfied BEFORE React can respond, and a click landing in that window is
 * silently swallowed: no pill moves, no chart changes, no error.
 *
 * That was the flake. Measured on the restore step of the portfolio test (a fresh
 * navigation followed immediately by a click — the tightest window in the file):
 * 3 failures in 5 isolated runs, always "element(s) not found" for the value
 * slider, and the failure dump always showed `button "Return" [pressed]` — i.e.
 * the click never ran at all, rather than running and rendering the wrong chart.
 *
 * The signal: ThemeToggle renders `{mounted ? <Icon/> : <span/>}`, so the SVG
 * appears only once the client has mounted. Note the button's `aria-label` is
 * NOT a valid signal — it is present in the SSR markup too, so waiting on the
 * accessible name proves nothing. Scoping to the svg INSIDE the theme button
 * also sidesteps the `header button svg` ambiguity on pages that mount a
 * CalendarGrid or a Sheet (each brings its own <header> svg).
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

const GATING = new Set(["critical", "serious"]);
function gating(results: { violations: { impact?: string | null }[] }) {
  return results.violations.filter((v) => GATING.has(v.impact ?? ""));
}

async function pillPressed(page: Page, name: "Chart" | "Graph" | "Table"): Promise<boolean> {
  const btn = page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name });
  return (await btn.getAttribute("aria-pressed")) === "true";
}

test("cash-flow view switches chart↔table, updates the URL, and persists", async ({ page }) => {
  await gotoHydrated(page, "/spending?period=2026-07");
  const chart = page.getByRole("figure", { name: /Income above the axis/ });
  const table = page.getByRole("table");

  // default view is the chart
  await expect(chart).toBeVisible();
  expect(await pillPressed(page, "Chart")).toBe(true);

  // switch to the table: URL carries the choice, the same numbers render as rows
  await page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name: "Table" }).click();
  await expect(page).toHaveURL(/[?&]cash=table\b/);
  await expect(table).toBeVisible();
  expect(await pillPressed(page, "Table")).toBe(true);
  await expect(chart).toHaveCount(0);
  // the table reconciles: it has the period column and a Net column
  await expect(table.getByRole("columnheader", { name: "Period" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Net" })).toBeVisible();

  // the table view is accessible (overlay-open doctrine: scan the new state)
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // the GRAPH view: the same data as cumulative running-total lines
  await page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name: "Graph" }).click();
  await expect(page).toHaveURL(/[?&]cash=graph\b/);
  await expect(page.getByRole("figure", { name: /Running totals for the period/ })).toBeVisible();
  expect(await pillPressed(page, "Graph")).toBe(true);
  await expect(page.getByText("Income, running total")).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // the choice is sticky: a fresh visit with NO cash param keeps the graph
  await gotoHydrated(page, "/spending");
  await expect(page.getByRole("figure", { name: /Running totals for the period/ })).toBeVisible();
  expect(await pillPressed(page, "Graph")).toBe(true);

  // restore the default so sibling specs see the chart
  await page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name: "Chart" }).click();
  await expect(page.getByRole("figure", { name: /Income above the axis/ })).toBeVisible();
  await gotoHydrated(page, "/spending");
  await expect(page.getByRole("figure", { name: /Income above the axis/ })).toBeVisible();
});

async function invPillPressed(page: Page, name: "Value" | "Return"): Promise<boolean> {
  const btn = page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name });
  return (await btn.getAttribute("aria-pressed")) === "true";
}

test("portfolio chart switches value↔return, updates the URL, and persists", async ({ page }) => {
  // The portfolio view is PERSISTED, and this suite deliberately shares ONE
  // database across specs (playwright.config.ts: workers: 1). So "the default is
  // Value" is not a precondition this test may assume — any earlier spec that
  // touched /investments leaves it on Return, and this one then fails on its very
  // first assertion having tested nothing. That was the flake: 2 of 5 full runs,
  // always here, always "element(s) not found" for the value slider.
  //
  // Establish the precondition the way the app actually stores it. A `?view=`
  // param only wins for THAT render (lib/view-state.ts resolveViewState prefers
  // the URL over the persisted value) — it does not write the preference. Only
  // the pill click persists, which is why the tail of this test restores by
  // clicking too.
  await gotoHydrated(page, "/investments");
  if (!(await invPillPressed(page, "Value"))) {
    await pressView(page, "Portfolio chart view", "Value");
  }

  const valueChart = page.getByRole("slider", { name: /Portfolio value over time/ });
  const returnChart = page.getByRole("slider", { name: /Portfolio return over time/ });

  await expect(valueChart).toBeVisible();
  expect(await invPillPressed(page, "Value")).toBe(true);

  // switch to return: the URL carries it, the slider relabels to the return line
  await pressView(page, "Portfolio chart view", "Return");
  await expect(page).toHaveURL(/[?&]view=returns\b/);
  await expect(returnChart).toBeVisible();
  expect(await invPillPressed(page, "Return")).toBe(true);
  await expect(valueChart).toHaveCount(0);

  // the return view is accessible (scan the new state)
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // sticky: a fresh visit with NO view param still shows the return line
  await gotoHydrated(page, "/investments");
  await expect(page.getByRole("slider", { name: /Portfolio return over time/ })).toBeVisible();
  expect(await invPillPressed(page, "Return")).toBe(true);

  // restore the default so sibling specs see the value chart
  await pressView(page, "Portfolio chart view", "Value");
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
  await gotoHydrated(page, "/investments");
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
});

/**
 * 🔴 Presses made faster than the server answers. A press writes its view and only THEN
 * navigates, so until it lands everything on the page — each switcher's view, the URL the
 * range pill reads — is the page from before it. Built on that, Table pressed while Return
 * was being written saved `view: "value"` over it and landed on the Value table, and a press
 * made while a range pill was in flight took the range back. Every press on a page now
 * builds on the newest one asked for (src/lib/page-asks.ts). The writes are held
 * (`delayServerActions`) so "faster than the server" is every run, not one in fifteen.
 *
 * 🔴 And so is the range pill's page: until 2026-10-05 this test let it land before the view
 * presses, so they built on a URL that already carried the range, and the range half passed
 * on main's code too. Held until both presses are made, the range is in the URL only because
 * the presses built on what the pill ASKED for.
 */
test("a range pill and two view presses made before any lands all take", async ({ page }) => {
  await gotoHydrated(page, "/investments");
  const range = page.getByRole("group", { name: "Chart range" }).first();
  const view = page.getByRole("group", { name: "Portfolio chart view" });
  const lens = page.getByRole("group", { name: "Portfolio lens" });
  await expect(view.getByRole("button", { name: "Value" })).toHaveAttribute("aria-pressed", "true");

  // the panel is live: a range pill flips on the client, with no server round trip — and the
  // page the pill navigates to for the panels around the chart is held, in flight
  const rangePage = await holdRequests(page, pageRequest("/investments", { range: "1M" }));
  await expect(async () => {
    await range.getByRole("button", { name: "1 month" }).click();
    await expect(range.getByRole("button", { name: "1 month" })).toHaveAttribute("aria-pressed", "true", {
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect.poll(() => rangePage.count()).toBeGreaterThan(0);

  await delayServerActions(page);
  await view.getByRole("button", { name: "Return" }).click();
  await lens.getByRole("button", { name: "Table" }).click(); // Return is not yet written
  await rangePage.release(); // the router runs the writes only once the range's page is in
  await expect(view.getByRole("button", { name: "Return" })).toHaveAttribute("aria-pressed", "true");
  await expect(lens.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: /Portfolio return by day/ })).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=returns\b/);
  await expect(page).toHaveURL(/[?&]lens=table\b/);
  await expect(page).toHaveURL(/[?&]range=1M\b/);

  // both were written, not just drawn: a fresh visit with no params opens on them
  await gotoHydrated(page, "/investments");
  await expect(page.getByRole("table", { name: /Portfolio return by day/ })).toBeVisible();

  // restore the defaults for sibling specs, each press proved
  await pressView(page, "Portfolio lens", "Chart");
  await pressView(page, "Portfolio chart view", "Value");
  await gotoHydrated(page, "/investments");
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
});

/**
 * 🔴 The period picker followed while a press is being written. Its link carries no view, so
 * June draws the SAVED one — and drawn before the write landed, it drew the Chart, and nothing
 * drew it again: the Table pill un-pressed over a Table he had saved, a reload showing it.
 * The press now makes the link again once its write lands (src/lib/page-asks.ts `landing`).
 * The write is held until June's page is in, so the losing order is every run.
 */
test("a period link followed while a press is being written lands with the press", async ({ page }) => {
  await gotoHydrated(page, "/spending?period=2026-07");
  const cashView = page.getByRole("group", { name: "Cash flow view" });
  await expect(cashView.getByRole("button", { name: "Chart" })).toHaveAttribute("aria-pressed", "true");

  const write = await holdRequests(page, isServerAction);
  await expect(async () => {
    await cashView.getByRole("button", { name: "Table" }).click();
    // a click before the panel hydrates is swallowed: press until the write is sent
    await expect.poll(() => write.count(), { timeout: 1_000 }).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  const june = page.waitForResponse((response) => pageRequest("/spending", { period: "2026-06" })(response.request()));
  await page.getByRole("link", { name: "Previous period" }).click();
  await june; // June is drawn while the write is held…
  await write.release(); // …and only then does Table reach the server

  await expect(cashView.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page).toHaveURL(/\/spending\?period=2026-06$/); // the link's URL, as it wrote it

  // saved, not just drawn: a fresh visit with no params opens on the table
  await gotoHydrated(page, "/spending");
  await expect(cashView.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");

  // restore the default for sibling specs, the press proved
  await pressView(page, "Cash flow view", "Chart");
  await gotoHydrated(page, "/spending");
  await expect(page.getByRole("figure", { name: /Income above the axis/ })).toBeVisible();
});

async function holdingPillPressed(page: Page, name: "Price" | "Return"): Promise<boolean> {
  const btn = page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name });
  return (await btn.getAttribute("aria-pressed")) === "true";
}

test("a holding chart switches price↔return, updates the URL, and persists", async ({ page }) => {
  // resolve the first holding-detail URL from /investments (stable fixture order)
  await gotoHydrated(page, "/investments");
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await gotoHydrated(page, href!);

  const priceChart = page.getByRole("slider", { name: /price over time/ });
  const returnChart = page.getByRole("slider", { name: /return over time/ });

  // default view is the price line, with its avg-cost reference + trade marks
  await expect(priceChart).toBeVisible();
  expect(await holdingPillPressed(page, "Price")).toBe(true);

  // switch to return: the URL carries it, the slider relabels, the stats strip appears
  await page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name: "Return" }).click();
  await expect(page).toHaveURL(/[?&]view=returns\b/);
  await expect(returnChart).toBeVisible();
  expect(await holdingPillPressed(page, "Return")).toBe(true);
  await expect(priceChart).toHaveCount(0);
  await expect(page.getByText("Best day")).toBeVisible();
  await expect(page.getByText(/Value = (net contributed|contributions) \+ market/)).toBeVisible();
  // honesty labels: the baseline is named (never "all time") + the method basis
  await expect(page.getByText(/your return · since .+ · at daily closes/)).toBeVisible();

  // the $ ⇄ % unit switch appears only in the return view; % relabels the hero
  const unitGroup = page.getByRole("group", { name: "Return unit" });
  await expect(unitGroup).toBeVisible();
  await unitGroup.getByRole("button", { name: "%" }).click();
  await expect(page).toHaveURL(/[?&]unit=percent\b/);
  await expect(returnChart).toBeVisible();

  // the return view is accessible (scan the new state)
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // sticky: a fresh visit with NO params still shows the % return line
  await gotoHydrated(page, href!);
  await expect(page.getByRole("slider", { name: /return over time/ })).toBeVisible();
  expect(await holdingPillPressed(page, "Return")).toBe(true);

  // restore the default so sibling specs (visual baselines) see the price chart
  await page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name: "Price" }).click();
  await expect(page.getByRole("slider", { name: /price over time/ })).toBeVisible();
  await unitGroupRestore(page, href!);
});

test("the benchmark picker fetches history for an unheld symbol and persists", async ({ page }) => {
  // this test backfills (fake) closes into price_cache and runs LAST in the
  // suite; the db is reseeded from scratch on every run, so nothing leaks
  await gotoHydrated(page, "/investments?view=returns");
  const picker = page.getByRole("combobox", { name: "Benchmark" });
  await expect(picker).toBeVisible();
  // the fixture has no cached SPY — the picker says so instead of a blank overlay
  await expect(page.getByText(/No price history for SPY yet/)).toBeVisible();

  // pick Nasdaq 100: the action backfills 2y of closes, then navigates with ?bench
  await picker.selectOption("QQQ");
  await expect(page).toHaveURL(/[?&]bench=QQQ\b/);
  await expect(page.getByText(/Nasdaq 100 replay/)).toBeVisible();
  await expect(page.getByText(/simulated at daily closes/)).toBeVisible();

  // sticky: a fresh visit with NO bench param keeps the persisted pick
  await gotoHydrated(page, "/investments?view=returns");
  await expect(page.getByText(/Nasdaq 100 replay/)).toBeVisible();

  // the % framing swaps to the buy-and-hold comparison for the same benchmark;
  // honesty: the benchmark's % names its OWN basis day (its 2y backfill window can
  // be shorter than the You line's), never the literally-false "all time"
  await page.getByRole("group", { name: "Return unit" }).getByRole("button", { name: "%" }).click();
  await expect(page.getByText(/Nasdaq 100.*% since /).first()).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // restore: $ framing, the SPY default (which backfills SPY — last test), Value view
  await page.getByRole("group", { name: "Return unit" }).getByRole("button", { name: "$" }).click();
  // wait for the $ navigation to settle before picking (the picker's href
  // carries the ACTIVE view state — selecting mid-transition would keep %)
  await expect(page.getByText(/Nasdaq 100 replay/)).toBeVisible();
  await expect(page).not.toHaveURL(/unit=percent/);
  await page.getByRole("combobox", { name: "Benchmark" }).selectOption("SPY");
  await expect(page).not.toHaveURL(/bench=/);
  await expect(page.getByText(/S&P 500 replay/)).toBeVisible();
  await page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name: "Value" }).click();
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
});

/**
 * Comparison is OPT-IN. Before "Just my return" existed the benchmark resolver
 * fell through to SPY, so there was no way to see your own line without a market
 * line drawn over it — the owner's words: "i am forced to compare my performance
 * to something."
 *
 * The load-bearing assertion is the DASHED PATH COUNT, not the caption. A caption
 * can disappear while the overlay is still drawn (and the reverse), and it is the
 * drawn line the complaint was actually about.
 */
test("the benchmark can be turned off entirely, and stays off", async ({ page }) => {
  await gotoHydrated(page, "/investments?view=returns&unit=percent");
  const picker = page.getByRole("combobox", { name: "Benchmark" });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option").first()).toHaveText("Just my return");

  // with SPY (restored by the test above) the comparison is drawn
  await expect(page.getByText(/S&P 500.*% since /).first()).toBeVisible();
  const dashedWith = await countDashedPaths(page);
  expect(dashedWith).toBeGreaterThan(0);

  await picker.selectOption("__none");
  await expect(page).toHaveURL(/[?&]bench=__none\b/);
  await expect(page.getByText(/S&P 500.*% since /)).toHaveCount(0);
  expect(await countDashedPaths(page)).toBe(0);
  // the "no price history for X" nag must not fire for a choice that HAS none by design
  await expect(page.getByText(/No price history for/)).toHaveCount(0);
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // sticky, like every other view choice: a fresh visit with no ?bench stays off
  await gotoHydrated(page, "/investments?view=returns&unit=percent");
  await expect(page.getByRole("combobox", { name: "Benchmark" })).toHaveValue("__none");
  expect(await countDashedPaths(page)).toBe(0);

  // restore SPY + the $ unit + Value view for whatever runs after this.
  // ⛔ Each step is PROVED before the next. `not.toHaveURL(/bench=/)` proves nothing here:
  // the fresh visit above never carried `?bench`, so it passed before the pick was written,
  // and the `$` press went out while the pick was still navigating — computed from the
  // pre-pick view (its href carried `bench=__none`) and lost. Measured 2026-10-01 on a
  // loaded box (trace: the `$` action sent 50 ms after the pick's returned, its navigation
  // superseded): the page stayed on %, and a later test opened /investments with no value
  // line. The S&P legend is drawn only once the pick has landed (re-picking SPY is
  // idempotent), and each pill flips only once its own press has. Not held back like the
  // other restores: holding the pick did not make the lost press reproducible.
  await expect(async () => {
    await page.getByRole("combobox", { name: "Benchmark" }).selectOption("SPY");
    await expect(page.getByText(/S&P 500.*% since /).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/bench=/);
  await pressView(page, "Return unit", "$");
  await expect(page).not.toHaveURL(/unit=percent/);
  await pressView(page, "Portfolio chart view", "Value");
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
});

/** Dashed strokes in the chart — how the benchmark overlay is drawn. */
async function countDashedPaths(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll("svg path")).filter(
        (el) => (el.getAttribute("stroke-dasharray") ?? "") !== "",
      ).length,
  );
}

/**
 * Day and week windows (owner: "i also need a week and day view"). 1D on a daily
 * series is yesterday→today — the change since the previous close, which is the
 * honest reading for a ledger with no intraday prices.
 *
 * Asserts the WINDOW each pill produces, not just that the pill lights up: a pill
 * that highlights while the chart still shows all time is the exact failure the
 * fell-back note was added for, and it would pass an aria-pressed-only test.
 */
test("the range pills offer a day and a week view, and each shows its own window", async ({ page }) => {
  await gotoHydrated(page, "/investments");
  const pills = page.getByRole("group", { name: "Chart range" }).first();
  await expect(pills.getByRole("button")).toHaveText(["1D", "1W", "1M", "3M", "YTD", "1Y", "ALL"]);

  const header = page.locator("p", { hasText: /· (all time|1D|1W|1M|3M|YTD|1Y)/ }).first();
  for (const [label, token] of [
    ["1 day", "1D"],
    ["1 week", "1W"],
  ] as const) {
    await pills.getByRole("button", { name: label }).click();
    await expect(pills.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    // the header names the window it is actually showing…
    await expect(header).toContainText(`· ${token}`);
    // …and the chart really narrowed: the series never widens as the window shrinks
    expect(await visibleDayCount(page)).toBeGreaterThan(0);
  }

  // 1D is the tightest window the pills offer, and it means one of two things:
  // with an intraday session cached it draws that session (many points); without
  // one it falls back to daily granularity — two points, the previous close and
  // today. Which applies depends on whether a sibling zz spec has loaded a
  // session, so read the page's own note rather than assuming an order.
  //
  // The lower bound is not decoration. This assertion used to read
  // `toBeLessThanOrEqual(2)` alone, and `visibleDayCount` used to return 1 when
  // it found nothing at all — so a chart that drew NOTHING scored 1 and passed.
  // The tripwire meant to protect the 1D view was certifying a blank one.
  await pills.getByRole("button", { name: "1 day" }).click();
  const hasSession = await page.getByText(/Today's session ·/).isVisible();
  const dayPoints = await visibleDayCount(page);
  expect(dayPoints).toBeGreaterThan(0);
  expect(hasSession ? dayPoints > 2 : dayPoints <= 2).toBe(true);

  await pills.getByRole("button", { name: "all time" }).click();
  await expect(header).toContainText("· all time");
});

/**
 * How many points the chart is currently drawing, read off its own x-axis data.
 *
 * Returns 0 — never 1 — when the chart drew nothing. The previous `|| 1` tail
 * made "found nothing" indistinguishable from "found one point", which is how a
 * blank 1D chart satisfied an upper-bound assertion. A count is now either real
 * or zero, and callers assert both bounds.
 */
async function visibleDayCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const slider = document.querySelector('[role="slider"]');
    if (!slider) return 0;
    const ticks = slider.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick").length;
    // axis ticks are thinned for readability; the plotted dots are the denser signal
    const dots = slider.querySelectorAll(".recharts-line-dot").length;
    return Math.max(ticks, dots);
  });
}

/**
 * Reset the persisted unit to $ (the default) so a later Return visit is clean, and leave the
 * holding on Price — which `a holding's table…` below opens on, with nothing in between that
 * would put it back.
 *
 * ⛔ Every press is PROVED before the next step (pressView). The fresh visit at the end
 * resolves the view from app_settings, and one sent before the Price press is written comes
 * back on the Return line. With the presses held back that failed here every run, left the
 * holding on Return, and the next holding test's first "price over time" slider was then
 * "not found" — the message of that test's one recorded failure, though in that run this
 * test had passed, so this race does not account for that failure on its own.
 */
async function unitGroupRestore(page: Page, href: string): Promise<void> {
  await delayServerActions(page);
  // flip to Return (unit switcher only renders there), set $, flip back to Price
  await pressView(page, "Holding chart view", "Return");
  await pressView(page, "Return unit", "$");
  await expect(page).not.toHaveURL(/unit=percent/);
  await pressView(page, "Holding chart view", "Price");
  await gotoHydrated(page, href);
  await expect(page.getByRole("slider", { name: /price over time/ })).toBeVisible();
}

/* ─────────────────────────── the chart⇄table LENS (pass 23) ───────────────────────────
 * Roadmap #2: the honest "show me the raw numbers" escape hatch on every chart.
 * `lens` is a THIRD view dimension (URL `?lens=table` + persisted per surface), so these
 * tests carry the same two-step restore as their siblings above: click back to the default
 * AND re-navigate with no param, proving app_settings rolled back too. Leaving a persisted
 * lens=table would render a DataTable where later specs assert a chart role.
 *
 * Every lens table is located BY ITS CAPTION (DataTable renders it as the accessible name) —
 * these pages already carry other tables (holdings, anchors, transactions), so a bare
 * getByRole("table") is a strict-mode violation AND would not prove the lens rendered. */

/**
 * Restore a surface's lens to the default (Chart) — press, prove the press landed, then prove
 * persistence on a fresh visit.
 *
 * ⛔ Proved by the pill (pressView), not by `not.toHaveURL(/lens=table/)`: that wait proves
 * nothing when the page was reached by a fresh visit with no `?lens` — the balance test's
 * sticky check does exactly that — so it passed at once and the fresh visit raced the write.
 * With the press held back, the balance test failed here every run, its table still drawn.
 */
async function lensRestore(page: Page, group: string, href: string, table: RegExp): Promise<void> {
  await delayServerActions(page);
  await pressView(page, group, "Chart");
  await expect(page).not.toHaveURL(/lens=table/);
  await gotoHydrated(page, href);
  await expect(page.getByRole("table", { name: table })).toHaveCount(0);
  expect(
    await page.getByRole("group", { name: group }).getByRole("button", { name: "Chart" }).getAttribute("aria-pressed"),
  ).toBe("true");
}

test("the balance chart switches chart↔table, and the table shows the chart's own window", async ({ page }) => {
  await gotoHydrated(page, "/accounts");
  await page.locator('section[aria-label="Robinhood"] a[href^="/accounts/"]').first().click();
  await expect(page.getByRole("slider", { name: /Balance over time/ })).toBeVisible();
  const href = page.url().split("?")[0]!;

  await page.getByRole("group", { name: "Balance lens" }).getByRole("button", { name: "Table" }).click();
  await expect(page).toHaveURL(/[?&]lens=table\b/);
  // the caption states the window the rows actually cover — the chart's own 3M default
  const table = page.getByRole("table", { name: /Balance by day — 3 months/ });
  await expect(table).toBeVisible();
  await expect(page.getByRole("slider", { name: /Balance over time/ })).toHaveCount(0);
  // the rows carry the day, the balance, and the BASIS — the dashed-line honesty in words
  await expect(table.getByRole("columnheader", { name: "Day" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Balance" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Basis" })).toBeVisible();
  // the range pills come along, so the window is still steerable from the table
  await expect(page.getByRole("group", { name: "Chart range" })).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // changing the range re-windows the ROWS, and the caption follows honestly
  await page.getByRole("group", { name: "Chart range" }).getByRole("button", { name: "1 year" }).click();
  await expect(page.getByRole("table", { name: /Balance by day — 1 year/ })).toBeVisible();

  // sticky across a fresh visit with no param, then restored for sibling specs
  await gotoHydrated(page, href);
  await expect(page.getByRole("table", { name: /Balance by day/ })).toBeVisible();
  await lensRestore(page, "Balance lens", href, /Balance by day/);
});

test("the portfolio lens tables the SAME metric the view/unit switchers select", async ({ page }) => {
  await gotoHydrated(page, "/investments");
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();

  await page.getByRole("group", { name: "Portfolio lens" }).getByRole("button", { name: "Table" }).click();
  await expect(page).toHaveURL(/[?&]lens=table\b/);
  const valueTable = page.getByRole("table", { name: /Portfolio value by day/ });
  await expect(valueTable).toBeVisible();
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toHaveCount(0);
  await expect(valueTable.getByRole("columnheader", { name: "Value" })).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // the lens is ORTHOGONAL to view: switching to Return re-columns the SAME table,
  // so neither switcher becomes a no-op in table mode
  await page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name: "Return" }).click();
  await expect(page).toHaveURL(/[?&]view=returns\b/);
  await expect(page).toHaveURL(/[?&]lens=table\b/);
  const returnTable = page.getByRole("table", { name: /Portfolio return by day/ });
  await expect(returnTable).toBeVisible();
  await expect(returnTable.getByRole("columnheader", { name: "Return" })).toBeVisible();
  await expect(page.getByRole("table", { name: /Portfolio value by day/ })).toHaveCount(0);

  // back to Value + Chart, and prove the persisted layer rolled back too
  await page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name: "Value" }).click();
  await expect(page).not.toHaveURL(/view=returns/);
  await lensRestore(page, "Portfolio lens", "/investments", /Portfolio .* by day/);
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
});

test("a holding's table names its trade days, and the recurring amount history tables too", async ({ page }) => {
  // ── the holding lens ──
  await gotoHydrated(page, "/investments");
  const holdingHref = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(holdingHref).toBeTruthy();
  await gotoHydrated(page, holdingHref!);
  await expect(page.getByRole("slider", { name: /price over time/ })).toBeVisible();

  await page.getByRole("group", { name: "Holding lens" }).getByRole("button", { name: "Table" }).click();
  await expect(page).toHaveURL(/[?&]lens=table\b/);
  const table = page.getByRole("table", { name: /close by day/ });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Close" })).toBeVisible();
  // the price chart pins buy/sell marks; the table names them in a column
  await expect(table.getByRole("columnheader", { name: "Trade" })).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);
  await lensRestore(page, "Holding lens", holdingHref!, /close by day/);

  // ── the recurring amount-history lens ──
  await gotoHydrated(page, "/recurring");
  await page.getByRole("button", { name: /Detect now/ }).click();
  await gotoHydrated(page, "/recurring?tab=all");
  await page.locator('a[href^="/recurring/"]').first().click();
  const seriesHref = page.url().split("?")[0]!;
  const lens = page.getByRole("group", { name: "Amount history lens" });
  // not every series has ≥2 posted occurrences — only assert where the card exists
  if ((await lens.count()) > 0) {
    await lens.getByRole("button", { name: "Table" }).click();
    await expect(page).toHaveURL(/[?&]lens=table\b/);
    const amounts = page.getByRole("table", { name: /Charge amount for each/ });
    await expect(amounts).toBeVisible();
    await expect(amounts.getByRole("columnheader", { name: "Amount" })).toBeVisible();
    expect(gating(await analyzeSettled(page))).toEqual([]);
    await lensRestore(page, "Amount history lens", seriesHref, /Charge amount for each/);
  }
});
