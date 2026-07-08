import { expect, test, type Page } from "@playwright/test";

/**
 * Phase-gate visual baselines: every Phase 0 screen at 320/768/1024/1440 in
 * both themes (web testing rules + master-plan global phase gate).
 */
const WIDTHS = [320, 768, 1024, 1440] as const;
const THEMES = ["light", "dark"] as const;
const ROUTES = [
  { path: "/", name: "dashboard" },
  { path: "/accounts", name: "accounts" },
  { path: "/transactions", name: "transactions" },
  { path: "/spending", name: "spending" },
  { path: "/budgets", name: "budgets" },
  { path: "/recurring", name: "recurring" },
  { path: "/investments", name: "investments" },
  { path: "/settings", name: "settings" },
] as const;

async function openHydrated(page: Page, path: string, theme: string, width: number) {
  await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // theme-toggle icon renders only after hydration — waiting on it makes
  // screenshots deterministic (no pre/post-hydration ambiguity)
  await expect(page.locator("header button svg")).toBeVisible();
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    for (const route of ROUTES) {
      test(`${route.name} ${theme} @${width}`, async ({ page }) => {
        await openHydrated(page, route.path, theme, width);
        await expect(page).toHaveScreenshot(`${route.name}-${theme}-${width}.png`, {
          fullPage: true,
        });
      });
    }
  }
}

test("theme toggle switches themes", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: /switch to dark theme/i }).click();
  await expect(html).toHaveClass(/dark/);
  await page.getByRole("button", { name: /switch to light theme/i }).click();
  await expect(html).not.toHaveClass(/dark/);
});

test("exactly one navigation landmark is visible per viewport", async ({ page }) => {
  for (const route of ROUTES) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(route.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(1);

    await page.setViewportSize({ width: 360, height: 800 });
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(1);
  }
});

test("skip link jumps focus to main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});
