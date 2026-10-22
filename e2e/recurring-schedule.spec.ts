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
   *   Rent 07-09 · Paycheck 07-17 (biweekly, so 07-31 too; 08-14 is past the window)
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
   * ⚠️ Aug 7 was a payday of the old Jul 10 anchor, a week off Paycheck's own
   * deposits. On the deposits' Fridays (Jul 17) the third payday is Aug 14 and
   * no row stands on this window's far edge — so the edge is pinned on the
   * dashboard's 14-day strip below, the same `upcomingOccurrences`, where Car
   * Lease's Jul 22 is day FIFTEEN (and recurring.test.ts, "the last day of an
   * N-day window is day N-1").
   *
   * ⚠️ Car Insurance sits on the 26th and not the 24th deliberately: on the 24th
   * it shared a day with a payday of the old anchor, and this test's own premise
   * — one monthly series per day of month — would have been broken by the
   * fixture rather than by the app.
   */
  const dates = schedule.map((row) => /^([A-Z][a-z]{2} \d{1,2})/.exec(row)?.[1] ?? row);
  expect(dates).toEqual([
    "Jul 9",
    "Jul 16",
    "Jul 17",
    "Jul 20",
    "Jul 22",
    "Jul 26",
    "Jul 31",
    "Aug 5",
  ]);

  // and the one that moved, named — so a future edit that puts the right count
  // of rows on the wrong days cannot pass this
  const mealKit = schedule.find((row) => row.includes("Meal Kit"));
  expect(mealKit).toBeDefined();
  expect(mealKit!.startsWith("Aug 5")).toBe(true);
});

/**
 * ⛔ THE WINDOW'S FAR EDGE, where a row can stand on it. The check above lost its edge row when Paycheck moved onto
 * its deposits' Fridays (8ef2fc5): with nothing on Aug 6 or Aug 7, a 31-day window lists the same eight rows, and an
 * off-by-one at the far end — `today + windowDays` where it must be `today + windowDays - 1`, the defect that once
 * listed his rent twice — passes it. The dashboard's strip reads the same `upcomingOccurrences` over 14 days: from
 * E2E_FAKE_TODAY = 2026-07-08, day fourteen is Jul 21 and Car Lease's Jul 22 is day FIFTEEN — measured on a scratch
 * e2e seed (2026-10-14): 14 days list four rows, 15 days list Car Lease too.
 */
test("the dashboard's 14-day strip ends on day fourteen: Car Lease's Jul 22 is day fifteen", async ({ page }) => {
  await page.goto("/");
  const strip = page.locator('section[aria-labelledby="upcoming-heading"]');
  await expect(strip.getByRole("heading", { name: "Upcoming · next 14 days" })).toBeVisible();
  const chips = (await strip.locator("li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const dates = chips.map((chip) => /^([A-Z][a-z]{2} \d{1,2})/.exec(chip)?.[1] ?? chip);
  expect(dates).toEqual(["Jul 9", "Jul 16", "Jul 17", "Jul 20"]);
  expect(chips.some((chip) => chip.includes("Car Lease"))).toBe(false);
});

/**
 * …and the dashboard's line over the same schedule, which no e2e text read. "$X due by your next paycheck" sums
 * every bill due ON OR BEFORE the next payday (`upcomingBills`): Rent Jul 9 and Netflix Jul 16 by Paycheck's Jul 17,
 * the ACME deposits' own Friday. Two bills, so the figure is a sum; under the old Jul 10 anchor it was Rent alone.
 */
test("the dashboard's paycheck line sums the bills due by the next payday", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("p", { hasText: "due by your next paycheck" })).toHaveText(
    "$1,815.99 due by your next paycheck (Jul 17)",
  );
});
