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
