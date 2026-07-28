import { expect, test } from "@playwright/test";

/**
 * Bulk edit (ux-overhaul-plan §3.5/§3.9): selection mode, the checkbox path and
 * the "select all matching" path, each stating its server-computed blast radius
 * and undoable. Runs LAST (zz-, after the read-only visual/a11y/interaction and
 * golden-path specs) because it mutates the shared seeded database.
 */

test.describe.configure({ mode: "serial" });

test("select rows by checkbox, apply, and undo — count copy matches", async ({ page }) => {
  await page.goto("/transactions");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  const checks = page.getByRole("checkbox", { name: /^Select / });
  await checks.nth(0).check();
  await checks.nth(1).check();

  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar.getByText("2 selected")).toBeVisible();

  await bar.getByRole("button", { name: "Reviewed" }).click();
  // toast states the server-confirmed affected count (scope to the <p>; the
  // aria-live region carries the same text off-screen)
  await expect(page.locator("p", { hasText: /Marked reviewed · 2/ })).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("p", { hasText: /Marked reviewed · 2/ })).toHaveCount(0);
});

test("selection resets on a filter navigation — a confirmed set can't re-bind", async ({ page }) => {
  // regression for the critical review finding: selection state must not survive
  // a soft <Link> nav, or a "select all matching" would silently re-bind to the
  // new (larger) result set and over-mutate on the next click.
  await page.goto("/transactions?q=STARBUCKS");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await bar.getByRole("button", { name: /Select all \d+/ }).click();
  await expect(bar).toBeVisible();

  // Reset is a next/link soft nav that keeps the ledger mounted
  await page.getByRole("link", { name: "Reset" }).click();
  await expect(page).toHaveURL(/\/transactions$/);

  // the selection is cleared: the bar is gone, so no stale allMatching persists
  await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
});

test("select all matching applies to the whole filtered set with its server count", async ({ page }) => {
  // a bounded, stable filter so the matching count is small and deterministic
  await page.goto("/transactions?q=STARBUCKS");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  const selectAll = bar.getByRole("button", { name: /Select all \d+/ });
  await expect(selectAll).toBeVisible();
  const matchCount = Number((await selectAll.innerText()).match(/Select all (\d+)/)![1]);
  expect(matchCount).toBeGreaterThan(0);

  await selectAll.click();
  // the bar now states the whole set — the by-filter blast radius, not the page
  await expect(bar.getByText(`${matchCount} selected`)).toBeVisible();

  // Exclude is gated: the confirm must state the same server count the bar did,
  // and the rows are only written once it is accepted
  await bar.getByRole("button", { name: "Exclude" }).click();
  const gate = page.getByRole("dialog");
  await expect(gate.getByText(`${matchCount} transactions`).first()).toBeVisible();
  await expect(gate.getByText("every transaction matching the current filters").first()).toBeVisible();
  await gate.getByRole("button", { name: "Exclude them" }).click();

  await expect(page.locator("p", { hasText: new RegExp(`Excluded · ${matchCount}`) })).toBeVisible();
});
