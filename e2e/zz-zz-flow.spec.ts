import { expect, test, type Page } from "@playwright/test";

import { analyzeSettled } from "./axe-helpers";

/**
 * /flow — transfers between the owner's own accounts.
 *
 * This surface PERSISTS its view (measure + lens) in app_settings, so it lives
 * in the zz tier and restores the defaults at the end for sibling specs.
 */

const GATING = new Set(["critical", "serious"]);
function gating(results: { violations: { impact?: string | null }[] }) {
  return results.violations.filter((v) => GATING.has(v.impact ?? ""));
}

/**
 * Navigate and WAIT FOR HYDRATION. The switchers are `"use client"` buttons that
 * ship in the SSR HTML already visible and enabled, so a click can land before
 * React attaches onClick and be swallowed silently — see the long note in
 * zz-zz-view-switcher.spec.ts, where that cost 3-in-5 runs. The theme toggle's
 * SVG renders only after mount, which makes it a true signal; its aria-label is
 * in the SSR markup and so proves nothing.
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

/** Press a pill and prove the press landed; setView is idempotent, so retrying is safe. */
async function press(page: Page, group: string, name: string): Promise<void> {
  const pill = page.getByRole("group", { name: group }).getByRole("button", { name });
  await expect(async () => {
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

test("the flow page states its totals, switches gross↔net and chart↔table, and is accessible", async ({
  page,
}) => {
  await gotoHydrated(page, "/flow");

  await expect(page.getByRole("heading", { name: "Flow", level: 1 })).toBeVisible();

  // the summary rail names both measures at once — you can never see one
  // without the other, which is the whole point of the surface
  await expect(page.getByText("Gross moved")).toBeVisible();
  await expect(page.getByText("Net moved")).toBeVisible();
  await expect(page.getByText("Round-tripped")).toBeVisible();

  // establish the precondition rather than assume it: an earlier run may have
  // left this surface on net/table (the preference is persisted, and the suite
  // shares one database)
  await press(page, "Transfer measure", "Gross");
  await press(page, "Transfer lens", "Chart");

  // the spine renders and every arc is keyboard-reachable with a real label
  const arcs = page.locator("g[data-edge]");
  await expect(arcs.first()).toBeVisible();
  const arcCount = await arcs.count();
  expect(arcCount).toBeGreaterThan(0);
  for (let i = 0; i < arcCount; i += 1) {
    const arc = arcs.nth(i);
    await expect(arc).toHaveAttribute("tabindex", "0");
    const label = await arc.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toMatch(/over \d+ transfers?/);
  }

  expect(gating(await analyzeSettled(page))).toEqual([]);

  const grossReturning = await page.locator('g[data-edge][data-onward="false"]').count();

  // NET: the URL carries it, and the left-hand return region drains.
  //
  // NOT to zero, deliberately. Nodes are ordered by each account's TOTAL net
  // position, so a pair can still net "up" the ladder: an account that is a net
  // sink overall may nonetheless be a net sender to one particular counterparty.
  // On the real data exactly one such arc survives, and it is honest rather than
  // a fold that kept a losing direction. Asserting zero here would be asserting
  // a bug.
  await press(page, "Transfer measure", "Net");
  await expect(page).toHaveURL(/[?&]measure=net\b/);
  const netArcs = await page.locator("g[data-edge]").count();
  expect(netArcs).toBeLessThanOrEqual(arcCount); // netting folds bidirectional pairs
  expect(await page.locator('g[data-edge][data-onward="false"]').count()).toBeLessThanOrEqual(
    grossReturning,
  );

  // TABLE lens: a real matrix with row and column headers and the conservation footer
  await press(page, "Transfer lens", "Table");
  await expect(page).toHaveURL(/[?&]lens=table\b/);
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.locator("caption")).toBeVisible();
  await expect(table.getByRole("rowheader").first()).toBeVisible();
  await expect(page.getByText(/Out .* = In /)).toBeVisible();

  expect(gating(await analyzeSettled(page))).toEqual([]);

  // sticky across a fresh visit with no params
  await gotoHydrated(page, "/flow");
  await expect(page.getByRole("table")).toBeVisible();

  // restore the defaults for sibling specs
  await press(page, "Transfer lens", "Chart");
  await press(page, "Transfer measure", "Gross");
  await gotoHydrated(page, "/flow");
  await expect(page.locator("g[data-edge]").first()).toBeVisible();
});

test("the flow page is reachable from the main navigation", async ({ page }) => {
  await gotoHydrated(page, "/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Flow" }).click();
  await expect(page).toHaveURL(/\/flow$/);
  await expect(page.getByRole("heading", { name: "Flow", level: 1 })).toBeVisible();
});
