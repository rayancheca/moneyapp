import { expect, test } from "@playwright/test";

/**
 * The ledger-row expander (S4 of "nothing read-only"): notes edit inline on
 * any row; date / amount / description edit inline on MANUAL rows only —
 * imported rows render their facts read-only ("audit trail"). Named zz-zz so
 * it runs after zz-wallets-style specs; it creates its own wallet + manual row
 * and leaves the ledger's imported rows untouched (notes are restored).
 */

test("manual txn edits inline in the expander; imported rows stay immutable", async ({ page }) => {
  // create a dedicated wallet + manual row
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New cash wallet" }).click();
  await page.getByLabel("Wallet name").fill("Expander wallet");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const walletRow = page.getByRole("listitem").filter({ hasText: "Expander wallet" });
  await expect(walletRow).toBeVisible();
  await walletRow.getByRole("button", { name: "Add transaction" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Amount").fill("20");
  await sheet.getByLabel("Description").fill("Expander coffee");
  await sheet.getByRole("button", { name: "Add transaction" }).click();
  await expect(page.locator("p", { hasText: /Added to Expander wallet/ })).toBeVisible();

  // find the manual row in the ledger and expand it
  await page.goto("/transactions?q=Expander+coffee");
  const expandBtn = page.getByRole("button", { name: /^Expand details for/ }).first();
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  // amount edits through the string-math parser: -20 → -25.50
  await page.getByRole("button", { name: /^Amount:/ }).click();
  const amountInput = page.getByRole("textbox", { name: "Amount" });
  await amountInput.fill("(25.50)");
  await amountInput.press("Enter");
  await expect(page.getByRole("button", { name: /^Amount: -\$25\.50/ })).toBeVisible();
  await expect(page.locator("body")).toContainText("Amount set to");

  // date edits with validation: garbage is rejected, a real date saves
  await page.getByRole("button", { name: /^Transaction date:/ }).click();
  const dateInput = page.getByRole("textbox", { name: "Transaction date" });
  await dateInput.fill("not-a-date");
  await dateInput.press("Enter");
  await expect(page.getByText("Use a real date, YYYY-MM-DD")).toBeVisible();
  await dateInput.fill("2026-07-01");
  await dateInput.press("Enter");
  await expect(page.getByRole("button", { name: /^Transaction date: 2026-07-01/ })).toBeVisible();

  /*
   * Notes edit inline on any row.
   *
   * The click is retried rather than issued once: the date save above ends in a
   * `router.refresh()`, and when that lands React re-renders the expander and
   * REPLACES this button's node. A single click can resolve the locator, lose the
   * node to the refresh, and land on a detached element — a no-op that then times
   * out waiting for an input that never opens. Latent since the expander shipped;
   * it surfaced once the suite got slower, and it fails ~3 runs in 4 rather than
   * cleanly, which is the signature of exactly this race.
   */
  await expect(async () => {
    await page.getByRole("button", { name: /^Notes:/ }).click();
    await expect(page.getByRole("textbox", { name: "Notes" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const notesInput = page.getByRole("textbox", { name: "Notes" });
  await notesInput.fill("paid in cash");
  await notesInput.press("Enter");
  await expect(page.getByRole("button", { name: /^Notes: paid in cash/ })).toBeVisible();

  // reload — everything persisted (not just optimistic)
  await page.reload();
  await page.getByRole("button", { name: /^Expand details for/ }).first().click();
  await expect(page.getByRole("button", { name: /^Amount: -\$25\.50/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transaction date: 2026-07-01/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Notes: paid in cash/ })).toBeVisible();
});

test("an imported row's expander shows read-only facts and the audit-trail note", async ({ page }) => {
  // scope to an imported account — wallet specs may have put manual rows on top
  await page.goto("/transactions");
  await page.getByLabel("Account").selectOption({ label: "Chase Total Checking" });
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/account=/);
  const expandBtn = page.getByRole("button", { name: /^Expand details for/ }).first();
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  // imported rows: no editable Amount/date triggers, and the immutability note shows
  await expect(page.locator("body")).toContainText("Imported row — date and amount are the audit trail");
  await expect(page.getByRole("button", { name: /^Amount:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Transaction date:/ })).toHaveCount(0);
  // notes still edit inline — mutate then restore so the seed stays pristine
  await page.getByRole("button", { name: /^Notes:/ }).click();
  const notesInput = page.getByRole("textbox", { name: "Notes" });
  await notesInput.fill("temp note");
  await notesInput.press("Enter");
  await expect(page.getByRole("button", { name: /^Notes: temp note/ })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^Notes: temp note/ })).toHaveCount(0);
});
