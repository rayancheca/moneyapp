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
 *
 * Food additionally carries a bill that came due and never posted (Meal Kit,
 * 2026-07-05), so the overdue disclosure — the past-facing sibling of the tail
 * — has a rendered path under test. Utilities is the one budget with rollover
 * ON, banking $133.00 from two closed months against $250.00/month.
 */

/** The budget row `<li>` carrying a given top-level category link. */
function budgetRow(page: Page, category: string): Locator {
  return page
    .locator("li")
    .filter({ has: page.getByRole("link", { name: category, exact: true }) })
    .first();
}

test("every active budget renders a pace bar, and states a verdict only where covered", async ({ page }) => {
  await page.goto("/budgets");
  await expect(page.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible();

  // one progressbar per budget row, each with a spoken value
  const bars = page.getByRole("progressbar");
  await expect(bars).toHaveCount(4);
  for (const category of ["Food", "Subscriptions", "Housing", "Utilities"]) {
    await expect(budgetRow(page, category)).toBeVisible();
  }

  // A row states a pace verdict ONLY where the ledger covers the window. In this
  // fixture every budget has unaccounted days, so the two non-`over` rows report
  // coverage instead — "On track · 0% used" over an unimported stretch is the one
  // failure mode a budgeting tool cannot afford, and suppressing it is the point.
  // `over` is deliberately exempt: money already spent is measured, not inferred,
  // so Housing still speaks.
  await expect(page.getByText(/Over budget/).first()).toBeVisible();
  await expect(page.getByText(/days? unaccounted/).first()).toBeVisible();
  await expect(page.getByText(/On track/)).toHaveCount(0);
  await expect(page.getByText(/Off pace/)).toHaveCount(0);
});

test("a budget whose window the ledger covers DOES state its pace", async ({ page }) => {
  // the other half of the contract above: suppression must be driven by coverage,
  // not be a blanket silence. Housing is `over` and therefore always speaks; this
  // pins that a verdict and a coverage note are mutually exclusive per row.
  await page.goto("/budgets");
  const housing = budgetRow(page, "Housing");
  await expect(housing).toBeVisible();
  await expect(housing.getByText(/Over budget/)).toBeVisible();
  await expect(housing.getByText(/unaccounted/)).toHaveCount(0);
});

test("the month header compares what is budgeted against expected income", async ({ page }) => {
  await page.goto("/budgets");
  const header = page.getByText(/expected income/);
  await expect(header).toBeVisible();
  // over- or under-allocated, one of the two must be stated — never neither
  await expect(page.getByText(/left to allocate|Over-allocated by/).first()).toBeVisible();
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

test("a bill that came due and never posted is disclosed on its budget row", async ({ page }) => {
  await page.goto("/budgets");
  const food = budgetRow(page, "Food");
  await expect(food).toBeVisible();

  // Meal Kit was expected 2026-07-05 and never arrived. Food is `under` and
  // undermeasured, so its headline is "Awaiting statements" — the overdue line
  // is the ONLY thing telling him $125.00 of this month is already committed.
  await expect(food.getByText("$125.00 expected by now, not imported")).toBeVisible();
  await expect(food.getByText(/Meal Kit Jul 5/)).toBeVisible();

  // exactly one row is overdue — Housing and Subscriptions must stay silent,
  // or the state would be decorative rather than measured
  await expect(page.getByText(/expected by now, not imported/)).toHaveCount(1);

  // overdue is NOT the forward tail: budgetTail opens strictly AFTER today, so
  // Food gains no "expected before" trigger and Subscriptions keeps the only one
  await expect(food.getByRole("button", { name: /expected before/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /expected before/ })).toHaveCount(1);

  // the screen reader is told the same thing the sighted reader is
  await expect(food.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    /\$125\.00 was expected by now and has not been imported\.$/,
  );

  // …and it is committed money, so it lands in the projection exactly once:
  // $653.36 of extrapolated variable spend + $125.00 overdue = $778.36
  await expect(food.getByText("$778.36")).toBeVisible();
});

test("a rolling budget names the line it is graded against, and the toggle turns it off", async ({
  page,
}) => {
  await page.goto("/budgets");
  const utilities = budgetRow(page, "Utilities");
  await expect(utilities).toBeVisible();

  // May banked $56.00 and June $77.00 against $250.00/month, so the row is
  // graded against $383.00 — and says so, because "Budget $250.00 · Left …"
  // computed from $383.00 is a pair of numbers the reader cannot reconcile.
  await expect(utilities.getByText("Available")).toBeVisible();
  await expect(utilities.getByText("$250.00 plan + $133.00 rolled over")).toBeVisible();
  // $383.00 is deliberately NOT asserted as visible text: nothing has posted to
  // Utilities in July, so Available and Left are the same figure and the locator
  // matches twice. The denominator is pinned by aria-valuetext below instead.

  // the screen reader hears the same denominator, not the plan
  await expect(utilities.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    /of \$383\.00 \(\$133\.00 rolled over\)/,
  );

  // no other budget rolls over, so the carry is opted into and not ambient
  await expect(page.getByText(/rolled over/)).toHaveCount(1);

  // turning it off drops the carry and restores plain plan grading. "Available"
  // disappearing is the assertion rather than "Budget" appearing — the row also
  // carries the deactivate confirm sheet, whose copy contains that word.
  const on = utilities.getByRole("button", { name: "Rolls over", exact: true });
  await expect(on).toHaveAttribute("aria-pressed", "true");
  await on.click();

  const off = utilities.getByRole("button", { name: "Roll over", exact: true });
  await expect(off).toHaveAttribute("aria-pressed", "false");
  await expect(utilities.getByText(/rolled over/)).toHaveCount(0);
  await expect(utilities.getByText("Available")).toHaveCount(0);

  // restored, so sibling zz-specs see the seed unchanged
  await off.click();
  await expect(utilities.getByText("$250.00 plan + $133.00 rolled over")).toBeVisible();
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
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  await gate.getByRole("button", { name: "Deactivate this budget" }).click();

  // back to the four seeded budgets
  await expect(page.getByRole("progressbar")).toHaveCount(4);
});
