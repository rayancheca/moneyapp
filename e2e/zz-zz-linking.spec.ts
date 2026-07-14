import { expect, test, type Page } from "@playwright/test";

/**
 * S5 "linkable": pair two transactions as one transfer and attach a
 * transaction to a recurring series — from the transaction sheet, candidates
 * loaded on demand. Uses its own two cash wallets so the seeded ledger and
 * its sibling specs stay untouched.
 */

async function makeWallet(page: Page, name: string): Promise<void> {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New cash wallet" }).click();
  await page.getByLabel("Wallet name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
}

async function addTxn(
  page: Page,
  wallet: string,
  amount: string,
  direction: "Spent" | "Received",
  description: string,
): Promise<void> {
  const walletRow = page.getByRole("listitem").filter({ hasText: wallet });
  await walletRow.getByRole("button", { name: "Add transaction" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Amount").fill(amount);
  await sheet.getByLabel("Direction").selectOption({ label: direction });
  await sheet.getByLabel("Description").fill(description);
  await sheet.getByRole("button", { name: "Add transaction" }).click();
  await expect(page.locator("p", { hasText: new RegExp(`Added to ${wallet}`) })).toBeVisible();
}

test("link two transactions as a transfer from the sheet, then unlink", async ({ page }) => {
  await makeWallet(page, "Left pocket");
  await makeWallet(page, "Right pocket");
  await addTxn(page, "Left pocket", "40", "Spent", "Moved to right pocket");
  await addTxn(page, "Right pocket", "40", "Received", "Received from left pocket");

  // open the outflow's sheet
  await page.goto("/transactions?q=Moved+to+right+pocket");
  await page.locator('[aria-haspopup="dialog"]').first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  // disclose candidates and pick the counterpart
  await sheet.getByRole("button", { name: "Link as transfer…" }).click();
  const candidate = sheet.getByRole("button", { name: /Received from left pocket/i });
  await expect(candidate).toBeVisible();
  await candidate.click();
  await expect(page.locator("body")).toContainText("Linked as transfer");

  // the link persisted: the Transfer checkbox reflects it and the counterpart shows
  await expect(sheet.getByRole("checkbox", { name: "Transfer" })).toBeChecked();
  await sheet.getByRole("button", { name: "Show counterpart" }).click();
  await expect(sheet.getByText(/received from left pocket/i)).toBeVisible();

  // unlink dissolves the pair
  await sheet.getByRole("button", { name: "Unlink transfer" }).click();
  await expect(page.locator("body")).toContainText("Transfer unlinked");
  await expect(sheet.getByRole("checkbox", { name: "Transfer" })).not.toBeChecked();
});

test("attach a transaction to a recurring series from the sheet, then detach", async ({ page }) => {
  // series exist after detection (idempotent, same as zz-recurring-detail)
  await page.goto("/recurring");
  await page.getByRole("button", { name: "Detect now" }).click();

  await makeWallet(page, "Series pocket");
  await addTxn(page, "Series pocket", "12", "Spent", "Maybe a subscription");

  await page.goto("/transactions?q=Maybe+a+subscription");
  await page.locator('[aria-haspopup="dialog"]').first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  await sheet.getByRole("button", { name: "Attach to recurring series…" }).click();
  const firstSeries = sheet.locator('section:has-text("Attach to series") ul button').first();
  await expect(firstSeries).toBeVisible();
  const seriesName = (await firstSeries.locator("span").first().textContent()) ?? "";
  await firstSeries.click();
  await expect(page.locator("body")).toContainText("Attached to");

  // linked state renders with a Detach affordance; detach restores
  const detach = sheet.getByRole("button", { name: "Detach" });
  await expect(detach).toBeVisible();
  await expect(sheet.getByText(seriesName, { exact: false }).first()).toBeVisible();
  await detach.click();
  await expect(page.locator("body")).toContainText("Detached from");
  await expect(sheet.getByRole("button", { name: "Attach to recurring series…" })).toBeVisible();
});
