import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Budgets pace-bar contract (ux-overhaul-plan §8). The seed plants three
 * monthly budgets tuned to one deterministic tone each at E2E_FAKE_TODAY
 * (2026-07-08): Food under (green), Subscriptions off-pace (amber, WITH an
 * expected-recurring tail), Housing over (red). This proves the whole §8
 * surface — the three pace tones, the hollow tail → its contributing series,
 * the inline amount editor with a 6-month guide, and the reciprocal link to
 * the category page — without dead-ending. The inline-edit test mutates a
 * budget amount and restores it, so sibling zz-specs see the seed unchanged.
 */

/** The budget row `<li>` carrying a given top-level category link. */
function budgetRow(page: Page, category: string): Locator {
  return page
    .locator("li")
    .filter({ has: page.getByRole("link", { name: category, exact: true }) })
    .first();
}

test("every active budget renders a pace bar in all three tones", async ({ page }) => {
  await page.goto("/budgets");
  await expect(page.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible();

  // one progressbar per budget row, each with a spoken value
  const bars = page.getByRole("progressbar");
  await expect(bars).toHaveCount(3);
  for (const category of ["Food", "Subscriptions", "Housing"]) {
    await expect(budgetRow(page, category)).toBeVisible();
  }

  // the §8 crux: green→amber→red by PROJECTED pace, one of each present
  await expect(page.getByText(/On track/).first()).toBeVisible(); // under
  await expect(page.getByText(/Off pace/).first()).toBeVisible(); // at-risk
  await expect(page.getByText(/Over budget/).first()).toBeVisible(); // over
});

test("the hollow tail opens a popover of contributing series → its recurring page", async ({
  page,
}) => {
  await page.goto("/budgets");

  // Subscriptions is the only budget with an expected-but-unposted recurring
  // tail (Netflix), so exactly one "expected before" trigger exists.
  const tail = page.getByRole("button", { name: /expected before/ });
  await expect(tail).toHaveCount(1);
  await expect(tail).toHaveAttribute("aria-expanded", "false");

  await tail.click();
  await expect(tail).toHaveAttribute("aria-expanded", "true");

  // the popover lists the contributing series; each drills to its detail page
  const seriesLink = page.locator('a[href^="/recurring/"]').first();
  await expect(seriesLink).toBeVisible();
  await seriesLink.click();
  await expect(page).toHaveURL(/\/recurring\/[^/]+$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
});

test("the inline editor writes a new amount with a 6-month guide (restored)", async ({ page }) => {
  await page.goto("/budgets");
  const food = budgetRow(page, "Food");

  const edit = food.getByRole("button", { name: "Edit Food budget amount" });
  await edit.click();

  // the guide is one tap to adopt; the amount field is pre-filled with the live value
  const amount = page.getByRole("textbox", { name: "Food budget amount" });
  await expect(amount).toBeVisible();
  // scope the guide to THIS open popover — every row renders its own editor into
  // the DOM (native popover=auto hides the closed ones with display:none, so a
  // bare text query would match all three).
  const editor = page.locator("div[popover]").filter({ has: amount });
  await expect(editor.getByText(/6-mo avg/)).toBeVisible();
  const original = await amount.inputValue();

  await amount.fill("850.00");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("body")).toContainText("Food budget updated");

  // persisted: reopening the editor shows the new live value
  await food.getByRole("button", { name: "Edit Food budget amount" }).click();
  await expect(page.getByRole("textbox", { name: "Food budget amount" })).toHaveValue("850.00");

  // restore so sibling specs see the seed unchanged
  await page.getByRole("textbox", { name: "Food budget amount" }).fill(original);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("body")).toContainText("Food budget updated");
});

test("a budget row links reciprocally to its category page", async ({ page }) => {
  await page.goto("/budgets");
  await budgetRow(page, "Food").getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/\/categories\/[^/]+/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("Predict budgets reviews forecast amounts, creates one, and restores", async ({ page }) => {
  await page.goto("/budgets");
  await page.getByRole("button", { name: "Predict budgets" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Predicted budgets")).toBeVisible();
  // it's a forecast of next month, not a description of the past
  await expect(sheet.getByText(/forecast of your .* spending/)).toBeVisible();
  // every prediction names its basis: the predicted total + a confidence
  await expect(sheet.getByText(/predicts .* for /).first()).toBeVisible();
  await expect(sheet.getByText(/% confidence/).first()).toBeVisible();
  const boxes = sheet.getByRole("checkbox");
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);

  // keep only the FIRST prediction checked (low-confidence rows default OFF, so
  // check it explicitly), remember its category name
  await boxes.first().check();
  for (let i = 1; i < count; i += 1) await boxes.nth(i).uncheck();
  const firstLabel = (await sheet.locator("li").first().locator("span.font-medium").innerText()).trim();
  await sheet.getByRole("button", { name: /Create 1 monthly budget/ }).click();

  // the new budget appears as a live pace row…
  const row = page
    .locator("li")
    .filter({ has: page.getByRole("link", { name: firstLabel, exact: true }) })
    .first();
  await expect(row.getByRole("progressbar")).toBeVisible();

  // …and is deactivated again so sibling specs see the seeded three budgets.
  // Deactivate is gated: the confirm names what stops being budgeted, and the
  // row survives until it is accepted.
  await row.getByRole("button", { name: "Deactivate" }).click();
  const gate = page.getByRole("dialog");
  await expect(gate.getByText(/stops being budgeted/).first()).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(4);
  await gate.getByRole("button", { name: "Deactivate this budget" }).click();

  await expect(page.getByRole("progressbar")).toHaveCount(3);
});
