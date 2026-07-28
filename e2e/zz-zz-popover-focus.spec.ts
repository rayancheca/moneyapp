import { expect, test } from "@playwright/test";

/**
 * Popover mounts its panel only WHILE open, so a closed CategoryPicker no
 * longer ships its ~67-option listbox into a page nothing can see. The one
 * thing that gate can break is focus, and it breaks it two different ways:
 *
 *  - React's `autoFocus` is a focus() call at mount on the client (never the
 *    attribute the native popover focusing steps look for), and under the gate
 *    that call lands one step before the panel leaves display:none — the
 *    CategoryPicker path;
 *  - consumers that focus their own child from an effect keyed on `open`
 *    (Menu, BudgetAmountEditor, SeriesMembership) need the panel already shown
 *    and their ref already attached by the time that effect runs — the Menu
 *    path.
 *
 * Both are asserted here against the real app; both were verified to FAIL/PASS
 * before the gate landed. Read-only: nothing is committed to the database.
 */

test("opening a category picker puts focus in its search input", async ({ page }) => {
  await page.goto("/transactions");

  const chip = page.getByRole("button", { name: /^Category: .* Change$/ }).first();
  await expect(chip).toBeVisible();
  await chip.click();

  const search = page.getByRole("combobox", { name: "Search categories" });
  await expect(search).toBeVisible();
  // document.activeElement IS the search input
  await expect(search).toBeFocused();

  // and the focus is real, not just an attribute: keystrokes land in the field
  // with no intervening click
  await page.keyboard.type("gro");
  await expect(search).toHaveValue("gro");

  const panel = page.locator("[popover]").filter({ has: search });
  // the panel is anchored to its trigger — start-aligned and edge-to-edge on
  // one side or the other (the util flips it above when the row sits low).
  // Measured against a panel that has already MOUNTED its list, so this also
  // catches a flip decided against an empty, zero-height box.
  const [trigger, box] = [(await chip.boundingBox())!, (await panel.boundingBox())!];
  const gap = Math.min(
    Math.abs(box.y - (trigger.y + trigger.height)),
    Math.abs(trigger.y - (box.y + box.height)),
  );
  expect(gap).toBeLessThan(24);
  expect(Math.abs(box.x - trigger.x)).toBeLessThan(24);

  // Popover shows the panel visible for the one commit its children mount in
  // (so their autoFocus can land) and then hands visibility back to the top
  // layer. If that inline display survived, a NATIVE light dismiss — which
  // hides the panel a task before React hears the toggle — would be overridden
  // and the panel would linger.
  expect(await panel.evaluate((el) => (el as HTMLElement).style.display)).toBe("");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Categories" })).toBeHidden();
});

test("a panel whose owner focuses it from an effect still gets the caret", async ({ page }) => {
  await page.goto("/budgets");

  // BudgetAmountEditor focuses (and selects) its input from an effect keyed on
  // `open`, reaching through a ref into the panel's DOM — the same path Menu
  // and SeriesMembership take. It only works if the children mount in the same
  // commit `open` flips and the panel is already shown when that parent effect
  // runs. Read-only: the amount is never saved.
  await page.getByRole("button", { name: "Edit Food budget amount" }).click();

  const amount = page.getByRole("textbox", { name: "Food budget amount" });
  await expect(amount).toBeVisible();
  await expect(amount).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(amount).toBeHidden();
});

test("a closed popover keeps its panel out of the document", async ({ page }) => {
  await page.goto("/transactions");
  await page.getByRole("button", { name: /^Category: .* Change$/ }).first().waitFor();

  // the ledger renders one picker per row; none of their listboxes are in the
  // page until a picker is opened
  const closedPanels = await page.locator("[popover]").count();
  expect(closedPanels).toBeGreaterThan(1);
  expect(await page.locator('[popover] [role="option"]').count()).toBe(0);

  await page.getByRole("button", { name: /^Category: .* Change$/ }).first().click();
  expect(await page.locator('[popover] [role="option"]').count()).toBeGreaterThan(1);
});
