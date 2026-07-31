import { expect, test, type Page } from "@playwright/test";

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
  "/budgets",
  "/recurring",
  "/investments",
  "/investments?range=1M",
  "/settings",
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
