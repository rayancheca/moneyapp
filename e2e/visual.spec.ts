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
  { path: "/spending?period=2026", name: "spending-year" },
  { path: "/budgets", name: "budgets" },
  { path: "/recurring", name: "recurring" },
  { path: "/investments", name: "investments" }, // ALL range → a gain (green) accent
  { path: "/investments?range=1M", name: "investments-loss" }, // 1M → a loss (red) accent
  { path: "/settings", name: "settings" },
] as const;

/** Resolve a stable category page URL from the year view (id is random per
 *  reseed, but the top-spending category — hence the page content — is not). */
async function resolveCategoryUrl(page: Page): Promise<string> {
  await page.goto("/spending?period=2026");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/categories/"]').first().getAttribute("href");
  if (!href) throw new Error("no category link on /spending?period=2026");
  return `${href}?period=2026`;
}

/** Resolve the first holding-detail URL from /investments (the largest holding
 *  by value — stable across reseeds since the fixture prices are fixed). */
async function resolveInvestmentUrl(page: Page): Promise<string> {
  await page.goto("/investments");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  if (!href) throw new Error("no holding link on /investments");
  return href;
}

async function openHydrated(page: Page, path: string, theme: string, width: number) {
  await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The theme-toggle icon renders only after hydration — waiting on it makes
  // screenshots deterministic. Target it by accessible name, not `header button
  // svg`: pages with a CalendarGrid (its own <header> nav) or a mounted Sheet
  // (its own <header> close button) put more than one svg under a <header>.
  await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeVisible();
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

// category page (`/categories/[id]`) — resolved dynamically, fixed snapshot name
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`category ${theme} @${width}`, async ({ page }) => {
      const url = await resolveCategoryUrl(page);
      await openHydrated(page, url, theme, width);
      await expect(page).toHaveScreenshot(`category-${theme}-${width}.png`, { fullPage: true });
    });
  }
}

// holding detail (`/investments/[assetType]/[symbol]`) — resolved dynamically
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`holding ${theme} @${width}`, async ({ page }) => {
      const url = await resolveInvestmentUrl(page);
      await openHydrated(page, url, theme, width);
      await expect(page).toHaveScreenshot(`holding-${theme}-${width}.png`, { fullPage: true });
    });
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
