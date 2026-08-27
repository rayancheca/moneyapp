import { expect, test } from "@playwright/test";

/**
 * The PHASE III-B insight strip on /spending.
 *
 * What unit tests already own: which claim a fact set admits, and which it
 * refuses. `src/lib/insight-validator.test.ts` fires 25 adversarial strings at
 * the gates and `src/services/spending-insights.test.ts` drives a ledger whose
 * answers are known independently.
 *
 * What only a browser can show is that the rendered string is a string a reader
 * can use: no unrendered slot, no `undefined` field, and a proof that actually
 * opens and names documents.
 *
 * ⚠️ **This spec does NOT catch a hydration mismatch, and it was MEASURED not
 * assumed.** The `<div popover>` inside a `<p>` trap that failed nine tests last
 * session was reintroduced here deliberately, and all three tests below stayed
 * GREEN — React 19 recovered the subtree well enough that the badge still
 * opened. `e2e/hydration.spec.ts` failed on the same mutation, immediately and
 * by name. A click test proves interactivity survived; only a console listener
 * proves hydration did. The two are not substitutes, and a comment here once
 * claimed they were.
 *
 * ⚠️ Scoped by id, not by heading text. `getByRole(name:)` matches on SUBSTRING,
 * and this page already carries "What this page cannot see".
 */

const STRIP = "section:has(#ledger-insights)";

/**
 * A rendered sentence. Deliberately shaped from what the fixture ACTUALLY
 * renders rather than guessed: at E2E_FAKE_TODAY the strip reads Jun 2026 and
 * emits a rank, a share, a delta and a flat trend.
 *
 * The checks are for the failure modes a template can produce — an unrendered
 * slot, an undefined field, a NaN — none of which a unit test over the service
 * can see once the string has been handed to React.
 */
const BROKEN = /\{\{|undefined|NaN|Infinity|\[object/;

test.describe("what the ledger says", () => {
  test("renders proven sentences, and each proof opens", async ({ page }) => {
    await page.goto("/spending");
    const strip = page.locator(STRIP);
    await expect(strip).toBeVisible();

    const items = strip.locator("li");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const text = (await items.nth(i).innerText()).trim();
      expect(text, `insight ${i}`).not.toMatch(BROKEN);
      // every claim in the vocabulary is exactly one sentence
      expect(text, `insight ${i}`).toMatch(/\.$|\.\s/);
    }

    /*
     * The interactivity check. A hydration break leaves the badge on screen and
     * inert, so clicking is the only assertion that can tell the two apart —
     * `toBeVisible` passes either way.
     */
    await strip.getByRole("button").first().click();
    const panel = page.locator("[popover]").filter({ hasText: "Standing on" }).first();
    await expect(panel).toBeVisible();
    // the proof names documents, which is the whole point of it being a popover
    await expect(panel).toContainText(/read by/);
  });

  test("names the window it is talking about, in the heading and in the sentences", async ({ page }) => {
    await page.goto("/spending");
    const strip = page.locator(STRIP);
    // the strip does NOT follow the period selector; its window is the newest
    // month every account has been imported through, so it has to say which
    await expect(strip).toContainText(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/);
  });

  test("the period selector does not silently change what the strip claims", async ({ page }) => {
    await page.goto("/spending");
    const before = await page.locator(STRIP).innerText();
    // a different period changes the page's totals and must not change a
    // sentence whose window is stated inside the sentence itself.
    // ⚠️ innerText BOTH sides: `toHaveText` compares textContent, which
    // concatenates across block boundaries and would never equal an innerText
    // capture no matter how right the page was.
    await page.goto("/spending?period=2026");
    await expect(page.locator(STRIP)).toBeVisible();
    expect(await page.locator(STRIP).innerText()).toBe(before);
  });
});
