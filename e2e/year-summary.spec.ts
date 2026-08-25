import { expect, test } from "@playwright/test";

/**
 * `/summary/[year]` — the printable year summary.
 *
 * The assertions here are STRUCTURAL, not figure-by-figure: the fixture's
 * categories and the real ledger's differ (the fixture predates Tutoring,
 * Financial Aid, Family pass-through and Gambling), so pinning amounts would
 * only assert the fixture back to itself. What is worth pinning is the property
 * the page exists for — that earned money and money-you-did-not-earn are never
 * added together — plus the disclaimer, which is the sentence that makes it
 * safe to print.
 *
 * Figures are pinned in `src/lib/year-summary.test.ts` and
 * `src/services/year-summary.test.ts` against measured 2025 values.
 */

const MONEY = /^-?−?\$[\d,]+\.\d{2}$/;

test.describe("year summary", () => {
  test("says what it is before it says any number", async ({ page }) => {
    await page.goto("/summary/2026");
    const disclaimer = page.getByText(/not tax advice/i);
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText("not a tax document");
  });

  test("the three headline figures are distinct and all real money", async ({ page }) => {
    await page.goto("/summary/2026");
    for (const label of ["Earned", "All money in", "Passed through"]) {
      await expect(page.getByRole("term").filter({ hasText: new RegExp(`^${label}$`, "i") })).toBeVisible();
    }
    const figures = await page.locator("dl dd.figures").first().innerText();
    expect(figures.trim()).toMatch(MONEY);
  });

  /**
   * The property the whole page exists for. `Earned` counts wages, tutoring and
   * savings interest; `All money in` adds what arrived without being earned. If
   * a year holds any not-earned money the two MUST differ — collapsing them is
   * the misstatement this page was built to prevent.
   */
  test("earned and all-money-in are computed apart, not aliases", async ({ page }) => {
    await page.goto("/summary/2026");
    const values = await page.locator("dl dd.figures").allInnerTexts();
    expect(values.length).toBeGreaterThanOrEqual(3);
    const [earned, allIn] = values;
    expect(earned).toMatch(MONEY);
    expect(allIn).toMatch(MONEY);
    const num = (t: string) => Number(t.replace(/[^\d.]/g, ""));
    // all money in can never be LESS than what was earned
    expect(num(allIn!)).toBeGreaterThanOrEqual(num(earned!));
  });

  test("every line states the rule it stands on and how many rows are behind it", async ({ page }) => {
    await page.goto("/summary/2026");
    const rows = page.getByText(/\d+ rows? · (\d+ source documents?|derived)/);
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("a year with nothing imported says so rather than rendering zeroes", async ({ page }) => {
    await page.goto("/summary/1999");
    await expect(page.getByText(/Nothing imported for 1999/)).toBeVisible();
    await expect(page.getByText(MONEY)).toHaveCount(0);
  });

  /**
   * The route segment is user input and reaches an engine that throws on a bad
   * year, so the page rejects anything that is not four digits before calling it.
   *
   * ⚠️ Asserted on the RENDER, not the status code. `notFound()` from a
   * force-dynamic page returns HTTP 200 with the not-found body throughout this
   * app — measured, `/accounts/nonexistent-id` does the same, while a genuinely
   * unmatched path like `/no-such-route` returns 404. That is pre-existing
   * app-wide behaviour and not this route's to fix; asserting 404 here would
   * have been a test failing on someone else's defect.
   */
  test("a year that is not a year is not a page", async ({ page }) => {
    await page.goto("/summary/banana");
    await expect(page.getByText(/Nothing lives at this address/)).toBeVisible();
    await expect(page.getByText(/not tax advice/i)).toHaveCount(0);
  });

  test("a four-digit year the ledger has never seen still renders its own empty state", async ({
    page,
  }) => {
    await page.goto("/summary/1999");
    await expect(page.getByText(/Nothing lives at this address/)).toHaveCount(0);
  });

  test("other years are reachable from the page", async ({ page }) => {
    await page.goto("/summary/2026");
    const nav = page.getByRole("navigation", { name: "Other years" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "2025" })).toHaveAttribute("href", "/summary/2025");
    // the current year is marked, not linked away to itself unmarked
    await expect(nav.getByRole("link", { name: "2026" })).toHaveAttribute("aria-current", "page");
  });

  /**
   * The print stylesheet is the reason this route exists as its own page. Two
   * things it must do, both of which the first two drafts got wrong: hide the
   * app shell, and NOT hide the page's own header — which is also a <header>,
   * and carries the year and the disclaimer.
   */
  test("printing hides the app shell and keeps the sheet", async ({ page }) => {
    await page.goto("/summary/2026");
    await page.emulateMedia({ media: "print" });

    await expect(page.locator("aside")).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Other years" })).toBeHidden();

    // the sheet, its title and its disclaimer all survive
    await expect(page.getByRole("heading", { level: 1, name: "2026" })).toBeVisible();
    await expect(page.getByText(/not tax advice/i)).toBeVisible();
  });

  test("printing gives the sheet the whole page width", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/summary/2026");
    await page.emulateMedia({ media: "print" });
    // the shell is a 13.5rem/1fr grid; hiding the aside alone leaves the sheet
    // auto-placed into the 216px first column, which is what draft two printed
    const width = await page.locator(".summary-sheet").evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(900);
  });
});
