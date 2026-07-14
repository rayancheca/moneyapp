import { expect, test } from "@playwright/test";
import { analyzeSettled } from "./axe-helpers";

/**
 * S8 (Track 2): the net-worth chart expands into a focus modal — a native
 * <dialog> (focus trap, Escape, focus return) with the same scrub chart
 * rendered taller. View-transition morph is progressive enhancement; the test
 * asserts the functional contract, not the animation.
 */

test("chart focus mode opens as a modal, closes on Escape, returns focus", async ({ page }) => {
  await page.goto("/");
  const expand = page.getByRole("button", { name: "Focus the net worth chart" });
  await expect(expand).toBeVisible();
  await expand.click();

  const dialog = page.getByRole("dialog", { name: "Net worth chart — focus view" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Net worth — focus")).toBeVisible();
  // the focus view renders the interactive scrub chart
  await expect(
    dialog.getByRole("application", { name: /Net worth over time/ }).or(
      dialog.locator('[aria-label*="Net worth over time"]'),
    ).first(),
  ).toBeVisible();

  // overlay-open axe doctrine (keyboard.spec.ts): route scans never see this
  // dialog subtree — sweep it while it is OPEN
  const results = await analyzeSettled(page);
  const gating = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(gating.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  // native dialog returns focus to the opener
  await expect(expand).toBeFocused();
});

test("the close button also dismisses the focus view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Focus the net worth chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Net worth chart — focus view" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close focus view" }).click();
  await expect(dialog).not.toBeVisible();
});

test("the focus modal shares the range pill with the inline chart (both directions)", async ({ page }) => {
  await page.goto("/");
  // inline chart: switch 1Y → 3M (the dialog is closed, so the only visible
  // "Chart range" group belongs to the inline card)
  const inlinePills = page.getByRole("group", { name: "Chart range" });
  await inlinePills.getByRole("button", { name: "3 months" }).click();
  await expect(inlinePills.getByRole("button", { name: "3 months" })).toHaveAttribute("aria-pressed", "true");

  // open focus → the modal is "the same chart, bigger": 3M, not the 1Y default
  await page.getByRole("button", { name: "Focus the net worth chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Net worth chart — focus view" });
  await expect(dialog).toBeVisible();
  const dialogPills = dialog.getByRole("group", { name: "Chart range" });
  await expect(dialogPills.getByRole("button", { name: "3 months" })).toHaveAttribute("aria-pressed", "true");

  // change the range IN the modal → the inline chart follows after close
  await dialogPills.getByRole("button", { name: "1 month" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("group", { name: "Chart range" }).getByRole("button", { name: "1 month" }),
  ).toHaveAttribute("aria-pressed", "true");
});
