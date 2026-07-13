import { expect, test, type Page } from "@playwright/test";

/**
 * The dashboard net-worth chart's rich controls (§7.1): visible axes, a
 * drag-to-zoom custom window with a Reset, and From/To date inputs. The drag and
 * the typed date only change local chart state (no data mutation), so sibling
 * specs see the shared seed unchanged.
 */

function plot(page: Page) {
  return page.getByRole("slider", { name: /Net worth over time/ });
}

test("renders visible axes controls: range pills + From/To inputs", async ({ page }) => {
  await page.goto("/");
  await expect(plot(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "Chart range" })).toBeVisible();
  await expect(page.getByLabel("From date", { exact: true })).toBeVisible();
  // exact: the "YTD" pill's accessible name is "year to date", a substring match
  await expect(page.getByLabel("To date", { exact: true })).toBeVisible();
});

test("dragging the plot zooms to a custom window, and Reset restores the range", async ({ page }) => {
  await page.goto("/");
  const box = await plot(page).boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  // drag across the middle of the plot to select a sub-range
  await page.mouse.move(box!.x + box!.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.7, y, { steps: 12 });
  await page.mouse.up();

  const reset = page.getByRole("button", { name: /Reset/ });
  await expect(reset).toBeVisible();
  // no pill reads as pressed while a custom window is in effect
  await expect(page.getByRole("button", { name: "all time" })).toHaveAttribute("aria-pressed", "false");

  await reset.click();
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
});

test("the From date input sets a custom window", async ({ page }) => {
  await page.goto("/");
  const from = page.getByLabel("From date", { exact: true });
  const start = await from.inputValue();
  const end = await page.getByLabel("To date", { exact: true }).inputValue();
  // a day squarely inside the current window
  const mid = new Date((Date.parse(start) + Date.parse(end)) / 2).toISOString().slice(0, 10);
  await from.fill(mid);

  await expect(page.getByRole("button", { name: /Reset/ })).toBeVisible();
});
