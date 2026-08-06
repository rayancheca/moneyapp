import { expect, test, type Page } from "@playwright/test";

/**
 * Hover-only row controls on a COARSE pointer (§2.5 reveal contract).
 *
 * The ledger's select-checkbox and expander chevron ship `opacity-0` and are
 * revealed by `group-hover/row:` / `group-focus-within/row:`. A touch device
 * has neither, so the only thing standing between a phone and an invisible
 * control is one `pointer-coarse:opacity-100` — in TransactionsLedger.tsx for
 * the ledger, and in DataTable.tsx:66 (CONTROL_REVEAL) for any table that
 * turns selection on. Both are branches every desktop spec in the suite runs
 * straight past. Hence its own project (see playwright.config.ts):
 * `hasTouch: true` is what Chromium maps to `(pointer: coarse)`.
 *
 * DataTable's reveal site was, until now, deliberately NOT covered: the span
 * renders only under `selectable`, and none of DataTable's consumers passed it
 * (every `selectable` prop in src/ belonged to ScrubChart), so there was no
 * route to assert it on. PortfolioHoldingsTable now passes it — the holdings
 * table on /investments ticks rows to subtotal them — which puts the branch on
 * a real page, and the second test below asserts it there.
 *
 * Two rules this file exists to obey, both learned the hard way:
 *
 *  - Assert COMPUTED OPACITY, never toBeVisible(). Playwright counts an
 *    opacity-0 element as visible, so `toBeVisible()` here passes on desktop
 *    too and proves precisely nothing. That false-green is what made pass 37's
 *    e2e a flake.
 *  - Keep the fine-pointer negative control. Without it a green run cannot
 *    tell "the coarse branch fired" from "these controls are opaque always" —
 *    the same assertion would pass if someone deleted the `opacity-0`.
 *
 * Takes no screenshots — baseline churn is a tracked gate and this file must
 * add zero baselines. Runs first (project order) against the un-mutated seed;
 * both tests are read-only (they never tick a box, only measure the reveal).
 */

/** The two live `pointer-coarse:` controls, as the LEDGER row renders them. */
function revealControls(page: Page) {
  return {
    // REVEAL sits on the <label> WRAPPING the checkbox, not on the input:
    // opacity does not inherit, so the input's own computed value is always 1
    // and asserting on it would measure nothing. Hop to the parent from the
    // role locator rather than naming a class — the wrapper is the contract.
    checkboxWrapper: page.getByRole("checkbox", { name: /^Select / }).first().locator("xpath=.."),
    expander: page.getByRole("button", { name: /^Expand details for / }).first(),
  };
}

/**
 * The same control in a DataTable, as the holdings table renders it: the
 * reveal is on the <span> wrapping the input (DataTable.tsx:250), so the same
 * parent hop applies for the same reason.
 *
 * The name pattern is NOT a bare /^Select /: DataTable's header also renders
 * "Select all rows", it comes first in the DOM, and it carries no reveal span
 * at all — `.first()` would silently measure a <th> and read 1 in both
 * contexts. `rowLabel` names each row "{symbol} in {account}", so requiring
 * " in " keeps this on a body row.
 */
function holdingsCheckboxWrapper(page: Page) {
  return page
    .getByRole("checkbox", { name: /^Select \S+ in / })
    .first()
    .locator("xpath=..");
}

/**
 * Navigate, then wait for the client to mount — the reveal is a CSS branch on a
 * client-rendered row, so reading opacity before hydration reads the wrong DOM.
 * The signal is the SVG INSIDE the theme toggle (ThemeToggle renders
 * `{mounted ? <Icon/> : <span/>}`): its aria-label ships in the SSR markup and
 * so proves nothing, and a bare `header button svg` is ambiguous on any page
 * that mounts a Sheet or CalendarGrid. Same idiom as zz-zz-view-switcher.
 */
async function openLedger(page: Page): Promise<void> {
  await page.goto("/transactions");
  await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

/** …the same, for the page that owns the only selectable DataTable. */
async function openHoldings(page: Page): Promise<void> {
  await page.goto("/investments");
  await expect(page.getByRole("heading", { level: 1, name: "Investments" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

test("row controls are revealed on a coarse pointer, and still hidden on a fine one", async ({
  page,
  browser,
}) => {
  // Guard: prove the media feature actually flipped BEFORE reading opacity, so
  // a failure says which half broke — the emulation or the stylesheet.
  await openLedger(page);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

  const coarse = revealControls(page);
  await expect(coarse.checkboxWrapper).toHaveCSS("opacity", "1");
  await expect(coarse.expander).toHaveCSS("opacity", "1");

  // Negative control. browser.newContext() inherits this project's `use` via
  // Playwright's auto artifacts fixture, which back-fills every key the caller
  // omits — so baseURL, timezoneId, locale AND the 390x844 viewport all carry
  // over, and `hasTouch` is the only variable that differs. Nothing here
  // hovers or focuses, so the fine-pointer row keeps its resting state.
  const fine = await browser.newContext({ hasTouch: false });
  try {
    const finePage = await fine.newPage();
    await openLedger(finePage);
    expect(await finePage.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);

    const hidden = revealControls(finePage);
    await expect(hidden.checkboxWrapper).toHaveCSS("opacity", "0");
    await expect(hidden.expander).toHaveCSS("opacity", "0");
  } finally {
    await fine.close();
  }
});

test("holdings checkboxes are revealed on a coarse pointer, and still hidden on a fine one", async ({
  page,
  browser,
}) => {
  // Same shape as the ledger test above, one route over: this is DataTable's
  // own reveal, which no page could exercise until the holdings table turned
  // selection on.
  await openHoldings(page);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

  await expect(holdingsCheckboxWrapper(page)).toHaveCSS("opacity", "1");

  const fine = await browser.newContext({ hasTouch: false });
  try {
    const finePage = await fine.newPage();
    await openHoldings(finePage);
    expect(await finePage.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);

    // resting: no hover, no focus inside a row, and nothing ticked (a selection
    // reveals every checkbox through `group-data-[selecting]/table`)
    await expect(holdingsCheckboxWrapper(finePage)).toHaveCSS("opacity", "0");
  } finally {
    await fine.close();
  }
});
