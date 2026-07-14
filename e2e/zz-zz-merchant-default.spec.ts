import { expect, test } from "@playwright/test";

/**
 * S6: the merchant→category default rule edits inline on the merchant page.
 * Sets a default, then Undo restores the previous one so the shared seed's
 * merchant map is left exactly as found.
 */

test("set a merchant's default category from its page, then undo", async ({ page }) => {
  // reach a merchant page through a ledger row's sheet
  await page.goto("/transactions");
  const sheetTriggers = page.locator('[aria-haspopup="dialog"]');
  await expect(sheetTriggers.first()).toBeVisible();
  const count = Math.min(await sheetTriggers.count(), 8);
  let reached = false;
  for (let i = 0; i < count && !reached; i++) {
    await sheetTriggers.nth(i).click();
    const view = page.getByRole("button", { name: "View merchant →" });
    try {
      await view.waitFor({ state: "visible", timeout: 2000 });
      await view.click();
      await expect(page).toHaveURL(/\/merchants\/.+/);
      reached = true;
    } catch {
      await page.keyboard.press("Escape");
    }
  }
  expect(reached, "no seeded ledger row resolved to a merchant").toBe(true);

  // the default-category picker lives next to its label
  const section = page.locator("section", { hasText: "Default category" }).first();
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: /^Category:/ }).click();
  const picker = page.getByRole("listbox", { name: "Categories" });
  await expect(picker).toBeVisible();
  await picker.getByRole("option").nth(3).click();
  await expect(page.locator("body")).toContainText("Default set to");

  // Undo restores the previous default (seed unchanged)
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});
