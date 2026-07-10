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
  // preview surface for the Stage-0 primitives (un-gated by MONEYAPP_PREVIEW
  // in the harness); replaced by the real /transactions rebuild in Stage 1.
  // Overlay-open axe lives in keyboard.spec.ts — this scans the closed page.
  "/design/stage-0a",
] as const;
const THEMES = ["light", "dark"] as const;

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`axe: ${route} (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.goto(route);
      // hydrated — target the theme toggle by name, not `header button svg`
      // (a mounted Sheet has its own <header> + close button, two svgs)
      await expect(
        page.getByRole("button", { name: /Switch to (light|dark) theme/ }),
      ).toBeVisible();

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
