import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The golden path, driven through the real browser UI: upload statement
 * files → accounts auto-created → periods reconciled → transactions
 * categorized → net worth on the dashboard. Runs LAST (zz- prefix): it
 * mutates the shared e2e database after the visual/a11y specs finish.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");

test.describe.configure({ mode: "serial" });

test("upload statements through the UI and watch the trust layer work", async ({ page }) => {
  await page.goto("/imports");

  await page.setInputFiles('input[name="files"]', [
    path.join(FIXTURES, "capital-one", "3333_transaction_download.ofx"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-04-01_2026-04-30.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-05-01_2026-05-31.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-venturex-2026-04-20_2026-05-19.pdf"),
  ]);
  await page.getByRole("button", { name: "Import", exact: true }).click();

  // the imports ledger shows parsed files and reconciled periods
  await expect(page.getByText("Imported files")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/reconciled periods/i)).toBeVisible();
  const reconciledCount = page
    .locator("p", { hasText: /^Reconciled periods$/ })
    .locator("xpath=following-sibling::p");
  await expect(reconciledCount).toHaveText(/[1-9]/);

  // accounts were auto-created from the files
  await page.goto("/accounts");
  await expect(page.getByText("Capital One 360 Checking")).toBeVisible();
  await expect(page.getByText("Venture X")).toBeVisible();

  // transactions imported and categorized by the seed merchant map
  await page.goto("/transactions");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText(/coverage/i).first()).toBeVisible();

  // the dashboard now shows a real net worth
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /net worth/i })).toBeVisible();
  await expect(page.locator("header + * , main").first()).not.toContainText("No accounts yet");
});

test("a corrupted statement is quarantined with its exact gap and can be accepted", async ({ page }) => {
  await page.goto("/imports");
  await page.setInputFiles('input[name="files"]', [
    path.join(FIXTURES, "discover", "corrupted", "discover-card-2024-11-15_CORRUPTED.pdf"),
  ]);
  await page.getByRole("button", { name: "Import", exact: true }).click();

  await expect(page.getByText("Unreconciled statements")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/gap/i).first()).toBeVisible();

  await page.getByRole("button", { name: "Accept as-is" }).click();
  await expect(page.getByText("Unreconciled statements")).toHaveCount(0);
});
