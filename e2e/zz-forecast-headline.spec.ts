import { expect, test, type Page } from "@playwright/test";

/**
 * The forecast card's HEADLINE is the schedule, not the prediction.
 *
 * ⛔ This spec exists because the owner had to say it twice. The card shipped
 * with the total on top and the committed/variable split disclosed in a band
 * beneath it, and his reply was: *"projected income is 1047*4 a month.
 * projected spend is the actual monthlies i have you so around 3.5k"*. The
 * tiles are what the eye lands on, so the tiles have to be the commitments.
 *
 * ⚠️ Nothing behavioural covered this card before — the five figures had only
 * PIXEL baselines, and a baseline cannot tell you whether "$4,188.00" is sitting
 * under "Projected income" or somewhere else entirely. It pins that the number
 * did not move, which is exactly the wrong question when the number is under the
 * wrong label. That is why this asserts by LABEL and by RELATIONSHIP rather than
 * by literal amount: a seed change should not be able to make it lie, and a
 * regression that puts the total back on top must not be able to make it pass.
 */

/** "$1,234.56" / "−$1,234.56" / "+$1,234.56" → cents, sign included. */
function toCents(text: string): number {
  const t = text.trim();
  const negative = t.startsWith("−") || t.startsWith("-");
  const digits = Number(t.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(digits)) throw new Error(`unparseable money: ${JSON.stringify(text)}`);
  return Math.round(digits * 100) * (negative ? -1 : 1);
}

/**
 * The value of one `<dt>`/`<dd>` pair, read from the card's own text.
 *
 * Deliberately NOT `boundingBox`-style value-returning navigation without a
 * wait: `toBeVisible()` retries to the expect timeout first, which is the guard
 * `e2e/box-helpers.ts` was written about.
 */
async function statCents(page: Page, scope: string, label: string): Promise<number> {
  const dt = page.locator(`${scope} dt`).filter({ hasText: new RegExp(`^${label}$`, "i") }).first();
  await expect(dt, `"${label}" should be on the forecast card`).toBeVisible();
  const dd = dt.locator("xpath=following-sibling::dd[1]");
  await expect(dd).toBeVisible();
  return toCents((await dd.innerText()).trim());
}

/**
 * One labelled part of the composition band — "Committed $3,567.60 (9 lines)".
 * Returns a positive MAGNITUDE, which is how the band prints it: the direction
 * is carried by the "Money in"/"Money out" heading above, not by a sign.
 */
async function bandPartCents(page: Page, label: string): Promise<number> {
  const part = page
    .locator(`${CARD} span`)
    .filter({ hasText: new RegExp(`^${label}\\s*\\$`) })
    .first();
  await expect(part, `the band should carry a "${label}" part`).toBeVisible();
  const text = (await part.innerText()).replace(label, "").replace(/\(.*\)/, "");
  return toCents(text);
}

const CARD = "section:has(h2:text-matches('^Forecast'))";
const PACE = `${CARD} div:has(> h3:text-matches('recent pace', 'i'))`;

test.describe("the forecast headline is the schedule", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/recurring");
    await expect(page.locator(CARD).first()).toBeVisible();
  });

  /**
   * ⚠️ The arithmetic alone is NOT enough here, and mutation proved it: `net ===
   * income + spending` holds for the committed reading and for the total
   * reading alike, so a version of this test that stopped there stayed green
   * while the tiles showed the very thing he objected to. The assertion that
   * bites is the tiles matching the BAND's committed/scheduled parts to the
   * cent — that is only true of one of the two readings.
   */
  test("the headline tiles are the committed figures, not the totals", async ({ page }) => {
    const income = await statCents(page, CARD, "Projected income");
    const spending = await statCents(page, CARD, "Projected spending");
    const net = await statCents(page, CARD, "Projected net");
    expect(net).toBe(income + spending);

    expect(spending).toBe(-(await bandPartCents(page, "Committed")));
    expect(income).toBe(await bandPartCents(page, "Scheduled"));
  });

  /**
   * The regression that started this. If the headline ever goes back to being
   * income-plus-pace and spending-plus-pace, these two comparisons flip.
   */
  test("the pace row carries MORE spending than the headline does", async ({ page }) => {
    const headlineSpend = await statCents(page, CARD, "Projected spending");
    const paceSpend = await statCents(page, PACE, "Spending");

    // both are negative; the pace row is the larger outflow
    expect(paceSpend).toBeLessThan(headlineSpend);
    expect(headlineSpend).toBeLessThanOrEqual(0);
  });

  test("the pace row is a complete reading of its own, and a different one", async ({ page }) => {
    const paceIncome = await statCents(page, PACE, "Income");
    const paceSpend = await statCents(page, PACE, "Spending");
    const paceNet = await statCents(page, PACE, "Net");
    expect(paceNet).toBe(paceIncome + paceSpend);

    const headlineNet = await statCents(page, CARD, "Projected net");
    expect(paceNet).not.toBe(headlineNet);
  });

  /**
   * Two end-of-month cash figures on one card is a real hazard — this app has
   * been bitten before by one quantity with two definitions. What keeps it safe
   * is that each belongs to a complete reading and each is labelled with the
   * assumption behind it, so this pins that BOTH are present and that they
   * differ by exactly the difference between the two nets.
   */
  test("each reading carries its own end-of-month cash", async ({ page }) => {
    const headlineCash = await statCents(page, CARD, "EOM cash");
    const paceCash = await statCents(page, PACE, "EOM cash");
    const headlineNet = await statCents(page, CARD, "Projected net");
    const paceNet = await statCents(page, PACE, "Net");

    expect(headlineCash - paceCash).toBe(headlineNet - paceNet);
  });

  test("the card says out loud that the headline is bills and pay only", async ({ page }) => {
    await expect(page.locator(CARD).getByText(/bills and scheduled pay only/i)).toBeVisible();
  });
});
