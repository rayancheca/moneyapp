import { expect, test } from "@playwright/test";

/**
 * ⌘K entity index (ux-overhaul-plan §3.8): accounts, categories, and merchants
 * are searchable in the command palette and navigate to their surface. Read-only
 * (navigation only), so it runs before the mutating zz- specs.
 */

test("⌘K finds a merchant and navigates to its page", async ({ page }) => {
  await page.goto("/transactions");
  // hydrated — the KeyScope window listener + ⌘K are live once the toggle paints
  await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+KeyK");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();

  await palette.getByRole("combobox").fill("Netflix");
  const option = palette.getByRole("option", { name: /Netflix/ }).first();
  await expect(option).toBeVisible();
  await option.click();

  await expect(page).toHaveURL(/\/merchants\/[A-Za-z0-9-]+/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
