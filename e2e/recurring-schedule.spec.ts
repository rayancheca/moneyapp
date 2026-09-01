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
 * the list is exactly the series seed-helpers.ts inserts, projected from
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
   *   Car Lease 07-22 · Car Insurance 07-26  (§9 — the car card had no fixture)
   *
   * Meal Kit is the row that moves: a 30-day hop puts it on Aug 4, which is a
   * day the bill has never once been charged on.
   *
   * ⛔ **`Aug 7` used to be in this list and it should never have been.** This
   * test asserted a 31-day window under a heading that says 30 days: from
   * E2E_FAKE_TODAY = 2026-07-08, day one is the 8th and day thirty is **Aug 6**,
   * so the third biweekly paycheck on Aug 7 is day THIRTY-ONE. It appeared only
   * because `upcomingOccurrences` ended its window at `today + windowDays`
   * rather than `today + windowDays - 1`.
   *
   * The same extra day showed on the real ledger as `Flamingo South Beach
   * (rent)` listed TWICE under "Upcoming 30 days" — 2026-09-01 and 2026-10-01 —
   * which is what sent me looking. This expectation is a test that had encoded
   * the defect, so it is the expectation that changed, and the row it lost is
   * named here so nobody quietly adds it back.
   *
   * ⚠️ Car Insurance sits on the 26th and not the 24th deliberately: on the 24th
   * it shared a day with a payday, and this test's own premise — one monthly
   * series per day of month — would have been broken by the fixture rather than
   * by the app.
   */
  const dates = schedule.map((row) => /^([A-Z][a-z]{2} \d{1,2})/.exec(row)?.[1] ?? row);
  expect(dates).toEqual([
    "Jul 9",
    "Jul 10",
    "Jul 16",
    "Jul 20",
    "Jul 22",
    "Jul 24",
    "Jul 26",
    "Aug 5",
  ]);

  // and the one that moved, named — so a future edit that puts the right count
  // of rows on the wrong days cannot pass this
  const mealKit = schedule.find((row) => row.includes("Meal Kit"));
  expect(mealKit).toBeDefined();
  expect(mealKit!.startsWith("Aug 5")).toBe(true);
});
