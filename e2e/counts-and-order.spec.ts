import { expect, test } from "@playwright/test";

/**
 * A count a reader can check by counting — and the only one of this pass's four
 * fixes the fixture can express.
 *
 * ⛔ The assertion is on TEXT, not pixels. All 598 baselines stayed green at
 * `maxDiffPixels: 0` through every fix in this pass, because an `aria-label` on
 * a chart bar is a sentence the app is making and the visual gate cannot read
 * one.
 *
 * ⚠️ THE OTHER THREE ARE NOT HERE, because a test that cannot fail is worse
 * than none. Each was checked against the seed before it was left out:
 *
 *   - **"1 transactions" under a merchant name** (60 of them on the owner's
 *     ledger). Every merchant in the seed has at least 8 rows. The bar chart
 *     below covers the same rule on the surface the fixture CAN reach.
 *   - **The remove-balance confirmation counting its carried days.** Every one
 *     of the seed's anchors is `statement` or `ofx_ledger`, and the remove
 *     control renders only for `manual` and `live` — the dialog does not exist
 *     here. `services/coverage.test.ts` pins the rule (`basisIsChecked`), which
 *     is what the page reads now instead of keeping its own copy.
 *   - **The account picker's order.** The seed's eight accounts all carry
 *     `display_order = 0` and each name opens with its own institution's, so
 *     the broken sort and the right one produce the identical list. Measured:
 *     reverting the fix left this suite green. `accounts.test.ts` builds the
 *     shape that separates them.
 *
 * ⚠️ And do not size the fixture from `data/e2e.db` as a run leaves it. That
 * file is reseeded by `global-setup` and then grown by the zz-specs — its
 * post-suite shape holds 17 accounts and two single-row merchants, the fresh
 * seed 8 and none. Both readings above are of the fresh seed.
 */

/**
 * 🔴 "1 transactions" — on every bar of every category's 12-month chart, and
 * under 60 merchant names. The sibling chart on the same page (`SpendHeatmap`)
 * has pluralised the same noun since it shipped, and four more call sites in
 * the same two features had it right.
 *
 * A bar is a link whose accessible name is its whole reading: a screen reader
 * hears the sentence and a screenshot shows none of it.
 */
test("a month holding one transaction says so in the singular", async ({ page }) => {
  await page.goto("/categories");
  const hrefs = await page
    .locator('a[href^="/categories/"]')
    .evaluateAll((els) => [
      ...new Set(els.map((e) => (e as HTMLAnchorElement).getAttribute("href")!)),
    ]);
  expect(hrefs.length).toBeGreaterThan(0);

  let sawSingular = false;
  for (const href of hrefs) {
    await page.goto(href);
    const labels = await page
      .locator('a[aria-label*=" transaction"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")!));
    for (const label of labels) {
      expect(label, `${href} bar label`).not.toMatch(/\b1 transactions\b/);
      if (/\b1 transaction\b/.test(label)) sawSingular = true;
    }
    if (sawSingular) break;
  }
  expect(sawSingular, "no category month in the fixture holds exactly one row").toBe(true);
});
