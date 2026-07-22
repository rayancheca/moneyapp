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
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => {
        const timing = a.effect?.getTiming();
        if (timing && timing.iterations === Infinity) return undefined;
        // a cancelled animation (unmount) rejects `finished` — that's settled too
        return a.finished.catch(() => {});
      }),
    ),
  );
  return new AxeBuilder({ page }).analyze();
}
