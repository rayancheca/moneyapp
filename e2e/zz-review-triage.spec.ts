import { expect, test } from "@playwright/test";

/**
 * The review-inbox triage flow (ux-overhaul-plan §3.3/§3.9): confirm a merchant
 * cluster in one gesture, undo it losslessly, then drain the historical backlog
 * with the amnesty. Runs LAST (zz-, after zz-golden-path) because it mutates the
 * shared seeded database — the read-only visual/a11y/interaction specs and the
 * golden-path upload have already finished against the pristine backlog.
 *
 * Targets the "Trader Joe's" merchant cluster by name: it is categorized, so
 * neither the golden-path import nor its categorize pass touches it (both only
 * act on uncategorized rows), keeping this spec independent of earlier mutations.
 */

test.describe.configure({ mode: "serial" });

const REVIEW = "/transactions?view=review";

test("confirm a merchant cluster in one gesture, then undo it", async ({ page }) => {
  await page.goto(REVIEW);

  const cluster = page.locator("[data-cluster-key]").filter({ hasText: "Trader Joe's" });
  await expect(cluster).toBeVisible();
  await cluster.getByRole("button", { name: /Confirm all/ }).click();

  // the value-returning action fires a toast and the cluster clears from the queue
  // (scope to the toast <p>; the aria-live region carries the same text off-screen)
  await expect(page.locator("p", { hasText: /Confirmed \d+ · Trader Joe's/ })).toBeVisible();
  await expect(page.locator("[data-cluster-key]").filter({ hasText: "Trader Joe's" })).toHaveCount(0);

  // Undo restores the whole cluster (lossless inverse patch)
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("[data-cluster-key]").filter({ hasText: "Trader Joe's" })).toBeVisible();
});

test("amnesty drains the pre-month backlog with a blast-radius confirm", async ({ page }) => {
  await page.goto(REVIEW);

  const amnesty = page.getByRole("button", { name: /Mark \d+ before .* reviewed/ });
  await expect(amnesty).toBeVisible();
  const before = Number((await amnesty.innerText()).match(/Mark (\d+)/)![1]);
  expect(before).toBeGreaterThan(0);

  await amnesty.click();
  await expect(page.locator("p", { hasText: /Marked \d+ reviewed/ })).toBeVisible();

  // the amnesty target is gone (all its rows now reviewed); any remaining
  // current-month clusters — or the cleared empty state — is a smaller queue
  await expect(page.getByRole("button", { name: /Mark \d+ before .* reviewed/ })).toHaveCount(0);
});
