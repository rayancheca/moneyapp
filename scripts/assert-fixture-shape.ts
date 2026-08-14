/**
 * Guards the two properties the seeded investment fixture must hold, against a
 * database built by the REAL seeder (not a replica of its arithmetic):
 *
 *   1. every seeded symbol's close series actually BENDS — the defect this
 *      replaced was a ruler-straight diagonal on every investment chart;
 *   2. each holding's last-day move is still EXACTLY lastDayDeltaCents, because
 *      the movers direction and the dashboard's headline move are contract.
 *
 * Exit 0 = both hold.
 *
 * The RULES live in ./fixture-shape.ts and are unit-tested there; this file is
 * only the I/O around them — seed a throwaway database, read it, print. The
 * same rules now also run inside e2e/global-setup.ts on every Playwright
 * invocation, which is the automatic gate. Two callers, one copy of the
 * arithmetic, so they cannot drift apart.
 *
 * Given that gate, why keep the script? Because it answers the question WITHOUT
 * A BUILD. global-setup runs `assertBundleIsFresh` before it ever reaches the
 * seed, so the in-harness check is unreachable until `next build` has run.
 * This script seeds its own database in /tmp and needs no .next at all — it is
 * the form you can run mid-edit.
 *
 *   pnpm assert-fixture-shape
 */
import fs from "node:fs";
import path from "node:path";

const OUT = "/tmp/moneyapp-fixture-assert";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const dbPath = path.join(OUT, "e2e.db");
process.env.MONEYAPP_DB_PATH = dbPath;
process.env.MONEYAPP_ORIGINALS_DIR = path.join(OUT, "originals");
process.env.MONEYAPP_BACKUPS_DIR = path.join(OUT, "backups");
process.env.MONEYAPP_SKIP_BACKUP = "1";
process.env.MONEYAPP_FAKE_PRICES = "1";

const { E2E_FAKE_TODAY, seedE2eDatabase } = await import("../e2e/seed-helpers");
process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;

await seedE2eDatabase(dbPath);

const Database = (await import("better-sqlite3")).default;
const raw = new Database(dbPath, { readonly: true });

const { SEEDED_SERIES, checkFixtureShape, formatFixtureShapeFailures, seriesKey } = await import(
  "./fixture-shape"
);

// Read by (symbol, asset_type) — the pair price_cache is actually unique on.
// Any OTHER symbol in the table is ignored by construction, because iteration is
// driven by the contract list rather than by the query: SPY and QQQ arrive from
// the statement fixtures (and from the spec that writes closes), and they are a
// random walk with no pinned delta, so they have no shape to hold.
const read = raw.prepare(
  "select close from price_cache where symbol = ? and asset_type = ? order by quoted_on",
);
const series = new Map<string, number[]>(
  SEEDED_SERIES.map((s) => [
    seriesKey(s.symbol, s.assetType),
    (read.all(s.symbol, s.assetType) as { close: number }[]).map((r) => r.close),
  ]),
);

raw.close();

const report = checkFixtureShape(series);

for (const shape of report.shapes) {
  console.log(
    `${shape.symbol.padEnd(5)} ${shape.closeCount} closes · ${shape.turns} turns ` +
      `(${(shape.turnRate * 100).toFixed(1)}%) · last-day ${shape.lastDayDeltaCents}c`,
  );
}

if (report.failures.length > 0) {
  console.error("\nFAILURES:\n" + formatFixtureShapeFailures(report));
  process.exit(1);
}
console.log("\nfixture price series: bends, and the last-day deltas are exact");
