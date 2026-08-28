import { expect, test, type Page } from "@playwright/test";
import { visibleBox } from "./box-helpers";
import { analyzeSettled } from "./axe-helpers";

/**
 * The linked period-activity panel (dashboard-dynamic §2, §4): brushing the
 * net-worth chart cross-filters an "activity in this window" panel below, and
 * "← Back" steps through the timeframe history. Drag + back/forward only change
 * client + windowed-read state (no data mutation), so sibling specs are unaffected.
 */

function plot(page: Page) {
  return page.getByRole("slider", { name: /Net worth over time/ });
}

/** Drag a horizontal range across the plot at [x0..x1] fractions of its width. */
async function brush(page: Page, x0: number, x1: number): Promise<void> {
  const box = await visibleBox(plot(page), "the net-worth plot");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * x0, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, y, { steps: 14 });
  await page.mouse.up();
}

function windowHeading(page: Page) {
  return page.getByRole("heading", { name: /In this window/ });
}

test("the panel starts as an invitation, not a dead gap", async ({ page }) => {
  await page.goto("/");
  await expect(plot(page)).toBeVisible();
  await expect(page.getByText(/Drag across the chart to break down any window/)).toBeVisible();
  await expect(windowHeading(page)).toHaveCount(0);
});

test("brushing the chart cross-filters the activity panel", async ({ page }) => {
  await page.goto("/");
  await brush(page, 0.3, 0.7);

  // the linked panel appears with the window's cash-flow summary + list
  const panel = page.getByRole("region", { name: /Activity from/ });
  await expect(panel.getByRole("heading", { name: /In this window/ })).toBeVisible();
  await expect(panel.getByText(/spent$/)).toBeVisible();
  await expect(panel.getByText("Income", { exact: true })).toBeVisible();
  await expect(panel.getByText("Transactions", { exact: true })).toBeVisible();
  // the chart shows a custom window (no pill pressed) + a Reset
  await expect(page.getByRole("button", { name: /Reset/ })).toBeVisible();

  // let the windowed fetch + entrance animation settle before scanning
  await page.waitForLoadState("networkidle");
  await expect(panel.getByText(/spent$/)).toBeVisible();
  // and it passes axe in this new state (nothing critical/serious)
  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);
});

test("← Back restores the previous timeframe", async ({ page }) => {
  await page.goto("/");
  // the From input reflects the active window deterministically (YYYY-MM-DD)
  const fromInput = page.getByLabel("From date", { exact: true });

  await brush(page, 0.3, 0.65);
  await expect(windowHeading(page)).toBeVisible();
  const firstFrom = await fromInput.inputValue();

  await brush(page, 0.1, 0.4);
  await expect(windowHeading(page)).toBeVisible();
  const secondFrom = await fromInput.inputValue();
  expect(secondFrom).not.toBe(firstFrom);

  // step back to the first window
  await page.getByRole("button", { name: "Previous timeframe" }).click();
  await expect(fromInput).toHaveValue(firstFrom);
});

test("Reset clears the window back to the invitation", async ({ page }) => {
  await page.goto("/");
  await brush(page, 0.3, 0.7);
  await expect(windowHeading(page)).toBeVisible();

  await page.getByRole("button", { name: /Reset/ }).click();
  await expect(windowHeading(page)).toHaveCount(0);
  await expect(page.getByText(/Drag across the chart to break down any window/)).toBeVisible();
});
