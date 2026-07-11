import { expect, test } from "@playwright/test";

/**
 * "Recategorize all N" (ux-overhaul-plan §3.2.5): the transaction sheet's
 * same-name panel recategorizes a whole merchant group in ONE gesture AND
 * creates the forward rule, behind a lossless Undo that reverts every row and
 * deletes the created rule. Runs LAST (zz-, sorts before zz-review-triage /
 * zz-rules-manager) and fully UNDOES itself, so the shared seed and its rule
 * set are pristine for later specs.
 *
 * Targets Netflix — a seeded recurring merchant with a multi-transaction group
 * (150 occurrences in the fixtures) that no other spec mutates.
 */

test.describe.configure({ mode: "serial" });

test("recategorize a whole merchant group from the sheet, then undo rows + rule", async ({ page }) => {
  await page.goto("/transactions?q=NETFLIX");

  // open the first Netflix row's sheet
  await page.getByRole("button").filter({ hasText: /NETFLIX/i }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // the per-row Category chip reflects the current category — capture it so we
  // can prove the round-trip reverts exactly
  const categoryChip = dialog.getByRole("button", { name: /^Category:/ });
  await expect(categoryChip).toBeVisible();
  const original = (await categoryChip.textContent())?.trim() ?? "";
  expect(original).not.toBe("Groceries"); // the target below must be a real change

  // the same-merchant panel offers "Recategorize all N →"
  const recat = dialog.getByRole("button", { name: /Recategorize all \d+/ });
  await expect(recat).toBeVisible();
  await recat.click();

  // pick Food > Groceries from the open picker (scoped to the visible listbox —
  // every ledger row behind the sheet also has a closed, hidden picker)
  const picker = page.getByRole("listbox", { name: "Categories" });
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: /Groceries/ }).first().click();

  // value-returning action → blast-radius toast + a rule was created
  await expect(page.locator("p", { hasText: /set to Groceries · rule created/ })).toBeVisible();
  // the whole group moved — the open row's chip now reads Groceries
  await expect(categoryChip).toHaveText(/Groceries/);

  // Undo reverts the recategorization AND deletes the created rule
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(categoryChip).toHaveText(original); // rows restored exactly

  // and the "Always: Netflix → Groceries" rule is gone (undo cleaned it up)
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /contains "NETFLIX"/ })).toHaveCount(0);
});
