import { expect, test, type Page } from "@playwright/test";

/**
 * S3 of the "nothing read-only" program: every name edits inline where it is
 * shown, via the shared <InlineEditableText> primitive — recurring series,
 * categories, and merchants (the account name is covered by
 * zz-account-rename). Each test mutates then fully restores via Undo + a
 * reload assertion so sibling zz-specs see the seed unchanged.
 */

function triggerName(label: string, value: string): string {
  return `${label}: ${value}. Click to edit.`;
}

async function readTriggerValue(page: Page, label: string): Promise<string> {
  const trigger = page.getByRole("button", { name: new RegExp(`^${label}:`) });
  await expect(trigger).toBeVisible();
  const aria = (await trigger.getAttribute("aria-label")) ?? "";
  return aria.replace(new RegExp(`^${label}:\\s*`), "").replace(/\.\s*Click to edit\.$/, "");
}

async function renameAndRestore(page: Page, label: string): Promise<void> {
  const original = await readTriggerValue(page, label);
  const renamed = `${original} (edited)`;

  // Enter saves — optimistic update + a toast that offers Undo
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  const input = page.getByRole("textbox", { name: label });
  await expect(input).toBeVisible();
  await input.fill(renamed);
  await input.press("Enter");
  await expect(page.getByRole("button", { name: triggerName(label, renamed), exact: true })).toBeVisible();
  await expect(page.locator("body")).toContainText("Renamed to");

  // Undo restores; wait for the save to settle (aria-busy clears only after
  // the server confirms) so the reload below proves persistence, not a race
  await page.getByRole("button", { name: "Undo" }).click();
  const restored = page.getByRole("button", { name: triggerName(label, original), exact: true });
  await expect(restored).toBeVisible();
  await expect(restored).not.toHaveAttribute("aria-busy", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: triggerName(label, original), exact: true })).toBeVisible();
}

async function openFirstSeries(page: Page): Promise<void> {
  // series exist after detection; the All tab lists them (zz-recurring-detail's
  // established navigation — detection is idempotent, safe to re-run)
  await page.goto("/recurring");
  await page.getByRole("button", { name: "Detect now" }).click();
  await page.goto("/recurring?tab=all");
  const link = page.locator('a[href^="/recurring/"]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/recurring\/.+/);
}

test("recurring series name edits inline with Undo", async ({ page }) => {
  await openFirstSeries(page);
  await renameAndRestore(page, "Series name");
});

test("category name edits inline with Undo", async ({ page }) => {
  await page.goto("/spending");
  const link = page.locator('a[href^="/categories/"]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/categories\/.+/);
  await renameAndRestore(page, "Category name");
});

test("merchant name edits inline with Undo", async ({ page }) => {
  // reach a merchant page through a ledger row's sheet — open rows until one
  // resolves to a merchant (not every seeded row has one)
  await page.goto("/transactions");
  const sheetTriggers = page.locator('[aria-haspopup="dialog"]');
  await expect(sheetTriggers.first()).toBeVisible();
  const count = Math.min(await sheetTriggers.count(), 8);
  let reached = false;
  for (let i = 0; i < count && !reached; i++) {
    await sheetTriggers.nth(i).click();
    const view = page.getByRole("button", { name: "View merchant →" });
    try {
      await view.waitFor({ state: "visible", timeout: 2000 });
      await view.click();
      await expect(page).toHaveURL(/\/merchants\/.+/);
      reached = true;
    } catch {
      await page.keyboard.press("Escape"); // close the sheet, try the next row
    }
  }
  expect(reached, "no seeded ledger row resolved to a merchant").toBe(true);
  await renameAndRestore(page, "Merchant name");
});
