import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { and, desc, eq } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { accounts } from "@/db/schema";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, type AssetType } from "@/db/schema/holdings";
import { parseAmountToCents } from "@/lib/money";
import {
  formatQuantityE8,
  parseQuantityE8,
  positionsAsOf,
  reconstructHoldings,
  toActivityRows,
  verifyAgainstDividends,
} from "@/lib/robinhood-holdings";
import { netWorthSeries, rebuildAccount } from "@/services/derivation";

/**
 * Rebuilds the Robinhood Brokerage share book from the activity export.
 *
 * The book on disk is a one-shot backfill: all 1,925 holding_events rows were
 * written inside the single minute 2026-07-11T01:02, from an older and shorter
 * export, and nothing has maintained them since. It under-counts eight of the
 * nine live symbols and omits GOOG entirely — which is also why GOOG's price
 * feed died, since refreshPrices only quotes symbols with an active holdings
 * row. Measured against the July 2026 statement's Portfolio Summary, the app
 * agrees on ONE symbol of nine.
 *
 * The all-time export (2,258 records, 2023-12-05..2026-07-31) carries every
 * share movement and a Price on all but two of them, so quantity AND cost basis
 * are recorded facts rather than estimates. src/lib/robinhood-holdings.ts does
 * the reconstruction; this script is the driver. Both arbiters must pass before
 * anything is written:
 *
 *   1. the 44 share counts Robinhood prints inside its own dividend lines
 *   2. the nine positions on the July 2026 statement, frozen below
 *
 * Expect net worth to RISE by roughly $3,250 — the app has been under-counting.
 *
 * ⚠ Order matters. holdings is written first so GOOG becomes active again;
 * only then can a price refresh reach the 2026-04-28..today hole, and only
 * then is the derived curve worth computing. Run a price refresh from the UI
 * (or `refreshPrices`) after this script, then re-check the account.
 *
 *   pnpm tsx scripts/rebuild-robinhood-holdings.ts            # dry run
 *   pnpm tsx scripts/rebuild-robinhood-holdings.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");

/**
 * `--db=<path>` points the whole run at a copy, so the write can be rehearsed
 * on a throwaway before it touches real money (the trial-import doctrine).
 * Defaults to the real database.
 */
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

/**
 * Every activity export, oldest first. Robinhood exports a date RANGE, so a
 * later download continues an earlier one rather than replacing it: the
 * all-time export stops 2026-07-31 and the next one starts 2026-08-07.
 *
 * ⛔ Two exports covering the same day would count that day's shares twice —
 * nothing inside a row says which file it came from — so overlapping ranges
 * are refused outright. A hole between two ranges is only REPORTED: whether
 * anything traded in it is a question for the statement arbiter below, not
 * something the exports can answer.
 */
const CSV_PATHS: readonly string[] = [
  "statements/robinhood/3ab6c2a8-5f00-5de8-b339-c3e514d5b7a7.csv",
  "statements/robinhood/robinhood-activity-2026-08-07-to-2026-09-09.csv",
];
const BROKERAGE = "Robinhood Brokerage";

/**
 * Every statement's Portfolio Summary — the arbiter. A rebuild that does not
 * reproduce EACH of these to the last decimal has found different shares than
 * the ones the broker says are there, and must not be written.
 *
 * Positions are SETTLED shares, which is what `positionsAsOf` counts: a trade
 * executed on a statement's last day that settles after it is printed under
 * "Executed Trades Pending Settlement" and is absent from the summary — the
 * 2026-08-31 MSFT sale of 1.95851, settling 2026-09-01.
 */
const STATEMENTS: readonly { day: string; positions: Readonly<Record<string, string>> }[] = [
  {
    // July 2026, page 3
    day: "2026-07-31",
    positions: {
      AAPL: "16.150657",
      AMZN: "34.884778",
      COKE: "33.959422",
      GOOG: "0.312739",
      META: "7.283111",
      MSFT: "45.890386",
      SPY: "18.027139",
      UNH: "19.329560",
      WMT: "0.412664",
    },
  },
  {
    // August 2026, pages 8–9
    day: "2026-08-31",
    positions: {
      AAPL: "21.150657",
      AMZN: "34.884778",
      // ⚠️ 33.002963 held PLUS 1 share on loan through Stock Lending ("Loaned
      // Securities", page 9). The summary's Total Securities counts both, and
      // a share on loan is still the owner's.
      COKE: "34.002963",
      GOOG: "0.312739",
      META: "9.038535",
      MSFT: "40.911519",
      SPY: "22.088821",
      UNH: "19.329560",
      WMT: "0.413621",
    },
  },
];
const LATEST_STATEMENT_DAY = (STATEMENTS.at(-1) as (typeof STATEMENTS)[number]).day;

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** BigInt → the schema's integer column, refusing anything that would lose precision. */
function toInt(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} exceeds safe integer range: ${value}`);
  return n;
}

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const brokerage = db.select().from(accounts).where(eq(accounts.name, BROKERAGE)).get();
  if (!brokerage) throw new Error(`No "${BROKERAGE}" account`);

  /*
   * Asset type is NOT inferred from the ticker — "ETH" is both a coin and a
   * listed ticker, and a wrong guess makes a holding resolve against the wrong
   * price series. Reuse the classification already in the database and refuse
   * any symbol it does not know.
   */
  const assetOf = new Map<string, AssetType>(
    db
      .selectDistinct({ symbol: holdingEvents.symbol, assetType: holdingEvents.assetType })
      .from(holdingEvents)
      .where(eq(holdingEvents.accountId, brokerage.id))
      .all()
      .map((r) => [r.symbol, r.assetType]),
  );

  const exports = CSV_PATHS.map((csvPath) => {
    const csv = fs.readFileSync(path.join(process.cwd(), csvPath), "utf8");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const fileRows = toActivityRows(parsed.data, parseAmountToCents);
    if (fileRows.length === 0) throw new Error(`${csvPath} holds no activity rows`);
    const days = fileRows.map((r) => r.activityDate).sort();
    return { csvPath, rows: fileRows, first: days[0] as string, last: days.at(-1) as string };
  });
  exports.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  for (const [i, e] of exports.entries()) {
    console.log(`Export      ${e.csvPath}  ${e.first} → ${e.last}  (${e.rows.length} records)`);
    const prev = exports[i - 1];
    if (prev && e.first <= prev.last) {
      throw new Error(`${e.csvPath} starts ${e.first}, inside ${prev.csvPath} (ends ${prev.last}) — shares would count twice`);
    }
    if (prev) console.log(`  ⚠ no export covers the days after ${prev.last} and before ${e.first}`);
  }
  const rows = exports.flatMap((e) => e.rows);
  const { events, positions } = reconstructHoldings(rows);

  console.log(`Records     ${rows.length}   share events ${events.length}\n`);

  /* ── arbiter 1: the export's own dividend share counts ───────────── */
  const checks = verifyAgainstDividends(events, rows);
  const failed = checks.filter((c) => !c.matches);
  console.log(`Dividend share counts: ${checks.length - failed.length}/${checks.length} exact`);
  for (const f of failed) {
    console.log(
      `  ✗ ${f.symbol} R/D ${f.recordDate}: statement ${formatQuantityE8(f.expectedE8)} vs rebuilt ${formatQuantityE8(f.actualE8)}`,
    );
  }

  /* ── arbiter 2: every statement's Portfolio Summary ─────────────── */
  const current = db
    .select()
    .from(holdings)
    .where(eq(holdings.accountId, brokerage.id))
    .all();
  const currentQty = new Map(current.map((h) => [h.symbol, BigInt(h.quantityE8)]));

  let mismatched = 0;
  for (const statement of STATEMENTS) {
    const asOf = positionsAsOf(events, statement.day);
    console.log(`\nPositions on ${statement.day} — app now → rebuilt (statement)`);
    for (const [symbol, expected] of Object.entries(statement.positions)) {
      const want = parseQuantityE8(expected);
      const got = asOf.get(symbol) ?? 0n;
      const ok = got === want;
      if (!ok) mismatched += 1;
      console.log(
        `  ${ok ? "✓" : "✗"} ${symbol.padEnd(5)} ${formatQuantityE8(currentQty.get(symbol) ?? 0n).padStart(13)}` +
          ` → ${formatQuantityE8(got).padStart(13)}  (${expected})`,
      );
    }
    const ghosts = [...asOf].filter(([s, q]) => q !== 0n && !(s in statement.positions));
    mismatched += ghosts.length;
    for (const [s, q] of ghosts) {
      console.log(`  ✗ ${s} holds ${formatQuantityE8(q)} but the statement does not list it`);
    }
  }

  const unknown = positions.filter((p) => !assetOf.has(p.symbol)).map((p) => p.symbol);
  if (unknown.length > 0) {
    console.log(`\n✗ No asset type on record for: ${unknown.join(", ")}`);
  }

  if (failed.length > 0 || mismatched > 0 || unknown.length > 0) {
    console.log("\nREFUSING to write — the rebuild does not reproduce the record above.");
    sqlite.close();
    process.exitCode = 1;
    return;
  }
  console.log("\nBoth arbiters agree to the last decimal.");

  const live = positions.filter((p) => p.quantityE8 > 0n);
  console.log(
    `\nWill write ${events.length} events and ${positions.length} holdings ` +
      `(${live.length} live, ${positions.length - live.length} exited), ` +
      `replacing ${current.length} holdings rows.`,
  );

  if (!CONFIRMED) {
    console.log("\nDry run — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  /*
   * Every write is scoped to the brokerage account id. holding_events is read
   * UNSCOPED elsewhere (portfolio.ts realizedTradesByLeg / holdingDeltasBetween),
   * and the Robinhood Crypto ETH book lives in the same table — an unscoped
   * delete here would destroy it and that account's whole balance curve.
   */
  const cryptoBefore = cryptoFingerprint(db, brokerage.id);
  const beforeNet = netWorthSeries(db).at(-1)?.totalCents ?? 0;

  withPreMutationSnapshot(db, "robinhood-holdings-rebuild", () => {
    db.transaction((tx) => {
      tx.delete(holdingEvents).where(eq(holdingEvents.accountId, brokerage.id)).run();
      tx.delete(holdings).where(eq(holdings.accountId, brokerage.id)).run();

      for (const e of events) {
        tx.insert(holdingEvents)
          .values({
            accountId: brokerage.id,
            symbol: e.symbol,
            assetType: assetOf.get(e.symbol) as AssetType,
            occurredOn: e.occurredOn,
            quantityDeltaE8: toInt(e.quantityDeltaE8, `${e.symbol} delta`),
            costCents: e.costCents,
            note: e.note,
            // the split marker the valuation reads — see ShareEvent.eventKind
            eventKind: e.eventKind,
          })
          .run();
      }
      for (const p of positions) {
        tx.insert(holdings)
          .values({
            accountId: brokerage.id,
            symbol: p.symbol,
            assetType: assetOf.get(p.symbol) as AssetType,
            quantityE8: toInt(p.quantityE8, `${p.symbol} quantity`),
            avgCostCents: p.avgCostCents,
            isActive: p.quantityE8 > 0n,
          })
          .run();
      }
    });
  });

  // outside the transaction — rebuildAccount opens its own, and a nested BEGIN
  // throws on this synchronous driver
  rebuildAccount(db, brokerage.id);

  const afterNet = netWorthSeries(db).at(-1)?.totalCents ?? 0;
  const cryptoAfter = cryptoFingerprint(db, brokerage.id);

  console.log(`\nNET WORTH  ${money(beforeNet)} → ${money(afterNet)}  (${money(afterNet - beforeNet)})`);
  console.log(
    cryptoBefore === cryptoAfter
      ? "Robinhood Crypto: untouched, as a brokerage-scoped write must leave it."
      : "  ⚠ THE CRYPTO BOOK MOVED. A scoped write cannot do that — restore from the snapshot above.",
  );

  const stale = staleSymbols(db, brokerage.id);
  if (stale.length > 0) {
    console.log(
      `\n⚠ ${stale.length} held symbol(s) have no recent close, so those days are valued at a ` +
        `carried price: ${stale.join(", ")}.\n  Run a price refresh, then re-check the account.`,
    );
  }

  sqlite.close();
}

/** Everything about the OTHER investment account that this write must not change. */
function cryptoFingerprint(
  db: ReturnType<typeof createDatabase>["db"],
  brokerageId: string,
): string {
  const other = db.select().from(accounts).where(eq(accounts.type, "investment")).all();
  const parts: string[] = [];
  for (const a of other) {
    if (a.id === brokerageId) continue;
    const ev = db
      .select()
      .from(holdingEvents)
      .where(eq(holdingEvents.accountId, a.id))
      .all();
    const hs = db.select().from(holdings).where(eq(holdings.accountId, a.id)).all();
    parts.push(
      `${a.name}:${ev.length}:${ev.reduce((s, e) => s + e.quantityDeltaE8, 0)}:` +
        `${hs.length}:${hs.reduce((s, h) => s + h.quantityE8, 0)}`,
    );
  }
  return parts.join("|");
}

/**
 * Live symbols whose newest cached close predates the statement day.
 *
 * A held symbol with no close is not skipped and not zeroed — crypto-history
 * CARRIES the last known price forward and marks the day `carried`, which the
 * coverage grade counts as neither broken nor unverified. So a price hole
 * silently values a real position at a months-old price and shows up nowhere.
 * GOOG is exactly that case today: its feed stopped on 2026-04-27 because the
 * stale book had it at zero shares.
 */
function staleSymbols(db: ReturnType<typeof createDatabase>["db"], accountId: string): string[] {
  return db
    .select()
    .from(holdings)
    .where(and(eq(holdings.accountId, accountId), eq(holdings.isActive, true)))
    .all()
    .filter((h) => {
      const latest = db
        .select({ quotedOn: priceCache.quotedOn })
        .from(priceCache)
        .where(and(eq(priceCache.symbol, h.symbol), eq(priceCache.assetType, h.assetType)))
        .orderBy(desc(priceCache.quotedOn))
        .limit(1)
        .get();
      return (latest?.quotedOn ?? "") < LATEST_STATEMENT_DAY;
    })
    .map((h) => h.symbol);
}

main();
