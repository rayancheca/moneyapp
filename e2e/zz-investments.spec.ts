import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";

/**
 * Investments interaction contract (ux-overhaul-plan §6.5). READ-ONLY — it only
 * navigates and drives client state (range pills, keyboard scrub, the P/L day
 * sheet), never mutating the seed, so it is order-independent; named `zz-` to
 * sort after the visual/a11y baselines. The seeded portfolio is fixture-forced
 * so the ALL range is a gain and the 1M range is a loss (seed-helpers
 * seedInvestments), which makes the accent-switch assertion deterministic.
 */

async function gotoInvestments(page: Page): Promise<void> {
  await page.goto("/investments");
  await expect(page.getByRole("heading", { level: 1, name: "Investments" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeVisible();
}

test("range pills switch the accent: ALL is a gain, 1M is a loss", async ({ page }) => {
  await gotoInvestments(page);
  const slider = page.getByRole("slider", { name: /Portfolio value over time/ });
  // default range is ALL → an upward (gain) accent
  await expect(slider).toHaveAttribute("aria-valuetext", /up \d/);

  await page.getByRole("button", { name: "1 month" }).click();
  await expect(page.getByRole("button", { name: "1 month" })).toHaveAttribute("aria-pressed", "true");
  // the 1M window dips (fixture ETH loss) → a downward accent
  await expect(slider).toHaveAttribute("aria-valuetext", /down \d/);
});

test("keyboard scrub moves the hairline and announces the point", async ({ page }) => {
  await gotoInvestments(page);
  const slider = page.getByRole("slider", { name: /Portfolio value over time/ });
  await slider.focus();
  const before = await slider.getAttribute("aria-valuenow");
  const beforeText = await slider.getAttribute("aria-valuetext");

  for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowLeft");

  const after = await slider.getAttribute("aria-valuenow");
  const afterText = await slider.getAttribute("aria-valuetext");
  expect(Number(after)).toBe(Number(before) - 5); // hairline stepped back five days
  expect(afterText).not.toBe(beforeText); // a different day → a different announcement
  expect(afterText).toMatch(/\$[\d,]+/); // still a money value text
});

test("a holding page renders trade marks on the price chart", async ({ page }) => {
  await gotoInvestments(page);
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trade history" })).toBeVisible();
  await expect(page.getByText("Buy").first()).toBeVisible();
  // ReferenceDot trade marks render as <circle> inside the chart svg
  await expect(page.locator("svg circle").first()).toBeVisible();
});

test("the P/L calendar opens a day sheet with per-holding detail", async ({ page }) => {
  await gotoInvestments(page);
  // day cells with movement carry "portfolio up/down …" in their aria-label
  const dayCell = page.getByRole("button", { name: /portfolio (up|down)/ }).first();
  await expect(dayCell).toBeVisible();
  await dayCell.click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Portfolio P/L")).toBeVisible();

  // the open sheet must be axe-clean too (critical/serious only)
  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);
});
