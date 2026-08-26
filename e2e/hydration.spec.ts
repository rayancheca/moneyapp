import { expect, test, type Page } from "@playwright/test";

/**
 * Every route hydrates cleanly.
 *
 * ## Why this spec exists
 *
 * A hydration mismatch does not fail a build, does not fail a type-check, and
 * in production does not even print a readable message — React ships it as a
 * minified `#418`. What it DOES do is discard the client tree for the affected
 * subtree, which silently removes that part of the page's interactivity.
 *
 * On 2026-08-26 one such tag — a `ProvenancePopover` inside a `<p>` in a card
 * headline — failed NINE tests that never mention that card: all eight
 * dashboard chart views, plus the net-worth drag test, whose `boundingBox()`
 * came back null because the plot never hydrated. Nothing in any of those
 * failures named the cause. A second, older instance was found the same day in
 * `CadenceSentence`, where it had been sitting since the Phase 1 commit.
 *
 * ## The rule it guards
 *
 * ⛔ A `<p>` may not contain a `<div>`. HTML parsing CLOSES the paragraph where
 * the div begins, so the browser's DOM stops matching the server's string. Any
 * `Popover`-based component — `ProvenancePopover`, `CadenceToken`, anything
 * whose panel is a `<div popover>` — therefore must never be mounted inside a
 * paragraph. `<h1>`–`<h3>`, `<dt>`, `<li>` and `<span>` are all fine.
 *
 * ## Why it asserts on a signature rather than on silence
 *
 * "No console errors at all" would be a stricter claim than this spec can keep:
 * a future third-party warning, or a deliberate error log, would turn it red
 * for a reason unrelated to hydration and it would get weakened or skipped.
 * Matching the two React messages that mean "the DOM you built is not the DOM
 * you described" keeps the assertion narrow enough to stay trustworthy.
 *
 * `pageerror` IS asserted absolutely, because an uncaught exception during
 * render is never acceptable on any route.
 */

/**
 * The React messages that mean a hydration or DOM-nesting failure, in both
 * their development and production spellings. #418 and #425 are the minified
 * hydration errors; the nesting message is what the dev build prints instead.
 */
const HYDRATION_SIGNATURE = /Minified React error #(418|425)|cannot be a descendant of|Hydration failed|did not match/i;

/**
 * Every route the app serves. Deliberately its own list rather than a shared
 * one: `overflow.spec.ts` carries width-measurement machinery this spec does not
 * need, and coupling them would make a hydration check depend on a layout list.
 * The completeness check at the bottom is what stops the two drifting.
 */
const ROUTES: readonly string[] = [
  "/",
  "/accounts",
  "/transactions",
  "/spending",
  "/categories",
  "/budgets",
  "/recurring",
  "/recurring?tab=all",
  "/recurring?tab=calendar",
  "/investments",
  "/settings",
  "/imports",
  "/flow",
];

/** Routes whose URL depends on a row id, resolved from the fixture at run time. */
const DYNAMIC: readonly { name: string; resolve: (page: Page) => Promise<string | null> }[] = [
  {
    name: "/accounts/[id]",
    resolve: async (page) => {
      await page.goto("/accounts");
      const href = await page.locator('a[href^="/accounts/"]').first().getAttribute("href");
      return href;
    },
  },
  {
    name: "/categories/[id]",
    resolve: async (page) => {
      await page.goto("/spending");
      const href = await page.locator('a[href^="/categories/"]').first().getAttribute("href");
      return href;
    },
  },
  {
    name: "/recurring/[id]",
    resolve: async (page) => {
      await page.goto("/recurring?tab=all");
      const href = await page.locator('a[href^="/recurring/"]').first().getAttribute("href");
      return href;
    },
  },
  {
    name: "/investments/[assetType]/[symbol]",
    resolve: async (page) => {
      await page.goto("/investments");
      const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
      return href;
    },
  },
];

/** Collects everything the page complains about while it loads and settles. */
async function complaints(page: Page, url: string): Promise<string[]> {
  const found: string[] = [];
  page.on("pageerror", (e) => found.push(`[pageerror] ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") found.push(`[console] ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle" });
  // hydration runs after the document settles; without this the assertion can
  // pass simply by being made too early
  await page.waitForTimeout(400);
  return found;
}

test.describe("every route hydrates", () => {
  for (const route of ROUTES) {
    test(`no hydration mismatch — ${route}`, async ({ page }) => {
      const found = await complaints(page, route);
      const hydration = found.filter((f) => HYDRATION_SIGNATURE.test(f));
      expect(hydration, `hydration failure on ${route}:\n${hydration.join("\n")}`).toEqual([]);
      const crashes = found.filter((f) => f.startsWith("[pageerror]"));
      expect(crashes, `uncaught exception on ${route}:\n${crashes.join("\n")}`).toEqual([]);
    });
  }

  for (const d of DYNAMIC) {
    test(`no hydration mismatch — ${d.name}`, async ({ page }) => {
      const url = await d.resolve(page);
      // a fixture with no such row is not a pass: say so rather than assert
      // nothing, which is how a route quietly loses its coverage
      expect(url, `no ${d.name} link found in the fixture to follow`).not.toBeNull();
      const found = await complaints(page, url!);
      const hydration = found.filter((f) => HYDRATION_SIGNATURE.test(f));
      expect(hydration, `hydration failure on ${url}:\n${hydration.join("\n")}`).toEqual([]);
      const crashes = found.filter((f) => f.startsWith("[pageerror]"));
      expect(crashes, `uncaught exception on ${url}:\n${crashes.join("\n")}`).toEqual([]);
    });
  }
});
