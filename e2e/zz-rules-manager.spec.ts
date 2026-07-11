import { expect, test } from "@playwright/test";

/**
 * The rules manager (ux-overhaul-plan §3.4): toggle a rule and reorder its
 * precedence. Runs LAST (zz-, sorts after the other zz- specs) because it
 * mutates the shared seeded rules; the read-only settings visual baseline was
 * captured earlier against the pristine seeded rule set.
 */

test.describe.configure({ mode: "serial" });

const ruleItems = (page: import("@playwright/test").Page) =>
  page.getByRole("listitem").filter({ hasText: /When a transaction/ });

test("toggle a rule off and back on", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();

  const first = ruleItems(page).first();
  await expect(first).toBeVisible();

  await first.getByRole("button", { name: "Disable" }).click();
  await expect(first.getByRole("button", { name: "Enable" })).toBeVisible();

  await first.getByRole("button", { name: "Enable" }).click();
  await expect(first.getByRole("button", { name: "Disable" })).toBeVisible();
});

test("reorder precedence with the up/down controls", async ({ page }) => {
  await page.goto("/settings");
  const items = ruleItems(page);
  expect(await items.count()).toBeGreaterThanOrEqual(2); // at least two seeded rules

  const firstSentence = await items.first().locator("p").first().innerText();

  // lower the leading rule's precedence — it moves to second
  await items.first().getByRole("button", { name: /Lower precedence/ }).click();
  await expect(items.nth(1).locator("p").first()).toHaveText(firstSentence);
});

test("delete offers an Undo that restores the rule", async ({ page }) => {
  await page.goto("/settings");
  const items = ruleItems(page);
  const before = await items.count();
  const sentence = await items.first().locator("p").first().innerText();

  await items.first().getByRole("button", { name: /^Delete / }).click();
  await expect(page.locator("p", { hasText: /^Deleted "/ })).toBeVisible();
  await expect(items).toHaveCount(before - 1);

  // the delete toast's Undo re-creates the rule (its conditions/precedence/history)
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(items).toHaveCount(before);
  await expect(items.filter({ hasText: sentence })).toHaveCount(1);
});
