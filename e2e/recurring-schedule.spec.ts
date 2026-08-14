import { expect, test } from "@playwright/test";

/**
 * The projected schedule on /recurring, asserted as TEXT.
 *
 * The route already has eight visual baselines, and every one of them passed
 * unchanged while calendar-month stepping moved a rendered date by a day:
 * `maxDiffPixelRatio: 0.001` cannot see one glyph. So the dates on this page
 * were, in practice, asserted by nothing — which is the whole failure mode
 * this project keeps rediscovering, a screen saying something no test reads.
 *
 * Read-only (navigate + read), and named without a `zz-` prefix so it runs on
 * the pristine seed before any spec mutates it. Detection has NOT run here, so
 * the list is exactly the five series seed-helpers.ts inserts, projected from
 * E2E_FAKE_TODAY = 2026-07-08 over a 30-day window.
 */
test("the upcoming list places every monthly series on its own day of month", async ({ page }) => {
  await page.goto("/recurring");

  const card = page.locator("section", {
    has: page.getByRole("heading", { name: "Upcoming 30 days" }),
  });
  await expect(card).toHaveCount(1);

  const rows = await card.locator("li").allInnerTexts();
  const schedule = rows.map((t) => t.replace(/\s+/g, " ").trim());

  /*
   * Anchors from seedRecurring / seedBudgets, each stepped by ONE calendar
   * month where a second occurrence lands inside the window:
   *   Rent 07-09 · Paycheck 07-10 (biweekly, so 07-24 and 08-07 too)
   *   Netflix 07-16 · Gym 07-20 · Meal Kit 07-05 → 08-05
   *
   * Meal Kit is the row that moves: a 30-day hop puts it on Aug 4, which is a
   * day the bill has never once been charged on.
   */
  const dates = schedule.map((row) => /^([A-Z][a-z]{2} \d{1,2})/.exec(row)?.[1] ?? row);
  expect(dates).toEqual(["Jul 9", "Jul 10", "Jul 16", "Jul 20", "Jul 24", "Aug 5", "Aug 7"]);

  // and the one that moved, named — so a future edit that puts the right count
  // of rows on the wrong days cannot pass this
  const mealKit = schedule.find((row) => row.includes("Meal Kit"));
  expect(mealKit).toBeDefined();
  expect(mealKit!.startsWith("Aug 5")).toBe(true);
});
