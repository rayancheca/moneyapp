import { expect, test } from "@playwright/test";

/**
 * /categories rows expand in place, and what they reveal is editable: the name,
 * the re-parent menu, and the order within the row's own group.
 *
 * Runs late and RESTORES the order it changes. `sort_order` is read by four other
 * surfaces (the budget form, the transaction category picker, the command index
 * and the design preview), so a persisted reorder left behind would move the
 * positional `.nth()` option picks in zz-split / zz-inline-chip / zz-categorize.
 */

/** The row `<li>` carrying a given category link. */
function row(page: import("@playwright/test").Page, name: string) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("link", { name, exact: true }) })
    .first();
}

test("a category row expands to reveal its editors, and collapses again", async ({ page }) => {
  await page.goto("/categories");
  const food = row(page, "Food");
  await expect(food).toBeVisible();

  const trigger = food.getByRole("button", { name: "Details for Food" }).first();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  /*
   * The contract is asserted on `aria-expanded` plus `inert` on THIS row's own
   * region, resolved through aria-controls.
   *
   * Deliberately not on visibility: the panel collapses via a
   * `grid-template-rows` transition, so "is it visible yet" is a timing question
   * and a timing assertion here is the exact flake shape a previous pass lost a
   * whole session to. And not via toHaveCount either — Playwright's role engine
   * resolves roles from the DOM, not the real accessibility tree, so it happily
   * matches controls inside an inert subtree that no user can reach.
   */
  const regionId = await trigger.getAttribute("aria-controls");
  // attribute selector, not `#id` — useId() emits ids that need CSS escaping and
  // CSS.escape is a browser global the test process does not have
  const ownPanel = page.locator(`[id="${regionId}"] > div`);
  await expect(ownPanel).toHaveAttribute("inert", "");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(ownPanel).not.toHaveAttribute("inert", "");
  await expect(food.getByRole("button", { name: "Move Food down" }).first()).toBeVisible();
  await expect(food.getByRole("button", { name: /Name of Food/ }).first()).toBeVisible();

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(ownPanel).toHaveAttribute("inert", "");
});

test("a locked category says why it cannot be edited instead of hiding the reason", async ({
  page,
}) => {
  await page.goto("/categories");
  // "Income" is an IMPORT_HINT_ROOT — parsers resolve it by name, so rename and
  // archive are refused. The panel explains that rather than showing dead controls.
  const income = row(page, "Income");
  await income.getByRole("button", { name: "Details for Income" }).first().click();
  await expect(income.getByText(/resolve this category by name/).first()).toBeVisible();
  await expect(income.getByRole("button", { name: /Name of Income/ })).toHaveCount(0);
});

test("reordering a root persists, and restores", async ({ page }) => {
  await page.goto("/categories");

  const spending = page.getByRole("region", { name: "Spending categories" });
  const firstName = async () =>
    (await spending.locator("li > div a[href^='/categories/']").first().innerText()).trim();

  const original = await firstName();

  // move the first Spending root down; the second takes its place
  const first = row(page, original);
  await first.getByRole("button", { name: `Details for ${original}` }).first().click();
  await first.getByRole("button", { name: `Move ${original} down` }).first().click();
  await expect
    .poll(async () => await firstName(), { timeout: 10_000 })
    .not.toBe(original);

  // persisted server-side, not optimistic state
  await page.reload();
  expect(await firstName()).not.toBe(original);

  // restore, or the positional category-picker specs shift under us
  const moved = row(page, original);
  await moved.getByRole("button", { name: `Details for ${original}` }).first().click();
  await moved.getByRole("button", { name: `Move ${original} up` }).first().click();
  await expect.poll(async () => await firstName(), { timeout: 10_000 }).toBe(original);
  await page.reload();
  expect(await firstName()).toBe(original);
});
