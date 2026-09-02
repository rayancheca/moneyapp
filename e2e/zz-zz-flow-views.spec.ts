import { expect, test } from "@playwright/test";
import { FLOW_VIEW_SPEC } from "../src/components/charts/transfer-flow-view-spec";
import { specDefaults } from "../src/lib/view-state";

/**
 * EVERY option of EVERY /flow view dimension has to actually render.
 *
 * The same guard `zz-zz-dashboard-chart-options.spec.ts` exists for, now on the
 * surface that just grew a third dimension. A view dimension is a PROMISE that
 * every option renders — it puts a clickable pill on screen and a persistable,
 * shareable URL behind it — and the promise is worth exactly what enumerates
 * it. `/?chart=terrain` shipped as a 500 that 246 tests walked past, because
 * not one of them opened the view.
 *
 * Reading the spec itself means the next option added to FLOW_VIEW_SPEC is
 * covered the same day, with nobody having to remember. Deliberately shallow:
 * what this catches is the page failing to render at all, which is precisely
 * the failure a rich per-view assertion is too specific to notice.
 *
 * It navigates by URL and never clicks a pill, so it PERSISTS NOTHING — which
 * matters, because the whole suite shares one database and `/flow` is a
 * view-persisting surface.
 */

const DEFAULTS = specDefaults(FLOW_VIEW_SPEC);

/**
 * The accessible name of each dimension's switcher. A MAP, not a ternary with a
 * catch-all: a `key === "measure" ? … : key === "shape" ? … : "Transfer lens"`
 * silently routes any future dimension to the lens group, where it finds a
 * pressed button, passes, and reports nothing — the exact vacuity this file
 * exists to prevent. An unmapped dimension must fail loudly instead.
 */
const SWITCHER_LABEL: Record<string, string> = {
  measure: "Transfer measure",
  shape: "Transfer shape",
  // the tower's CAMERA became a real dimension on 2026-09-02 (it declared a URL
  // key over a `useState` before), and its pill lives inside TransferTower —
  // beside the drawing it turns, not in the panel with the other three
  towerView: "Tower viewpoint",
  lens: "Transfer lens",
};

/**
 * Pin EVERY dimension in the URL and vary one. `/flow?shape=tower` alone does
 * not decide what is drawn — `lens` does — so with `lens=table` persisted from
 * an earlier spec, that URL renders the MATRIX, the tower is never mounted, and
 * every assertion below still passes. The suite shares one database and
 * `zz-zz-flow.spec.ts` presses "Table" mid-test, so that state is reachable
 * inside a single run whenever a test between the press and the restore fails.
 */
/**
 * Dimensions whose SWITCHER only exists inside another dimension's value.
 *
 * The tower's camera pill is rendered by `TransferTower`, beside the drawing it
 * turns — so `?towerView=plan` with the default `shape=spine` renders no group
 * at all and the check below would fail for the wrong reason. Declared rather
 * than special-cased inline, so the next such pill has somewhere to go.
 */
const REQUIRES: Record<string, Record<string, string>> = {
  towerView: { shape: "tower" },
};

function url(overrides: Record<string, string>): string {
  const params = new URLSearchParams({ ...DEFAULTS, ...overrides });
  return `/flow?${params.toString()}`;
}

test("the flow spec has dimensions and options to enumerate", () => {
  // guards the guard: an empty spec would make every assertion below vacuous
  expect(FLOW_VIEW_SPEC.length).toBeGreaterThanOrEqual(3);
  for (const dim of FLOW_VIEW_SPEC) {
    expect(dim.options.length, `dimension "${dim.key}" has no options`).toBeGreaterThanOrEqual(2);
    expect(
      SWITCHER_LABEL[dim.key],
      `dimension "${dim.key}" has no entry in SWITCHER_LABEL — add one, or the ` +
        `URL check below cannot tell whether its pill responded`,
    ).toBeDefined();
  }
});

for (const dim of FLOW_VIEW_SPEC) {
  for (const option of dim.options) {
    test(`/flow renders with ${dim.key}=${option}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));

      const target = url({ [dim.key]: option });
      const response = await page.goto(target);

      expect(response?.status(), `GET ${target}`).toBe(200);
      // a status check alone is not enough: the error boundary renders with 200
      await expect(page.getByText("This page didn't render.")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Flow", level: 1 })).toBeVisible();
      // the switchers must survive — they are how a user gets back out of a view,
      // and a crash that took only the panel would still strand them there
      await expect(page.getByRole("group", { name: "Transfer measure" })).toBeVisible();
      await expect(page.getByRole("group", { name: "Transfer lens" })).toBeVisible();

      // and the drawing itself has to exist, or "renders" means nothing
      if (option === "table") {
        await expect(page.getByRole("table")).toBeVisible();
      } else if (dim.key === "shape") {
        const drawn = option === "tower" ? "[data-arc]" : "g[data-edge]";
        await expect(page.locator(drawn).first()).toBeVisible();
        if (option === "tower") expect(await page.locator("[data-arc]").count()).toBeGreaterThan(0);
      }

      expect(errors, `client errors with ${dim.key}=${option}`).toEqual([]);
    });
  }
}

/**
 * The URL is the shareable part of a view. A dimension the PAGE forgets to read
 * still works from its own pill — setView persists, then navigates, and the
 * persisted value wins — so the bug is invisible in the app and only shows up
 * when someone opens a link. That is exactly the failure this asserts away.
 */
test("every dimension is honoured from the URL, not merely from its pill", async ({ page }) => {
  for (const dim of FLOW_VIEW_SPEC) {
    // defaults are options[0], so the last option is never the default
    const nonDefault = dim.options[dim.options.length - 1]!;
    // ask in the CHART lens: the shape switcher is deliberately not rendered
    // beside the matrix, since the matrix is the same matrix either way
    await page.goto(
      url({
        [dim.key]: nonDefault,
        lens: dim.key === "lens" ? nonDefault : "chart",
        // a pill that lives INSIDE a drawing needs that drawing on screen
        ...(REQUIRES[dim.key] ?? {}),
      }),
    );

    const group = SWITCHER_LABEL[dim.key];
    expect(group, `unmapped dimension "${dim.key}"`).toBeDefined();

    const pressed = page.getByRole("group", { name: group }).getByRole("button", { pressed: true });
    await expect(
      pressed,
      `/flow?${dim.key}=${nonDefault} did not select "${nonDefault}" — check that ` +
        `src/app/flow/page.tsx passes ${dim.key} into resolveViewState`,
    ).toHaveCount(1);
    // and it is genuinely the non-default one, not the default sitting pressed
    await expect(pressed).not.toHaveText(new RegExp(`^${dim.options[0]!}$`, "i"));
  }
});
