import { defineConfig, devices } from "@playwright/test";
import { E2E_FAKE_TODAY } from "./e2e/seed-helpers";

/**
 * Baseline lifecycle (stage-gate flow) — the webServer below runs `pnpm
 * start`, which serves whatever `.next` build already exists. A stale build
 * silently baselines OLD code, and a brand-new spec with no committed
 * baseline fails its first run by design (Playwright writes the actual and
 * fails). Neither is runtime flake; both are lifecycle. The sanctioned flow:
 *
 * - Regenerating baselines after an intentional UI change:
 *     `pnpm build && pnpm e2e:update`   (fresh build, --update-snapshots)
 *   Commit the regenerated snapshots WITH the UI change that caused them.
 * - Verifying a stage gate:
 *     `pnpm e2e:fresh`                  (next build && playwright test)
 *   Never gate against an old `.next`; a gate run must not write snapshots.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // specs share one database; the golden-path spec mutates it last
  retries: 0,
  globalSetup: "./e2e/global-setup.ts",
  // A gate run (E2E_GATE=1) must never silently write a missing baseline and
  // pass on the rewrite: turn absence into an explicit error so "expected
  // churn" can't masquerade as "no regression". Local dev keeps the default
  // 'missing' (write-then-fail) so a brand-new spec self-heals on rerun.
  updateSnapshots: process.env.E2E_GATE ? "none" : "missing",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3111",
    trace: "retain-on-failure",
  },
  expect: {
    toHaveScreenshot: {
      // deterministic UI (no motion in baselines)
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // MONEYAPP_FAKE_TODAY pins server-side "today" (RSC renders on the
    // server) to the same date global-setup seeded with — see seed-helpers.ts.
    // MONEYAPP_ORIGINALS_DIR keeps browser-driven uploads (zz-golden-path)
    // out of the user's real data/originals archive — must match global-setup.
    // MONEYAPP_PREVIEW=1 un-gates /design/stage-0a (else notFound in a
    // production `next start`) so the overlay a11y + keyboard specs can reach
    // the only surface that mounts the Sheet/Toast before Stage 1.
    command: `MONEYAPP_DB_PATH=data/e2e.db MONEYAPP_ORIGINALS_DIR=data/e2e-originals MONEYAPP_BACKUPS_DIR=data/e2e-backups MONEYAPP_SKIP_BACKUP=1 MONEYAPP_FAKE_PRICES=1 MONEYAPP_FAKE_TODAY=${E2E_FAKE_TODAY} MONEYAPP_PREVIEW=1 pnpm start --port 3111`,
    url: "http://localhost:3111",
    // never baseline against a stale or foreign server
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
