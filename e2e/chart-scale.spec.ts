import { test, expect } from "@playwright/test";

/**
 * Scale honesty, across the surfaces where it bites.
 *
 * MEASURED on the real ledger: the active accounts span **seven million to one**,
 * and at the dashboard chart's height FIVE OF TEN draw under a single device
 * pixel — Robinhood Cash at $113.88 is 0.34px against Robinhood Brokerage's
 * $70,291.75. A reader could not tell an empty account from one holding a hundred
 * dollars, and nothing on screen admitted it.
 *
 * ⚠️ Read-only, and deliberately NOT `zz`-prefixed: the `zz-*` specs mutate the
 * shared fixture and these assertions read balances off a pristine seed.
 */

test("the per-account chart names the lines it cannot show", async ({ page }) => {
  await page.goto("/?chart=accounts");

  /*
   * Lines cannot be tiered the way bars can — two scales in one frame is a dual
   * axis, which misleads worse than a flat line does. So the honest move is for
   * the chart to say which series it is failing to draw, and to point at the
   * per-account selector that already exists.
   */
  const note = page.getByText(/Too small to see beside the rest/);
  await expect(note).toBeVisible();
  await expect(note).toContainText("Discover it Card");
  await expect(note).toContainText("$86.89");
  await expect(note).toContainText("Pick it on its own above to read the line.");
});

test("the SPLIT frame has the same disease, and admits it", async ({ page }) => {
  /*
   * I wrote this as the negative case — "assets and what is owed are comparable,
   * so nothing should be disclosed" — and it was wrong. On the seeded ledger
   * assets are ~$134k against ~$1.1k owed, a ratio over a hundred, so the owed
   * line is pinned to the baseline and unreadable. The disclosure fires, and it
   * is right to.
   */
  await page.goto("/?chart=split");
  await expect(page.getByText(/Too small to see beside the rest/)).toBeVisible();
});

test("a frame with nothing to compare stays quiet — this is a disclosure, not furniture", async ({
  page,
}) => {
  // One series has no second series to be dwarfed by. The note must not appear
  // just because a chart exists.
  await page.goto("/?chart=assets");
  await expect(page.getByText(/Too small to see beside the rest/)).toHaveCount(0);
});
