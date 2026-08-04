import { expect, test } from "@playwright/test";

/**
 * Cash wallets (ux-overhaul-plan §3.7): create an import-free wallet and add a
 * manual transaction that derives a balance from the seeded $0 opening anchor.
 * Runs LAST (zz-) because it creates an account + rows in the shared database.
 */

test("create a cash wallet, add a transaction, and see a derived balance", async ({ page }) => {
  await page.goto("/accounts");

  await page.getByRole("button", { name: "New cash wallet" }).click();
  await page.getByLabel("Wallet name").fill("Pocket cash");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const walletRow = page.getByRole("listitem").filter({ hasText: "Pocket cash" });
  await expect(walletRow).toBeVisible();
  await expect(walletRow).toContainText("$0.00"); // the $0 opening anchor derives immediately

  // add a $20 cash spend
  await walletRow.getByRole("button", { name: "Add transaction" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Amount").fill("20");
  await sheet.getByLabel("Description").fill("Coffee");
  await sheet.getByRole("button", { name: "Add transaction" }).click();

  await expect(page.locator("p", { hasText: /Added to Pocket cash/ })).toBeVisible();
  // The manual row moved the DERIVED balance off $0 (spent $20 → −$20). Asserted
  // positively on the figure itself: the row also carries an "Opened with $0.00"
  // subtitle now, and a "row does not contain $0.00" proxy read that as failure
  // while the balance was in fact correct.
  await expect(walletRow).toContainText("-$20.00");
  // the OPENING is still $0 — the transaction moved the balance, not the anchor
  await expect(walletRow).toContainText("Opened with");
  await expect(walletRow.getByRole("button", { name: "Opening cash for Pocket cash" })).toHaveAttribute(
    "aria-label",
    /\$0\.00/,
  );
});
