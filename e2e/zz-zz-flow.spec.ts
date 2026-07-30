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
  // shape too — the tower also tags its groups `data-edge`, so a leaked
  // shape=tower would satisfy the locator below and then fail on the labels,
  // for a reason the failure message would not name
  await press(page, "Transfer shape", "Spine");

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

test("the tower puts time on the vertical axis, and never becomes the only path to a fact", async ({
  page,
}) => {
  await gotoHydrated(page, "/flow");
  await press(page, "Transfer lens", "Chart");
  await press(page, "Transfer measure", "Gross");

  // Count the SPINE's edges while the spine is still on screen. Both charts tag
  // their groups `data-edge` — honestly, since both are keyed by route — so
  // reading that selector after the switch just counts the tower against
  // itself, which is an assertion that can never fail.
  const spineEdges = await page.locator("g[data-edge]").count();
  expect(spineEdges).toBeGreaterThan(0);

  await press(page, "Transfer shape", "Tower");
  await expect(page).toHaveURL(/[?&]shape=tower\b/);

  // one arc per (edge, month) bucket that carried money — necessarily more than
  // the spine's one per edge, which is the whole point of adding a time axis
  const arcs = page.locator("[data-arc]");
  await expect(arcs.first()).toBeVisible();
  const arcCount = await arcs.count();
  expect(arcCount).toBeGreaterThan(spineEdges);

  // every arc key is unique, so the paint order is a total order
  const keys = await arcs.evaluateAll((els) => els.map((e) => e.getAttribute("data-arc")));
  expect(new Set(keys).size).toBe(keys.length);

  // THE ESCAPE HATCH. The arcs are pointer-only by design — a couple of hundred
  // tab stops would be a trap — so the rail beside the plate has to carry every
  // account as a real link, or the view is unreachable without a mouse.
  const rail = page.getByRole("list", { name: "Accounts in this tower" });
  await expect(rail).toBeVisible();
  const railLinks = rail.getByRole("link");
  expect(await railLinks.count()).toBeGreaterThan(1);
  await expect(railLinks.first()).toHaveAttribute("href", /\/transactions\?/);

  // and nothing inside the drawing is focusable
  expect(await page.locator("[data-arc][tabindex]").count()).toBe(0);

  // the viewpoints are real buttons, which is what makes the camera keyboard-
  // reachable without a drag gesture nobody can perform from a keyboard
  for (const viewpoint of ["Front", "Plan", "Side", "Quarter"]) {
    await press(page, "Tower viewpoint", viewpoint);
    await expect(page.locator("[data-arc]").first()).toBeVisible();
  }

  expect(gating(await analyzeSettled(page))).toEqual([]);

  // NET folds the bidirectional pairs, so it can only ever draw fewer arcs
  await press(page, "Transfer measure", "Net");
  expect(await page.locator("[data-arc]").count()).toBeLessThanOrEqual(arcCount);

  // restore the defaults for sibling specs — the suite shares one database and
  // this surface persists its view
  await press(page, "Transfer measure", "Gross");
  await press(page, "Transfer shape", "Spine");
  await gotoHydrated(page, "/flow");
  await expect(page.locator("g[data-edge]").first()).toBeVisible();
  expect(await page.locator("[data-arc]").count()).toBe(0);
});

test("the tower's geometry is deterministic — the same view twice is the same markup", async ({
  page,
}) => {
  // The visual baselines and every future screenshot depend on this. It is
  // asserted directly rather than hoped for: no Math.random, no Date, no
  // physics settling, and a paint order tie-broken by id.
  const markup = async () => {
    await page.goto("/flow?shape=tower&measure=gross&lens=chart");
    await expect(
      page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
    ).toBeVisible();
    await expect(page.locator("[data-arc]").first()).toBeVisible();
    return page.locator("[data-arc]").first().locator("xpath=..").innerHTML();
  };

  const a = await markup();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.setViewportSize({ width: 1280, height: 720 });
  const b = await markup();

  expect(b).toBe(a);
  expect(a.length).toBeGreaterThan(1_000); // guards the guard
});

test("the flow page is reachable from the main navigation", async ({ page }) => {
  await gotoHydrated(page, "/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Flow" }).click();
  await expect(page).toHaveURL(/\/flow$/);
  await expect(page.getByRole("heading", { name: "Flow", level: 1 })).toBeVisible();
});
