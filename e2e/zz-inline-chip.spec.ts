import { expect, test } from "@playwright/test";

/**
 * Inline chip picker (ux-overhaul-plan §3.2): the ledger row's category chip is
 * itself the control — clicking it opens the picker and recategorizes WITHOUT
 * opening the sheet. Runs LAST (zz-) because it recategorizes a real row.
 */

test("recategorize inline from the ledger row chip — no sheet", async ({ page }) => {
  await page.goto("/transactions");

  // the chip is a picker trigger ("Category: {name}. Change"), not the row's
  // sheet button (aria-haspopup="dialog")
  const chip = page.getByRole("button", { name: /^Category: .* Change$/ }).first();
  await expect(chip).toBeVisible();
  await chip.click();

  const picker = page.getByRole("listbox", { name: "Categories" });
  await expect(picker).toBeVisible();
  // the sheet did NOT open — the chip is a separate, inline control
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await picker.getByRole("option").nth(2).click();
  await expect(page.locator("p", { hasText: /Categorized as/ })).toBeVisible();
  // still no sheet after the correction
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
