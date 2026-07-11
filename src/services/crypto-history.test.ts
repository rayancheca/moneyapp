import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "./accounts";
import { netWorthSeries } from "./derivation";
import { upsertHolding } from "./holdings";
import { rebuildInvestmentHistory } from "./crypto-history";

process.env.MONEYAPP_FAKE_PRICES = "1";

const TODAY = "2026-07-05";

let dir: string;
let bundle: DbBundle;
let cryptoId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-crypto-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db
    .select()
    .from(institutions)
    .where(eq(institutions.name, "Robinhood"))
    .get()!;
  cryptoId = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Crypto",
    type: "investment",
    subtype: "crypto",
  });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function cacheEthClose(quotedOn: string, close: number): void {
  bundle.db
    .insert(priceCache)
    .values({
      symbol: "ETH",
      assetType: "crypto",
      quotedOn,
      close,
      source: "coinbase",
      fetchedAt: `${quotedOn}T20:00:00.000Z`,
    })
    .run();
}

function balanceRows() {
  return bundle.db
    .select()
    .from(dailyBalances)
    .where(eq(dailyBalances.accountId, cryptoId))
    .orderBy(asc(dailyBalances.day))
    .all()
    .map((r) => [r.day, r.balanceCents, r.basis]);
}

/** 0.5 ETH bought 07-01, +0.3 ETH on 07-03 — the spec's stepping fixture. */
function seedEthTimeline(): void {
  upsertHolding(bundle.db, {
    accountId: cryptoId,
    symbol: "ETH",
    assetType: "crypto",
    quantityE8: 50_000_000,
    occurredOn: "2026-07-01",
  });
  upsertHolding(bundle.db, {
    accountId: cryptoId,
    symbol: "ETH",
    assetType: "crypto",
    quantityE8: 80_000_000,
    occurredOn: "2026-07-03",
  });
}

describe("rebuildInvestmentHistory — quantity timeline × cached closes", () => {
  test("values step with quantity and follow daily closes", () => {
    seedEthTimeline();
    cacheEthClose("2026-07-01", 3000);
    cacheEthClose("2026-07-02", 3050);
    // 07-03 close missing — carried forward from 07-02
    cacheEthClose("2026-07-04", 3200);
    // 07-05 (today) missing — carried from 07-04

    rebuildInvestmentHistory(bundle.db, cryptoId, TODAY);

    expect(balanceRows()).toEqual([
      ["2026-07-01", 150_000, "derived"], // 0.5 × 3000
      ["2026-07-02", 152_500, "derived"], // 0.5 × 3050
      ["2026-07-03", 244_000, "carried"], // 0.8 × 3050 (last known close)
      ["2026-07-04", 256_000, "derived"], // 0.8 × 3200
      ["2026-07-05", 256_000, "carried"],
    ]);
  });

  test("days before the first cached close are skipped, never invented", () => {
    seedEthTimeline();
    cacheEthClose("2026-07-03", 3100); // closes only start on 07-03

    rebuildInvestmentHistory(bundle.db, cryptoId, TODAY);

    expect(balanceRows()).toEqual([
      ["2026-07-03", 248_000, "derived"], // 0.8 × 3100
      ["2026-07-04", 248_000, "carried"],
      ["2026-07-05", 248_000, "carried"],
    ]);
  });

  test("a close dated before the first event seeds the carry-forward", () => {
    upsertHolding(bundle.db, {
      accountId: cryptoId,
      symbol: "ETH",
      assetType: "crypto",
      quantityE8: 100_000_000, // 1 ETH
      occurredOn: "2026-07-02",
    });
    cacheEthClose("2026-06-30", 2900); // last close BEFORE the buy

    rebuildInvestmentHistory(bundle.db, cryptoId, "2026-07-03");
    expect(balanceRows()).toEqual([
      ["2026-07-02", 290_000, "carried"],
      ["2026-07-03", 290_000, "carried"],
    ]);
  });

  test("rebuild is delete-and-replace: running twice yields identical rows", () => {
    seedEthTimeline();
    cacheEthClose("2026-07-01", 3000);
    cacheEthClose("2026-07-04", 3200);

    rebuildInvestmentHistory(bundle.db, cryptoId, TODAY);
    const first = balanceRows();
    rebuildInvestmentHistory(bundle.db, cryptoId, TODAY);
    expect(balanceRows()).toEqual(first);
  });

  test("no events → an empty curve (rows cleared)", () => {
    // stale rows from a previous rebuild must not survive
    bundle.db
      .insert(dailyBalances)
      .values({ accountId: cryptoId, day: "2026-07-01", balanceCents: 1, basis: "derived" })
      .run();
    rebuildInvestmentHistory(bundle.db, cryptoId, TODAY);
    expect(balanceRows()).toEqual([]);
  });

  test("refuses non-investment accounts", () => {
    const robinhood = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Robinhood"))
      .get()!;
    const checking = createAccount(bundle.db, {
      institutionId: robinhood.id,
      name: "Cash",
      type: "checking",
    });
    expect(() => rebuildInvestmentHistory(bundle.db, checking, TODAY)).toThrow(
      /not an investment account/,
    );
  });

  test("works for an equity brokerage account, priced under each symbol's asset_type", () => {
    const robinhood = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Robinhood"))
      .get()!;
    const brokerage = createAccount(bundle.db, {
      institutionId: robinhood.id,
      name: "Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    // 2 AAPL (stock) bought 07-01; a same-named "AAPL" crypto close must be ignored
    upsertHolding(bundle.db, {
      accountId: brokerage,
      symbol: "AAPL",
      assetType: "stock",
      quantityE8: 200_000_000,
      occurredOn: "2026-07-01",
    });
    bundle.db
      .insert(priceCache)
      .values([
        { symbol: "AAPL", assetType: "stock", quotedOn: "2026-07-01", close: 200, source: "yahoo", fetchedAt: "2026-07-01T20:00:00.000Z" },
        { symbol: "AAPL", assetType: "crypto", quotedOn: "2026-07-01", close: 999999, source: "coinbase", fetchedAt: "2026-07-01T20:00:00.000Z" },
      ])
      .run();

    rebuildInvestmentHistory(bundle.db, brokerage, "2026-07-01");
    const rows = bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, brokerage))
      .all();
    // 2 × $200 = $400, NOT priced off the same-named crypto row
    expect(rows).toEqual([
      expect.objectContaining({ day: "2026-07-01", balanceCents: 40_000, basis: "derived" }),
    ]);
  });

  test("the crypto curve feeds the net-worth series (Phase 2b exemption closed)", () => {
    seedEthTimeline();
    cacheEthClose("2026-07-01", 3000);
    cacheEthClose("2026-07-04", 3200);
    rebuildInvestmentHistory(bundle.db, cryptoId, TODAY);

    const series = netWorthSeries(bundle.db);
    const jul4 = series.find((p) => p.day === "2026-07-04");
    expect(jul4?.totalCents).toBe(256_000);
    expect(jul4?.complete).toBe(true); // the only active account is covered
  });
});
