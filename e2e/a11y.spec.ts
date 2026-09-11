import { expect, test } from "@playwright/test";
import { withParam } from "./url-helpers";
import { analyzeSettled } from "./axe-helpers";

/**
 * Phase gate: zero critical a11y violations on every screen (master-plan §4).
 * We gate on serious too — everything on these screens is under our control.
 */
const ROUTES = [
  "/",
  "/accounts",
  "/transactions",
  "/transactions?view=review", // categorize-walk launcher + review inbox
  "/spending",
  "/spending?period=2026",
  "/budgets",
  // swept from pass 46, BEFORE the disclosure/reorder/inline-edit work landed on
  // it — this route carries ~180 controls and axe had never looked at it
  "/categories",
  "/recurring",
  "/investments",
  "/investments?range=1M", // the loss (red) accent state
  "/settings",
  // preview surface for the Stage-0 primitives (un-gated by MONEYAPP_PREVIEW
  // in the harness); replaced by the real /transactions rebuild in Stage 1.
  // Overlay-open axe lives in keyboard.spec.ts — this scans the closed page.
  "/design/stage-0a",
] as const;
const THEMES = ["light", "dark"] as const;

async function expectHydrated(page: import("@playwright/test").Page): Promise<void> {
  // hydrated — target the theme toggle by name, not `header button svg`
  // (a mounted Sheet has its own <header> + close button, two svgs)
  await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeVisible();
}

function gatingViolations(results: { violations: { id: string; impact?: string | null; nodes: unknown[] }[] }) {
  return results.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
}

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`axe: ${route} (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.goto(route);
      await expectHydrated(page);
      const results = await analyzeSettled(page);
      expect(gatingViolations(results)).toEqual([]);
    });
  }

  // category page (`/categories/[id]`) — resolved dynamically
  test(`axe: /categories/[id] (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
    await page.goto("/spending?period=2026");
    const href = await page.locator('a[href^="/categories/"]').first().getAttribute("href");
    if (!href) throw new Error("no category link on /spending?period=2026");
    await page.goto(withParam(href, "period", "2026"));
    await expectHydrated(page);
    const results = await analyzeSettled(page);
    expect(gatingViolations(results)).toEqual([]);
  });

  // holding detail (`/investments/[assetType]/[symbol]`) — resolved dynamically
  test(`axe: /investments/[holding] (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
    await page.goto("/investments");
    const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
    if (!href) throw new Error("no holding link on /investments");
    await page.goto(href);
    await expectHydrated(page);
    const results = await analyzeSettled(page);
    expect(gatingViolations(results)).toEqual([]);
  });

  // account detail (`/accounts/[id]`) — resolved dynamically (holdings + charts)
  test(`axe: /accounts/[id] (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
    await page.goto("/accounts");
    const href = await page
      .locator('section[aria-label="Robinhood"] a[href^="/accounts/"]')
      .first()
      .getAttribute("href");
    if (!href) throw new Error("no account link in the Robinhood section on /accounts");
    await page.goto(href);
    await expectHydrated(page);
    const results = await analyzeSettled(page);
    expect(gatingViolations(results)).toEqual([]);
  });
}
