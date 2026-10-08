import { expect, test } from "@playwright/test";

/**
 * Spending drill-down contract (ux-overhaul-plan §1.1 / §5): the period lives in
 * the URL, and every surface navigates to a pre-filtered ledger — a stat card to
 * its kind-scoped list, a heatmap day to that day, a category to its page.
 * Read-only navigation; the shared seed is untouched.
 */

test("period selector is URL state and pages", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  const granularity = page.getByRole("navigation", { name: "Period granularity" });
  await expect(granularity).toBeVisible();

  // switch granularity → year, via a real link
  await granularity.getByText("Year").click();
  await expect(page).toHaveURL(/period=2026(?!-)/);

  // page back a year
  await page.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/period=2025/);
});

test("next-month category forecasts show on the current month, not on year granularity", async ({ page }) => {
  // the current month (FAKE_TODAY 2026-07-08) → forecasts target August 2026
  await page.goto("/spending?period=2026-07");
  await expect(page.getByText(/August 2026 ≈ \$/).first()).toBeVisible();

  // switch to year granularity → the engine only forecasts the next month, so
  // it is gated out here (would be a mismatched future number otherwise)
  await page.getByRole("navigation", { name: "Period granularity" }).getByText("Year").click();
  await expect(page).toHaveURL(/period=2026(?!-)/);
  await expect(page.getByText(/≈ \$/)).toHaveCount(0);
});

test("the Spent stat card drills to the kind-scoped spending ledger", async ({ page }) => {
  await page.goto("/spending?period=2026");
  await page.getByRole("link", { name: /Spent this period/ }).click();
  await expect(page).toHaveURL(/category=spending/);
  await expect(page).toHaveURL(/from=2026-01-01/);
  await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();
});

test("a heatmap day opens its detail sheet, which still drills to that day's transactions", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // the heatmap opens on July 2026 (the in-progress month under the frozen clock)
  const day = page.getByRole("button", { name: /^Jul 3\b/ });
  await expect(day).toBeVisible();
  await day.click();

  // pass 23: a day now opens a DETAIL sheet rather than navigating straight off
  // the page — the day's total, its count, and where/who the money went to
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Spent")).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Where it went" })).toBeVisible();

  // the ledger drill is preserved, one click further in
  await sheet.getByRole("link", { name: /All transactions for this day/ }).click();
  await expect(page).toHaveURL("/transactions?from=2026-07-03&to=2026-07-03");
});

test("a heatmap day from the NEIGHBOURING month drills to the ledger instead of claiming nothing was posted", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // July's grid pads with real June days; this month's payload holds none of
  // them, so a sheet there would state an absence that was never queried
  const padding = page.getByRole("button", { name: /^Jun 29\b/ });
  await expect(padding).toBeVisible();
  await padding.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL("/transactions?from=2026-06-29&to=2026-06-29");
});

test("the day sheet's breakdown reconciles to the day's total", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  await page.getByRole("button", { name: /spent across/ }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  // the lists are capped at the top few, so a truncated one must show its
  // residual — a partial breakdown under an exact total otherwise reads as whole
  const text = await sheet.innerText();
  const spent = /\$([\d,]+\.\d{2})/.exec(text)?.[1];
  expect(spent).toBeTruthy();
  const merchants = sheet.locator("h3", { hasText: "Who it went to" }).locator("xpath=following-sibling::ul[1]/li");
  const amounts = (await merchants.allInnerTexts()).map(
    (t) => Number((/\$([\d,]+\.\d{2})/.exec(t)?.[1] ?? "0").replace(/,/g, "")),
  );
  const sum = amounts.reduce((a, b) => a + b, 0);
  expect(sum).toBeCloseTo(Number(spent!.replace(/,/g, "")), 2);
});

test("a heatmap cell states the day's spend, not just a colour", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // the label carries the exact figure, its count, and the biggest destination —
  // the cell is no longer a tint whose only readable form is a screen-reader hint
  const day = page.getByRole("button", { name: /^Jul 1\b/ });
  await expect(day).toHaveAttribute("aria-label", /spent across \d+ transactions?, mostly \w+/);
  // and the figure is VISIBLE in the cell, compactly
  await expect(day.getByText(/^−\$/)).toBeVisible();
});

test("a cell shows what came IN as well as what went out, and the sheet gives the day a net", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // Jul 2 is a payday under the frozen clock. Whether it ALSO carries spending
  // depends on how earlier specs categorized that day, so drive the assertions
  // off the day's actual label rather than assuming — an order-dependent
  // hardcoded assumption is exactly what made the first version of this flake.
  const day = page.getByRole("button", { name: /^Jul 2\b/ });
  const label = (await day.getAttribute("aria-label")) ?? "";
  expect(label).toMatch(/income/);

  // the sign, not colour alone, says which direction each figure is
  await expect(day.getByText(/^\+\$/)).toBeVisible();
  if (/spent/.test(label)) await expect(day.getByText(/^−\$/)).toBeVisible();

  await day.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Income", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Net", { exact: true })).toBeVisible();
  // the net is stated in words as well as by sign
  await expect(sheet.getByText(/more income than spending|more spending than income/)).toBeVisible();
});

test("a category opens its page", async ({ page }) => {
  await page.goto("/spending?period=2026");
  await page.locator('a[href^="/categories/"]').first().click();
  await expect(page).toHaveURL(/\/categories\//);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
});

test("the day heatmap follows the selected period (regression: prop-desync)", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  // heatmap opens on the in-progress month (frozen clock 2026-07-08)
  await expect(page.getByRole("grid", { name: "July 2026" })).toBeVisible();
  // paging the PERIOD back a month must move the heatmap with it
  await page.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/period=2026-06/);
  await expect(page.getByRole("grid", { name: "June 2026" })).toBeVisible();
});

/**
 * The cash-earnings note: silent on a month whose paydays all banked, and scoped
 * to what has been imported on a month whose payday has not been looked for.
 *
 * ⚠️ Read what the fixture holds before changing either test. The note reads
 * CONFIRMED income series only. The seed's one confirmed series is Paycheck
 * (biweekly, $2,943.19), and seed-helpers links the ACME direct deposits to it —
 * which stop on 2026-05-08 on purpose. "Employer (cash)", the weekly ATM series
 * that does bank up to FAKE_TODAY, is only `detected`, so the note never reads it.
 *
 * 🔴 This file used to assert the note was ABSENT on 2026-07, calling the
 * schedule current. It passed only because zz-inline-renames' "Detect now" runs
 * before this file (workers: 1) and, until 622fbff, moved Paycheck's 49 seeded
 * deposits onto a detected "Acme Corp (payroll)" — so the note had no evidence
 * left to read. The `spending` visual baseline, photographed before any Detect,
 * showed the note all along. Measured 2026-09-15: base code (e818154) on the
 * fixture prints "Paycheck implies $2,943.19 of earnings on Jul 3, 2026 and none
 * of it reached an account" for 2026-07.
 */
test("cash-earnings note is silent on a month whose paydays all banked", async ({ page }) => {
  // April's paydays are Apr 3 and Apr 17 — Paycheck's anchor Fridays (§6A 55
  // step B) — and the deposits of Apr 10 and Apr 24 banked both. The schedule
  // still reads series-stale as of FAKE_TODAY, so this is the `unbankedCents > 0`
  // half of the gate.
  await page.goto("/spending?period=2026-04");
  await expect(page.getByRole("link", { name: /^Savings rate/ }).first()).toBeVisible();
  await expect(page.getByLabel("What this page cannot see")).toHaveCount(0);
});

/*
 * ⚖️ ONE PAYDAY UNIVERSE (§6A 55 step B): the note counts Paycheck's paydays where the recurring calendar, /budgets
 * and the settlement draw them — its anchor's Fridays (Jul 10, Jun 26, Jun 12 …), walked back to its first deposit.
 * 🔴 It counted the DEPOSITS' Fridays, a week off: July held "Jul 3, 2026", a payday no other page drew.
 *
 * ⚠️ So this fixture can no longer express a payday past the checked frontier: Chase Total Checking is read through
 * Jun 30 and the anchor's Fridays skip from Jun 26 to Jul 10, after FAKE_TODAY. The unlooked-for sentence keeps its
 * coverage in src/lib/section-notes.test.ts; here, July is silent and June's two paydays fall on checked days.
 * Measured on a pristine fixture before and after `detectRecurringSeries` (2026-10-08): "Detect now", which runs
 * before this file, leaves Paycheck's anchor, interval and links as seeded: the silence is July's, not an empty
 * series.
 */
test("cash-earnings note is silent on a month whose first payday is still to come", async ({ page }) => {
  await page.goto("/spending?period=2026-07");
  await expect(page.getByRole("link", { name: /^Savings rate/ }).first()).toBeVisible();
  await expect(page.getByLabel("What this page cannot see")).toHaveCount(0);
});

test("cash-earnings note calls June's checked paydays unbanked, and names them", async ({ page }) => {
  await page.goto("/spending?period=2026-06");
  const note = page.getByLabel("What this page cannot see");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText(
    "Paycheck implies $5,886.38 of earnings over Jun 12 – 26, 2026 and none of it reached an account.",
  );
  await expect(note).not.toContainText("has been checked through");
});
