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
