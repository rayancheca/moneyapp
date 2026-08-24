import { test, expect } from "@playwright/test";

/**
 * The net-worth bridge — the dashboard's eighth hero view.
 *
 * ⚠️ The RANGE matters to what renders, and each of these picks its window for a
 * reason. The suite would otherwise photograph one shape and call the chart
 * covered, which is the fixture-blindness pass 53 recorded.
 *
 * ⚠️ NOT `zz`-prefixed, and that is load-bearing. Playwright runs files
 * alphabetically, the `zz-*` specs are the ones that MUTATE the shared fixture
 * (renaming accounts, categorising, editing budgets), and these assertions read
 * exact dollar figures off a pristine seed. Filed as `zz-zz-zz-…` first, two of
 * the four passed alone and failed in the full run for exactly that reason.
 * Everything here is read-only: the range pills are ChartFocus's lifted state
 * and the Bridge/Table switcher is local `useState`, so nothing persists a view
 * preference the way the hero's own ViewSwitcher would.
 */

const bridgeRange = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Bridge range" });

test("the bridge decomposes the hero number and states where it started and ended", async ({
  page,
}) => {
  await page.goto("/?chart=bridge");
  await expect(page.getByRole("group", { name: "Net worth chart view" })).toBeVisible();
  await expect(bridgeRange(page)).toBeVisible();

  // the two totals are PRINTED, not left to a hover: they are the question the
  // chart answers, and there is no room to label ten columns at the 320 floor
  await expect(page.getByText("$133,473.39").first()).toBeVisible();

  // every band names itself and its signed amount, so a band whose bar is under
  // one pixel is still readable
  for (const label of ["Earned", "Refunds", "Spent", "Moved", "Market", "Unexplained"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  /*
   * The axis omits zero — it has to, or an $82k→$109k bridge makes every band a
   * sliver — and it says so. The flag was published by the layout from the start
   * and rendered nowhere until review grepped for its consumers and found only
   * its own unit tests.
   */
  await expect(
    page.getByText(/Bar heights are measured from .*, not from zero/),
  ).toBeVisible();
  await expect(page.getByText(/The two rules mark the opening and closing totals\./)).toBeVisible();
});

test("a band too small to draw is redrawn on its own axis, with the magnification stated", async ({
  page,
}) => {
  /*
   * Year-to-date on this fixture puts Market at −$521.42 against $39,934.90 of
   * earnings — 0.18px at the chart's height, which is no pixels at all. The
   * magnified row is the whole answer to "a $300 balance beside a $100k account",
   * and it must SAY how much it magnified or it is just a second, wronger chart.
   */
  await page.goto("/?chart=bridge");
  await bridgeRange(page).getByRole("button", { name: "Year to date" }).click();

  // BOTH ceilings are printed, so the stated factor is checkable against two
  // numbers on the page rather than taken on trust: $39,934.90 / $521.42 = 77.
  // matched in pieces, not as one long regex: the copy renders a typographic
  // apostrophe (&rsquo;) and a straight one in the pattern silently never matches
  const caption = page.getByText(/Too small to draw above/);
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("full width is $521.42");
  await expect(caption).toContainText("the tallest band above is $39,934.90");
  await expect(caption).toContainText("77× larger");
  await expect(page.getByText("-$521.42").first()).toBeVisible();
});

test("a residual is named rather than left as a bare hole", async ({ page }) => {
  /*
   * All-time on this fixture is +$61,765.55 that no transaction explains — five
   * accounts opening with a balance and the holdings' first day. A bridge that
   * printed only "Unexplained $61,765.55" would be reporting a defect that is
   * not there, so the difference between "unaccounted for" and "accounted for,
   * just not by a transaction" is on screen.
   */
  await page.goto("/?chart=bridge");
  await bridgeRange(page).getByRole("button", { name: "All time" }).click();

  await expect(page.getByText(/no transaction explains — and all of it has a name/)).toBeVisible();
  await expect(page.getByText("balance restated").first()).toBeVisible();
  await expect(page.getByText("entered coverage")).toBeVisible();
});

test("the table lens carries every band, including the ones the chart cannot draw", async ({
  page,
}) => {
  await page.goto("/?chart=bridge");
  await bridgeRange(page).getByRole("button", { name: "Year to date" }).click();
  await page.getByRole("group", { name: "Bridge view" }).getByRole("button", { name: "Table" }).click();

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(9); // header + eight bands
  await expect(table.getByText("-$521.42")).toBeVisible();
});
