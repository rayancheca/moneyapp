import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";
import { delayServerActions, pressView } from "./view-helpers";

/**
 * The money-flow Sankey (pass 21): a switchable view on /spending and a "Flow"
 * mode on the dashboard hero. Income sources → a hub → spending categories, with
 * drill-through links to the ledger. This spec mutates app_settings
 * (viewPreferences) so it lives in the zz tier and RESTORES the defaults (Chart /
 * combined Net worth) at the end for sibling specs.
 *
 * ⛔ Each restoring press is PROVED before the fresh visit that checks it (pressView, the
 * rule networth-bridge.spec.ts and zz-zz-view-switcher.spec.ts use). Both defaults leave the
 * URL clean, so that visit resolves the view from app_settings — and a visit sent before the
 * press is written comes back on the Sankey. Every press is held back on its way to the
 * server (delayServerActions), so a restore that does not wait fails here, every run.
 */

const GATING = new Set(["critical", "serious"]);
function gating(results: { violations: { impact?: string | null }[] }) {
  return results.violations.filter((v) => GATING.has(v.impact ?? ""));
}

const drillLink = (page: Page) => page.getByRole("link", { name: /view transactions/ });

test("/spending Sankey: switches in, renders drillable flow, is accessible, restores", async ({ page }) => {
  await page.goto("/spending?period=2026-07");

  await page.getByRole("group", { name: "Cash flow view" }).getByRole("button", { name: "Sankey" }).click();
  await expect(page).toHaveURL(/[?&]cash=sankey\b/);

  // the flow renders with at least one drill-through node link to the ledger
  await expect(drillLink(page).first()).toBeVisible();
  const href = await drillLink(page).first().getAttribute("href");
  expect(href).toContain("/transactions?");

  // the new view is accessible (overlay-open doctrine: scan the switched state)
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // restore the default so sibling specs see the chart
  await delayServerActions(page);
  await pressView(page, "Cash flow view", "Chart");
  await page.goto("/spending");
  await expect(page.getByRole("figure", { name: /Income above the axis/ })).toBeVisible();
});

test("dashboard Flow mode: range pills + flow⇄table toggle, accessible, restores", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("group", { name: "Net worth chart view" }).getByRole("button", { name: "Flow" }).click();
  await expect(page).toHaveURL(/[?&]chart=sankey\b/);

  // the Sankey carries its own range pills (1Y pressed by default)
  const rangeGroup = page.getByRole("group", { name: "Flow range" });
  await expect(rangeGroup.getByRole("button", { name: "1 year" })).toHaveAttribute("aria-pressed", "true");
  await expect(drillLink(page).first()).toBeVisible();

  // the internal flow⇄table toggle surfaces the same numbers as rows
  await page.getByRole("group", { name: "Sankey view" }).getByRole("button", { name: "Table" }).click();
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Flow" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Amount" })).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // switching the range pill re-renders the flow (back on the diagram)
  await page.getByRole("group", { name: "Sankey view" }).getByRole("button", { name: "Flow" }).click();
  await rangeGroup.getByRole("button", { name: "3 months" }).click();
  await expect(drillLink(page).first()).toBeVisible();

  // restore the combined default so sibling specs see the net-worth line
  await delayServerActions(page);
  await pressView(page, "Net worth chart view", "Net worth");
  await page.goto("/");
  await expect(page.getByRole("slider", { name: /Net worth over time/ })).toBeVisible();
});
