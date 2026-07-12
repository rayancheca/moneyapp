import { expect, test, type Page } from "@playwright/test";

/**
 * Dashboard drill-down contract (ux-overhaul-plan §7.4): the hub never
 * dead-ends — every teaser lands on exactly its target. Read-only navigation
 * against the shared seed. The account edit/reorder flows at the bottom mutate
 * and restore, so sibling zz-specs see the seed unchanged.
 */

test("the net-worth hero and every teaser render", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Net worth" })).toBeVisible();
  // ScrubChart adopted for net worth (role=slider wrapper)
  await expect(page.getByRole("slider", { name: /Net worth over time/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Upcoming/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Spending pace/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Investments" })).toBeVisible();
});

test("To Review → the clustered review queue", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Review all/ }).click();
  await expect(page).toHaveURL(/\/transactions\?view=review/);
  await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();
});

test("a recent transaction opens the sheet in place (no navigation)", async ({ page }) => {
  await page.goto("/");
  const recent = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Recent transactions" }) });
  await recent.getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/$/); // still on the dashboard
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("an upcoming bill → its recurring series page", async ({ page }) => {
  await page.goto("/");
  await page.locator('a[href^="/recurring/"]').first().click();
  await expect(page).toHaveURL(/\/recurring\/[^/]+$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
});

test("the spending-pace widget → /spending", async ({ page }) => {
  await page.goto("/");
  const pace = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^Spending pace/ }) });
  await pace.getByRole("link", { name: /Details/ }).click();
  await expect(page).toHaveURL(/\/spending/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the investments teaser → /investments, and the top mover → its holding", async ({ page }) => {
  await page.goto("/");
  const teaser = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Investments" }) });
  await teaser.getByRole("link", { name: /Portfolio/ }).click();
  await expect(page).toHaveURL(/\/investments$/);

  await page.goto("/");
  await page.getByRole("link", { name: /Top mover/ }).click();
  await expect(page).toHaveURL(/\/investments\/(stock|etf|crypto)\/[A-Z]+/);
});

test("an institution card expands and drills into an account", async ({ page }) => {
  await page.goto("/");
  const robinhood = page.locator('section[aria-label="Robinhood"]');
  await robinhood.getByRole("button", { name: /Robinhood/ }).first().click();
  await robinhood.locator('a[href^="/accounts/"]').first().click();
  await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
});

test("Manage → the accounts management surface", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Manage/ }).click();
  await expect(page).toHaveURL(/\/accounts$/);
});

// ── Account editing (mutates then restores the shared seed) ───────────────────

/** The ordered account short-names inside one institution section on /accounts. */
async function orderIn(page: Page, institution: string): Promise<string[]> {
  const links = page.locator(`section[aria-label="${institution}"] a[href^="/accounts/"]`);
  return (await links.allInnerTexts()).map((t) => t.split("\n")[0]!.trim());
}

test("the edit sheet renames an account (restored afterward)", async ({ page }) => {
  await page.goto("/accounts");
  const robinhood = page.locator('section[aria-label="Robinhood"]');
  const firstEdit = robinhood.getByRole("button", { name: /^Edit / }).first();
  // the button aria-label carries the SHORT name; the sheet field holds the FULL
  // name. Restore MUST write the full name back (else the institution prefix is
  // dropped, corrupting the shared seed) — so capture it from the field itself.
  const shortName = (await firstEdit.getAttribute("aria-label"))!.replace(/^Edit /, "");

  await firstEdit.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const nameField = sheet.getByLabel("Account name");
  const fullName = await nameField.inputValue();
  await nameField.fill(`${fullName} Edited`);
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("body")).toContainText("Account updated");
  await expect(robinhood.getByRole("button", { name: `Edit ${shortName} Edited` })).toBeVisible();

  // restore the FULL name so sibling zz-specs see the seed unchanged
  await robinhood.getByRole("button", { name: `Edit ${shortName} Edited` }).click();
  const restore = page.getByRole("dialog");
  await restore.getByLabel("Account name").fill(fullName);
  await restore.getByRole("button", { name: "Save changes" }).click();
  await expect(robinhood.getByRole("button", { name: `Edit ${shortName}` })).toBeVisible();
});

test("Move down reorders within an institution and writes it (restored afterward)", async ({ page }) => {
  await page.goto("/accounts");
  const before = await orderIn(page, "Robinhood");
  test.skip(before.length < 2, "needs ≥2 accounts to reorder");

  const first = before[0]!;
  await page.getByRole("button", { name: `Move ${first} down` }).click();
  await expect
    .poll(async () => (await orderIn(page, "Robinhood"))[0])
    .not.toBe(first);

  // move it back up to restore the seed order
  await page.getByRole("button", { name: `Move ${first} up` }).click();
  await expect.poll(async () => await orderIn(page, "Robinhood")).toEqual(before);
});
