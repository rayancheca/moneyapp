import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";

/**
 * Investments interaction contract (ux-overhaul-plan §6.5). READ-ONLY — it only
 * navigates and drives client state (range pills, keyboard scrub, the P/L day
 * sheet), never mutating the seed, so it is order-independent; named `zz-` to
 * sort after the visual/a11y baselines. The seeded portfolio is fixture-forced
 * so the ALL range is a gain and the 1M range is a loss (seed-helpers
 * seedInvestments), which makes the accent-switch assertion deterministic.
 */

async function gotoInvestments(page: Page): Promise<void> {
  await page.goto("/investments");
  await expect(page.getByRole("heading", { level: 1, name: "Investments" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeVisible();
}

test("range pills switch the accent: ALL is a gain, 1M is a loss", async ({ page }) => {
  await gotoInvestments(page);
  const slider = page.getByRole("slider", { name: /Portfolio value over time/ });
  // default range is ALL → an upward (gain) accent
  await expect(slider).toHaveAttribute("aria-valuetext", /up \d/);

  await page.getByRole("button", { name: "1 month" }).click();
  await expect(page.getByRole("button", { name: "1 month" })).toHaveAttribute("aria-pressed", "true");
  // the 1M window dips (fixture ETH loss) → a downward accent
  await expect(slider).toHaveAttribute("aria-valuetext", /down \d/);
});

test("money-weighted (XIRR) return is shown alongside the time-weighted return", async ({ page }) => {
  await gotoInvestments(page);
  // the Total-return stat pairs the flow-insensitive TWR with the money-weighted
  // (XIRR) return — both stated, never conflated
  await expect(page.getByText(/time-weighted/)).toBeVisible();
  await expect(page.getByText("money-weighted · your dollars")).toBeVisible();
});

test("keyboard scrub moves the hairline and announces the point", async ({ page }) => {
  await gotoInvestments(page);
  const slider = page.getByRole("slider", { name: /Portfolio value over time/ });
  await slider.focus();
  const before = await slider.getAttribute("aria-valuenow");
  const beforeText = await slider.getAttribute("aria-valuetext");

  for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowLeft");

  const after = await slider.getAttribute("aria-valuenow");
  const afterText = await slider.getAttribute("aria-valuetext");
  expect(Number(after)).toBe(Number(before) - 5); // hairline stepped back five days
  expect(afterText).not.toBe(beforeText); // a different day → a different announcement
  expect(afterText).toMatch(/\$[\d,]+/); // still a money value text
});

test("the metric column cycles to Realized P/L ('—' until a sell exists)", async ({ page }) => {
  await gotoInvestments(page);
  // tap the cycling header: Day % → Day change → Unrealized P/L → Realized P/L
  const cycle = () => page.getByRole("button", { name: /Tap to cycle metric/ }).click();
  await cycle();
  await cycle();
  await expect(page.getByRole("button", { name: /Unrealized P\/L/ })).toBeVisible();
  await cycle();
  await expect(page.getByRole("button", { name: /Realized P\/L/ })).toBeVisible();
  // the fixture book has no sells — every row honestly reads "—"
  const table = page.getByRole("table");
  await expect(table.getByTitle(/No sells yet/).first()).toBeVisible();
});

test("a holding page renders trade marks on the price chart", async ({ page }) => {
  await gotoInvestments(page);
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trade history" })).toBeVisible();
  await expect(page.getByText("Buy").first()).toBeVisible();
  // ReferenceDot trade marks render as <circle> inside the chart svg
  await expect(page.locator("svg circle").first()).toBeVisible();
});

test("the portfolio chart opens a focus modal that carries the same view + footer, Escape closes it", async ({
  page,
}) => {
  await gotoInvestments(page);
  // the inline card exposes a focus affordance (pass-22 chart-parity: focus mode
  // everywhere) — clicking it expands the SAME chart into a labelled dialog
  await page.getByRole("button", { name: "Focus the Portfolio chart" }).click();
  const dialog = page.getByRole("dialog", { name: /Portfolio chart — focus/ });
  await expect(dialog).toBeVisible();
  // the same scrub chart renders inside (default Value view → value slider)
  await expect(dialog.getByRole("slider", { name: /Portfolio value over time/ })).toBeVisible();
  // the summary footer (TWR/XIRR/P/L) renders in the modal too — footer parity
  await expect(dialog.getByText("money-weighted · your dollars")).toBeVisible();
  // the open modal must be axe-clean (critical/serious only)
  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);
  // Escape closes natively (no morph trap) and returns focus to the opener
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("switching a holding between Price and Return resets the shared range (no lying caption)", async ({
  page,
}) => {
  await gotoInvestments(page);
  const href = await page.locator('a[href^="/investments/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // this holding has a Return view (>= 2 flow-adjusted days)
  const returnToggle = page.getByRole("button", { name: "Return", exact: true });
  await expect(returnToggle).toBeVisible();

  // in Price view (default), select a non-default window (default is ALL)
  const oneMonth = page.getByRole("button", { name: "1 month" });
  await oneMonth.click();
  await expect(oneMonth).toHaveAttribute("aria-pressed", "true");

  // switching series must RESET the range to the default: the price series is
  // today-anchored while the return series ends at the last trade, so carrying
  // "1M" across would leave ScrubChart falling back to the full series while the
  // pill still read "1M" (a lying caption). The lifted range resets on switch.
  await returnToggle.click();
  await expect(page.getByRole("button", { name: "all time" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "1 month" })).toHaveAttribute("aria-pressed", "false");

  // restore the default Price view — the holding view preference PERSISTS
  // (saved to app_settings), so leaving it on Return would pollute sibling
  // specs that expect the price chart (view-switcher, visual holding baselines)
  await page.getByRole("group", { name: "Holding chart view" }).getByRole("button", { name: "Price" }).click();
  await expect(page.getByRole("slider", { name: /price over time/ })).toBeVisible();
});

test("the P/L calendar opens a day sheet with per-holding detail", async ({ page }) => {
  await gotoInvestments(page);
  // day cells with movement carry "portfolio up/down …" in their aria-label
  const dayCell = page.getByRole("button", { name: /portfolio (up|down)/ }).first();
  await expect(dayCell).toBeVisible();
  await dayCell.click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Portfolio P/L")).toBeVisible();

  // the open sheet must be axe-clean too (critical/serious only)
  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);
});

/** Every wedge's `opacity` attribute, in slice order. */
async function wedgeOpacities(page: Page): Promise<(string | null)[]> {
  return page.locator("path.recharts-sector").evaluateAll((els) => els.map((e) => e.getAttribute("opacity")));
}

test("the allocation donut highlights a holding from its legend, and is keyboard-reachable", async ({ page }) => {
  await gotoInvestments(page);
  const legend = page.getByRole("list", { name: "Allocation legend" });
  await expect(legend).toBeVisible();
  await legend.scrollIntoViewIfNeeded();

  // RESTING: nothing highlighted, so nothing is dimmed — this is the state the
  // visual baselines capture, and it must stay untouched by the feature
  const rest = await wedgeOpacities(page);
  expect(rest.length).toBeGreaterThan(1);
  expect(rest.every((o) => o === "1")).toBe(true);

  // KEYBOARD: the legend rows are the existing tab stops, so FOCUS drives the
  // same highlight a pointer does — no second set of tab stops on the wedges
  const rows = legend.getByRole("link");
  await rows.nth(1).focus();
  const focused = await wedgeOpacities(page);
  expect(focused[1]).toBe("1"); // the focused holding stays lit
  expect(focused.filter((o) => o === "1")).toHaveLength(1); // every other wedge recedes

  // the legend swatches follow their wedge, but the LABELS never dim — text
  // contrast is identical in every highlight state (AA can't regress here).
  //
  // Polled rather than sampled once: a wedge carries its opacity as an SVG
  // ATTRIBUTE (flips instantly), but a swatch dims through a CSS transition, so
  // a single getComputedStyle can land at t=0 and still read the resting "1"
  // for every swatch. Same two facts asserted — one lit, and it is the focused
  // one — just waited for instead of raced.
  const swatchOpacities = () =>
    legend
      .locator("span[aria-hidden]")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  await expect
    .poll(async () => {
      const o = await swatchOpacities();
      return { lit: o.filter((x) => x === "1").length, focusedIsLit: o[1] === "1" };
    })
    .toEqual({ lit: 1, focusedIsLit: true });

  // blurring restores the resting state exactly
  await rows.nth(1).blur();
  expect(await wedgeOpacities(page)).toEqual(rest);
});
