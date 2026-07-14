import { expect, test, type Page } from "@playwright/test";

/**
 * The inline <InlineEditableText> primitive on the account detail page (S2 of
 * the "nothing read-only" program): the account name is editable right where
 * it's shown. Click → input; Escape cancels; Enter saves optimistically with a
 * Toast+Undo. This test mutates then fully restores the name (via Undo, then a
 * reload assertion) so sibling zz-specs see the seed unchanged.
 */

const TRIGGER = /^Account name:/;

async function openFirstAccount(page: Page): Promise<string> {
  await page.goto("/accounts");
  const link = page.locator('a[href^="/accounts/"]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/accounts\/.+/);
  const trigger = page.getByRole("button", { name: TRIGGER });
  await expect(trigger).toBeVisible();
  const label = (await trigger.getAttribute("aria-label")) ?? "";
  return label.replace(/^Account name:\s*/, "").replace(/\.\s*Click to edit\.$/, "");
}

test("account name edits inline — Escape cancels, Enter saves, Undo restores", async ({ page }) => {
  const original = await openFirstAccount(page);
  const rest = (name: string) => `Account name: ${name}. Click to edit.`;

  // Escape cancels without persisting
  await page.getByRole("button", { name: TRIGGER }).click();
  const input = page.getByRole("textbox", { name: "Account name" });
  await expect(input).toBeVisible();
  await input.fill("Throwaway Draft");
  await input.press("Escape");
  await expect(page.getByRole("button", { name: rest(original), exact: true })).toBeVisible();

  // Enter saves — optimistic update + a toast that offers Undo
  const renamed = `${original} (edited)`;
  await page.getByRole("button", { name: TRIGGER }).click();
  const input2 = page.getByRole("textbox", { name: "Account name" });
  await input2.fill(renamed);
  await input2.press("Enter");
  await expect(page.getByRole("button", { name: rest(renamed), exact: true })).toBeVisible();
  await expect(page.locator("body")).toContainText("Renamed to");

  // Undo restores the original name (and keeps the seed pristine for siblings)
  await page.getByRole("button", { name: "Undo" }).click();
  const restored = page.getByRole("button", { name: rest(original), exact: true });
  await expect(restored).toBeVisible();
  // wait for the undo save to settle — reload must prove persistence, not race it
  await expect(restored).not.toHaveAttribute("aria-busy", "true");

  // the restore is persisted, not just optimistic
  await page.reload();
  await expect(page.getByRole("button", { name: rest(original), exact: true })).toBeVisible();
});
