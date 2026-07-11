import { expect, test } from "@playwright/test";

/**
 * Categorizing from the category page (ux-overhaul-plan §5.4): the Spending
 * categories table links each category to its page, whose transaction list
 * carries the same inline category picker as the ledger — routing through the
 * shared value-returning correction flow (proven end-to-end by zz-inline-chip).
 * This spec proves the wiring: a category link opens its page, its transactions
 * render, and the inline picker opens. Read-only (no commit), shared seed
 * untouched.
 */

test("open a category page from Spending and reveal its inline category picker", async ({ page }) => {
  await page.goto("/spending?period=2026");
  await expect(page.getByRole("heading", { level: 1, name: "Spending" })).toBeVisible();

  const categoryLink = page.locator('a[href^="/categories/"]').first();
  const href = await categoryLink.getAttribute("href");
  expect(href).toBeTruthy();

  // land on the category page with a full-year window so its list is populated
  await page.goto(`${href}?period=2026`);
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();

  const inlinePicker = page.getByRole("button", { name: /^Category:/ }).first();
  await expect(inlinePicker).toBeVisible();
  await inlinePicker.click();

  // the shared searchable category picker opens — the same control as the ledger
  await expect(page.getByRole("listbox", { name: "Categories" })).toBeVisible();
});
