import { expect, test } from "@playwright/test";
import { DASHBOARD_VIEW_SPEC } from "../src/components/dashboard/dashboard-view-spec";

/**
 * EVERY option of the hero chart dimension has to actually render.
 *
 * This spec exists because a whole suite went green over a 500. The `terrain`
 * option was appended to DASHBOARD_VIEW_SPEC — which put a seventh pill in the
 * switcher and made `/?chart=terrain` a real, clickable, persistable URL — while
 * the page still resolved the view with `chartMode as DashboardMode`. The cast
 * carried the raw slug into `buildDashboardSeries`, whose exhaustive switch had
 * no case for it; the switch fell out the bottom, returned `undefined`, and the
 * RSC died on `.map`. Anyone clicking the pill got the error boundary instead of
 * the dashboard. 246 e2e tests passed, because not one of them opened the view
 * the wave had just shipped.
 *
 * The lesson is not "test terrain" — it is that a view dimension is a PROMISE
 * that every option renders, and the promise is only worth what enumerates it.
 * So this spec reads the spec itself: add an option and it is covered the same
 * day, with no one having to remember. Deliberately shallow — each option's
 * content is asserted by its own spec (zz-zz-dashboard-modes, zz-zz-sankey);
 * what this catches is the whole page failing to render at all, which is the
 * failure a rich per-view assertion is too specific to notice.
 */

const CHART_OPTIONS = DASHBOARD_VIEW_SPEC.find((d) => d.key === "chart")?.options ?? [];

test("the chart dimension has options to enumerate", () => {
  // guards the guard: an empty list would make every assertion below vacuous
  expect(CHART_OPTIONS.length).toBeGreaterThanOrEqual(6);
});

for (const option of CHART_OPTIONS) {
  test(`the hero renders in the "${option}" view`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const response = await page.goto(`/?chart=${option}`);

    expect(response?.status(), `GET /?chart=${option}`).toBe(200);
    // the error boundary renders a heading, so a status check alone is not
    // enough — this is the string the user actually sees when an RSC throws
    await expect(page.getByText("This page didn't render.")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Net worth" })).toBeVisible();
    // the switcher itself must survive: it is how the user gets back out of a
    // view, and a crash that took only the panel would still strand them
    await expect(page.getByRole("group", { name: "Net worth chart view" })).toBeVisible();
    expect(errors, `client errors in the "${option}" view`).toEqual([]);
  });
}

/**
 * The terrain's central claim is that its ribbons ADD UP to the line above it,
 * and it says so in its own accessible name. That sentence is the feature; a
 * terrain that renders while quietly disagreeing is worse than one that does
 * not render, so assert the claim and not merely the pixels.
 *
 * It regressed once already: the view inherited the `accts` CURATION from the
 * Accounts line view, drew 11 of 16 accounts, compared that subset against the
 * whole net-worth line and announced a $67.00 mismatch that did not exist.
 */
test("the terrain states that it reconciles with the net-worth line", async ({ page }) => {
  await page.goto("/?chart=terrain");
  const figure = page.getByRole("img", { name: /Net worth terrain/ });
  await expect(figure).toBeVisible();

  const label = (await figure.getAttribute("aria-label")) ?? "";
  expect(label, "the terrain must state its reconciliation either way").toMatch(
    /(the same net worth as the chart above|does NOT match)/,
  );
  expect(label, "the ribbons disagree with the hero — read the on-page note").toContain(
    "the same net worth as the chart above",
  );
});

/**
 * Looking at the terrain must not REWRITE the account curation. The view asks
 * for every account; if that resolved selection were echoed back onto the URL
 * and persisted, a glance at the terrain would silently widen the user's
 * curated Accounts view to "all" — a destructive edit performed by reading.
 */
test("the terrain does not overwrite the account selection", async ({ page }) => {
  await page.goto("/?chart=accounts");
  const pills = page.getByRole("group", { name: "Accounts shown" });
  await expect(pills).toBeVisible();
  const before = await pills.getByRole("button", { pressed: true }).count();
  expect(before).toBeGreaterThan(0);

  // deselect one, so the curation is genuinely narrower than "everything".
  // Hold its NAME, not the locator: `.first()` re-resolves against whatever is
  // pressed at click time, so after a round trip it would point at a different
  // account and the restore below would quietly deselect a second one.
  const chosenName = (await pills.getByRole("button", { pressed: true }).first().innerText()).trim();
  await pills.getByRole("button", { name: chosenName, exact: true }).click();
  await expect(pills.getByRole("button", { pressed: true })).toHaveCount(before - 1);
  const curated = before - 1;

  // take a look at the terrain, then come back
  await page.goto("/?chart=terrain");
  await expect(page.getByRole("img", { name: /Net worth terrain/ })).toBeVisible();
  await page.goto("/?chart=accounts");
  await expect(pills.getByRole("button", { pressed: true })).toHaveCount(curated);

  // RESTORE THE SEED — both halves of it. Toggling an account chip writes the
  // WHOLE view state, not just `accts`, so this spec would otherwise hand the
  // next one a dashboard whose persisted view is "accounts": zz-zz-dashboard-
  // modes opens `/` with no `?chart`, the RSC falls back to the preference, and
  // its first assertion (the combined net-worth slider) fails somewhere it did
  // not touch. Navigation alone never persists — only a pill click does — so
  // the restore is a click too.
  await pills.getByRole("button", { name: chosenName, exact: true }).click();
  await expect(pills.getByRole("button", { pressed: true })).toHaveCount(before);
  await page
    .getByRole("group", { name: "Net worth chart view" })
    .getByRole("button", { name: "Net worth", exact: true })
    .click();
  await expect(page.getByRole("slider", { name: /Net worth over time/ })).toBeVisible();
});
