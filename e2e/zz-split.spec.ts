import { expect, test } from "@playwright/test";

/**
 * Transaction splitting (RocketMoney-style): open a transaction, carve its
 * amount across two categories, save, confirm the "Split · N" chip, then remove
 * the split. Runs LAST (zz-) because it mutates a real seeded row; it cleans up
 * after itself by removing the split it created.
 */

test("split a transaction across two categories, then remove it", async ({ page }) => {
  await page.goto("/transactions");

  // open the first row whose sheet offers splitting (skip transfer/non-active rows)
  const sheetButtons = page.locator('button[aria-haspopup="dialog"]');
  const count = await sheetButtons.count();
  let opened = false;
  for (let i = 0; i < Math.min(count, 8); i += 1) {
    await sheetButtons.nth(i).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    if (await dialog.getByRole("button", { name: "Split transaction" }).isVisible().catch(() => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(opened, "expected a splittable transaction in the first rows").toBe(true);

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Split transaction" }).click();

  // the editor seeds line 1 with the whole amount; carve $0.01 onto line 1 so
  // the live "remaining" tells us exactly what line 2 needs (any amount works)
  const amounts = dialog.getByLabel("Split amount");
  await expect(amounts).toHaveCount(2);
  await amounts.nth(0).fill("0.01");

  // read "$X left" and type that exact remainder into line 2
  const remaining = dialog.getByText(/left$/);
  await expect(remaining).toBeVisible();
  const leftText = (await remaining.textContent()) ?? "";
  const money = leftText.match(/\$[\d,]+\.\d{2}/)?.[0];
  expect(money, `could not parse remaining from "${leftText}"`).toBeTruthy();
  await amounts.nth(1).fill(money!);

  // pick a category for each part (the two pickers inside the split editor)
  const pickers = dialog.getByRole("button", { name: /Category:.*Change/ });
  // pickers[0] is the row's main category; the split lines follow it
  await pickers.nth(1).click();
  await page.getByRole("listbox", { name: "Categories" }).getByRole("option").nth(2).click();
  await pickers.nth(2).click();
  await page.getByRole("listbox", { name: "Categories" }).getByRole("option").nth(3).click();

  // fully allocated → Save enabled
  await expect(dialog.getByText("Fully allocated")).toBeVisible();
  const save = dialog.getByRole("button", { name: "Save split" });
  await expect(save).toBeEnabled();
  await save.click();

  // the sheet now shows the two parts + Edit/Remove controls
  await expect(dialog.getByRole("button", { name: "Edit split" })).toBeVisible();
  const remove = dialog.getByRole("button", { name: "Remove split" });
  await expect(remove).toBeVisible();

  // close and confirm the ledger row shows the "Split · N" chip
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Split · 2$/ }).first()).toBeVisible();

  // clean up: reopen and remove the split so the seeded base is restored
  await page.getByRole("button", { name: /^Split · 2$/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Remove split" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Split transaction" })).toBeVisible();
});
