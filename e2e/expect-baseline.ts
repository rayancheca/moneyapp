import { expect, type Locator, type Page } from "@playwright/test";
import { baselineRefusal } from "../scripts/e2e-renderer/fingerprint";

/**
 * expect() for a comparison with a committed baseline:
 *
 *     await expectBaseline(page).toHaveScreenshot("dashboard-light-1440.png", { fullPage: true });
 *
 * Global setup measures the renderer canary once a run. A gate (E2E_GATE) is stopped there
 * outright when this Mac no longer draws it as e2e/baseline-renderer.json says. Any other run goes
 * on, so that a spec comparing no baseline is not stopped for a Mac it never asks about, and the
 * refusal lands here instead: global setup hands it to the workers (E2E_RENDERER_REFUSAL), and
 * every comparison with a committed baseline throws it before comparing, or, under
 * --update-snapshots, before redrawing one with the Mac's drift in it. The rest of the test up to
 * that line has run, as it would have up to a failing screenshot.
 *
 * A bare expect(…).toHaveScreenshot would compare whatever the renderer:
 * scripts/e2e-renderer/baseline-guard.test.ts refuses one in any spec.
 */
export function expectBaseline<T extends Page | Locator>(target: T): ReturnType<typeof expect<T>> {
  const refusal = baselineRefusal(process.env);
  if (refusal !== null) throw new Error(refusal);
  return expect(target);
}
