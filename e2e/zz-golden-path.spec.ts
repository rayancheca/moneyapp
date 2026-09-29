import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectBaseline } from "./expect-baseline";

/**
 * The golden path, driven through the real browser UI: upload statement
 * files → accounts auto-created → periods reconciled → transactions
 * categorized → net worth on the dashboard. Runs LAST (zz- prefix): it
 * mutates the shared e2e database after the visual/a11y/interaction specs
 * finish. The base is pre-seeded with fixture set A (see seed-helpers.ts),
 * so this spec uploads only the RESERVED set B (capital-one + the corrupted
 * discover statement) and asserts relative to captured before-values.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");

test.describe.configure({ mode: "serial" });

test("upload statements through the UI and watch the trust layer work", async ({ page }) => {
  await page.goto("/imports");

  // the seeded base already shows reconciled periods — capture the count so
  // the assertion measures THIS upload's contribution, not set A's
  const reconciledCount = page
    .locator("p", { hasText: /^Reconciled periods$/ })
    .locator("xpath=following-sibling::p");
  const reconciledBefore = Number(await reconciledCount.innerText());

  await page.setInputFiles('input[name="files"]', [
    path.join(FIXTURES, "capital-one", "3333_transaction_download.ofx"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-04-01_2026-04-30.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-05-01_2026-05-31.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-venturex-2026-04-20_2026-05-19.pdf"),
  ]);
  await page.getByRole("button", { name: "Import", exact: true }).click();

  // completion signal: the uploaded set-B file appears in the imports ledger
  // (the "Imported files" card itself pre-exists on the seeded base). Scoped to
  // the ledger's own cell: each row's un-import confirmation names its file too
  // (in the headline and in the button's sr-only description), so a bare text
  // match is three elements now. The cell is the assertion that was meant.
  await expect(
    page.getByRole("cell", { name: "3333_transaction_download.ofx", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/reconciled periods/i)).toBeVisible();
  await expect
    .poll(async () => Number(await reconciledCount.innerText()))
    .toBeGreaterThan(reconciledBefore);

  // accounts were auto-created from the files, grouped under their institution
  // section (§7.2 manage view: rows are always visible, editable, reorderable)
  await page.goto("/accounts");
  const capOneCard = page.getByRole("region", { name: "Capital One" });
  await expect(capOneCard).toBeVisible();
  await expect(capOneCard.getByText("360 Checking")).toBeVisible();
  await expect(capOneCard.getByText("Venture X")).toBeVisible();
  // each account row exposes its edit + reorder affordances
  await expect(capOneCard.getByRole("button", { name: /Edit 360 Checking/ })).toBeVisible();
  await expectBaseline(page).toHaveScreenshot("accounts-managed-light.png", { fullPage: true });

  // rows link into the enriched account detail page
  await capOneCard.getByRole("link", { name: /360 Checking/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /360 Checking/ })).toBeVisible();
  await expect(page.getByText("Balance history")).toBeVisible();
  await expectBaseline(page).toHaveScreenshot("account-detail-light.png", { fullPage: true });
  await page.getByRole("button", { name: /switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectBaseline(page).toHaveScreenshot("account-detail-dark.png", { fullPage: true });
  await page.getByRole("button", { name: /switch to light theme/i }).click();

  // transactions imported and categorized by the seed merchant map
  await page.goto("/transactions");
  // the Stage-1 ledger is date-grouped rows (buttons that open the sheet), not a table
  await expect(page.locator('button[aria-haspopup="dialog"]').first()).toBeVisible();
  await expect(page.getByText(/coverage/i).first()).toBeVisible();

  // the dashboard now shows a real net worth
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /net worth/i })).toBeVisible();
  await expect(page.locator("header + * , main").first()).not.toContainText("No accounts yet");
});

test("a corrupted statement is quarantined with its exact gap and can be accepted", async ({ page }) => {
  // set A deliberately withholds the clean 2024-11-15 → 2024-12-14 Discover
  // statement (seed-helpers.ts), so this CORRUPTED twin is the period's only
  // source and its printed-balance gap is genuinely detectable. The seeded
  // base is gap-free (guarded in global-setup), so "Unreconciled statements"
  // below can only be this upload.
  await page.goto("/imports");
  await page.setInputFiles('input[name="files"]', [
    path.join(FIXTURES, "discover", "corrupted", "discover-card-2024-11-15_CORRUPTED.pdf"),
  ]);
  await page.getByRole("button", { name: "Import", exact: true }).click();

  await expect(page.getByText("Unreconciled statements")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/gap/i).first()).toBeVisible();

  // gated: accepting a gap is a one-way door, so the confirm states the money
  // being kept before anything is written, and the card survives until then
  await page.getByRole("button", { name: "Accept as-is" }).click();
  const gate = page.getByRole("dialog");
  // .first(): the measured line and the button's sr-only description both say it
  await expect(gate.getByText("Gap kept, permanently").first()).toBeVisible();
  await expect(page.getByText("Unreconciled statements")).toHaveCount(1);
  await gate.getByRole("button", { name: "Accept the gap" }).click();

  await expect(page.getByText("Unreconciled statements")).toHaveCount(0);
});
