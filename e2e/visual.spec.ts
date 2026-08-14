import { expect, test, type Page } from "@playwright/test";

/**
 * Phase-gate visual baselines: every Phase 0 screen at 320/768/1024/1440 in
 * both themes (web testing rules + master-plan global phase gate).
 */
const WIDTHS = [320, 768, 1024, 1440] as const;
const THEMES = ["light", "dark"] as const;

interface VisualRoute {
  path: string;
  name: string;
  /** extra wait for a route whose chart measures itself after mount */
  settle?: (page: Page) => Promise<void>;
}

/**
 * ⚠️ `/flow` needs more than `openHydrated` gives, for two reasons.
 *
 * 1. It PERSISTS its view (measure + shape + lens) in app_settings, and the
 *    whole suite shares one database — so its URL pins every dimension. Without
 *    that, a run in which `zz-zz-flow.spec.ts` failed between pressing "Table"
 *    and restoring "Chart" would leave these baselines capturing the matrix.
 * 2. Both of its charts size themselves from a ResizeObserver in a LAYOUT
 *    effect, so before React attaches they render at a hard-coded default width
 *    and the screenshot is of a chart that has not measured its container.
 *    `openHydrated` waits on the theme toggle by accessible NAME, which is in
 *    the SSR markup and therefore proves nothing; the SVG *inside* it renders
 *    only after mount and is a true signal. Layout effects all flush in the
 *    same commit, so once that svg exists the chart has measured.
 */
async function settleFlow(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

const ROUTES: readonly VisualRoute[] = [
  { path: "/", name: "dashboard" },
  { path: "/accounts", name: "accounts" },
  { path: "/transactions", name: "transactions" },
  { path: "/transactions?view=review", name: "transactions-review" }, // the categorize walk launcher + inbox
  { path: "/spending", name: "spending" },
  { path: "/spending?period=2026", name: "spending-year" },
  { path: "/budgets", name: "budgets" },
  { path: "/recurring", name: "recurring" },
  { path: "/investments", name: "investments" }, // ALL range → a gain (green) accent
  { path: "/investments?range=1M", name: "investments-loss" }, // 1M → a loss (red) accent
  { path: "/settings", name: "settings" },
  {
    path: "/flow?shape=spine&measure=gross&lens=chart",
    name: "flow-spine",
    settle: settleFlow,
  },
  {
    path: "/flow?shape=tower&measure=gross&lens=chart",
    name: "flow-tower",
    settle: settleFlow,
  },
];

/** Resolve a stable category page URL from the year view (id is random per
 *  reseed, but the top-spending category — hence the page content — is not). */
async function resolveCategoryUrl(page: Page): Promise<string> {
  await page.goto("/spending?period=2026");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/categories/"]').first().getAttribute("href");
  if (!href) throw new Error("no category link on /spending?period=2026");
  return `${href}?period=2026`;
}

/**
 * Resolve a holding-detail URL from /investments — whichever holding the page
 * links to FIRST in DOM order.
 *
 * ⚠️ Not "the largest holding by value", which is what this said until the
 * baselines were read back: the first link is AAPL, the SMALLEST position at
 * $7,147.20, because DOM order is not the holdings table's sort order.
 *
 * The expected symbol is asserted rather than assumed. Which page the eight
 * `holding-*` baselines capture is part of what they mean, and a reorder would
 * otherwise swap it silently — the run would still be green while every
 * baseline quietly documented a different asset.
 */
const EXPECTED_HOLDING = "/investments/stock/AAPL";

async function resolveInvestmentUrl(page: Page): Promise<string> {
  await page.goto("/investments");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  if (!href) throw new Error("no holding link on /investments");
  expect(href, "the holding baselines are captured against this page").toBe(EXPECTED_HOLDING);
  return href;
}

/** Resolve the Robinhood Brokerage account detail (holdings table + balance
 *  ScrubChart + ledger rows) — the richest account, and stable by the service's
 *  institution/displayOrder/name ordering. */
async function resolveAccountUrl(page: Page): Promise<string> {
  await page.goto("/accounts");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page
    .locator('section[aria-label="Robinhood"] a[href^="/accounts/"]')
    .first()
    .getAttribute("href");
  if (!href) throw new Error("no account link in the Robinhood section on /accounts");
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
  await settleAnimations(page);
}

/**
 * …and never screenshot a chart that is still drawing itself.
 *
 * `toHaveScreenshot({ animations: "disabled" })` does NOT fast-forward a
 * running CSS transition — it sets `transition: none`, which FREEZES it at
 * whatever value it had reached. Recharts' 1.1s reveal (ScrubChart's
 * `animateReveal`) is exactly such a transition, so a page captured mid-reveal
 * produces a stable-but-arbitrary frame: Playwright reports "captured a stable
 * screenshot" and the two consecutive frames agree, because both are frozen.
 * Measured on `dashboard dark @768`, three consecutive captures gave three
 * different half-drawn lines — a baseline that could be written but never
 * reproduced. Nothing about the wait relaxes an assertion; it removes the only
 * source of nondeterminism left in these screenshots.
 *
 * Same deterministic Web-Animations wait `axe-helpers.ts` already uses for the
 * route fade-rise, and for the same reason: wait on `finished`, never a timeout.
 * Infinite animations (the live-dot pulse-ring) never finish and are skipped —
 * they are decorative, and `animations: "disabled"` pins them to their first
 * frame, which is deterministic.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => {
        const timing = a.effect?.getTiming();
        if (timing && timing.iterations === Infinity) return undefined;
        // a cancelled animation (unmount) rejects `finished` — that is settled too
        return a.finished.catch(() => {});
      }),
    ),
  );
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    for (const route of ROUTES) {
      test(`${route.name} ${theme} @${width}`, async ({ page }) => {
        await openHydrated(page, route.path, theme, width);
        if (route.settle) {
          await route.settle(page);
          await settleAnimations(page);
        }
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

// account detail (`/accounts/[id]`) — resolved dynamically, fixed snapshot name
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`account-detail ${theme} @${width}`, async ({ page }) => {
      const url = await resolveAccountUrl(page);
      await openHydrated(page, url, theme, width);
      await expect(page).toHaveScreenshot(`account-detail-${theme}-${width}.png`, { fullPage: true });
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
