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
 * This lives as a script rather than a vitest test because the only honest way
 * to check it is to run the REAL seeder, and the seeder lives in e2e/ — outside
 * vitest's include globs, and it wants a database on disk. Deleting the
 * `close *= priceWobble(...)` line in e2e/seed-helpers.ts is otherwise a silent
 * change: no unit test imports the seeder, and the pixel baselines would simply
 * be regenerated straight again by whoever did it.
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

const symbols = raw.prepare("select distinct symbol from price_cache order by symbol").all() as {
  symbol: string;
}[];

// only the seeded positions carry the trend+wobble shape; SPY/QQQ arrive from
// the statement fixtures and are already a random walk
const SEEDED = new Set(["AAPL", "MSFT", "WMT", "ETH"]);
const LAST_DAY_DELTA_CENTS: Record<string, number> = { AAPL: 340, MSFT: -520, WMT: 0, ETH: 0 };

const failures: string[] = [];

for (const { symbol } of symbols) {
  if (!SEEDED.has(symbol)) continue;
  const rows = raw
    .prepare("select quoted_on, close from price_cache where symbol = ? order by quoted_on")
    .all(symbol) as { quoted_on: string; close: number }[];

  if (rows.length < 60) {
    failures.push(`${symbol}: only ${rows.length} closes`);
    continue;
  }

  // (1) does the line bend? count sign changes in the day-over-day delta,
  // excluding the pinned final day
  const closes = rows.slice(0, -1).map((r) => r.close);
  const deltas = closes.slice(1).map((v, i) => v - closes[i]!);
  let turns = 0;
  for (let i = 1; i < deltas.length; i++) {
    if (Math.sign(deltas[i]!) !== Math.sign(deltas[i - 1]!)) turns += 1;
  }
  const turnRate = turns / deltas.length;
  if (turnRate < 0.2) {
    failures.push(
      `${symbol}: series is effectively straight — ${turns} direction changes over ${deltas.length} days (${(turnRate * 100).toFixed(1)}%)`,
    );
  }

  // (2) is the final day still pinned to the contract delta?
  const last = rows.at(-1)!;
  const prev = rows.at(-2)!;
  const gotCents = Math.round(last.close * 100) - Math.round(prev.close * 100);
  const wantCents = LAST_DAY_DELTA_CENTS[symbol]!;
  if (gotCents !== wantCents) {
    failures.push(`${symbol}: last-day delta is ${gotCents}c, contract says ${wantCents}c`);
  }

  console.log(
    `${symbol.padEnd(5)} ${rows.length} closes · ${turns} turns (${(turnRate * 100).toFixed(1)}%) · last-day ${gotCents}c`,
  );
}

raw.close();

if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\nfixture price series: bends, and the last-day deltas are exact");
