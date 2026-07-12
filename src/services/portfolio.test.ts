import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { rebuildInvestmentHistory } from "./crypto-history";
import { upsertHolding } from "./holdings";
import {
  holdingRows,
  pnlCalendarMonth,
  pnlDayDetail,
  portfolioOverview,
  portfolioReturnDays,
  portfolioSeries,
  topMovers,
} from "./portfolio";

process.env.MONEYAPP_FAKE_PRICES = "1";

const D1 = "2026-03-02";
const D2 = "2026-03-03";
const D3 = "2026-03-04";
const TODAY = D3;

let dir: string;
let bundle: DbBundle;
let brokerage: string;
let crypto: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-portfolio-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  brokerage = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  crypto = createAccount(bundle.db, {
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

function cache(symbol: string, assetType: "stock" | "crypto", day: string, close: number): void {
  bundle.db
    .insert(priceCache)
    .values({
      symbol,
      assetType,
      quotedOn: day,
      close,
      source: assetType === "crypto" ? "coinbase" : "yahoo",
      fetchedAt: `${day}T20:00:00.000Z`,
    })
    .run();
}

/** A signed CUSIP trade transaction on the brokerage (equity flow source). */
function trade(day: string, amountCents: number, symbol: string): void {
  bundle.db
    .insert(transactions)
    .values({
      accountId: brokerage,
      postedOn: day,
      amountCents,
      rawDescription: `Apple CUSIP: 037833100 (${symbol})`,
      normalizedDescription: `apple cusip 037833100 ${symbol}`,
      dedupeHash: `${day}-${symbol}-${amountCents}`,
    })
    .run();
}

/**
 * A three-day mixed book. Equity: 1 AAPL @ $100 (D1), price → $110 (D2), buy a
 * 2nd @ $120 (D3). Crypto: 1 ETH @ $2,000 (D1), → $2,100 (D2), buy a 2nd @ $2,100
 * (D3). Crypto has NO trade txns — the ETH trade day must neutralize, not gain.
 */
function seedMixedBook(): void {
  cache("AAPL", "stock", D1, 100);
  cache("AAPL", "stock", D2, 110);
  cache("AAPL", "stock", D3, 120);
  cache("ETH", "crypto", D1, 2000);
  cache("ETH", "crypto", D2, 2100);
  cache("ETH", "crypto", D3, 2100);

  upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 10_000, occurredOn: D1 });
  upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 200_000_000, avgCostCents: 11_000, occurredOn: D3 });
  trade(D1, -10_000, "AAPL"); // opening buy (neutralized on the anchor day anyway)
  trade(D3, -12_000, "AAPL"); // bought 1 more at $120

  upsertHolding(bundle.db, { accountId: crypto, symbol: "ETH", assetType: "crypto", quantityE8: 100_000_000, avgCostCents: 200_000, occurredOn: D1 });
  upsertHolding(bundle.db, { accountId: crypto, symbol: "ETH", assetType: "crypto", quantityE8: 200_000_000, avgCostCents: 205_000, occurredOn: D3 });

  rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
  rebuildInvestmentHistory(bundle.db, crypto, TODAY);
}

describe("portfolioSeries — whole-portfolio value", () => {
  test("sums the reconciled per-account daily balances", () => {
    seedMixedBook();
    expect(portfolioSeries(bundle.db).map((p) => [p.day, p.valueCents, p.complete])).toEqual([
      [D1, 10_000 + 200_000, true],
      [D2, 11_000 + 210_000, true],
      [D3, 24_000 + 420_000, true],
    ]);
  });
});

describe("portfolioReturnDays — flow-adjusted, valuation-consistent flows", () => {
  test("a buy is not a gain; every quantity change is neutralized at close (equity + crypto)", () => {
    seedMixedBook();
    const days = portfolioReturnDays(bundle.db);
    expect(days.map((d) => d.day)).toEqual([D1, D2, D3]);

    // D2: pure market move — AAPL +$10, ETH +$100 → +$110, no flow
    expect(days[1]).toMatchObject({ day: D2, flowCents: 0, exact: true });
    // D3: both books buy. Bought capital must not read as a gain, and because the
    // flow is Σ Δqty×close (not cash), crypto is exact too — no fabrication needed.
    // flow(D3) = AAPL 1×$120 + ETH 1×$2,100 = 12000 + 210000
    expect(days[2]).toMatchObject({ day: D3, flowCents: 12_000 + 210_000, exact: true });
  });

  test("the whole-portfolio D3 return is exactly the equity market gain (+$10)", () => {
    seedMixedBook();
    const days = portfolioReturnDays(bundle.db);
    // return(D3) = nav(D3) − nav(D2) − flow(D3)
    //           = 444000 − 221000 − (equity 12000 + crypto neutralize 210000) = 1000
    const d3 = days[2]!;
    expect(d3.navCents - days[1]!.navCents - d3.flowCents).toBe(1_000);
  });
});

describe("portfolioOverview", () => {
  test("value is the whole portfolio; TWR is the whole portfolio, anchored + exact", () => {
    seedMixedBook();
    const o = portfolioOverview(bundle.db);
    expect(o.valueCents).toBe(444_000);
    expect(o.asOf).toBe(D3);
    // day change is whole-portfolio, flow-adjusted (+$10 equity, crypto flat) and
    // exact — trades are neutralized at close, so no phantom gain, no fabrication
    expect(o.dayChangeCents).toBe(1_000);
    expect(o.dayChangeExact).toBe(true);
    expect(o.dayChangeVsDay).toBe(D2);
    // whole-portfolio TWR gain = D2 (+$110) + D3 (+$10) = $120, never bought capital
    expect(o.twrGainCents).toBe(12_000);
    expect(o.twrAnchor).toBe(D1);
    expect(o.hasCrypto).toBe(true);
  });
});

describe("holdingRows + topMovers", () => {
  test("day change compares the last two closes for the held quantity", () => {
    seedMixedBook();
    const rows = holdingRows(bundle.db);
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    // qty 2 × ($120 − $110) = +$20
    expect(aapl.dayChangeCents).toBe(2_000);
    expect(aapl.valueCents).toBe(24_000);
  });

  test("winners are sorted by day-change %, losers separately", () => {
    seedMixedBook();
    const { winners, losers } = topMovers(bundle.db);
    expect(winners.map((w) => w.symbol)).toContain("AAPL");
    expect(losers).toEqual([]); // ETH flat day3, AAPL up
  });
});

describe("pnl calendar + day detail", () => {
  test("the P/L month carries each day's flow-adjusted move and exact flag", () => {
    seedMixedBook();
    const month = pnlCalendarMonth(bundle.db, "2026-03", TODAY);
    expect(month.cellsByDay[D2]).toMatchObject({ pnlCents: 11_000, exact: true });
    expect(month.cellsByDay[D3]).toMatchObject({ pnlCents: 1_000, exact: true });
    expect(month.cellsByDay[D1]).toBeUndefined(); // anchor day has no prior → no cell
    expect(month.monthPnlCents).toBe(12_000);
  });

  test("day detail per-holding deltas use the qty held ENTERING the day and reconcile to pnlCents", () => {
    seedMixedBook();
    const detail = pnlDayDetail(bundle.db, D3);
    expect(detail.exact).toBe(true);
    // D3 had a brokerage AAPL trade txn
    expect(detail.transactions.some((t) => t.description.includes("AAPL"))).toBe(true);
    // AAPL: 1 share held ENTERING D3 (the 2nd was bought ON D3) × ($120−$110) = +$10,
    // NOT 2 × $10 with today's qty. ETH flat D2→D3 → not listed.
    expect(detail.holdings.find((h) => h.symbol === "AAPL")?.deltaCents).toBe(1_000);
    // the breakdown sums to the headline flow-adjusted P/L (reconcile-to-the-cent)
    const sum = detail.holdings.reduce((s, h) => s + h.deltaCents, 0);
    expect(sum).toBe(detail.pnlCents);
  });

  test("a symbol priced only after its buy day is NOT a fabricated one-day gain", () => {
    // AAPL priced + held from D1; NEWB bought D2 but its price history starts only
    // on D3 — so it enters the NAV on D3 with an offsetting flow, not a phantom gain
    cache("AAPL", "stock", D1, 100);
    cache("AAPL", "stock", D2, 100);
    cache("AAPL", "stock", D3, 100); // AAPL flat all three days
    cache("NEWB", "stock", D3, 50); // NEWB's only close is D3
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, occurredOn: D1 });
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "NEWB", assetType: "stock", quantityE8: 200_000_000, occurredOn: D2 });
    rebuildInvestmentHistory(bundle.db, brokerage, D3);

    const days = portfolioReturnDays(bundle.db, [brokerage]);
    // D1 = AAPL only ($100); D2 carried ($100, NEWB unpriceable so the day is skipped
    // then carried); D3 = AAPL $100 + NEWB $100 = $200
    const d3 = days.find((d) => d.day === D3)!;
    const d2 = days.find((d) => d.day === D2)!;
    // NEWB's $100 appearance is fully offset by its rolled-forward flow → 0 return
    expect(d3.navCents - d2.navCents - d3.flowCents).toBe(0);
  });
});
