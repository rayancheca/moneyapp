import { expect, test } from "@playwright/test";

/**
 * S7 "movable": dashboard sections reorder in Arrange mode (keyboard buttons —
 * the accessible equivalent of the drag) and the order persists via
 * app_settings. The test moves a section down, proves persistence across a
 * reload, then restores the canonical order so sibling specs see the default.
 */

test("arrange mode reorders dashboard sections and persists", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Arrange" }).click();

  // in arrange mode every section shows its label + move buttons
  const moveDown = page.getByRole("button", { name: "Move Net worth down" });
  await expect(moveDown).toBeVisible();
  await moveDown.click();

  // done arranging — the hero is now second; the activity grid renders first
  await page.getByRole("button", { name: "Done arranging" }).click();
  const headings = page.locator("h1, h2");
  await expect(headings.first()).not.toHaveText(/Net worth/);

  // persisted, not just optimistic
  await page.reload();
  await expect(page.locator("h1, h2").first()).not.toHaveText(/Net worth/);

  // restore the canonical order for sibling specs
  await page.getByRole("button", { name: "Arrange" }).click();
  await page.getByRole("button", { name: "Move Net worth up" }).click();
  await page.getByRole("button", { name: "Done arranging" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Net worth" })).toBeVisible();
});
