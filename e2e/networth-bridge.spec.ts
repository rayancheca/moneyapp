import { test, expect } from "@playwright/test";
import { delayServerActions, pressView } from "./view-helpers";

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
 * ⛔ THAT WAS TRUE UNTIL 2026-09-02 AND IS NOT ANY MORE. The Bridge/Table
 * switcher used to be local `useState`; it is now a real view dimension
 * (`bridgeLens`), so pressing it persists — and `setView` persists the WHOLE
 * resolved state, `chart: "bridge"` included. This file is not `zz`-prefixed,
 * so it runs early, and the leak left the dashboard on the bridge's TABLE for
 * every later spec: 87 tests failed on one press, from the net-worth slider
 * being absent to eight visual baselines of a page nobody had changed.
 *
 * The last test therefore RESTORES what it presses, the way
 * `zz-zz-sankey.spec.ts` does for the flow lens. Since 2026-10-01 both prove
 * each restoring press landed before the next step (pressView) — the Sankey's
 * restores were bare clicks too, and held back they failed every run — and this
 * one then proves both dimensions came back (see the note at the restore). The
 * range pills are still ChartFocus's lifted state and still persist nothing.
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
  // one pixel is still readable.
  // ⛔ Scoped to the legend, not the page: since S22 the first band reads
  // "Income", and the dashboard's Upcoming strip prints "Income" as the kind of
  // the fixture's Paycheck (due Jul 10, inside its 14 days of Jul 8). A
  // page-wide exact match finds both, and strict mode throws.
  const legend = page.getByRole("list", { name: "Bridge legend" });
  for (const label of ["Income", "Refunds", "Spent", "Moved", "Market", "Unexplained"]) {
    await expect(legend.getByText(label, { exact: true })).toBeVisible();
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
  // header + nine bands — the ninth, "Agent's income", is $0.00 on this fixture (no agent) and present anyway:
  // a band is kept at zero rather than dropped (lib/attribution), owner decision 2026-09-28
  await expect(table.getByRole("row")).toHaveCount(10);
  await expect(table.getByText("-$521.42")).toBeVisible();

  // ⛔ RESTORE BOTH, in order: the lens first, then the hero mode — and PROVE each
  // press landed before taking the next step (pressView). `/` must not be requested
  // until the mode press is written, or the server still resolves the bridge and
  // there is no net-worth chart on it. Bare clicks did not wait: 1 gate in ~15
  // failed below, and the post-suite database of a green gate still held
  // `bridgeLens: "table"` — the mode press, made before the lens press's navigation
  // committed, was built on the view from before it and wrote the table straight
  // back. Since 2026-10-01 useViewState builds a press made while another is in
  // flight on that one (src/hooks/useViewState.test.ts); proving each press here
  // keeps this restore from leaning on it. Every press is held back on its way to
  // the server, so a restore that does not wait fails here, not once in ~15 gates.
  await delayServerActions(page);
  await pressView(page, "Bridge view", "Bridge");
  await pressView(page, "Net worth chart view", "Net worth");
  await page.goto("/");
  await expect(page.getByRole("slider", { name: /Net worth over time/ })).toBeVisible();
  // …and the lens rolled back with it: a fresh bridge visit opens on the chart
  await page.goto("/?chart=bridge");
  await expect(
    page.getByRole("group", { name: "Bridge view" }).getByRole("button", { name: "Bridge" }),
  ).toHaveAttribute("aria-pressed", "true");
});
