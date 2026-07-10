import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Keyboard + focus walkthrough of the Stage-0 overlay layer (ux-overhaul-plan
 * §2.9 gate: "keyboard walkthrough of Sheet/Menu/Palette"). Unit tests cover
 * the keyscope stack in isolation; these assert the browser-only behaviours
 * unit tests can't — <dialog>.showModal() inertness, native focus restoration,
 * and Esc precedence — against the /design/stage-0a preview, the only surface
 * that mounts the Sheet + rule Toast before the Stage-1 transactions rebuild
 * (which will re-point these at the real ledger). AxeBuilder also runs while
 * each overlay is OPEN, the coverage the route-level a11y scan can't reach.
 *
 * Runs before zz-golden-path.spec.ts (which mutates the shared seeded db);
 * these tests only read.
 */

const PREVIEW = "/design/stage-0a";

async function openHydrated(page: Page): Promise<void> {
  await page.goto(PREVIEW);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // the theme-toggle icon paints only after hydration — the KeyScope window
  // listener and the palette/sheet effects are live once it is. Target it by
  // name: the mounted Sheet also has a <header> button svg (strict-mode clash).
  await expect(
    page.getByRole("button", { name: /Switch to (light|dark) theme/ }),
  ).toBeVisible();
}

function gatingViolations(results: Awaited<ReturnType<AxeBuilder["analyze"]>>) {
  return results.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
}

test("sheet: opens with focus on the body region, Esc closes it (KeyScope precedence)", async ({
  page,
}) => {
  await openHydrated(page);
  await page.getByRole("button", { name: "Open preview sheet" }).click();

  const sheet = page.locator("dialog[open]");
  await expect(sheet).toBeVisible();
  // initial focus lands on the scrollable body, never the Close button:
  // readers hear content first and Enter can't instantly re-close the sheet
  await expect(sheet.locator("[role='region']")).toBeFocused();

  // Esc is owned by the sheet's modal KeyScope tier (list mnemonics below can't
  // leak, and the native cancel is preventDefaulted) — it pops this scope only
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("toast action stays operable and a11y-clean while a modal sheet is open", async ({ page }) => {
  await openHydrated(page);
  await page.getByRole("button", { name: "Open preview sheet" }).click();
  await expect(page.locator("dialog[open]")).toBeVisible();

  // The rule toast fires ~400ms after the sheet opens and, carrying an action,
  // never auto-dismisses. showModal() makes everything OUTSIDE the dialog inert
  // (dead to mouse AND keyboard) — the fix portals the toast stack INSIDE the
  // open dialog so its action survives. A visible-but-inert button would fail
  // Playwright's actionability check, so a successful click IS the proof.
  const action = page.getByRole("button", { name: "Create rule" });
  await expect(action).toBeVisible();

  // axe the live sheet + toast state (route scans never see open overlays)
  expect(gatingViolations(await new AxeBuilder({ page }).analyze())).toEqual([]);

  await action.click();
  await expect(action).toHaveCount(0); // acting dismissed the toast
  await expect(page.locator("dialog[open]")).toBeVisible(); // sheet stayed open
});

test("palette: ⌘K opens from anywhere and Esc restores focus to the trigger", async ({ page }) => {
  await openHydrated(page);

  const trigger = page.getByRole("button", { name: "Open preview sheet" });
  await trigger.focus();
  await expect(trigger).toBeFocused();

  // mod+k is registered at the palette tier, reachable from any context
  await page.keyboard.press("ControlOrMeta+KeyK");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();

  // browser-level axe on the combobox/listbox while it is open
  expect(gatingViolations(await new AxeBuilder({ page }).analyze())).toEqual([]);

  // the dialog stays mounted and closes via dialog.close(), so the browser's
  // dialog-close steps restore focus to the pre-⌘K element — not <body>
  await page.keyboard.press("Escape");
  await expect(palette).not.toBeVisible();
  await expect(trigger).toBeFocused();
});
