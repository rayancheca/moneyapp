import { expect, test } from "@playwright/test";

/**
 * The recurring calendar, asserted as TEXT.
 *
 * The grid now has eight visual baselines (visual.spec `recurring-calendar`),
 * and those baselines cannot see a digit: `maxDiffPixelRatio: 0.001` passed
 * green over a rendered date moving a whole day in pass 51. A calendar whose
 * entire job is to say HOW MUCH leaves and WHEN therefore needs its numbers
 * read by something, or they are asserted by nothing.
 *
 * Read-only — navigating and paging the month only reads — and named without a
 * `zz-` prefix so it runs on the pristine seed, before any spec mutates it.
 * Detection has NOT run here, so the series are exactly the five seed-helpers
 * inserts, projected from E2E_FAKE_TODAY = 2026-07-08.
 */

/** A day cell's rendered text, normalised: "9 • -1.8k" → "9 • -1.8k". */
async function cellTexts(page: import("@playwright/test").Page): Promise<string[]> {
  const buttons = await page.getByRole("gridcell").locator("button").all();
  const out: string[] = [];
  for (const b of buttons) {
    const aria = await b.getAttribute("aria-label");
    if (!aria || !/\bitems?:/.test(aria)) continue; // an empty day renders the date alone
    out.push((await b.innerText()).replace(/\s+/g, " ").trim());
  }
  return out;
}

test("every day with activity prints its own signed total", async ({ page }) => {
  await page.goto("/recurring?tab=calendar");
  await expect(page.getByRole("grid", { name: "July 2026" })).toBeVisible();

  /*
   * The seeded July, in full. Each row is `<day> <glyph> <compact net> <series>`
   * — the series name is the DOMINANT entry on the day (calendar-day-weight),
   * which is unambiguous here because every seeded day carries exactly one:
   *   Jul 5  Meal Kit  −$125.00   missed   (nextExpectedOn 07-05, before today)
   *   Jul 9  Rent      −$1,800.00 upcoming
   *   Jul 10 Paycheck  +$3,200.00 upcoming (biweekly → 07-24 as well)
   *   Jul 16 Netflix   −$15.99    upcoming
   *   Jul 20 Gym       −$49.00    upcoming
   *
   * The compact figures are the assertion that matters: they are what the grid
   * actually says about money, and a scale change, a sign flip or a lost digit
   * moves one of these strings while every baseline stays inside tolerance.
   */
  expect(await cellTexts(page)).toEqual([
    "5 ✕ -125 Meal Kit",
    "9 • -1.8k Rent",
    "10 • 3.2k Paycheck",
    "16 • -16 Netflix",
    "20 • -49 Gym Membership",
    "24 • 3.2k Paycheck",
  ]);

  // …and the month footer totals them. Upcoming excludes the missed Meal Kit:
  // -1800 + 3200 - 15.99 - 49 + 3200 = 4535.01.
  // `innerText` applies text-transform, and the footer's labels are uppercased
  // in CSS — so these read POSTED/UPCOMING, not Posted/Upcoming.
  const grid = page.getByRole("grid", { name: "July 2026" }).locator("..");
  const footer = (await grid.innerText()).replace(/\s+/g, " ");
  expect(footer).toContain("POSTED $0.00");
  expect(footer).toContain("UPCOMING +$4,535.01");
  expect(footer).toContain("1 missed");
});

/**
 * Narrow widths are where a money grid actually breaks, and this one broke
 * silently twice.
 *
 * First the figures sat `justify-between` — glyph hard left, amount hard right —
 * which left ~21px for the amount in a ~38px cell, and all six ellipsised: the
 * 320px grid rendered `-...` and `3...` where the money belonged. Eight visual
 * baselines were perfectly happy, because an ellipsis is a handful of pixels.
 * Then removing the `truncate` that caused the ellipsis simply moved the
 * failure: the identical too-wide text overflowed into the neighbouring day
 * instead, with `scrollWidth === clientWidth` the whole time.
 *
 * So BOTH failures are asserted, on both axes, at both narrow widths that
 * matter — 320 is the project's floor, and 440 is the owner's phone. Neither
 * gets Tailwind's `sm:` (640px), so neither is covered by the desktop layout.
 */
const NARROW_WIDTHS = [
  // 320: the project's floor. A cell is ~38px and only the figures fit.
  { width: 320, expectNames: false },
  // 440: the owner's phone. Cells are ~52px, which is where a series name
  // starts being worth truncating — hence the `min-[400px]:` gate.
  { width: 440, expectNames: true },
] as const;

for (const { width, expectNames } of NARROW_WIDTHS) {
  test(`no day cell clips or overflows its content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1400 });
    await page.goto("/recurring?tab=calendar");
    await expect(page.getByRole("grid", { name: "July 2026" })).toBeVisible();

    const amounts = page.locator('[role="grid"] button span.figures');

    const clipped = await amounts.evaluateAll((nodes) =>
      nodes
        .filter((n) => n.scrollWidth > n.clientWidth)
        .map((n) => `${n.textContent} (${n.scrollWidth} > ${n.clientWidth})`),
    );
    expect(clipped, "these amounts are ellipsised").toEqual([]);

    // …and the whole rendered cell, on both axes, against the day button that
    // owns it. Horizontal catches the spill into the next day; VERTICAL catches
    // the one that arrived with the two-line wrap, where an `aspect-square` cell
    // is ~30px tall and date + glyph + amount + bar need well over 40px.
    const overflowing = await page
      .locator('[role="grid"] button > span[aria-hidden]')
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getBoundingClientRect().height > 0)
          .filter((n) => {
            const cell = n.closest("button");
            if (!cell) return true;
            const a = n.getBoundingClientRect();
            const b = cell.getBoundingClientRect();
            return (
              a.left < b.left - 0.5 ||
              a.right > b.right + 0.5 ||
              a.bottom > b.bottom + 0.5 ||
              a.top < b.top - 0.5
            );
          })
          .map((n) => (n.textContent ?? "?").replace(/\s+/g, " ").trim()),
      );
    expect(overflowing, "these day cells overflow their own square").toEqual([]);

    // The wrapper is `flex-1 min-h-0`, so it is allowed to be SHORTER than its
    // own children: its rect stays inside the button while the content spills
    // past it, and the rect comparison above sees nothing. `scrollHeight`
    // reports the content extent whatever the overflow property is, which is
    // the only way to ask "did the figures, the name and the bar actually fit?"
    const tooTall = await page
      .locator('[role="grid"] button > span[aria-hidden]')
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.scrollHeight > n.clientHeight + 0.5)
          .map((n) => `${(n.textContent ?? "?").replace(/\s+/g, " ").trim()} (${n.scrollHeight} > ${n.clientHeight})`),
      );
    expect(tooTall, "these day cells cannot fit their own content").toEqual([]);

    // guard the guard: a filter over an empty set also returns [], which would
    // make both assertions above vacuous the day a selector stops matching
    expect(await amounts.count()).toBe(6);

    /*
     * …and the breakpoint itself, which every check above would pass without.
     * The names are gated on `min-[400px]:`, an arbitrary Tailwind variant; if
     * it failed to generate, the names would simply never render and the fit
     * assertions would get EASIER, not harder. So both sides are asserted: at
     * 440 (the owner's phone, and below Tailwind's `sm`) the name must be there,
     * and at 320 it must not.
     */
    const rentName = page.locator('[role="grid"] button').filter({ hasText: "Rent" }).first();
    if (expectNames) {
      await expect(rentName.getByText("Rent", { exact: true })).toBeVisible();
    } else {
      await expect(rentName.getByText("Rent", { exact: true })).toBeHidden();
    }
  });
}

test("a day cell enumerates its series, state and amount for a screen reader", async ({ page }) => {
  await page.goto("/recurring?tab=calendar");
  await expect(page.getByRole("grid", { name: "July 2026" })).toBeVisible();

  // The cell TEXT is a magnitude for scanning ("-1.8k"); the aria-label is the
  // exact figure. Both matter, and only one of them is readable by a screen
  // reader — so the exact one is asserted here rather than assumed.
  await expect(
    page.getByRole("button", { name: "Jul 9, 2026 — 1 item: Rent upcoming -$1,800.00" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Jul 5, 2026 — 1 item: Meal Kit missed -$125.00" }),
  ).toBeVisible();

  // an empty day is labelled by its date alone — no phantom "0 items"
  await expect(page.getByRole("button", { name: "Jul 7, 2026" })).toBeVisible();
});

/**
 * The `paid` state is not reachable in July 2026 — nothing seeded posts against
 * a series inside the month — so the one branch that renders a POSTED charge
 * would otherwise be covered by neither a baseline nor a text assertion.
 *
 * It is reachable by paging: seedBudgets links the Netflix series to a single
 * 2024-07 Streaming row (-$15.49 against a -$15.99 expectation, inside the $1
 * tolerance floor → `paid`, not `paid_different`). Paging there and reading it
 * back is what proves a posted charge renders as money at all.
 */
test("paging back to a posted charge renders it as paid", async ({ page }) => {
  await page.goto("/recurring?tab=calendar");
  await expect(page.getByRole("grid", { name: "July 2026" })).toBeVisible();

  const prev = page.getByRole("button", { name: "Previous month" });
  for (let i = 0; i < 24; i += 1) await prev.click();
  await expect(page.getByRole("grid", { name: "July 2024" })).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Jul 3, 2024 — 1 item: Netflix paid -$15.49" }),
  ).toBeVisible();
  expect(await cellTexts(page)).toEqual(["3 ✓ -15 Netflix"]);

  // a posted charge counts as Posted, never as Upcoming
  const grid = page.getByRole("grid", { name: "July 2024" }).locator("..");
  const footer = (await grid.innerText()).replace(/\s+/g, " ");
  expect(footer).toContain("POSTED -$15.49");
  expect(footer).toContain("UPCOMING $0.00");
});
