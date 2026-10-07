import { expect, test, type Page } from "@playwright/test";

/**
 * "Prove it" — the provenance badge and the panel behind it.
 *
 * The property worth pinning is NOT that a badge exists. It is that the badge
 * tells the truth about a figure it cannot prove: the whole feature is worth
 * less than nothing if an unchecked number can be mistaken for a checked one.
 * So these assertions are about VOCABULARY and REACHABILITY, not pixels — the
 * visual baselines cover the layout, and a badge reading the wrong word would
 * pass every one of them.
 *
 * ⚠️ Read-only: this spec opens popovers and never writes, so it sorts anywhere.
 */

/**
 * Navigate and WAIT FOR HYDRATION. The trigger is a `"use client"` button that
 * ships enabled in the SSR HTML, so a click can land before React attaches its
 * onClick and be swallowed silently. The theme toggle's SVG renders only after
 * mount, which makes it a true hydration signal.
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

/**
 * Every word the badge is allowed to say. A blank badge reads as "fine". ("you counted it": a balance he typed, §6A 50;
 * "part you entered": a total only part of which he typed)
 */
const VERDICT_WORDS =
  /on a statement|adds up|market value|you entered it|you counted it|part you entered|nothing checks it|no basis yet|does not add up|\d+ of \d+ add up/;

test("the dashboard headline says what it is standing on, and names what it cannot see", async ({ page }) => {
  await gotoHydrated(page, "/");

  const trigger = page.getByRole("button", { name: /How net worth is known/ });
  await expect(trigger).toBeVisible();

  await trigger.click();
  const panel = page.getByRole("dialog", { name: /What net worth is standing on/ });
  await expect(panel).toBeVisible();

  // the sentence the whole figure turns on
  await expect(panel).toContainText(/A total is only as proven as its weakest part/);
  // and the per-account breakdown, each carrying its own verdict
  await expect(panel).toContainText(/Assembled from \d+/i);
  await expect(panel.locator("li").first()).toContainText(VERDICT_WORDS);
});

/**
 * The panel is a dialog, so it has to be reachable and dismissible without a
 * mouse. `Popover`'s native light dismiss handles Escape; this proves the
 * trigger is in the tab order at all, which a `<span>` would not have been.
 */
test("the badge is reachable by keyboard and the panel closes on Escape", async ({ page }) => {
  await gotoHydrated(page, "/");
  const trigger = page.getByRole("button", { name: /How net worth is known/ });

  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");

  const panel = page.getByRole("dialog", { name: /What net worth is standing on/ });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

/**
 * ⚠️ Resolved dynamically, never by account NAME. The e2e fixture's accounts
 * and the real ledger's differ, so `getByRole("link", { name: /Chase Checking/ })`
 * passes locally against real data and times out against the fixture — which is
 * exactly how this test failed the first time it ran in the gate. Every other
 * spec that needs an account detail page does the same (`visual.spec.ts:206`).
 */
test("an account balance names the document that pins it", async ({ page }) => {
  await gotoHydrated(page, "/accounts");
  await page.locator('a[href^="/accounts/"]').first().click();

  const trigger = page.getByRole("button", { name: /How (this balance|the amount owed|the credit) is known/ });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText(VERDICT_WORDS);

  await trigger.click();
  const panel = page.getByRole("dialog", { name: /is standing on/ });
  await expect(panel).toBeVisible();
  // a balance is either standing on something named, or says plainly that it is not
  await expect(panel).toContainText(/Standing on|nothing checks|no basis|priced from holdings/i);
});

/**
 * The surface this pass added: the imports page fetched its periods and
 * rendered only three counts from them, so "what did this statement actually
 * establish?" had no answer anywhere in the app.
 */
test("the imports page says what each statement proved, and admits when one proves nothing", async ({ page }) => {
  await gotoHydrated(page, "/imports");

  const card = page.getByRole("heading", { name: "What the statements proved" });
  await expect(card).toBeVisible();

  const badges = page.getByRole("button", { name: /How .+ is known/ });
  const count = await badges.count();
  expect(count).toBeGreaterThan(0);
  // every badge says one of the allowed words — never blank, which reads as fine
  for (let i = 0; i < count; i += 1) await expect(badges.nth(i)).toContainText(VERDICT_WORDS);

  await badges.first().click();
  await expect(page.getByRole("dialog", { name: /is standing on/ })).toBeVisible();
});

/**
 * ⛔ The badge must sit BESIDE a figure, never around it. Wrapping would put a
 * button inside whatever the figure already lives in — a row link, a heading's
 * anchor — which is axe `nested-interactive` (serious). The a11y sweep covers
 * the routes; this asserts the structural rule directly so a future refactor
 * that wraps a figure fails here with a readable reason.
 */
test("no provenance badge is nested inside another interactive element", async ({ page }) => {
  for (const path of ["/", "/imports"]) {
    await gotoHydrated(page, path);
    const nested = await page.evaluate(() => {
      const triggers = [...document.querySelectorAll('button[aria-haspopup="dialog"]')].filter((b) =>
        /is known/.test(b.getAttribute("aria-label") ?? ""),
      );
      return triggers
        .filter((b) => b.parentElement?.closest("a,button,[role=button],[role=link]") != null)
        .map((b) => b.getAttribute("aria-label"));
    });
    expect(nested, `on ${path}`).toEqual([]);
  }
});
