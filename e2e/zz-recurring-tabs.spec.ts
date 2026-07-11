import { expect, test } from "@playwright/test";

/**
 * Recurring sub-views (ux-overhaul-plan §4.1): after detection runs, the tab
 * strip appears and the "All" view presents a suggestion queue (confirm / not
 * recurring) instead of a raw status table. Runs LAST (zz-) because "Detect
 * now" mutates the shared seed (creates series + tags rows); the read-only
 * visual baseline captured the pre-detection empty state earlier.
 */

test("detection reveals the sub-view tabs and the All suggestion queue", async ({ page }) => {
  await page.goto("/recurring");

  // the seeded corpus has recurring patterns but no series until detection runs
  await page.getByRole("button", { name: "Detect now" }).click();

  // the sub-view tabs now render; Upcoming is the default
  await expect(page.getByRole("navigation", { name: "Recurring views" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Upcoming/ })).toHaveAttribute("aria-current", "page");

  // switch to All → a suggestion queue of detected series, each confirmable
  await page.getByRole("link", { name: /^All/ }).click();
  await expect(page.getByRole("heading", { name: "Suggestions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" }).first()).toBeVisible();

  // confirming a suggestion moves it out of the queue (value-preserving action)
  const before = await page.getByRole("button", { name: "Confirm" }).count();
  await page.getByRole("button", { name: "Confirm" }).first().click();
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(before - 1);
});
