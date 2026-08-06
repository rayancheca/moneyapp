import { expect, test, type Page } from "@playwright/test";

/**
 * Hover-only row controls on a COARSE pointer (§2.5 reveal contract).
 *
 * The ledger's select-checkbox and expander chevron ship `opacity-0` and are
 * revealed by `group-hover/row:` / `group-focus-within/row:`. A touch device
 * has neither, so the only thing standing between a phone and two invisible
 * controls is one `pointer-coarse:opacity-100` in TransactionsLedger.tsx — a
 * branch every desktop spec in the suite runs straight past. Hence its own
 * project (see playwright.config.ts): `hasTouch: true` is what Chromium maps
 * to `(pointer: coarse)`.
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
 * The reveal site in DataTable.tsx is deliberately NOT covered: its span
 * renders under `selectable`, and none of DataTable's 8 consumers pass it
 * (all five `selectable` props in src/ belong to ScrubChart). It is
 * unreachable in the shipped app, so there is no route to assert it on.
 *
 * Takes no screenshots — baseline churn is a tracked gate and this file must
 * add zero baselines. Runs first (project order) against the un-mutated seed.
 */

/** The two live `pointer-coarse:` controls, as the row renders them. */
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
