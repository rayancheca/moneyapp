import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every page a server action can redirect to with `?error=` must RENDER it.
 *
 * The contract: React types `<form action>` as `(formData) => void | Promise<void>`,
 * so a server action used that way cannot return a failure. The void adapters
 * therefore `redirect()` back with the human message on `?error=` instead of
 * throwing and letting a Next.js error digest replace the page
 * (src/app/transactions/actions.ts:112-118 spells this out).
 *
 * That contract is only half-implemented by the redirect. Until this spec existed
 * NOTHING asserted the other half: `/accounts/[id]` and `/transactions` were both
 * being redirected to and both dropped the param, so a refused "Record a balance"
 * or a refused re-categorization re-rendered the page completely unchanged — the
 * exact silence the redirect was designed to avoid. Six other pages had it right,
 * which is what made the two holes invisible.
 *
 * `role="alert"` is asserted, not just the text: the redirect is a client
 * navigation, so without the live region a screen-reader user is never told.
 */

/** A message with a space, an ampersand and a quote — the ampersand is the one that
 *  matters, since /transactions appends `&error=` after existing filter params. */
const MSG = 'Could not save: "amount" & date are required';

interface Target {
  name: string;
  /** built with the message already encoded, exactly as the actions build it */
  url: (msg: string) => Promise<string> | string;
}

const STATIC: readonly Target[] = [
  { name: "/settings", url: (m) => `/settings?error=${encodeURIComponent(m)}` },
  { name: "/imports", url: (m) => `/imports?error=${encodeURIComponent(m)}` },
  { name: "/budgets", url: (m) => `/budgets?error=${encodeURIComponent(m)}` },
  { name: "/recurring", url: (m) => `/recurring?error=${encodeURIComponent(m)}` },
  { name: "/investments", url: (m) => `/investments?error=${encodeURIComponent(m)}` },
  { name: "/accounts", url: (m) => `/accounts?error=${encodeURIComponent(m)}` },
  { name: "/transactions", url: (m) => `/transactions?error=${encodeURIComponent(m)}` },
  // the shape returnPath() actually produces: error appended AFTER filters, with `&`
  {
    name: "/transactions (error after filters, via returnPath)",
    url: (m) => `/transactions?view=review&page=1&error=${encodeURIComponent(m)}`,
  },
];

async function accountDetailUrl(page: Page, msg: string): Promise<string> {
  await page.goto("/accounts");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/accounts/"]').first().getAttribute("href");
  if (!href) throw new Error("no account link on /accounts");
  return `${href}?error=${encodeURIComponent(msg)}`;
}

for (const target of STATIC) {
  test(`renders ?error= — ${target.name}`, async ({ page }) => {
    await page.goto(await target.url(MSG));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const alert = page.getByRole("alert").filter({ hasText: MSG });
    await expect(alert, `${target.name} dropped the ?error= message instead of rendering it`)
      .toBeVisible();
  });
}

test("renders ?error= — /accounts/[id] (the Record-a-balance path)", async ({ page }) => {
  const url = await accountDetailUrl(page, MSG);
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: MSG }),
    "/accounts/[id] dropped the ?error= message — addAnchorAction redirects here on refusal",
  ).toBeVisible();
});

/**
 * Drift guard: a NEW action that redirects with `?error=` must land on a page that
 * renders it. Derives the expectation from the action sources rather than a list a
 * future pass would forget to update — `src/app/<segment>/actions.ts` containing an
 * `error=` redirect implies `/<segment>` is a landing page and must be covered above.
 */
test("every action that redirects with ?error= lands on a covered page", () => {
  const appDir = path.join(process.cwd(), "src", "app");
  const segments = readdirSync(appDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("[") && !d.name.startsWith("("))
    .map((d) => d.name);

  const redirecting = segments.filter((seg) => {
    for (const file of ["actions.ts", "rules-actions.ts"]) {
      const p = path.join(appDir, seg, file);
      try {
        if (/[?&]error=/.test(readFileSync(p, "utf8"))) return true;
      } catch {
        // no such action file in this segment
      }
    }
    return false;
  });

  expect(redirecting.length, "found no ?error= redirects at all — did the scan break?")
    .toBeGreaterThan(4);

  const covered = new Set(STATIC.map((t) => t.name.split(" ")[0]));
  const uncovered = redirecting.map((s) => `/${s}`).filter((r) => !covered.has(r));
  expect(
    uncovered,
    `these segments redirect with ?error= but no test above asserts their page renders it: ${uncovered.join(", ")}`,
  ).toEqual([]);
});
