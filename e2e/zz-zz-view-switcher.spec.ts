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

async function pillPressed(page: Page, name: "Chart" | "Table"): Promise<boolean> {
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

  // the choice is sticky: a fresh visit with NO cash param still shows the table
  await page.goto("/spending");
  await expect(page.getByRole("table")).toBeVisible();
  expect(await pillPressed(page, "Table")).toBe(true);

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
