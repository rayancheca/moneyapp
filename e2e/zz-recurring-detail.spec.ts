import { expect, test, type Page } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";

/**
 * Series detail + calendar sub-view (ux-overhaul-plan §4.2/§4.1.3). Runs LAST
 * (zz-, before zz-recurring-tabs) because "Detect now" mutates the shared seed;
 * detection is idempotent so re-running it here is safe. Covers the detail
 * page's attach / detach / merge flows and the calendar Day Sheet, with an
 * in-state axe sweep on each new surface (route-level a11y never opens them).
 */

async function detectAndOpenFirstSeries(page: Page): Promise<void> {
  await page.goto("/recurring");
  await page.getByRole("button", { name: "Detect now" }).click();
  await page.goto("/recurring?tab=all");
  // every series row/card links to its detail page
  await page.locator('a[href^="/recurring/"]').first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Linked transactions/ })).toBeVisible();
}

/** "Linked transactions · N" → N */
async function linkedCount(page: Page): Promise<number> {
  const text = (await page.getByRole("heading", { name: /^Linked transactions/ }).textContent()) ?? "";
  return Number(text.replace(/\D+/g, ""));
}

test("detail page renders the editable cadence sentence and passes axe", async ({ page }) => {
  await detectAndOpenFirstSeries(page);

  // the cadence sentence states the schedule in words with editable tokens
  await expect(page.getByText(/charges|deposits|moves/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Series name:/ })).toBeVisible();

  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);
});

test("detach then attach round-trips the linked count", async ({ page }) => {
  await detectAndOpenFirstSeries(page);
  const before = await linkedCount(page);
  expect(before).toBeGreaterThan(0);

  // detach the first linked row via its ⋯ menu (scoped away from the header menu)
  await page.getByRole("button", { name: /^Actions for/ }).first().click();
  await page.getByRole("menuitem", { name: "Not part of this series" }).click();
  await expect(page.getByRole("heading", { name: `Linked transactions · ${before - 1}` })).toBeVisible();

  // the just-detached charge is now an unlinked candidate near the series amount
  await page.getByRole("button", { name: /Find transactions to attach/ }).click();
  const firstCandidate = page.getByRole("checkbox").first();
  await expect(firstCandidate).toBeVisible();
  await firstCandidate.check();
  await page.getByRole("button", { name: /^Attach/ }).click();
  await expect(page.getByRole("heading", { name: `Linked transactions · ${before}` })).toBeVisible();
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 54): merging a series in files its rows not filed yet under this series' category,
 * and the confirmation SAYS so before he presses — that sentence was his condition for merge filing at all.
 *
 * 🔴 The merge test below never shows it: its first candidate is income, which the rule refuses onto a subscription,
 * so the sentence could be deleted from the page with every test green. Read where it fires instead: on Apple
 * (Subscriptions > Software), CAPITAL ONE 360 TRANSFER is a bill whose 24 rows at −$400.00 have no category — measured
 * 2026-10-08 on a copy of the post-suite data/e2e.db through `seriesDetail`. Cancel, so nothing is merged or filed.
 */
test("the merge confirmation names what it will file before the press", async ({ page }) => {
  await page.goto("/recurring");
  await page.getByRole("button", { name: "Detect now" }).click();
  await page.goto("/recurring?tab=all");
  await page.getByRole("link", { name: "Apple", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: /^Linked transactions/ })).toBeVisible();

  await page.getByRole("button", { name: /Merge another series in/ }).click();
  await page.getByPlaceholder("Search series…").fill("CAPITAL ONE");
  await page.getByRole("button", { name: "Choose CAPITAL ONE 360 TRANSFER to merge in", exact: true }).click();
  const prompt = page.locator("[popover]").filter({ hasText: "into this series?" });
  await expect(prompt.locator("p")).toHaveText(
    "Merge CAPITAL ONE 360 TRANSFER into this series? Its charges move here and it ends. " +
      "24 not filed yet will be filed under Subscriptions > Software.",
  );
  await prompt.getByRole("button", { name: "Cancel" }).click();

  // nothing to file (Rent's rows are filed) → the sentence he has always read, unchanged
  await page.getByPlaceholder("Search series…").fill("Rent");
  await page.getByRole("button", { name: "Choose Rent to merge in", exact: true }).click();
  await expect(prompt.locator("p")).toHaveText("Merge Rent into this series? Its charges move here and it ends.");
  await prompt.getByRole("button", { name: "Cancel" }).click();
});

test("merging another series in relinks its charges and ends it", async ({ page }) => {
  await detectAndOpenFirstSeries(page);

  await page.getByRole("button", { name: /Merge another series in/ }).click();
  await expect(page.getByPlaceholder("Search series…")).toBeVisible();
  // each candidate row is a button labelled "Choose {name} to merge in"
  await page.getByRole("button", { name: /^Choose .* to merge in$/ }).first().click();
  await page.getByRole("button", { name: "Merge in" }).click();
  await expect(page.locator("p", { hasText: /merged in/ })).toBeVisible();
});

test("calendar day sheet lists the day's recurring activity and passes axe", async ({ page }) => {
  await page.goto("/recurring");
  await page.getByRole("button", { name: "Detect now" }).click();
  await page.goto("/recurring?tab=calendar");

  await expect(page.getByRole("grid")).toBeVisible();
  // a day with activity announces its items in the aria-label
  const activeDay = page.getByRole("gridcell").getByRole("button", { name: /items:/ }).first();
  await expect(activeDay).toBeVisible();
  await activeDay.click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('a[href^="/recurring/"]').first()).toBeVisible();

  // let the open transition finish so axe measures the settled (opaque) sheet,
  // not a mid-fade frame whose reduced opacity trips a false contrast failure
  await page.waitForFunction(() => {
    const d = document.querySelector("dialog[open]");
    return !!d && getComputedStyle(d).opacity === "1";
  });

  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);
});
