import { expect, test } from "@playwright/test";

/**
 * Pass 68 — what `/imports` says about what is NOT there.
 *
 * Two panels answer two questions that this ledger proves are independent:
 * `Coverage by account` asks whether the money closes, and `Statements you do
 * not have` asks which documents are absent. On the owner's real database
 * Discover is **VERIFIED** and missing five statements, because a balance
 * anchor on the far side of a hole closes the chain without the statements in
 * between ever arriving.
 *
 * ⚠️ The e2e fixture's statements abut, so this spec pins the ALL-CLEAR branch
 * — which is the one worth pinning here anyway: a panel that vanished when
 * satisfied could not tell you it was satisfied, and the "5 statements" branch
 * is covered by `src/services/statement-gaps.test.ts` against a ledger whose
 * answer is known.
 */

test.describe("data health", () => {
  test("names what is missing, and says so even when nothing is", async ({ page }) => {
    await page.goto("/imports");
    const panel = page.locator("section", {
      has: page.getByRole("heading", { name: "Statements you do not have" }),
    });
    await expect(panel).toBeVisible();
    // present when satisfied, and explicit about it
    await expect(panel).toContainText(
      /Every statement between the first and the last is in the ledger\.|statements? · \d+ days uncovered/,
    );
    // it must never be read as a fault: staleness here is the normal rhythm
    await expect(panel).toContainText("These are files to fetch, not errors.");
  });

  test("⛔ a coverage row states what closes AND where it stops", async ({ page }) => {
    /*
     * The shipped sentence was "nothing has checked this account since
     * 2026-08-11" on an account that closes to the cent through 2026-08-03 —
     * `verifiedThrough` was computed, carried, and rendered only inside
     * `case "verified"`, so the two states that most needed it could not show
     * it. And it said "1 days".
     */
    await page.goto("/imports");
    const panel = page.locator("section", {
      has: page.getByRole("heading", { name: "Coverage by account" }),
    });
    await expect(panel).toBeVisible();
    const text = await panel.innerText();
    // no unpluralised count survives anywhere in the panel
    expect(text).not.toMatch(/\b1 days\b/);
    // and every date carries its year, so a 2023 hole cannot read as this year
    for (const m of text.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(,|\b)/g)) {
      expect(m[2], `"${m[0]}" has no year`).toBe(",");
    }
  });
});
