import fs from "node:fs";
import path from "node:path";
import {
  assertRendererMatchesBaselines,
  describeRendererCheck,
} from "../scripts/e2e-renderer/fingerprint";
import { assertQuietBox } from "../scripts/quiet-box";
import { E2E_FAKE_TODAY, seedE2eDatabase } from "./seed-helpers";

/**
 * E2E runs against a dedicated, freshly-built database — never dev data.
 * The base is seeded through the REAL import pipeline (fixture set A, see
 * seed-helpers.ts) so visual/a11y/interaction specs see populated pages;
 * capital-one (set B) stays reserved for zz-golden-path's upload flow.
 * The clock is pinned to E2E_FAKE_TODAY here AND in playwright.config.ts's
 * webServer command so seed-time derivation and server renders agree.
 */
/**
 * Fail fast when `.next` is older than the sources it is supposed to be built
 * from.
 *
 * playwright.config.ts serves the app with `pnpm start`, which happily serves a
 * STALE bundle — so `pnpm e2e` on unbuilt changes reports a green suite that
 * tested the previous build. That is not a theoretical risk: two Phase-1 waves
 * were signed off against a stale `.next`, and the rebuild immediately exposed
 * a client/server boundary violation that took two pages down. `tsc` cannot see
 * that class of bug; only a real render can.
 *
 * Green-but-meaningless is worse than red, so this throws rather than warns.
 * Use `pnpm e2e:fresh` (build + test). For a fast inner loop against a bundle
 * you know is current, set E2E_ALLOW_STALE=1.
 */
function assertBundleIsFresh(): void {
  if (process.env.E2E_ALLOW_STALE === "1") return;
  const buildId = path.join(process.cwd(), ".next", "BUILD_ID");
  if (!fs.existsSync(buildId)) {
    throw new Error("e2e: no .next build found — run `pnpm e2e:fresh` (or `next build`) first.");
  }
  const builtAt = fs.statSync(buildId).mtimeMs;

  let newest = 0;
  let newestFile = "";
  // Only `src` — Playwright runs e2e/ directly, so editing a spec does not make
  // the served bundle stale and must not block a run.
  //
  // ⛔ AND NOT `src`'s OWN TESTS, for exactly the same reason. `*.test.ts` lives
  // beside the code it tests but is never bundled, so touching one cannot make
  // the served pages stale — yet it tripped this guard and refused an e2e run
  // that had nothing wrong with it. A guard that blocks on a file it has already
  // reasoned is irrelevant is a guard people learn to skip with
  // E2E_ALLOW_STALE=1, which is worse than not having it.
  const roots = [path.join(process.cwd(), "src")];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) {
          newest = m;
          newestFile = path.relative(process.cwd(), full);
        }
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);

  if (newest > builtAt) {
    const drift = Math.round((newest - builtAt) / 1000);
    throw new Error(
      `e2e: .next is STALE — ${newestFile} was modified ${drift}s after the last build.\n` +
        "      `pnpm start` would serve the OLD bundle and the suite would pass against code you did not change.\n" +
        "      Run `pnpm e2e:fresh`, or set E2E_ALLOW_STALE=1 if you know the bundle is current.",
    );
  }
}

export default async function globalSetup(): Promise<void> {
  const load = assertQuietBox({ suite: "e2e", escapeHatch: "E2E_ALLOW_LOAD" });
  if (load.verdict !== "quiet") {
    console.warn(
      `[e2e] load average ${load.load1.toFixed(1)} across ${load.cores} cores — timings and any timeout ` +
        "failure in this run should be read as the machine, not the app.",
    );
  }
  assertBundleIsFresh();
  // Before anything is seeded: if this Mac no longer draws text the way it did when the
  // baselines were drawn, nearly every visual spec fails for a reason that is not the change
  // under test. On 2026-09-28 that took a 9-minute run and 107 failures to find out; the canary
  // says it in under a second. E2E_RENDERER_CHECK=skip bypasses it (the re-base command does).
  const renderer = await assertRendererMatchesBaselines();
  if (renderer.verdict === "skipped") console.warn(describeRendererCheck(renderer));
  else console.log(describeRendererCheck(renderer));
  const dbPath = path.join(process.cwd(), "data", "e2e.db");
  // NB: the db file is deliberately NOT unlinked — seedE2eDatabase wipes its
  // data in place so the webServer's open connection keeps the same inode and
  // reads this run's seed (see resetAllData). Deleting the file here would
  // strand the server on the previous run's data.
  // originals archived by the import pipeline follow the database: the e2e
  // harness must NEVER write into data/originals, where the user's REAL
  // statement originals live. Wiped like the db — droppings are not state.
  const originalsDir = path.join(process.cwd(), "data", "e2e-originals");
  fs.rmSync(originalsDir, { recursive: true, force: true });
  // Settings lists the backups dir; a dedicated (empty) one keeps that list a
  // deterministic empty state and out of the user's real backup archive.
  const backupsDir = path.join(process.cwd(), "data", "e2e-backups");
  fs.rmSync(backupsDir, { recursive: true, force: true });

  // set BEFORE the app modules load: rebuildAccount calls todayIso() while
  // deriving balances, and its output must match what the server renders
  process.env.MONEYAPP_DB_PATH = dbPath;
  process.env.MONEYAPP_ORIGINALS_DIR = originalsDir;
  process.env.MONEYAPP_BACKUPS_DIR = backupsDir;
  process.env.MONEYAPP_SKIP_BACKUP = "1";
  process.env.MONEYAPP_FAKE_PRICES = "1";
  process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;

  const summary = await seedE2eDatabase(dbPath);
  // one-line audit trail so a bad seed is debuggable from CI output
  console.log(
    `[e2e setup] seeded ${summary.txns} txns from ${summary.files} files — ` +
      `${summary.coveragePct}% categorized, ${summary.gapPeriods} open gaps, ` +
      `${summary.reviewBacklog} flagged for review, fake today ${E2E_FAKE_TODAY}`,
  );

  await assertFixtureKeptItsShape(dbPath);
}

/**
 * The seeded price series' SHAPE is contract, not decoration.
 *
 * Every investment baseline is drawn over these closes, and a ruler-straight
 * series is indistinguishable from a collapsed-series rendering bug — which is
 * exactly how ~40 baselines silently stopped being evidence once before. The
 * rules live in scripts/fixture-shape.ts and are unit-tested there; this is the
 * gate that actually runs them.
 *
 * Deliberately NOT gated behind E2E_GATE. There is no speed argument to make —
 * this reads the database the line above just built (measured in milliseconds)
 * rather than seeding a second one — and E2E_GATE is unset for `pnpm
 * e2e:update`, which is the command that REGENERATES the baselines. Gating here
 * would leave the hole open at the one moment the defect ships.
 *
 * Throwing aborts the whole run, the same mechanism assertBundleIsFresh uses.
 */
async function assertFixtureKeptItsShape(dbPath: string): Promise<void> {
  const { SEEDED_SERIES, checkFixtureShape, formatFixtureShapeFailures, seriesKey } = await import(
    "../scripts/fixture-shape"
  );
  const Database = (await import("better-sqlite3")).default;

  const raw = new Database(dbPath, { readonly: true });
  let report;
  try {
    // by (symbol, asset_type) — the pair price_cache is unique on. Ordering is
    // this caller's job: checkFixtureShape is pure and takes closes already in
    // ascending day order.
    const read = raw.prepare(
      "select close from price_cache where symbol = ? and asset_type = ? order by quoted_on",
    );
    report = checkFixtureShape(
      new Map(
        SEEDED_SERIES.map((s) => [
          seriesKey(s.symbol, s.assetType),
          (read.all(s.symbol, s.assetType) as { close: number }[]).map((r) => r.close),
        ]),
      ),
    );
  } finally {
    raw.close();
  }

  if (report.failures.length > 0) {
    throw new Error("e2e: " + formatFixtureShapeFailures(report));
  }
}
