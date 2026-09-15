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

/**
 * The kind headings carry a definition of what the kind does to the money math —
 * the one thing on this screen that silently changes it.
 *
 * The load-bearing assertion is the FIRST one: a tooltip body is live DOM text
 * even while its popover is closed (Playwright's text engine ignores
 * visibility), so a tip that rendered open by default would be invisible to
 * `toHaveCount` checks elsewhere but plainly wrong on screen. `toBeHidden`
 * reads layout, not the DOM, which is exactly the distinction that matters here.
 */
test("a kind heading explains what the kind does, and stays quiet until asked", async ({ page }) => {
  await page.goto("/categories");

  const trigger = page.getByRole("button", { name: "What Spending means" });
  await expect(trigger).toBeVisible();

  // present in the DOM, but not shown — the closed-popover contract
  const tip = page.getByText(/Counted as spending, together with money out that has no category yet/);
  await expect(tip).toHaveCount(1);
  await expect(tip).toBeHidden();

  // keyboard opens it immediately (no hover-intent delay on :focus-visible)
  await trigger.focus();
  await expect(tip).toBeVisible();

  // and Escape closes it without leaving the page
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Categories" })).toBeVisible();
});

test("every kind group on the page carries a definition", async ({ page }) => {
  await page.goto("/categories");
  // one per rendered group heading — never one per row; 77 rows of info buttons
  // would cost more in keyboard traversal than the jargon costs in confusion
  const headings = page.getByRole("heading", { level: 3 });
  const tips = page.getByRole("button", { name: /^What .+ means$/ });
  expect(await tips.count()).toBe(await headings.count());
});

/**
 * The measured note. Deliberately asserts NO count: this spec sorts after
 * zz-categorize / zz-inline-chip / zz-split, which assign categories positionally
 * (`option.nth(2)`) and do not restore, so the number of empty categories has
 * already moved by the time this runs. The contract being locked in is what the
 * note is allowed to SAY, not how many it found.
 */
test("the page states which categories are empty without concluding they are unused", async ({ page }) => {
  await page.goto("/categories");

  const note = page.getByRole("complementary", { name: "What this page noticed" });
  await expect(note).toBeVisible();
  await expect(note).toContainText(/hold no transactions|holds no transactions/);

  // the honesty contract: three different causes produced this one state on the
  // real ledger, so the note reports the state and refuses to explain it
  await expect(note).toContainText(/can mean/);
  await expect(note).toContainText(/landing on another category/);
  const body = (await note.textContent()) ?? "";
  expect(body).not.toMatch(/unused|safe to archive|no longer needed/i);
  // and it must not restate the page header's own archiving-is-not-deletion line
  expect(body).not.toMatch(/nothing is deleted|never deletes/i);

  // it carries no heading of its own — the tip-per-h3 count above depends on it
  await expect(note.getByRole("heading")).toHaveCount(0);
});
