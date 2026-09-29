import { defineConfig, devices } from "@playwright/test";
import { E2E_FAKE_TODAY } from "./e2e/seed-helpers";
import { scratchSnapshotTemplate } from "./scripts/e2e-renderer/snapshot-root";

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
 * - After an OS or browser update moves text rendering (the run stops in
 *   global-setup with "THE RENDERER CHANGED"):
 *     `pnpm e2e:rebase-renderer`             (dry run: proves it, writes nothing)
 *     `pnpm e2e:rebase-renderer --confirm`   (re-bases, records, re-runs the gate)
 */
const snapshotPathTemplate = scratchSnapshotTemplate(process.env);

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
  // E2E_SNAPSHOT_ROOT is set by `pnpm e2e:rebase-renderer` alone, for its control run: every
  // screenshot is read from and written to a scratch root with the same layout as e2e/, so the
  // run can draw the whole suite without --update-snapshots touching one committed baseline.
  // Unset, Playwright keeps its default layout under e2e/. A gate (E2E_GATE) refuses it here,
  // before one screenshot is compared, and any other run it redirects says so first thing in
  // global-setup: left set in a shell, it would compare every screenshot with the control's.
  ...(snapshotPathTemplate === undefined ? {} : { snapshotPathTemplate }),
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3111",
    trace: "retain-on-failure",
    // The BROWSER's timezone and locale are inputs to every rendered date, and
    // until now they were whatever the developer's machine happened to be. That
    // is the same hole pass 30's timezone bug went through: a plan that is
    // undetectably wrong on an Eastern box.
    //
    // Pacific/Kiritimati (UTC+14, and it has never observed DST) rather than
    // UTC, for the reason vitest.config.ts already pins it: under UTC the local
    // date EQUALS the UTC date on an Eastern box, so a `new Date(isoDay)` that
    // should have shifted a day silently agrees with itself and the bug class
    // stays invisible. At +14 every such slip is off by one and shows up.
    //
    // en-US matches the explicit locale the app's own Intl formatters request,
    // so a machine set to another locale can no longer move a baseline.
    timezoneId: "Pacific/Kiritimati",
    locale: "en-US",
  },
  expect: {
    toHaveScreenshot: {
      // deterministic UI (no motion in baselines)
      animations: "disabled",
      /**
       * FLAT, not a ratio. `maxDiffPixelRatio: 0.001` scaled the allowance with
       * page AREA, so the taller the page the blinder the gate: /transactions at
       * 1440x3487 is 5.0M pixels, which bought 5,021 pixels of silence. Three
       * real changes lived in that silence for months — a whole `Categories` item
       * added to the sidebar (0.00077 of a flow page, and therefore invisible on
       * every page that has a sidebar), a `Duplicates` filter tab added to
       * /transactions, and the dashboard's committed-bills figure moving
       * $2,000.41 → $2,004.16 when recurring absorption shipped.
       *
       * ZERO is not aspirational, it is measured. Re-running the whole suite at
       * `maxDiffPixelRatio: 0` put 435 of 458 tests green: every one of those
       * baselines matches itself run to run. The 22 that failed were all real
       * content, not anti-aliasing — the SMALLEST of them was 41 pixels. There is
       * no CI; this gate runs on one Mac with one font stack, so there is no
       * second renderer to be tolerant of.
       *
       * "Zero" is zero pixels as Playwright's comparator counts them, which is not
       * byte-exact: a pixel counts only past `threshold` (0.2 in YIQ by default,
       * about 52 grey levels) and only when pixelmatch does not take it for
       * anti-aliasing. Measured 2026-09-28: 20 dark pages drawn before macOS 27.2
       * differ from this Mac's drawing by 931 to 6,394 pixels and pass, and one
       * light page moved 5 pixels by one level between two runs of the same
       * commit. scripts/e2e-renderer/gate-comparator.ts asks the same comparator.
       *
       * An OS or font update that moves text rendering is NOT a reason to raise
       * this. macOS 27.2 did exactly that on 2026-09-28: 107 baselines failed
       * with no UI change, a median 0.23% of a page's pixels and a worst 0.59%,
       * thousands of pixels a page. A flat allowance that swallowed that would
       * swallow the 41-pixel changes above with it, and a ratio is how they hid
       * in the first place.
       * global-setup's renderer canary now stops the run in a second when the
       * Mac draws differently, and `pnpm e2e:rebase-renderer` does what that
       * session did by hand: a control run of the whole suite at the last pushed
       * commit, every committed baseline judged against it by
       * scripts/e2e-renderer/diff-verdict.ts, a refusal on anything that is not
       * renderer drift, and the gate re-run with the check on.
       *
       * Any other diff is read before it is regenerated: `node
       * scripts/crop-visual-diff.mjs test-results/<dir> <baseline>` crops the
       * changed region out of a full-page screenshot so you can see whether it is
       * anti-aliasing or a whole missing nav item.
       */
      maxDiffPixels: 0,
    },
  },
  // Two projects, ONE spec apart. The row controls in the ledger are hidden
  // (opacity-0) until hover/focus — a phone has neither, so the whole contract
  // rests on a `pointer-coarse:` branch that a desktop run can never execute.
  // Covering it needs a coarse-pointer context, and a project is the only way
  // to get one without re-running all 383 desktop tests a second time.
  //
  // `touch` is declared FIRST because with workers:1 Playwright drains the
  // queue in project-declaration order: the reveal spec reads the pristine
  // seeded database before any zz- spec mutates it.
  //
  // The `testIgnore` on chromium is LOAD-BEARING. `testMatch` narrows only the
  // project that carries it, so without the mirror-image ignore the new spec
  // would be collected by BOTH projects — the double-run this split exists to
  // avoid, and a second (fine-pointer) run of a spec that asserts coarse.
  //
  // hasTouch alone, NOT a phone descriptor: `hasTouch` is the single input
  // Chromium maps to `(pointer: coarse)`. A device descriptor would also swap
  // the UA and deviceScaleFactor, changing inputs this spec does not test.
  projects: [
    {
      name: "touch",
      testMatch: /touch-reveal\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: "chromium",
      testIgnore: /touch-reveal\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // MONEYAPP_FAKE_TODAY pins server-side "today" (RSC renders on the
    // server) to the same date global-setup seeded with — see seed-helpers.ts.
    // MONEYAPP_ORIGINALS_DIR keeps browser-driven uploads (zz-golden-path)
    // out of the user's real data/originals archive — must match global-setup.
    // MONEYAPP_PREVIEW=1 un-gates /design/stage-0a (else notFound in a
    // production `next start`) so the overlay a11y + keyboard specs can reach
    // the only surface that mounts the Sheet/Toast before Stage 1.
    // ANTHROPIC_API_KEY= pins the ONE input that came from the developer's
    // machine rather than from this file. /settings renders a one-line
    // "configured" note when the key is present and a two-line "No
    // ANTHROPIC_API_KEY" warning when it is not — a 16px height delta that
    // failed all eight settings baselines the moment a real `.env` appeared
    // beside the worktree. Next's env loader never overwrites a key that is
    // already defined, so assigning empty here wins over `.env`. Absent is
    // also the honest default: no spec drives Claude classification, and a
    // live key would let one bill the owner for real API calls.
    // TZ pins the SERVER half of the same hole the browser `timezoneId` closes
    // above. RSCs render dates on the server, so leaving this to the host clock
    // means half the rendered page came from a pinned timezone and half from
    // whatever machine ran the suite. Same zone on both sides or neither is
    // pinned in any useful sense.
    command: `TZ=Pacific/Kiritimati MONEYAPP_DB_PATH=data/e2e.db MONEYAPP_ORIGINALS_DIR=data/e2e-originals MONEYAPP_BACKUPS_DIR=data/e2e-backups MONEYAPP_SKIP_BACKUP=1 MONEYAPP_FAKE_PRICES=1 MONEYAPP_FAKE_TODAY=${E2E_FAKE_TODAY} MONEYAPP_PREVIEW=1 ANTHROPIC_API_KEY= pnpm start --port 3111`,
    url: "http://localhost:3111",
    // never baseline against a stale or foreign server
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
