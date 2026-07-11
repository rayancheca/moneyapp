import { expect, test } from "@playwright/test";

/**
 * Categorizing from Spending (ux-overhaul-plan §5.4): the "Where it went"
 * breakdown expands into its exact transactions, each with the same inline
 * category picker as the ledger — routing through the shared value-returning
 * correction flow (proven end-to-end by zz-inline-chip). This spec proves the
 * Spending wiring: the row expands, its transactions lazy-load, and the inline
 * picker opens. Read-only (no commit), so the shared seed is untouched.
 */

test("expand a spending category to reveal and open inline category pickers", async ({ page }) => {
  await page.goto("/spending");
  await expect(page.getByRole("heading", { name: "Where it went" })).toBeVisible();

  // every breakdown row (and the Uncategorized bucket) carries an expand toggle
  const expand = page.getByRole("button", { name: /^Expand / }).first();
  await expect(expand).toBeVisible();
  await expand.click();

  // its transactions lazy-load, each with an inline category picker
  const inlinePicker = page.getByRole("button", { name: /^Category:/ }).first();
  await expect(inlinePicker).toBeVisible();
  await inlinePicker.click();

  // the shared searchable category picker opens — the same control as the ledger
  await expect(page.getByRole("listbox", { name: "Categories" })).toBeVisible();
});
