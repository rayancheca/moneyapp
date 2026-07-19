import { expect, test } from "@playwright/test";

/**
 * Spending drill-down contract (ux-overhaul-plan §1.1 / §5): the period lives in
 * the URL, and every surface navigates to a pre-filtered ledger — a stat card to
 * its kind-scoped list, a heatmap day to that day, a category to its page.
 * Read-only navigation; the shared seed is untouched.
 */

test("period selector is URL state and pages", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  const granularity = page.getByRole("navigation", { name: "Period granularity" });
  await expect(granularity).toBeVisible();

  // switch granularity → year, via a real link
  await granularity.getByText("Year").click();
  await expect(page).toHaveURL(/period=2026(?!-)/);

  // page back a year
  await page.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/period=2025/);
});

test("next-month category forecasts show on the current month, not on year granularity", async ({ page }) => {
  // the current month (FAKE_TODAY 2026-07-08) → forecasts target August 2026
  await page.goto("/spending?period=2026-07");
  await expect(page.getByText(/August 2026 ≈ \$/).first()).toBeVisible();

  // switch to year granularity → the engine only forecasts the next month, so
  // it is gated out here (would be a mismatched future number otherwise)
  await page.getByRole("navigation", { name: "Period granularity" }).getByText("Year").click();
  await expect(page).toHaveURL(/period=2026(?!-)/);
  await expect(page.getByText(/≈ \$/)).toHaveCount(0);
});

test("the Spent stat card drills to the kind-scoped spending ledger", async ({ page }) => {
  await page.goto("/spending?period=2026");
  await page.getByRole("link", { name: /Spent this period/ }).click();
  await expect(page).toHaveURL(/category=spending/);
  await expect(page).toHaveURL(/from=2026-01-01/);
  await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();
});

test("a heatmap day drills to that day's transactions", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // the heatmap opens on July 2026 (the in-progress month under the frozen clock)
  const day = page.getByRole("button", { name: /^Jul 3\b/ });
  await expect(day).toBeVisible();
  await day.click();
  await expect(page).toHaveURL("/transactions?from=2026-07-03&to=2026-07-03");
});

test("a category opens its page", async ({ page }) => {
  await page.goto("/spending?period=2026");
  await page.locator('a[href^="/categories/"]').first().click();
  await expect(page).toHaveURL(/\/categories\//);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
});

test("the day heatmap follows the selected period (regression: prop-desync)", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // heatmap opens on the in-progress month (frozen clock 2026-07-08)
  await expect(page.getByRole("grid", { name: "July 2026" })).toBeVisible();
  // paging the PERIOD back a month must move the heatmap with it
  await page.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/period=2026-06/);
  await expect(page.getByRole("grid", { name: "June 2026" })).toBeVisible();
});
