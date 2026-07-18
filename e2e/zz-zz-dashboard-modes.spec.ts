import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";

/**
 * The dashboard hero chart's view modes (pass-17 ask C): combined (default) /
 * assets / liabilities-owed / split two-line / per-account colored lines, all
 * through the same ScrubChart — the primary series keeps every interaction
 * invariant, overlays draw with a legend, and the choice lives in the URL +
 * app_settings. This spec mutates viewPreferences so it runs in the zz-zz tier
 * and RESTORES the combined default at the end for sibling specs.
 */

const GATING = new Set(["critical", "serious"]);
function gating(results: { violations: { impact?: string | null }[] }) {
  return results.violations.filter((v) => GATING.has(v.impact ?? ""));
}

function modePill(page: Page, name: string) {
  return page.getByRole("group", { name: "Net worth chart view" }).getByRole("button", { name });
}

test("hero chart switches combined→assets→owed→split, updates the URL, and persists", async ({ page }) => {
  await page.goto("/");
  // default: the combined net-worth chart, exactly as before the modes shipped
  await expect(page.getByRole("slider", { name: /Net worth over time/ })).toBeVisible();
  await expect(modePill(page, "Net worth")).toHaveAttribute("aria-pressed", "true");

  // assets: same machinery, assets rollup as the primary
  await modePill(page, "Assets").click();
  await expect(page).toHaveURL(/[?&]chart=assets\b/);
  await expect(page.getByRole("slider", { name: /Assets over time/ })).toBeVisible();
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // owed: the positive "amount owed" frame (debt down = good)
  await modePill(page, "Owed").click();
  await expect(page).toHaveURL(/[?&]chart=liabilities\b/);
  await expect(page.getByRole("slider", { name: /Amount owed over time/ })).toBeVisible();

  // split: assets primary + an owed overlay with a legend
  await modePill(page, "Split").click();
  await expect(page).toHaveURL(/[?&]chart=split\b/);
  await expect(page.getByRole("slider", { name: /Assets over time/ })).toBeVisible();
  const legend = page.locator('[aria-label="Chart legend"]');
  await expect(legend).toContainText("Assets");
  await expect(legend).toContainText("Amount owed");
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // sticky: a fresh visit with NO chart param keeps the persisted choice
  await page.goto("/");
  await expect(modePill(page, "Split")).toHaveAttribute("aria-pressed", "true");
});

test("accounts mode layers per-account lines, chips toggle the selection, focus modal carries the view", async ({ page }) => {
  await page.goto("/?chart=accounts");
  const chips = page.getByRole("group", { name: "Accounts shown" }).getByRole("button");
  const chipCount = await chips.count();
  expect(chipCount).toBeGreaterThan(1); // seeded world has several accounts
  // default selection: every active account, each with its own legend entry
  for (let i = 0; i < chipCount; i++) {
    await expect(chips.nth(i)).toHaveAttribute("aria-pressed", "true");
  }
  const legendItems = page.locator('[aria-label="Chart legend"] > span');
  await expect(legendItems).toHaveCount(chipCount);

  // deselect one account: its line leaves the legend and the URL carries the set
  const offName = (await chips.last().textContent()) ?? "";
  await chips.last().click();
  await expect(page).toHaveURL(/[?&]accts=/);
  await expect(chips.last()).toHaveAttribute("aria-pressed", "false");
  await expect(legendItems).toHaveCount(chipCount - 1);
  await expect(page.locator('[aria-label="Chart legend"]')).not.toContainText(offName.trim());
  expect(gating(await analyzeSettled(page))).toEqual([]);

  // the curated selection SURVIVES a mode round-trip (accounts → owed → accounts):
  // neither the URL fallback nor the persisted preference may reset it to all
  await modePill(page, "Owed").click();
  await expect(page).toHaveURL(/[?&]chart=liabilities\b/);
  await modePill(page, "Accounts").click();
  await expect(chips.last()).toHaveAttribute("aria-pressed", "false");
  await expect(legendItems).toHaveCount(chipCount - 1);

  // the focus modal renders the SAME view: switcher + chips + per-account slider,
  // and announces the current mode (not a hardcoded "Net worth")
  await page.getByRole("button", { name: "Focus the Accounts chart" }).click();
  const dialog = page.getByRole("dialog", { name: /Accounts chart — focus/ });
  await expect(dialog.getByRole("group", { name: "Net worth chart view" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Accounts shown" }).getByRole("button")).toHaveCount(chipCount);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // restore: re-select the chip (persistence now survives) then the combined default
  await chips.last().click();
  await expect(legendItems).toHaveCount(chipCount);
  await modePill(page, "Net worth").click();
  await expect(page.getByRole("slider", { name: /Net worth over time/ })).toBeVisible();
  await page.goto("/");
  await expect(modePill(page, "Net worth")).toHaveAttribute("aria-pressed", "true");
});
