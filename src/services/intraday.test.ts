import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { priceCache, priceIntraday } from "@/db/schema/holdings";
import { createAccount } from "./accounts";
import { upsertHolding } from "./holdings";
import {
  holdingIntradaySession,
  holdingSessionCents,
  intradayTicks,
  portfolioIntradayGrid,
  portfolioSession,
  refreshIntraday,
} from "./intraday";
import { fakeProvider, type PriceProvider } from "./prices";

process.env.MONEYAPP_FAKE_PRICES = "1";

const DAY = "2026-07-31";
const E8 = 1e8;

/** A provider that returns a fixed session, so the assertions are about the
 *  service's storage and windowing rather than about the fake walk. */
function stubProvider(ticks: { at: string; close: number }[], calls?: string[]): PriceProvider {
  return {
    source: "manual",
    getDailyCloses: () => Promise.resolve([]),
    getIntradayTicks: (symbol) => {
      calls?.push(symbol);
      return Promise.resolve(ticks);
    },
    getQuotes: () => Promise.resolve([]),
  };
}

describe("intraday", () => {
  let dir: string;
  let bundle: DbBundle;
  let brokerageId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-intraday-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const robinhood = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Robinhood"))
      .get()!;
    brokerageId = createAccount(bundle.db, {
      institutionId: robinhood.id,
      name: "Robinhood Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function hold(symbol: string, qty: number, assetType: "stock" | "etf" | "crypto" = "etf") {
    upsertHolding(bundle.db, { accountId: brokerageId, symbol, assetType, quantityE8: qty * E8 });
  }

  function cacheClose(
    symbol: string,
    day: string,
    close: number,
    assetType: "stock" | "etf" | "crypto" = "etf",
  ) {
    bundle.db
      .insert(priceCache)
      .values({
        symbol,
        assetType,
        quotedOn: day,
        close,
        source: "manual",
        fetchedAt: new Date().toISOString(),
      })
      .run();
  }

  describe("refreshIntraday", () => {
    test("caches every tick the provider returns, for every held symbol", async () => {
      hold("VOO", 1);
      hold("AAPL", 2, "stock");
      const calls: string[] = [];
      const provider = stubProvider(
        [
          { at: `${DAY}T13:30:00.000Z`, close: 100 },
          { at: `${DAY}T13:35:00.000Z`, close: 101 },
        ],
        calls,
      );

      const result = await refreshIntraday(bundle.db, { day: DAY, providers: () => provider });

      expect(result.symbols).toBe(2);
      expect(result.ticks).toBe(4);
      expect(result.errors).toEqual([]);
      expect(calls.sort()).toEqual(["AAPL", "VOO"]);
      expect(intradayTicks(bundle.db, "VOO", "etf", DAY)).toEqual([
        { at: `${DAY}T13:30:00.000Z`, close: 100 },
        { at: `${DAY}T13:35:00.000Z`, close: 101 },
      ]);
    });

    test("is idempotent — re-running updates rows in place rather than duplicating", async () => {
      hold("VOO", 1);
      const first = stubProvider([{ at: `${DAY}T13:30:00.000Z`, close: 100 }]);
      await refreshIntraday(bundle.db, { day: DAY, providers: () => first });

      const second = stubProvider([{ at: `${DAY}T13:30:00.000Z`, close: 175 }]);
      await refreshIntraday(bundle.db, { day: DAY, providers: () => second });

      const rows = intradayTicks(bundle.db, "VOO", "etf", DAY);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.close).toBe(175);
    });

    test("collects a per-symbol failure instead of losing the other symbols' sessions", async () => {
      hold("VOO", 1);
      hold("BOOM", 1);
      const provider: PriceProvider = {
        source: "manual",
        getDailyCloses: () => Promise.resolve([]),
        getIntradayTicks: (symbol) =>
          symbol === "BOOM"
            ? Promise.reject(new Error("delisted"))
            : Promise.resolve([{ at: `${DAY}T13:30:00.000Z`, close: 100 }]),
        getQuotes: () => Promise.resolve([]),
      };

      const result = await refreshIntraday(bundle.db, { day: DAY, providers: () => provider });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("BOOM");
      expect(result.errors[0]).toContain("delisted");
      expect(intradayTicks(bundle.db, "VOO", "etf", DAY)).toHaveLength(1);
    });

    test("reports a non-Error rejection without crashing on .message", async () => {
      hold("VOO", 1);
      const provider: PriceProvider = {
        source: "manual",
        getDailyCloses: () => Promise.resolve([]),
        // a bare string is what a stringly-thrown provider/transport error looks
        // like; `error instanceof Error` is false and `.message` is undefined
        getIntradayTicks: () => Promise.reject("socket hang up"),
        getQuotes: () => Promise.resolve([]),
      };

      const result = await refreshIntraday(bundle.db, { day: DAY, providers: () => provider });

      expect(result.errors).toEqual(["VOO: socket hang up"]);
    });

    test("a symbol with no session is not an error — a holiday is not a failure", async () => {
      hold("VOO", 1);

      const result = await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([]),
      });

      expect(result.errors).toEqual([]);
      expect(result.ticks).toBe(0);
    });

    test("prunes sessions older than the retention window, keeping yesterday", async () => {
      hold("VOO", 1);
      // three sessions: two days ago (dropped), yesterday (kept), today (kept)
      for (const day of ["2026-07-29", "2026-07-30", DAY]) {
        await refreshIntraday(bundle.db, {
          day,
          providers: () => stubProvider([{ at: `${day}T13:30:00.000Z`, close: 100 }]),
        });
      }

      expect(intradayTicks(bundle.db, "VOO", "etf", "2026-07-29")).toEqual([]);
      expect(intradayTicks(bundle.db, "VOO", "etf", "2026-07-30")).toHaveLength(1);
      expect(intradayTicks(bundle.db, "VOO", "etf", DAY)).toHaveLength(1);
    });

    test("reports how many rows the prune removed", async () => {
      hold("VOO", 1);
      await refreshIntraday(bundle.db, {
        day: "2026-07-01",
        providers: () => stubProvider([{ at: "2026-07-01T13:30:00.000Z", close: 100 }]),
      });

      const result = await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([{ at: `${DAY}T13:30:00.000Z`, close: 100 }]),
      });

      expect(result.prunedRows).toBe(1);
    });

    test("an empty book fetches nothing", async () => {
      const calls: string[] = [];

      const result = await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([], calls),
      });

      expect(result.symbols).toBe(0);
      expect(calls).toEqual([]);
    });

    test("defaults to the real provider lookup and today when unasked", async () => {
      hold("VOO", 1);
      // MONEYAPP_FAKE_PRICES=1 routes to fakeProvider, so this exercises the
      // default arguments without touching the network
      const result = await refreshIntraday(bundle.db);

      expect(result.errors).toEqual([]);
      expect(result.ticks).toBeGreaterThan(0);
    });

    test("ignores a holding that has been sold down to zero", async () => {
      hold("VOO", 1);
      hold("VOO", 0); // upsertHolding SETS the quantity (and rejects negatives)
      const calls: string[] = [];

      const result = await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([], calls),
      });

      expect(result.symbols).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  describe("intradayTicks", () => {
    test("does not bleed into the neighbouring day", async () => {
      hold("VOO", 1);
      await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () =>
          stubProvider([
            { at: `${DAY}T00:00:00.000Z`, close: 1 },
            { at: `${DAY}T23:55:00.000Z`, close: 2 },
          ]),
      });
      // a tick belonging to the next day, written directly
      bundle.db
        .insert(priceIntraday)
        .values({
          symbol: "VOO",
          assetType: "etf",
          quotedAt: "2026-08-01T00:00:00.000Z",
          close: 999,
          source: "manual",
          fetchedAt: new Date().toISOString(),
        })
        .run();

      const ticks = intradayTicks(bundle.db, "VOO", "etf", DAY);

      expect(ticks.map((t) => t.close)).toEqual([1, 2]);
    });

    test("keys on asset type, so ETH-the-crypto is not ETH-the-ticker", async () => {
      const fetchedAt = new Date().toISOString();
      for (const assetType of ["crypto", "stock"] as const) {
        bundle.db
          .insert(priceIntraday)
          .values({
            symbol: "ETH",
            assetType,
            quotedAt: `${DAY}T13:30:00.000Z`,
            close: assetType === "crypto" ? 3000 : 40,
            source: "manual",
            fetchedAt,
          })
          .run();
      }

      expect(intradayTicks(bundle.db, "ETH", "crypto", DAY)[0]!.close).toBe(3000);
      expect(intradayTicks(bundle.db, "ETH", "stock", DAY)[0]!.close).toBe(40);
    });
  });

  describe("portfolioIntradayGrid", () => {
    test("values the whole book on one grid, opening from yesterday's close", async () => {
      hold("VOO", 1);
      hold("AAPL", 2, "stock");
      cacheClose("VOO", "2026-07-30", 100);
      bundle.db
        .insert(priceCache)
        .values({
          symbol: "AAPL",
          assetType: "stock",
          quotedOn: "2026-07-30",
          close: 200,
          source: "manual",
          fetchedAt: new Date().toISOString(),
        })
        .run();

      // only VOO ticks; AAPL must be carried at its prior close
      const provider: PriceProvider = {
        source: "manual",
        getDailyCloses: () => Promise.resolve([]),
        getIntradayTicks: (symbol) =>
          symbol === "VOO"
            ? Promise.resolve([{ at: `${DAY}T13:30:00.000Z`, close: 110 }])
            : Promise.resolve([]),
        getQuotes: () => Promise.resolve([]),
      };
      await refreshIntraday(bundle.db, { day: DAY, providers: () => provider });

      const grid = portfolioIntradayGrid(bundle.db, DAY);

      expect(grid.points).toHaveLength(1);
      // VOO 1 x $110 + AAPL 2 x $200 (prior close)
      expect(grid.points[0]!.valueCents).toBe(11_000 + 40_000);
      expect(grid.pricedSymbols).toBe(2);
      expect(grid.totalSymbols).toBe(2);
    });

    test("is empty when nothing ticked, rather than drawing an invented flat line", async () => {
      hold("VOO", 1);
      cacheClose("VOO", "2026-07-30", 100);

      const grid = portfolioIntradayGrid(bundle.db, DAY);

      expect(grid.points).toEqual([]);
      expect(grid.pricedSymbols).toBe(1);
    });

    test("counts a symbol with no price at all as unpriced", async () => {
      hold("VOO", 1);
      hold("MYSTERY", 1);
      cacheClose("VOO", "2026-07-30", 100);
      await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () =>
          stubProvider(
            // both symbols get the stub's ticks, so give MYSTERY none by using a
            // provider that only answers for VOO
            [],
          ),
      });
      bundle.db
        .insert(priceIntraday)
        .values({
          symbol: "VOO",
          assetType: "etf",
          quotedAt: `${DAY}T13:30:00.000Z`,
          close: 110,
          source: "manual",
          fetchedAt: new Date().toISOString(),
        })
        .run();

      const grid = portfolioIntradayGrid(bundle.db, DAY);

      expect(grid.totalSymbols).toBe(2);
      expect(grid.pricedSymbols).toBe(1); // MYSTERY has neither a tick nor a close
      expect(grid.points[0]!.valueCents).toBe(11_000);
    });
  });

  describe("portfolioSession", () => {
    test("returns the identical grid portfolioIntradayGrid returns", async () => {
      hold("VOO", 1);
      cacheClose("VOO", "2026-07-30", 100);
      await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([{ at: `${DAY}T13:30:00.000Z`, close: 110 }]),
      });

      // the delegation proof: the old entry point must not have drifted
      expect(portfolioSession(bundle.db, DAY).grid).toEqual(portfolioIntradayGrid(bundle.db, DAY));
    });

    test("values the whole book at yesterday's closes", async () => {
      hold("VOO", 1);
      hold("AAPL", 2, "stock");
      cacheClose("VOO", "2026-07-30", 100);
      cacheClose("AAPL", "2026-07-30", 200, "stock");

      // VOO 1 x $100 + AAPL 2 x $200
      expect(portfolioSession(bundle.db, DAY).priorCloseCents).toBe(10_000 + 40_000);
    });

    test("refuses a partial baseline when one holding has no prior close", () => {
      hold("VOO", 1);
      hold("AAPL", 2, "stock");
      cacheClose("VOO", "2026-07-30", 100);
      // AAPL has no cached close at all

      // a partial sum would understate the day's move by AAPL's whole value,
      // and would do it silently — null makes the caller say so instead
      expect(portfolioSession(bundle.db, DAY).priorCloseCents).toBeNull();
    });

    test("has no baseline for an empty book", () => {
      expect(portfolioSession(bundle.db, DAY).priorCloseCents).toBeNull();
    });

    // ⚖️ owner, 2026-09-14/15: the agent's positions sit in a book paired with Robinhood Agentic, outside his portfolio
    test("⛔ leaves out the book paired with Robinhood Agentic — the agent's positions are not his session", () => {
      hold("VOO", 1);
      cacheClose("VOO", "2026-07-30", 100);
      cacheClose("AAPL", "2026-07-30", 200, "stock");
      const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
      const agentic = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
      const book = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
      bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
      upsertHolding(bundle.db, { accountId: book, symbol: "AAPL", assetType: "stock", quantityE8: 2 * E8 });
      upsertHolding(bundle.db, { accountId: book, symbol: "VOO", assetType: "etf", quantityE8: 3 * E8 });

      const session = portfolioSession(bundle.db, DAY);
      expect(session.priorCloseCents).toBe(10_000);
      expect(session.grid.totalSymbols).toBe(1);
    });

    test("ignores a close dated on the day itself", () => {
      hold("VOO", 1);
      cacheClose("VOO", DAY, 999); // today's close is not a PRIOR close
      cacheClose("VOO", "2026-07-30", 100);

      expect(portfolioSession(bundle.db, DAY).priorCloseCents).toBe(10_000);
    });
  });

  describe("holdingSessionCents", () => {
    test("converts dollars to cents for both the ticks and the baseline", async () => {
      hold("VOO", 1);
      cacheClose("VOO", "2026-07-30", 100.005);
      await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([{ at: `${DAY}T13:30:00.000Z`, close: 110.014 }]),
      });

      const session = holdingSessionCents(bundle.db, "VOO", "etf", DAY);

      expect(session.ticks).toEqual([{ at: `${DAY}T13:30:00.000Z`, valueCents: 11_001 }]);
      expect(session.priorCloseCents).toBe(10_001); // 100.005 rounds up
    });

    test("keeps a null baseline null rather than rounding it to zero", () => {
      hold("VOO", 1);

      expect(holdingSessionCents(bundle.db, "VOO", "etf", DAY).priorCloseCents).toBeNull();
    });
  });

  describe("holdingIntradaySession", () => {
    test("returns the session and the close it opened from", async () => {
      hold("VOO", 1);
      cacheClose("VOO", "2026-07-30", 100);
      await refreshIntraday(bundle.db, {
        day: DAY,
        providers: () => stubProvider([{ at: `${DAY}T13:30:00.000Z`, close: 110 }]),
      });

      const session = holdingIntradaySession(bundle.db, "VOO", "etf", DAY);

      expect(session.priorClose).toBe(100);
      expect(session.ticks).toEqual([{ at: `${DAY}T13:30:00.000Z`, close: 110 }]);
    });

    test("has a null prior close when there is no earlier history", () => {
      const session = holdingIntradaySession(bundle.db, "NEW", "etf", DAY);

      expect(session.priorClose).toBeNull();
      expect(session.ticks).toEqual([]);
    });

    test("never mistakes a SAME-day close for the prior close", async () => {
      cacheClose("VOO", DAY, 500); // today's close exists but must not be the baseline
      cacheClose("VOO", "2026-07-30", 100);

      expect(holdingIntradaySession(bundle.db, "VOO", "etf", DAY).priorClose).toBe(100);
    });
  });

  test("the fake provider serves a full session so demos and e2e never touch the network", async () => {
    const ticks = await fakeProvider.getIntradayTicks("VOO", "etf", DAY);

    expect(ticks.length).toBe(79); // 78 five-minute intervals across a 390-minute session
    expect(ticks[0]!.at).toBe(`${DAY}T13:30:00.000Z`);
    expect(ticks.at(-1)!.at).toBe(`${DAY}T20:00:00.000Z`);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.at > ticks[i - 1]!.at).toBe(true);
    }
  });

  test("the fake provider runs crypto across the whole day, not a market session", async () => {
    const ticks = await fakeProvider.getIntradayTicks("ETH", "crypto", DAY);

    expect(ticks.length).toBe(288);
    expect(ticks[0]!.at).toBe(`${DAY}T00:00:00.000Z`);
    expect(ticks.at(-1)!.at).toBe(`${DAY}T23:55:00.000Z`);
  });
});
