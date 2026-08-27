import { expect, test, type Page } from "@playwright/test";

/**
 * The 1D intraday view (owner's ask: "obviously the day view needs time on x axis").
 *
 * `zz-zz-` because these tests WRITE to `price_intraday` — via the real
 * "Load today's session" control rather than a seeding back door, so the write
 * path is exercised too. Under MONEYAPP_FAKE_PRICES the provider is
 * deterministic: 79 five-minute equity ticks from 13:30Z, 288 for crypto.
 *
 * WHAT THIS EXISTS TO CATCH. The chart derives its window and its axis from
 * `.day` with calendar math, and a session puts an ISO INSTANT there — which
 * that math correctly refuses by throwing. Five call sites would throw if the
 * substitution seam leaked (chart-window, both branches of chart-axis, the
 * tooltip readout, and the two drag-window captions), and every one of them
 * renders as a 500 rather than as a wrong pixel. The unit guards pin that those
 * parsers still refuse instants; this pins that the page never hands them one.
 */

/** Navigate, then wait for hydration — a segmented pill ships enabled in the SSR
 *  HTML, so a click before React attaches is silently swallowed (pass-26). */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }).locator("svg"),
  ).toBeVisible();
}

/**
 * Every axis tick label the chart is actually painting — BOTH axes.
 *
 * Two selectors that look obviously right return nothing here, and both would
 * have reported "the axis has no time labels" about a chart painting them
 * perfectly. recharts renders tick text into a separate
 * `.recharts-cartesian-axis-tick-label` layer, so `.recharts-cartesian-axis-tick`
 * matches six elements whose textContent is empty, and `.recharts-xAxis text`
 * matches nothing at all (the axis `<g>` contains zero `<text>` nodes).
 *
 * Since the layer is shared, this returns the y-axis money labels too. That is
 * fine for every assertion below and makes one of them stronger: no label
 * anywhere may read as a bare calendar day.
 */
async function tickLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="slider"] .recharts-cartesian-axis-tick-label')]
      .map((t) => (t.textContent ?? "").trim())
      .filter(Boolean),
  );
}

const TIME_LABEL = /\d{1,2}:\d{2}\s?(AM|PM)/;

test("1D loads a session and puts TIME on the x axis", async ({ page }) => {
  // (1) the URL-seeded range must render at all — the direct DateParseError
  // regression. A registry-driven view needs a spec that opens the option
  // (pass-25: /?chart=terrain was a 500 that 246 green tests walked past).
  await gotoHydrated(page, "/investments?range=1D");
  await expect(page.getByRole("heading", { name: "Investments" })).toBeVisible();

  // (2) nothing has ticked yet, so the view says so instead of drawing a flat
  // line, and offers the action that fixes it
  const loadButton = page.getByRole("button", { name: "Load today's session" });
  await expect(page.getByText(/No intraday prices for today yet/)).toBeVisible();
  await expect(loadButton).toBeVisible();

  // the daily fallback is still a real two-point segment, not a blank chart
  await expect(page.locator('[role="slider"]').first()).toBeVisible();

  // (3) load it for real — this hits refreshIntraday through the server action
  await loadButton.click();
  // .first(): the toast text is mirrored into an sr-only aria-live region
  await expect(page.getByText("Today's session loaded").first()).toBeVisible();

  // (4) THE OWNER'S ASK: the axis now reads as a clock, not as a calendar
  await expect(page.getByText(/Today's session ·/)).toBeVisible();
  const labels = await tickLabels(page);
  expect(labels.length).toBeGreaterThan(1);
  expect(labels.some((l) => TIME_LABEL.test(l))).toBe(true);
  // and no label is a bare calendar day, which is what it used to draw
  expect(labels.every((l) => !/^[A-Z][a-z]{2} \d{1,2}$/.test(l))).toBe(true);

  // (5) THE HEADER MUST AGREE WITH THE LINE. The portfolio's daily summarize is
  // flow-adjusted and selects rows with `d.day >= from`; handed an instant, that
  // comparison is false for every row, so it reported "$0.00 (+0.00%)" over a
  // session that had visibly moved — a wrong number with no exception anywhere.
  // Nothing else in this file would have caught it.
  const header = page.locator("p", { hasText: /· 1D/ }).first();
  await expect(header).toBeVisible();
  await expect(header).not.toContainText("$0.00 (+0.00%)");
});

test("the 1D readout names an instant, and scrubbing still walks it", async ({ page }) => {
  await gotoHydrated(page, "/investments?range=1D");
  const load = page.getByRole("button", { name: "Load today's session" });
  if (await load.isVisible()) {
    await load.click();
    await expect(page.getByText(/Today's session ·/)).toBeVisible();
  }

  const slider = page.locator('[role="slider"]').first();
  await expect(slider).toBeVisible();

  // the accessible readout must name a TIME — a day label here would mean the
  // header is describing a point the chart is not showing
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", TIME_LABEL);

  // scrubbing is index arithmetic over the session, so the keys still move it
  const first = await slider.getAttribute("aria-valuenow");
  await slider.press("ArrowRight");
  await expect(slider).not.toHaveAttribute("aria-valuenow", first ?? "");
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", TIME_LABEL);
});

test("the table lens shows the same session, timestamped", async ({ page }) => {
  await gotoHydrated(page, "/investments?range=1D");
  const load = page.getByRole("button", { name: "Load today's session" });
  if (await load.isVisible()) {
    await load.click();
    await expect(page.getByText(/Today's session ·/)).toBeVisible();
  }

  // the two lenses must agree about what "today" is; a Day column here would
  // mean the table was still windowing daily rows beside an intraday chart
  await page.getByRole("group", { name: "Portfolio lens" }).getByRole("button", { name: "Table" }).click();
  await expect(page.getByRole("columnheader", { name: "Time" })).toBeVisible();
  const caption = page.getByText(/today's session, \d+ points, newest first/);
  await expect(caption).toBeVisible();
  // it really is intraday, not the two-point daily fallback wearing a new header
  const points = Number(/(\d+) points/.exec((await caption.textContent()) ?? "")?.[1] ?? 0);
  expect(points).toBeGreaterThan(20);

  // restore the default lens for sibling specs (this persists per surface)
  await page.getByRole("group", { name: "Portfolio lens" }).getByRole("button", { name: "Chart" }).click();
  await expect(page.getByRole("columnheader", { name: "Time" })).toHaveCount(0);
});

test("a holding's own 1D opens from the previous close", async ({ page }) => {
  // AAPL is an equity, so its session starts at 13:30Z with a real overnight
  // gap — the case where the grid alone would silently start at the OPEN
  await gotoHydrated(page, "/investments/stock/AAPL");
  const pills = page.getByRole("group", { name: "Chart range" }).first();
  await pills.getByRole("button", { name: "1 day" }).click();

  const load = page.getByRole("button", { name: "Load today's session" });
  if (await load.isVisible()) {
    await load.click();
  }

  // the basis is STATED, not implied by the shape of the line
  await expect(page.getByText(/measured from yesterday's close/)).toBeVisible();

  const labels = await tickLabels(page);
  expect(labels.some((l) => TIME_LABEL.test(l))).toBe(true);
  // the axis keeps its end labels off the plot edges, where recharts centres
  // them half outside the chart (this rendered "Prev close" as "v close")
  expect(labels).not.toContain("v close");
});

test("the daily-only surfaces still offer no 1D pill at all", async ({ page }) => {
  // the negative control for the whole seam: DAILY_SERIES_RANGES is derived by
  // excluding "1D", so these surfaces cannot reach any session branch
  for (const path of ["/", "/flow"]) {
    await gotoHydrated(page, path);
    const groups = page.getByRole("group", { name: "Chart range" });
    for (let i = 0; i < (await groups.count()); i++) {
      await expect(groups.nth(i).getByRole("button", { name: "1 day" })).toHaveCount(0);
    }
  }
});

/**
 * Wait for the session control to settle, then load a session if one is needed.
 *
 * `isVisible()` does NOT auto-wait — it samples the DOM at one instant. Called
 * straight after a re-render it races the render, so the same run could take
 * either branch. That matters far more than it looks: the two branches leave
 * the page at DIFFERENT scroll offsets (0 vs 180), and at 180 the 56px sticky
 * header sits over the top of the chart card. A screenshot of the card then
 * captures the header bleeding across it — 983 differing pixels, intermittent,
 * and indistinguishable from a real visual regression.
 *
 * Waiting for EITHER the button or a loaded session first makes the branch a
 * property of the data (has this run priced AAPL yet?) rather than of timing.
 */
/**
 * Clear any toast before a card capture.
 *
 * ⚠️ Loading the session raises a "Today's session loaded" toast, and the toast
 * is `position: fixed` — so it overlaps the chart card and lands INSIDE an
 * element screenshot whenever the shot happens before it auto-dismisses. That
 * is a race: the baseline was recorded without it and a rerun caught it, which
 * makes the shot non-deterministic in both directions. Dismissing explicitly is
 * what removes the timing from the picture; waiting a fixed interval would only
 * move the race.
 */
async function dismissToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  for (let i = await dismiss.count(); i > 0; i = await dismiss.count()) {
    await dismiss.first().click();
    await expect(dismiss).toHaveCount(i - 1);
  }
}

async function ensureSessionLoaded(page: Page): Promise<void> {
  const load = page.getByRole("button", { name: "Load today's session" });
  await expect(load.or(page.getByText(/Today's session ·/)).first()).toBeVisible();
  if (await load.isVisible()) {
    await load.click();
  }
}

/**
 * Pin the page to the top before a card capture.
 *
 * Playwright scrolls a locator into view before shooting it, but only if it is
 * not already fully visible — so the resulting framing inherits whatever scroll
 * the preceding interactions happened to leave behind. Every card captured here
 * fits inside the 900px viewport at scroll 0, so scrolling home makes that
 * scroll-into-view a no-op and puts the card in the same place every run,
 * clear of the sticky header. Without it the capture is only as stable as the
 * scroll side effects of the clicks above it.
 */
async function scrollHome(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Visual baselines for the LOADED 1D state.
 *
 * They live here rather than in `visual.spec.ts` because of tier ordering: this
 * state only exists after something writes `price_intraday`, and the zz-zz tier
 * is where that write is allowed to happen. Seeding it globally instead would
 * make every surface's 1D pill intraday by default, which would invert the
 * daily-fallback assertion in zz-zz-view-switcher — a bigger change than the
 * coverage is worth.
 */
async function settleAnimations(page: Page): Promise<void> {
  // a frozen mid-reveal frame is stable but arbitrary: recharts' 1.1s draw-on is
  // a CSS transition, and `animations: "disabled"` freezes it rather than
  // completing it (visual.spec.ts learned this the expensive way)
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => {
        const timing = a.effect?.getTiming();
        if (timing && timing.iterations === Infinity) return undefined;
        return a.finished.catch(() => {});
      }),
    ),
  );
}

for (const width of [440, 1280]) {
  test(`the loaded 1D portfolio chart looks right @${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoHydrated(page, "/investments?range=1D");
    await ensureSessionLoaded(page);
    await expect(page.getByText(/Today's session ·/)).toBeVisible();
    await dismissToasts(page);
    await settleAnimations(page);
    await scrollHome(page);

    const card = page.locator('[role="slider"]').first().locator("xpath=ancestor::*[contains(@class,'relative')][1]");
    await expect(card).toHaveScreenshot(`intraday-portfolio-1d-${width}.png`);
  });
}

test("the loaded 1D holding chart looks right", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoHydrated(page, "/investments/stock/AAPL");
  await page.getByRole("group", { name: "Chart range" }).first().getByRole("button", { name: "1 day" }).click();
  await ensureSessionLoaded(page);
  await expect(page.getByText(/measured from yesterday's close/)).toBeVisible();
  await settleAnimations(page);
  await scrollHome(page);

  const card = page.locator('[role="slider"]').first().locator("xpath=ancestor::*[contains(@class,'relative')][1]");
  await expect(card).toHaveScreenshot("intraday-holding-1d.png");
});
