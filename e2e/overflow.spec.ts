import { expect, test, type Page } from "@playwright/test";

import { DASHBOARD_VIEW_SPEC } from "../src/components/dashboard/dashboard-view-spec";

/**
 * Horizontal-overflow gate — no route may scroll sideways on a phone.
 *
 * Why this exists as its own spec, when 143 visual baselines are already green:
 * `toHaveScreenshot({ fullPage: true })` captures the SCROLLPORT. A row that
 * runs 87px past a 320px viewport is simply cropped out of the PNG, so the
 * baseline is stable, reproducible, and blind to the defect. Three separate
 * passes shipped and then re-discovered the same three overflows by hand
 * because measuring width was nobody's assertion. Now it is.
 *
 * Widths: 320 is the spec floor; 375 is the common phone; 440 is the owner's
 * own device (iPhone 17 Pro Max, ~440pt CSS) and the width at which a previous
 * label-collision bug reproduced. Wider viewports are left to the visual
 * baselines — overflow is a narrow-viewport failure mode.
 */
const WIDTHS = [320, 375, 440] as const;

/**
 * Routes are duplicated from visual.spec.ts rather than shared, deliberately:
 * that list carries screenshot concerns (per-route `settle`, theme pinning,
 * chart-measurement waits) this spec does not need, and a shared list would
 * couple a width assertion to baseline churn. The overlap is checked by
 * `covers every route the visual baselines cover` at the bottom of this file,
 * so the two cannot silently drift apart.
 */
const ROUTES: readonly string[] = [
  "/",
  "/accounts",
  "/transactions",
  "/transactions?view=review",
  "/spending",
  "/spending?period=2026",
  // the category manager: a full-width table of every category with its
  // transaction count, so its min-content floor is set by the longest name
  "/categories",
  "/budgets",
  // all three tabs: they are separate DOMs behind one path, and the calendar is
  // a seven-column grid — the shape most likely to have a min-content floor
  "/recurring",
  "/recurring?tab=all",
  "/recurring?tab=calendar",
  "/investments",
  "/investments?range=1M",
  "/settings",
  "/imports",
  // reachable here only because playwright.config.ts sets MONEYAPP_PREVIEW=1;
  // a production `next start` returns notFound for it
  "/design/stage-0a",
  "/flow?shape=spine&measure=gross&lens=chart",
  "/flow?shape=tower&measure=gross&lens=chart",
];

interface Culprit {
  selector: string;
  right: number;
  width: number;
  text: string;
}

interface OverflowReport {
  scrollWidth: number;
  clientWidth: number;
  culprits: Culprit[];
}

/**
 * Measure the document and, when it overflows, name the elements responsible.
 *
 * An element is only a culprit if it escapes the viewport AND no ancestor
 * declares `overflow-x: auto|scroll|hidden`. A wide table inside its own
 * scroller is the SANCTIONED pattern in this codebase (the web rules require
 * wide content to scroll within its own container), so counting it would make
 * the gate un-passable and train everyone to ignore it. `hidden` counts as
 * contained too — it clips, so it cannot push the document wide.
 */
async function measure(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;

    const contained = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };

    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
        : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    const culprits: Culprit[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // display:none / unmounted
      if (r.right <= limit + 0.5) continue; // within the viewport (sub-pixel tolerance)
      if (contained(el)) continue; // inside a sanctioned scroller
      culprits.push({
        selector: describe(el),
        right: Math.round(r.right * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        text: (el.textContent ?? "").trim().slice(0, 60),
      });
    }

    // The deepest/widest offenders first — the outermost element is usually
    // just a container stretched by the real culprit inside it.
    culprits.sort((a, b) => b.right - a.right);
    return { scrollWidth: doc.scrollWidth, clientWidth: limit, culprits: culprits.slice(0, 6) };
  });
}

function explain(route: string, width: number, r: OverflowReport): string {
  const over = r.scrollWidth - r.clientWidth;
  const lines = [
    `${route} @${width}px overflows horizontally by ${over}px`,
    `  documentElement.scrollWidth=${r.scrollWidth}  clientWidth=${r.clientWidth}`,
    r.culprits.length
      ? "  widest escaping elements (not inside any overflow-x scroller):"
      : "  no un-contained element escapes — the overflow comes from a scroller's own width",
  ];
  for (const c of r.culprits) {
    lines.push(`    ${c.selector}  right=${c.right}  width=${c.width}  ${JSON.stringify(c.text)}`);
  }
  return lines.join("\n");
}

/** Load and wait for hydration — the same true signal visual.spec.ts uses: the
 *  theme toggle's SVG renders only after mount, unlike its accessible name,
 *  which is already in the SSR markup and proves nothing. Charts that size
 *  themselves from a ResizeObserver have measured by the time it exists. */
async function open(page: Page, route: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(route);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

for (const width of WIDTHS) {
  for (const route of ROUTES) {
    test(`no horizontal overflow — ${route} @${width}`, async ({ page }) => {
      await open(page, route, width);
      const report = await measure(page);
      expect(report.scrollWidth, explain(route, width, report)).toBeLessThanOrEqual(
        report.clientWidth,
      );
    });
  }
}

/**
 * The dynamic detail routes. Resolved from live content because their ids are
 * random per reseed; the resolvers mirror visual.spec.ts so the two specs
 * measure the same pages.
 */
const DYNAMIC: readonly { name: string; resolve: (page: Page) => Promise<string> }[] = [
  {
    /*
     * The year summary. Resolved from the ledger's own year list rather than
     * hard-coded, because the fixture's newest year moves with E2E_FAKE_TODAY
     * and a pinned year would quietly measure an empty page.
     */
    name: "/summary/[year]",
    resolve: async (page) => {
      await page.goto("/summary/2026");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      return "/summary/2026";
    },
  },
  {
    name: "/categories/[id]",
    resolve: async (page) => {
      await page.goto("/spending?period=2026");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const href = await page.locator('a[href^="/categories/"]').first().getAttribute("href");
      if (!href) throw new Error("no category link on /spending?period=2026");
      return `${href}?period=2026`;
    },
  },
  {
    name: "/investments/[assetType]/[symbol]",
    resolve: async (page) => {
      await page.goto("/investments");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
      if (!href) throw new Error("no holding link on /investments");
      return href;
    },
  },
  {
    name: "/accounts/[id]",
    resolve: async (page) => {
      await page.goto("/accounts");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const href = await page
        .locator('section[aria-label="Robinhood"] a[href^="/accounts/"]')
        .first()
        .getAttribute("href");
      if (!href) throw new Error("no account link in the Robinhood section on /accounts");
      return href;
    },
  },
  {
    name: "/recurring/[id]",
    resolve: async (page) => {
      // `?tab=all`, not the default `upcoming`: only AllSeriesView lists every
      // series as a link, and `upcoming` can legitimately be empty
      await page.goto("/recurring?tab=all");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const href = await page.locator('a[href^="/recurring/"]').first().getAttribute("href");
      if (!href) throw new Error("no series link on /recurring?tab=all");
      return href;
    },
  },
  {
    // No page links to a merchant directly (only a series detail and the ledger
    // row sheet do), so this reaches it the same way command-palette.spec.ts
    // does — ⌘K is the one deterministic path that does not depend on which
    // seeded row happens to carry a merchant.
    name: "/merchants/[id]",
    resolve: async (page) => {
      await page.goto("/transactions");
      await expect(
        page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
      ).toBeVisible();
      await page.keyboard.press("ControlOrMeta+KeyK");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await palette.getByRole("combobox").fill("Netflix");
      await palette.getByRole("option", { name: /Netflix/ }).first().click();
      await expect(page).toHaveURL(/\/merchants\/[A-Za-z0-9-]+/);
      return new URL(page.url()).pathname;
    },
  },
];

for (const width of WIDTHS) {
  for (const d of DYNAMIC) {
    test(`no horizontal overflow — ${d.name} @${width}`, async ({ page }) => {
      const url = await d.resolve(page);
      await open(page, url, width);
      const report = await measure(page);
      expect(report.scrollWidth, explain(d.name, width, report)).toBeLessThanOrEqual(
        report.clientWidth,
      );
    });
  }
}

/**
 * The dashboard's chart dimension, ENUMERATED FROM THE REGISTRY rather than
 * sampled. One state per route is not coverage for a URL-addressable view: the
 * pills that draw `?chart=sankey` are a different DOM from the ones that draw
 * `?chart=combined`, and only the sankey branch hand-rolls its own range row.
 * That row shipped 48px over the 320 floor and every one of these 49 width
 * assertions passed, because none of them opened it — the same lesson that
 * produced `zz-zz-dashboard-chart-options.spec.ts`, recurring inside the gate
 * that was supposed to be the backstop.
 *
 * Importing the spec (rather than restating the seven options) is the point:
 * an eighth option is measured the day it is added, with no second edit here.
 *
 * 320 only, deliberately. This sweep exists to catch automatic-minimum-size
 * failures, which are a min-content-vs-available problem and therefore always
 * bite hardest at the narrowest width — sankey measured 327px, so it fit at 375
 * and 440 and broke only at the floor. Running 7 options x 3 widths would
 * triple the cost of this file to re-measure two widths that cannot fail first.
 */
const CHART_OPTIONS: readonly string[] =
  DASHBOARD_VIEW_SPEC.find((d) => d.key === "chart")?.options ?? [];

test("the dashboard chart registry is non-empty", () => {
  // guards the guard: an import that silently resolved to [] would make every
  // assertion below vacuous by generating zero tests
  expect(CHART_OPTIONS.length).toBeGreaterThanOrEqual(7);
});

for (const chart of CHART_OPTIONS) {
  test(`no horizontal overflow — /?chart=${chart} @320`, async ({ page }) => {
    const route = `/?chart=${chart}`;
    await open(page, route, 320);
    const report = await measure(page);
    expect(report.scrollWidth, explain(route, 320, report)).toBeLessThanOrEqual(
      report.clientWidth,
    );
  });
}

/**
 * Structural drift guard. The guard below compares against visual.spec.ts, so a
 * route in NEITHER list is invisible to it by construction — which is exactly
 * how `/imports` went unmeasured and shipped 39px over. This one compares
 * against the filesystem instead, so a new `page.tsx` is covered or explicitly
 * exempted, and there is no third state.
 */
/**
 * Deliberately EMPTY. Every page in the app is measured, including the
 * `/design/stage-0a` specimen — it was clean at all three widths when this was
 * written, and a standing exemption for a route that passes is precisely the
 * unused third state that hid `/imports`. If a specimen ever needs to display
 * something wider than the viewport on purpose, add it here with that reason.
 */
const UNMEASURED: readonly { route: string; why: string }[] = [];

test("measures every page in src/app, or names why not", async () => {
  const { readdirSync } = await import("node:fs");
  const appDir = new URL("../src/app/", import.meta.url);
  const pages = readdirSync(appDir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name === "page.tsx")
    .map((e) => {
      const dir = e.parentPath ?? (e as unknown as { path: string }).path;
      const rel = dir.slice(dir.indexOf("src/app") + "src/app".length);
      return rel === "" ? "/" : rel;
    });

  expect(pages.length, "failed to enumerate src/app/**/page.tsx").toBeGreaterThan(10);

  const covered = new Set([
    ...ROUTES.map((r) => r.split("?")[0]!),
    ...DYNAMIC.map((d) => d.name),
    ...UNMEASURED.map((u) => u.route),
  ]);
  const unmeasured = pages.filter((p) => !covered.has(p));
  expect(
    unmeasured,
    `these pages exist but no width is ever measured on them: ${unmeasured.join(", ")}. ` +
      `Add each to ROUTES (static) or DYNAMIC (has an [id]), or to UNMEASURED with a reason.`,
  ).toEqual([]);
});

/**
 * Drift guard. A route added to the visual baselines but not here would be
 * screenshotted (and cropped) without ever being measured — exactly the hole
 * this spec was written to close. Compares path-only, since this spec pins
 * query strings for the /flow view dimensions the same way visual.spec.ts does.
 */
test("covers every route the visual baselines cover", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./visual.spec.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const ROUTES"), src.indexOf("/** Resolve a stable category"));
  const visualPaths = new Set(
    [...block.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]!.split("?")[0]!),
  );
  const minePaths = new Set(ROUTES.map((r) => r.split("?")[0]!));

  expect(visualPaths.size, "failed to parse routes out of visual.spec.ts").toBeGreaterThan(5);
  const missing = [...visualPaths].filter((p) => !minePaths.has(p));
  expect(
    missing,
    `visual.spec.ts screenshots these routes but overflow.spec.ts never measures them: ${missing.join(", ")}`,
  ).toEqual([]);
});
