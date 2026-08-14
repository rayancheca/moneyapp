import { expect, test } from "@playwright/test";

/**
 * The Statement schedule panel on /imports, asserted as TEXT.
 *
 * `/imports` carries no visual baseline at all, and pass 51 established that a
 * baseline would not have helped anyway: at `maxDiffPixelRatio: 0.001` a
 * screenshot cannot resolve a date changing by a day. Every figure this panel
 * prints is a prediction, so every figure is asserted in words.
 *
 * Read-only (navigate + read), and named without a `zz-` prefix so it runs on
 * the pristine seed before any spec mutates it. Dates come from the statements
 * set A imports, read at E2E_FAKE_TODAY = 2026-07-08.
 *
 * ⚠️ ALL SEVEN accounts are inside their cycle here, so `Ready to pull` and
 * `Behind` cannot be rendered by any Playwright run on this fixture. That is
 * exactly why their copy lives in `src/lib/statement-cadence.ts`, under the
 * 100%-branch gate, rather than in the panel — do not "fix" this by asserting
 * those strings here; they would never execute.
 */
test("the statement schedule states each account's measured cycle", async ({ page }) => {
  await page.goto("/imports");

  const card = page.locator("section", {
    has: page.getByRole("heading", { name: "Statement schedule" }),
  });
  await expect(card).toHaveCount(1);

  // the fixture is uploaded through the end of June / early July, so nothing is
  // outstanding — and the panel must say so calmly rather than in warning colour
  await expect(card).toContainText("nothing to download — every account is inside its own cycle");

  const rows = await card.locator("li").allInnerTexts();
  const flat = rows.map((t) => t.replace(/\s+/g, " ").trim());

  /*
   * Every row: the rhythm measured from the account's own closes, then the last
   * close and the next one predicted from it. Four of these accounts close on
   * the LAST DAY of the month — the shape a 30-day step gets wrong — and the
   * panel has to name that rather than call it "the 30th".
   */
  expect(flat).toEqual([
    "Chase Freedom Unlimited On schedule closes around the 4th, from 12 statements last one closed Jul 4, 4 days ago · next closes Aug 4",
    "Chase Savings On schedule closes on the last day of the month, from 12 statements last one closed Jun 30, 8 days ago · next closes Jul 31",
    "Chase Total Checking On schedule closes on the last day of the month, from 12 statements last one closed Jun 30, 8 days ago · next closes Jul 31",
    "Discover it Card On schedule closes around the 14th, from 12 statements last one closed Jun 14, 24 days ago · next closes Jul 14",
    "Robinhood Brokerage On schedule closes on the last day of the month, from 12 statements last one closed Jun 30, 8 days ago · next closes Jul 31",
    "SoFi Checking On schedule closes on the last day of the month, from 12 statements last one closed Jun 30, 8 days ago · next closes Jul 31",
    "SoFi Savings On schedule closes on the last day of the month, from 12 statements last one closed Jun 30, 8 days ago · next closes Jul 31",
  ]);

  // an account that has never issued a statement is absent, not flagged: the
  // wallet is a physical one and nagging about its statements would be invented
  await expect(card).not.toContainText("Cash on Hand");
});

/**
 * The dashboard half. It lists ONLY accounts with a close behind them, so on
 * this fixture — where all seven are inside their cycle — the renderable branch
 * is the all-clear. That branch is worth pinning precisely because it is a
 * claim: a teaser that vanished when satisfied could not make it, and on a home
 * screen the absence of a warning has to mean something.
 *
 * ⚠️ The `due` / `behind` rows cannot be reached from any Playwright run here.
 * Their words live in `src/lib/statement-cadence.ts` (`pullDemand`), under the
 * 100%-branch gate — do not try to assert them from this file.
 */
test("the dashboard says statements are handled rather than going quiet", async ({ page }) => {
  await page.goto("/");

  // the REGION landmark, not `section:has(heading)` — the activity hub is an
  // ancestor <section> that also contains this heading, so `has:` matches two
  const teaser = page.getByRole("region", { name: "Statements", exact: true });
  await expect(teaser).toHaveCount(1);
  await expect(teaser).toContainText("Every account is inside its own cycle — nothing to download.");

  // no count chip and no import prompt while there is nothing outstanding
  await expect(teaser.getByRole("link", { name: "Schedule →" })).toBeVisible();
  await expect(teaser.getByRole("link", { name: "Import →" })).toHaveCount(0);

  // and it drills to the panel that carries the full reasoning
  await teaser.getByRole("link", { name: "Schedule →" }).click();
  await expect(page.getByRole("heading", { name: "Statement schedule" })).toBeVisible();
});
