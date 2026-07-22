import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";

/**
 * The cash-flow view switcher (NS#2 Pillar 2): the SAME data as a vivid chart or a
 * raw-number table, chosen in the URL (shareable, Back works) and persisted per
 * surface. This spec mutates app_settings (viewPreferences) so it lives in the zz
 * tier and RESTORES the default (Chart) at the end for sibling specs.
 */

const GATING = new Set(["critical", "serious"]);
function gating(results: { violations: { impact?: string | null }[] }) {
  return results.violations.filter((v) => GATING.has(v.impact ?? ""));
}

async function pillPressed(page: Page, name: "Chart" | "Graph" | "Table"): Promise<boolean> {
  const btn = page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name });
  return (await btn.getAttribute("aria-pressed")) === "true";
}

test("cash-flow view switches chart↔table, updates the URL, and persists", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
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
  await expect(page.getByText("Earned, running total")).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // the choice is sticky: a fresh visit with NO cash param keeps the graph
  await page.goto("/spending");
  await expect(page.getByRole("figure", { name: /Running totals for the period/ })).toBeVisible();
  expect(await pillPressed(page, "Graph")).toBe(true);

  // restore the default so sibling specs see the chart
  await page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name: "Chart" }).click();
  await expect(page.getByRole("figure", { name: /Income above the axis/ })).toBeVisible();
  await page.goto("/spending");
  await expect(page.getByRole("figure", { name: /Income above the axis/ })).toBeVisible();
});

async function invPillPressed(page: Page, name: "Value" | "Return"): Promise<boolean> {
  const btn = page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name });
  return (await btn.getAttribute("aria-pressed")) === "true";
}

test("portfolio chart switches value↔return, updates the URL, and persists", async ({ page }) => {
  await page.goto("/investments");
  const valueChart = page.getByRole("slider", { name: /Portfolio value over time/ });
  const returnChart = page.getByRole("slider", { name: /Portfolio return over time/ });

  // default view is the value line
  await expect(valueChart).toBeVisible();
  expect(await invPillPressed(page, "Value")).toBe(true);

  // switch to return: the URL carries it, the slider relabels to the return line
  await page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name: "Return" }).click();
  await expect(page).toHaveURL(/[?&]view=returns\b/);
  await expect(returnChart).toBeVisible();
  expect(await invPillPressed(page, "Return")).toBe(true);
  await expect(valueChart).toHaveCount(0);

  // the return view is accessible (scan the new state)
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // sticky: a fresh visit with NO view param still shows the return line
  await page.goto("/investments");
  await expect(page.getByRole("slider", { name: /Portfolio return over time/ })).toBeVisible();
  expect(await invPillPressed(page, "Return")).toBe(true);

  // restore the default so sibling specs see the value chart
  await page.getByRole("group", { name: "Portfolio chart view" }).getByRole("button", { name: "Value" }).click();
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
  await page.goto("/investments");
  await expect(page.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
});

async function holdingPillPressed(page: Page, name: "Price" | "Return"): Promise<boolean> {
  const btn = page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name });
  return (await btn.getAttribute("aria-pressed")) === "true";
}

test("a holding chart switches price↔return, updates the URL, and persists", async ({ page }) => {
  // resolve the first holding-detail URL from /investments (stable fixture order)
  await page.goto("/investments");
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);

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
  await page.goto(href!);
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
  await page.goto("/investments?view=returns");
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
  await page.goto("/investments?view=returns");
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

/** Reset the persisted unit to $ (the default) so a later Return visit is clean. */
async function unitGroupRestore(page: Page, href: string): Promise<void> {
  // flip to Return (unit switcher only renders there), set $, flip back to Price
  await page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name: "Return" }).click();
  await page.getByRole("group", { name: "Return unit" }).getByRole("button", { name: "$" }).click();
  await expect(page).not.toHaveURL(/unit=percent/);
  await page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name: "Price" }).click();
  await page.goto(href);
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

/** Restore a surface's lens to the default (Chart) — click, then prove persistence. */
async function lensRestore(page: Page, group: string, href: string, table: RegExp): Promise<void> {
  await page.getByRole("group", { name: group }).getByRole("button", { name: "Chart" }).click();
  await expect(page).not.toHaveURL(/lens=table/);
  await page.goto(href);
  await expect(page.getByRole("table", { name: table })).toHaveCount(0);
  expect(
    await page.getByRole("group", { name: group }).getByRole("button", { name: "Chart" }).getAttribute("aria-pressed"),
  ).toBe("true");
}

test("the balance chart switches chart↔table, and the table shows the chart's own window", async ({ page }) => {
  await page.goto("/accounts");
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
  await page.goto(href);
  await expect(page.getByRole("table", { name: /Balance by day/ })).toBeVisible();
  await lensRestore(page, "Balance lens", href, /Balance by day/);
});

test("the portfolio lens tables the SAME metric the view/unit switchers select", async ({ page }) => {
  await page.goto("/investments");
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
  await page.goto("/investments");
  const holdingHref = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(holdingHref).toBeTruthy();
  await page.goto(holdingHref!);
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
  await page.goto("/recurring");
  await page.getByRole("button", { name: /Detect now/ }).click();
  await page.goto("/recurring?tab=all");
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
