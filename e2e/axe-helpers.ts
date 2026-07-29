import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Axe must never race the UI's entrance motion. The route-level fade-rise
 * (src/app/template.tsx) animates opacity 0→1 on EVERY navigation, and axe
 * computes color-contrast from the mid-animation BLENDED colors — a passing
 * palette reads as a "serious" violation while the text is still translucent
 * (observed: ink-faint scanned at 4.2:1 mid-fade, clean once settled). So all
 * axe scans go through this helper: wait for every FINITE animation's
 * `finished` promise (a deterministic Web-Animations wait, not a timeout),
 * then analyze. Infinite loops (the live-dot pulse-ring) are skipped — they
 * never finish and only animate decorative, text-free nodes.
 */
export async function analyzeSettled(page: Page): Promise<Awaited<ReturnType<AxeBuilder["analyze"]>>> {
  // ...and never race the NAVIGATION either. A view switch persists through a
  // server action and then router.push()es; scanning while that document is
  // still being swapped in yields a torso of ~43 phantom violations led by
  // "Document does not have a non-empty <title>" — the page isn't broken, it
  // just isn't there yet. A real document always has a title (every route sets
  // metadata), so that is the deterministic signal to wait on.
  await page.waitForFunction(() => document.title.trim().length > 0);
  // ...and settle to a FIXED POINT, not to one snapshot of the animation set.
  //
  // `getAnimations()` only reports animations that already exist. Hydration
  // mounts the client tree AFTER the toggle this helper's callers wait on, so a
  // single pass can await an empty-or-partial list, return early, and scan a
  // page that is still fading in — the exact mid-fade blend this helper was
  // written to avoid. Measured: `axe: / (light)` failed ~1 run in 6 in
  // isolation and 2 runs in 4 in a full suite, always with the same signature
  // (`color-contrast`, serious, 39 nodes) and never reproducible on demand.
  //
  // Looping to a fixed point closes that window: settle everything currently
  // running, yield a frame so anything hydration started can register, and
  // repeat until a frame passes with nothing finite left. The cap is a
  // backstop, not a timeout — normal pages reach the fixed point in 2 passes.
  await page.evaluate(async () => {
    const settleOnce = async (): Promise<number> => {
      const finite = document.getAnimations().filter((a) => {
        const timing = a.effect?.getTiming();
        // an infinite loop (the live-dot pulse-ring) never finishes, and only
        // animates decorative, text-free nodes
        return !(timing && timing.iterations === Infinity);
      });
      // a cancelled animation (unmount) rejects `finished` — that's settled too
      await Promise.all(finite.map((a) => a.finished.catch(() => {})));
      return finite.length;
    };
    for (let pass = 0; pass < 8; pass++) {
      const settled = await settleOnce();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (settled === 0 && document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity)) {
        return;
      }
    }
  });
  return new AxeBuilder({ page }).analyze();
}
