import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Phase gate: zero critical a11y violations on every screen (master-plan §4).
 * We gate on serious too — everything on these screens is under our control.
 */
const ROUTES = [
  "/",
  "/accounts",
  "/transactions",
  "/spending",
  "/budgets",
  "/recurring",
  "/investments",
  "/settings",
] as const;
const THEMES = ["light", "dark"] as const;

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`axe: ${route} (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.goto(route);
      await expect(page.locator("header button svg")).toBeVisible(); // hydrated

      const results = await new AxeBuilder({ page }).analyze();
      const gating = results.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      expect(
        gating.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      ).toEqual([]);
    });
  }
}
