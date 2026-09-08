import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";

/**
 * Two sentences a reader can check by counting.
 *
 * ⛔ Both assertions are on TEXT, not pixels — and both defects they pin were
 * invisible to the visual gate: all 598 baselines stayed green at
 * `maxDiffPixels: 0` through every fix in this pass. A chart bar's `aria-label`
 * is heard and never drawn, and the terrain's Table lens is in no baseline at
 * all.
 *
 * ⚠️ THREE SIBLING FIXES ARE NOT HERE, because a test that cannot fail is worse
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

const DB_PATH = "data/e2e.db";

function readFixture<T>(sql: string): T[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/**
 * 🔴 The Terrain's Table lens is captioned "Every account from its first
 * reconstructed day", and the chart's accessible name sends a reader to it for
 * "exact figures". Its First-day column read `vertices[0]` — the first of the
 * ~72 EVENLY SAMPLED columns the terrain draws, which for an account that
 * opened between two samples is not its first day at all. Nine of the owner's
 * eleven rows were wrong, SoFi Savings by $8,756.08.
 *
 * ⚠️ The visual gate saw none of it: this table is in no baseline, and all 598
 * screenshots stayed green through the fix. The fixture's accounts open 0, 10,
 * 26 and 27 days into a 765-day span against a sampling stride of ~7, so at
 * least one of them opens between samples — which is what makes this assertion
 * able to fail.
 */
test("the terrain table names each account's own first day", async ({ page }) => {
  const opening = readFixture<{ name: string; day: string; cents: number }>(`
    select a.name as name, min(d.day) as day,
           (select x.balance_cents from daily_balances x
             where x.account_id = a.id order by x.day limit 1) as cents
    from accounts a join daily_balances d on d.account_id = a.id
    group by a.id
  `);
  expect(opening.length).toBeGreaterThan(1);

  await page.goto("/?chart=terrain&terrainLens=table");
  const rows = page.locator("table tbody tr");
  await expect(rows.first()).toBeVisible();

  const money = (cents: number): string =>
    `${cents < 0 ? "-" : ""}$${Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const text = await rows.allInnerTexts();
  for (const o of opening) {
    const row = text.find((t) => t.includes(o.name));
    expect(row, `no terrain row for ${o.name}`).toBeDefined();
    // a card is drawn below the rule, so the terrain negates the owed frame
    const drawn = row!.includes("Owed") ? -Math.abs(o.cents) : o.cents;
    const month = `${MONTHS[Number(o.day.slice(5, 7)) - 1]} ${o.day.slice(0, 4)}`;
    expect(row, `${o.name} first day`).toContain(`${month} · ${money(drawn)}`);
  }
});
