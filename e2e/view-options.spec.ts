import { expect, test, type Page } from "@playwright/test";
import { ACCOUNT_VIEW_SPEC } from "../src/components/accounts/accounts-view-spec";
import { DECISIONS_VIEW_SPEC } from "../src/components/dashboard/dashboard-view-spec";
import { HOLDING_VIEW_SPEC, PORTFOLIO_VIEW_SPEC } from "../src/components/investments/investments-view-spec";
import { RECURRING_SERIES_VIEW_SPEC } from "../src/components/recurring/recurring-view-spec";
import { CASH_VIEW_SPEC } from "../src/components/spending/spending-view-spec";
import { WHERE_VIEW_SPEC } from "../src/lib/massif-layout";
import type { ViewSpec } from "../src/lib/view-state";

/**
 * EVERY option of EVERY view dimension has to actually render.
 *
 * ## Why this generalises an existing spec instead of copying it
 *
 * `zz-zz-dashboard-chart-options.spec.ts` already enumerates one dimension, and
 * it exists because a whole suite went green over a 500: `terrain` was appended
 * to `DASHBOARD_VIEW_SPEC`, which made `/?chart=terrain` a real clickable URL,
 * while the page still cast the raw slug into an exhaustive switch that had no
 * case for it. 246 e2e tests passed because not one opened the view that had
 * just shipped. Its own docstring states the lesson: *a view dimension is a
 * PROMISE that every option renders, and the promise is only worth what
 * enumerates it.*
 *
 * ⛔ That lesson was applied to ONE of the app's nine view specs. Measured:
 * only `DASHBOARD_VIEW_SPEC` and `FLOW_VIEW_SPEC` are imported by any e2e
 * spec, and **`?cash=` and `?where=` appear in none at all** — so
 * `/spending?cash=graph` and the "Where it went" relief were reachable,
 * persistable URLs that nothing opened. This file closes the class rather than
 * another instance: add an option to any spec below and it is covered the same
 * day, with nobody having to remember.
 *
 * Deliberately SHALLOW, for the same reason the original is: each option's
 * content is asserted by its own spec. What this catches is the whole page
 * failing to render, which a rich per-view assertion is too specific to notice.
 *
 * Dimensions are enumerated INDEPENDENTLY, each with the others left at their
 * defaults. The combinatorial product of the investments specs is 8 URLs per
 * page and buys nothing: the failure this guards against is an option no branch
 * handles, which shows up on the first URL that names it.
 *
 * ## ⚠️ Why this needs no `zz-` prefix
 *
 * Choosing a view by CLICKING persists it — `saveViewPreferenceAction` writes to
 * `app_settings`, which is why `zz-card-deck.spec.ts` carries its prefix and
 * puts the grid back. Naming a view in the URL does not: `resolveViewState` is a
 * pure read (url → persisted → default). This spec only ever navigates, so it
 * mutates nothing and cannot rebase a baseline.
 */

interface Surface {
  label: string;
  spec: ViewSpec;
  /** Resolved per test — detail-page ids are minted per seed. */
  path: (page: Page) => Promise<string>;
}

const fixed = (p: string) => async () => p;

/** The first holding link on /investments, whichever it is. */
async function holdingPath(page: Page): Promise<string> {
  await page.goto("/investments");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  if (!href) throw new Error("no holding link on /investments");
  return href;
}

async function accountPath(page: Page): Promise<string> {
  await page.goto("/accounts");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/accounts/"]').first().getAttribute("href");
  if (!href) throw new Error("no account link on /accounts");
  return href;
}

async function seriesPath(page: Page): Promise<string> {
  await page.goto("/recurring?tab=all");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const href = await page.locator('a[href^="/recurring/"]').first().getAttribute("href");
  if (!href) throw new Error("no series link on /recurring?tab=all");
  return href;
}

/**
 * ⛔ `DASHBOARD_VIEW_SPEC` and `FLOW_VIEW_SPEC` are absent ON PURPOSE — they
 * have their own enumerating specs which assert more than "it rendered", and a
 * shallower second copy here would be a second definition of the same promise.
 * Everything else the app ships is below.
 */
const SURFACES: readonly Surface[] = [
  { label: "dashboard cards", spec: DECISIONS_VIEW_SPEC, path: fixed("/") },
  { label: "spending cash-flow", spec: CASH_VIEW_SPEC, path: fixed("/spending") },
  { label: "spending where-it-went", spec: WHERE_VIEW_SPEC, path: fixed("/spending") },
  { label: "portfolio", spec: PORTFOLIO_VIEW_SPEC, path: fixed("/investments") },
  { label: "holding detail", spec: HOLDING_VIEW_SPEC, path: holdingPath },
  { label: "account detail", spec: ACCOUNT_VIEW_SPEC, path: accountPath },
  { label: "series detail", spec: RECURRING_SERIES_VIEW_SPEC, path: seriesPath },
];

test("every surface below has options to enumerate", () => {
  // guards the guard: an empty spec would make every assertion here vacuous,
  // and an import that silently resolved to `undefined` would look identical
  for (const s of SURFACES) {
    expect(s.spec.length, `${s.label} has dimensions`).toBeGreaterThan(0);
    for (const d of s.spec) {
      expect(d.options.length, `${s.label} · ${d.key} has options`).toBeGreaterThanOrEqual(2);
    }
  }
});

for (const surface of SURFACES) {
  for (const dimension of surface.spec) {
    for (const option of dimension.options) {
      test(`${surface.label} renders with ${dimension.key}=${option}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));

        const base = await surface.path(page);
        const url = `${base}${base.includes("?") ? "&" : "?"}${dimension.key}=${option}`;
        const response = await page.goto(url);

        expect(response?.status(), `GET ${url}`).toBe(200);
        /*
         * The status alone is not enough: Next serves the error boundary with a
         * 200, so a crashed RSC looks like a healthy response from the outside.
         * This is the string the user actually sees.
         */
        await expect(page.getByText("This page didn't render.")).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(errors, `client errors at ${url}`).toEqual([]);
      });
    }
  }
}
