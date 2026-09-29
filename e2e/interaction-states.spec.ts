import { expect, test, type Page } from "@playwright/test";
import { expectBaseline } from "./expect-baseline";
import { analyzeSettled } from "./axe-helpers";

/**
 * Interaction-state baselines + in-state axe (ux-overhaul-plan §2.7.3/.4):
 * states — not layouts — are under test, so each state is captured at
 * 375 + 1440, in both themes, AND swept by AxeBuilder while the state is
 * live (route-level a11y.spec.ts never sees open overlays). Runs against
 * the seeded un-mutated base (this file sorts before zz-golden-path.spec.ts,
 * which mutates the shared database).
 *
 * Stage 1+ appends states HERE, one defineStateTests() call per state:
 *
 *   defineStateTests({
 *     name: "txn-sheet-open",
 *     path: "/transactions",
 *     prepare: async (page) => {
 *       await page.getByRole("row", { name: /Netflix/ }).click();
 *       await expect(page.getByRole("dialog")).toBeVisible();
 *     },
 *   });
 *
 * The registrar emits one test PER THEME; each test pins the theme via a
 * localStorage init-script BEFORE navigation, then rebuilds the state from
 * scratch with `prepare`. Never flip the theme mid-state (header toggle,
 * storage events): a toggle click is intercepted by modal backdrops
 * (<dialog>.showModal makes the header unreachable), its pointerdown
 * light-dismisses popover="auto" menus, and the extra round-trips outlive
 * auto-dismissing toasts. Transient states are cheap to rebuild —
 * rebuilding per theme is the contract.
 */

const STATE_WIDTHS = [1440, 375] as const;
const THEMES = ["light", "dark"] as const;

export interface InteractionState {
  name: string;
  path: string;
  /** Builds the state after navigation + hydration; re-runs once per theme. */
  prepare?: (page: Page) => Promise<void>;
}

/** One test per theme: pin theme pre-paint → build state → per-width shot + axe. */
export function defineStateTests(state: InteractionState): void {
  for (const theme of THEMES) {
    test(`${state.name} (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.setViewportSize({ width: STATE_WIDTHS[0], height: 900 });
      await page.goto(state.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("header button svg")).toBeVisible(); // hydrated
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);

      await state.prepare?.(page);

      for (const width of STATE_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await expectBaseline(page).toHaveScreenshot(`${state.name}-${theme}-${width}.png`, {
          fullPage: true,
        });
        // axe runs IN the prepared state — the coverage a route scan can't give
        const results = await analyzeSettled(page);
        const gating = results.violations.filter(
          (v) => v.impact === "critical" || v.impact === "serious",
        );
        expect(
          gating.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
        ).toEqual([]);
      }
    });
  }
}

defineStateTests({
  name: "transactions-seeded",
  path: "/transactions",
  prepare: async (page) => {
    // Stage-1 ledger rows are buttons that open the transaction sheet
    await expect(page.locator('button[aria-haspopup="dialog"]').first()).toBeVisible();
  },
});

defineStateTests({
  name: "review-inbox",
  path: "/transactions?view=review",
  prepare: async (page) => {
    // the seeded clustered backlog (§3.3): merchant "Confirm all" cards + one
    // uncategorized "Categorize all" card, above the amnesty drain control
    await expect(page.getByRole("button", { name: /Confirm all/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /before .* reviewed/ })).toBeVisible();
  },
});

defineStateTests({
  name: "bulk-selection",
  path: "/transactions",
  prepare: async (page) => {
    // §3.5 selection mode: enter it, pick two rows, and the bottom action bar
    // states the blast radius with category / reviewed / exclude / transfer
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const checks = page.getByRole("checkbox", { name: /^Select / });
    await checks.nth(0).check();
    await checks.nth(1).check();
    await expect(page.getByRole("region", { name: "Bulk actions" })).toBeVisible();
    await expect(page.getByText("2 selected")).toBeVisible();
  },
});
