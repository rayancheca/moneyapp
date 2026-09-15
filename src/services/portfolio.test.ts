import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { addDays, todayIso } from "@/lib/dates";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { rebuildInvestmentHistory } from "./crypto-history";
import { upsertHolding } from "./holdings";
import { hasBenchmark, holdingRows, marketChangeBetween, pnlCalendarMonth, pnlDayDetail, portfolioBenchmarkDays, portfolioDayChange, portfolioOverview, portfolioRealizedPl, portfolioReturnDays, portfolioSeries, realizedLegKey, topMovers } from "./portfolio";

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

function cache(symbol: string, assetType: "stock" | "etf" | "crypto", day: string, close: number): void {
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

describe("marketChangeBetween — the windowed market term the bridge needs", () => {
  /*
   * The three terms have to ACCOUNT for the whole portfolio, and the mixed book
   * makes each of them a different number so none can be wired to another:
   *   D1  AAPL 1 @ $100 + ETH 1 @ $2,000  → NAV $2,100
   *   D2  prices only                     → NAV $2,210, gain +$110, flow $0
   *   D3  one more of each                → NAV $4,440, gain +$10, flow $2,220
   */
  test("gain and flow are separate measurements, not two names for one", () => {
    seedMixedBook();
    const w = marketChangeBetween(bundle.db, D1, D3);
    expect(w.gainCents).toBe(11_000 + 1_000);
    expect(w.netFlowCents).toBe(12_000 + 210_000);
    // swap them and both assertions move — which is the point
    expect(w.gainCents).not.toBe(w.netFlowCents);
  });

  test("the window is half-open: `from` is a baseline day, not a counted one", () => {
    // Same convention as balance replay, and the reason a bridge built on this
    // closes against a net-worth delta instead of double-counting the opening.
    seedMixedBook();
    expect(marketChangeBetween(bundle.db, D2, D3).gainCents).toBe(1_000);
    expect(marketChangeBetween(bundle.db, D2, D3).netFlowCents).toBe(222_000);
    // a zero-length window measures nothing at all
    expect(marketChangeBetween(bundle.db, D3, D3).gainCents).toBe(0);
  });

  test("a window that predates the portfolio reports its opening, which is otherwise lost", () => {
    /*
     * `dailyReturns` starts at index 1, so the first day of any slice is a
     * baseline. That is right for a window opening mid-history and wrong for one
     * opening before the portfolio did — there the dropped day is the
     * portfolio's own first, and its value entered net worth from nowhere. On the
     * real ledger it is $20.19 and it is the entire residual of an all-time bridge.
     */
    seedMixedBook();
    const all = marketChangeBetween(bundle.db, "2026-01-01", D3);
    expect(all.openedInWindowCents).toBe(210_000);
    // and the three terms now account for the whole portfolio, from nothing
    expect(all.openedInWindowCents + all.gainCents + all.netFlowCents).toBe(444_000);
  });

  test("a window starting ON the first day reports no opening — it is a baseline", () => {
    seedMixedBook();
    expect(marketChangeBetween(bundle.db, D1, D3).openedInWindowCents).toBe(0);
    expect(marketChangeBetween(bundle.db, D2, D3).openedInWindowCents).toBe(0);
  });

  test("an empty portfolio is flat and exact rather than a division by zero", () => {
    expect(marketChangeBetween(bundle.db, D1, D3)).toMatchObject({
      gainCents: 0,
      netFlowCents: 0,
      openedInWindowCents: 0,
      exact: true,
    });
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
    // whole-portfolio TWR gain = D2 (+$110) + D3 (+$10) = $120, never bought capital
    expect(o.twrGainCents).toBe(12_000);
    expect(o.twrAnchor).toBe(D1);
    expect(o.hasCrypto).toBe(true);
  });

  test("an empty book has no value and no covered day", () => {
    const o = portfolioOverview(bundle.db);
    expect(o.asOf).toBeNull();
    expect(o.valueCents).toBe(0);
  });
});

const NO_DAY_CHANGE = { cents: null, pct: null, exact: true, on: null, vsDay: null, closes: [] };

describe("portfolioDayChange — the move INTO the newest close, never into a day the series carried past it", () => {
  test("whole-portfolio, flow-adjusted and exact: +$10 equity, crypto flat, and a buy is not a gain", () => {
    seedMixedBook();
    const dc = portfolioDayChange(bundle.db, holdingRows(bundle.db));
    // trades are neutralized at close, so no phantom gain, no fabrication
    expect(dc.cents).toBe(1_000);
    expect(dc.pct).toBeCloseTo((1_000 / 221_000) * 100, 10);
    expect(dc.exact).toBe(true);
    expect([dc.on, dc.vsDay]).toEqual([D3, D2]);
    expect(dc.closes).toEqual([
      { quotedOn: D3, previousQuotedOn: D2 },
      { quotedOn: D3, previousQuotedOn: D2 },
    ]);
  });

  /*
   * 🔴 THE REAL LEDGER'S SHAPE, read Tue 2026-09-15. Stocks closed Fri and Mon,
   * the coin every day through Mon, and `rebuildInvestmentHistory` carries both
   * books to today. `portfolioOverview` measured Tuesday against Monday — two
   * days valued at the same closes — and the header printed "Today $0.00
   * +0.00%" over a portfolio whose ten holdings had moved +$1,904.99.
   */
  test("read the day after Monday's closes, it is Monday's move — not the $0.00 of a carried Tuesday", () => {
    const [FRI, SAT, SUN, MON, TUE] = ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"];
    cache("AAPL", "stock", "2026-09-10", 100);
    cache("AAPL", "stock", FRI, 110);
    cache("AAPL", "stock", MON, 121);
    for (const [day, close] of [["2026-09-10", 2000], [FRI, 2010], [SAT, 2020], [SUN, 2030], [MON, 2100]] as const) {
      cache("ETH", "crypto", day, close);
    }
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 200_000_000, avgCostCents: 10_000, occurredOn: "2026-09-10" });
    upsertHolding(bundle.db, { accountId: crypto, symbol: "ETH", assetType: "crypto", quantityE8: 100_000_000, avgCostCents: 200_000, occurredOn: "2026-09-10" });
    rebuildInvestmentHistory(bundle.db, brokerage, TUE);
    rebuildInvestmentHistory(bundle.db, crypto, TUE);

    // the shape: the series runs to Tuesday, flat from Monday
    expect(portfolioOverview(bundle.db).asOf).toBe(TUE);
    // 2 AAPL × $121 + 1 ETH × $2,100
    expect(portfolioSeries(bundle.db).slice(-2).map((p) => p.valueCents)).toEqual([234_200, 234_200]);

    const rows = holdingRows(bundle.db, TUE);
    const dc = portfolioDayChange(bundle.db, rows);
    // AAPL 2 × ($121 − $110) over Fri→Mon, ETH 1 × ($2,100 − $2,030) over Sun→Mon
    expect(dc.cents).toBe(2_200 + 7_000);
    // …which is every holding's own move, summed: the figure the table beneath adds up to
    expect(dc.cents).toBe(rows.reduce((sum, r) => sum + (r.dayChangeCents ?? 0), 0));
    expect([dc.on, dc.vsDay]).toEqual([MON, SUN]);
    expect(dc.closes).toEqual([
      { quotedOn: MON, previousQuotedOn: FRI },
      { quotedOn: MON, previousQuotedOn: SUN },
    ]);
  });

  test("closes newer than every covered day — prices stored, history not rebuilt — give no figure over other days", () => {
    seedMixedBook(); // covered through D3
    cache("AAPL", "stock", "2026-03-05", 130);
    expect(portfolioDayChange(bundle.db, holdingRows(bundle.db, "2026-03-05"))).toEqual(NO_DAY_CHANGE);
  });

  test("a leg sold to nothing is not in the NAV, and its closes do not move where the change ends", () => {
    seedMixedBook();
    const sold = { quotedOn: "2026-03-05", previousQuotedOn: D3, quantityE8: 0 };
    const dc = portfolioDayChange(bundle.db, [...holdingRows(bundle.db), sold]);
    expect([dc.on, dc.cents]).toEqual([D3, 1_000]);
  });

  test("a newest close ON the first covered day has no covered day before it to be measured from", () => {
    // two closes from before the position was opened: the series starts on the day it was
    const day = todayIso();
    cache("AAPL", "stock", addDays(day, -1), 100);
    cache("AAPL", "stock", day, 110);
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 10_000, occurredOn: day });
    expect(portfolioSeries(bundle.db).map((p) => p.day)).toEqual([day]); // guards the shape

    const rows = holdingRows(bundle.db, day);
    expect([rows[0]!.quotedOn, rows[0]!.previousQuotedOn]).toEqual([day, addDays(day, -1)]);
    expect(portfolioDayChange(bundle.db, rows)).toEqual(NO_DAY_CHANGE);
  });

  test("a portfolio with no prior covered day reports NO day change, not a flat one", () => {
    /*
     * A position opened TODAY, priced today, and never before. The series is
     * built forward to today from its first covered day, so this — not a
     * back-dated single price — is the one shape that yields exactly one day.
     * Measured: seeding at D1 instead produces a series running D1 → today and
     * a perfectly real (flat) change, which is why this test dates everything
     * at `todayIso()`.
     *
     * Reachable rather than theoretical: /investments guards its empty state on
     * the number of investment ACCOUNTS, never on covered days, so this is what
     * the header renders on the day a brokerage account gets its first holding.
     */
    const day = todayIso();
    cache("AAPL", "stock", day, 100);
    upsertHolding(bundle.db, {
      accountId: brokerage,
      symbol: "AAPL",
      assetType: "stock",
      quantityE8: 100_000_000,
      avgCostCents: 10_000,
      occurredOn: day,
    });

    const o = portfolioOverview(bundle.db);
    expect(o.asOf).toBe(day);
    expect(o.valueCents).toBeGreaterThan(0);
    // 0 would be a measurement — it would say the portfolio moved nowhere
    expect(portfolioDayChange(bundle.db, holdingRows(bundle.db, day))).toEqual(NO_DAY_CHANGE);
  });

  test("an empty book reports no day change either", () => {
    expect(portfolioDayChange(bundle.db, holdingRows(bundle.db))).toEqual(NO_DAY_CHANGE);
    expect(portfolioDayChange(bundle.db, [])).toEqual(NO_DAY_CHANGE);
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

  /*
   * 🔴 These moves were dated with the PORTFOLIO's two covered days, which the
   * series carries past the newest close. Measured on the real ledger, Tue
   * 2026-09-15: /investments read "Top movers · Today" over Fri→Mon moves. The
   * dates a move was measured between are the rows' own, so they travel with it.
   */
  test("each row and each mover carries the two closes its day change was measured between", () => {
    seedMixedBook();
    const aapl = holdingRows(bundle.db).find((r) => r.symbol === "AAPL")!;
    expect([aapl.quotedOn, aapl.previousQuotedOn]).toEqual([D3, D2]);
    const mover = topMovers(bundle.db).winners.find((w) => w.symbol === "AAPL")!;
    expect([mover.quotedOn, mover.previousQuotedOn]).toEqual([D3, D2]);
  });

  /*
   * 🔴 "30d" DREW THE LAST 30 CLOSES. Stocks are quoted on trading days only, so
   * 30 closes span about six weeks while crypto's span 30 days — one column,
   * two windows. Measured 2026-09-14 on /investments: 9 of 10 holdings drew
   * 43–44 days under the header "30d", and the green/red tone was a verdict
   * about those 43 days. ⛔ The unit fixture had 3 closes and the e2e fixture
   * quotes stocks on weekends, so neither could express this: this one quotes
   * weekdays only, asks on a Monday (so the window opens on a weekend), and
   * holds a daily series and a long-stale one beside it.
   */
  test("the 30d sparkline spans the trailing 30 calendar days, not the last 30 closes", () => {
    const SPARK_TODAY = "2026-03-16"; // a Monday
    const weekdays: string[] = [];
    for (let d = new Date("2026-01-26T00:00:00Z"); d <= new Date("2026-03-13T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) weekdays.push(d.toISOString().slice(0, 10));
    }
    expect(weekdays).toHaveLength(35); // guards the fixture
    weekdays.forEach((day, i) => cache("AAPL", "stock", day, 100 + i));
    for (let d = new Date("2026-01-26T00:00:00Z"), i = 0; d <= new Date("2026-03-16T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1), i++) {
      cache("ETH", "crypto", d.toISOString().slice(0, 10), 2000 + i);
    }
    cache("STALE", "stock", "2025-12-16", 50);
    cache("STALE", "stock", "2025-12-17", 51);
    cache("STALE", "stock", "2026-03-16", 60);
    for (const [accountId, symbol, assetType] of [
      [brokerage, "AAPL", "stock"],
      [crypto, "ETH", "crypto"],
      [brokerage, "STALE", "stock"],
    ] as const) {
      upsertHolding(bundle.db, { accountId, symbol, assetType, quantityE8: 100_000_000, avgCostCents: 100, occurredOn: "2026-01-26" });
    }

    const rows = holdingRows(bundle.db, SPARK_TODAY);
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    // Feb 16 – Mar 13 (20 closes) carried through Sat 14, Sun 15, Mon 16 — the window opens Sat Feb 14
    expect(aapl.sparkline).toHaveLength(23);
    expect(aapl.sparkline[0]).toBe(11_500); // the Feb 16 close, not Feb 2's
    expect(aapl.sparkline.at(-1)).toBe(13_400); // Mar 13, carried
    expect(aapl.dayChangeCents).toBe(100); // still the last two CLOSES

    const eth = rows.find((r) => r.symbol === "ETH")!;
    expect(eth.sparkline).toHaveLength(31); // [today − 30, today] — the holding page's 1M rule
    expect(eth.sparkline[0]).toBe(201_900); // Feb 14

    const stale = rows.find((r) => r.symbol === "STALE")!;
    // one close inside the window is not a line — and never the months before it
    expect(stale.sparkline).toEqual([]);
    expect(stale.dayChangeCents).toBe(900);
    expect(stale.latestClose).toBe(60);
  });

  test("realized P/L surfaces per leg and on the holding row after a sell", () => {
    seedMixedBook();
    // sell 1 of the 2 AAPL on D3 at the $120 close: avg basis (100+120)/2 = $110
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 11_000, occurredOn: D3 });

    const realized = portfolioRealizedPl(bundle.db);
    expect(realized.realizedCents).toBe(1_000); // $120 − $110 avg basis
    expect(realized.sellCount).toBe(1);
    const aaplLeg = realized.byLeg.get(realizedLegKey(brokerage, "stock", "AAPL"))!;
    expect(aaplLeg.realizedCents).toBe(1_000);
    expect(aaplLeg.sellCount).toBe(1);
    // the byLeg parts sum to the portfolio figure
    const legSum = [...realized.byLeg.values()].reduce((s, p) => s + p.realizedCents, 0);
    expect(legSum).toBe(realized.realizedCents);

    const rows = holdingRows(bundle.db);
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.realizedCents).toBe(1_000);
    expect(aapl.realizedSellCount).toBe(1);
    expect(aapl.realizedExact).toBe(true);
    // ETH has no sells → the column reads "—"
    const eth = rows.find((r) => r.symbol === "ETH")!;
    expect(eth.realizedCents).toBeNull();
    expect(eth.realizedSellCount).toBe(0);
  });

  test("the P/L calendar and day sheet carry the day's realized sells", () => {
    seedMixedBook();
    // sell 1 of the 2 AAPL on D3 at the $120 close (avg basis $110 → +$10)
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 11_000, occurredOn: D3 });

    const month = pnlCalendarMonth(bundle.db, "2026-03", TODAY);
    expect(month.cellsByDay[D3]).toMatchObject({ realizedCents: 1_000, realizedSellCount: 1 });
    expect(month.cellsByDay[D2]).toMatchObject({ realizedCents: 0, realizedSellCount: 0 });
    expect(month.realizedMonthCents).toBe(1_000);
    expect(month.realizedSellCount).toBe(1);
    expect(month.realizedExact).toBe(true);

    const detail = pnlDayDetail(bundle.db, D3);
    expect(detail.realizedCents).toBe(1_000);
    expect(detail.realizedSales).toEqual([
      {
        symbol: "AAPL",
        assetType: "stock",
        qtyE8: 100_000_000,
        gainCents: 1_000,
        exact: true,
        clamped: false,
      },
    ]);
    // a sell-free day carries an empty book
    expect(pnlDayDetail(bundle.db, D2).realizedSales).toEqual([]);
    expect(pnlDayDetail(bundle.db, D2).realizedCents).toBe(0);
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

describe("benchmark reads honor (symbol, asset_type)", () => {
  // Regression: the benchmark READ path (hasBenchmark / portfolioBenchmarkDays)
  // must resolve the asset type the SAME way the write path does
  // (benchmarkAssetType: presets by table, any custom ticker → "etf"), so a
  // custom benchmark ticker that collides with a HELD crypto symbol never reads
  // the wrong asset's closes (nor skips its own backfill).
  test('a custom "ETH" benchmark (→ etf) does NOT match the held crypto ETH rows', () => {
    cache("SPY", "etf", D1, 500);
    cache("ETH", "crypto", D1, 2000);
    cache("ETH", "crypto", D2, 2100);

    // SPY resolves to etf and has etf rows → present
    expect(hasBenchmark(bundle.db, "SPY")).toBe(true);
    // "ETH" resolves to etf (custom, non-preset); only crypto ETH exists → absent,
    // so setBenchmarkAction's gate fetches the etf history instead of silently
    // reusing the crypto closes. (Before the fix this returned true.)
    expect(hasBenchmark(bundle.db, "ETH")).toBe(false);
  });

  test("BTC preset resolves to crypto and reads its crypto closes", () => {
    cache("BTC", "crypto", D1, 60_000);
    cache("BTC", "crypto", D2, 61_000);
    expect(hasBenchmark(bundle.db, "BTC")).toBe(true);
    const closes = portfolioBenchmarkDays(bundle.db, [D1, D2], "BTC").map((d) => d.close);
    expect(closes).toEqual([60_000, 61_000]);
  });

  test("portfolioBenchmarkDays reads the etf SPY series, never a same-symbol crypto row", () => {
    cache("SPY", "etf", D1, 500);
    cache("SPY", "etf", D2, 510);
    // a decoy crypto row under the same symbol must never leak into an etf benchmark
    cache("SPY", "crypto", D1, 999);
    cache("SPY", "crypto", D2, 999);
    const closes = portfolioBenchmarkDays(bundle.db, [D1, D2, D3], "SPY").map((d) => d.close);
    // D1/D2 = etf closes; D3 carries forward the latest etf close (510), not 999
    expect(closes).toEqual([500, 510, 510]);
  });
});

/**
 * ⚖️ Owner decisions: Robinhood #655929651 is "Robinhood Agentic", kept OUT of his own brokerage returns
 * (2026-09-14), and when the agent buys a stock a second account holds the positions while Robinhood Agentic keeps
 * the cash (2026-09-15). That book is paired with Robinhood Agentic by `accounts.cash_account_id`.
 *
 * It is still VALUED — net worth, its own account, and `pnpm ledger-check`'s witness ask for it by id — but nothing
 * that reports HIS portfolio reads it: value, returns, realized and unrealized P/L, holdings, the P&L calendar.
 */
describe("⛔ the agent's book — paired with Robinhood Agentic — stays out of his portfolio", () => {
  function pairedBook(cashName: string): { book: string; cash: string } {
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const cash = createAccount(bundle.db, { institutionId: robinhood.id, name: cashName, type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, {
      institutionId: robinhood.id,
      name: `${cashName} Brokerage`,
      type: "investment",
      subtype: "brokerage",
    });
    bundle.db.update(accounts).set({ cashAccountId: cash }).where(eq(accounts.id, book)).run();
    // AAPL too, so a per-symbol view that merged legs would move
    cache("WMT", "stock", D1, 100);
    cache("WMT", "stock", D2, 104);
    cache("WMT", "stock", D3, 110);
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, avgCostCents: 10_000, occurredOn: D2 });
    upsertHolding(bundle.db, { accountId: book, symbol: "AAPL", assetType: "stock", quantityE8: 50_000_000, avgCostCents: 11_000, occurredOn: D2 });
    // a sale, so realized P/L has something to pick up
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 10_000_000, occurredOn: D3 });
    rebuildInvestmentHistory(bundle.db, book, TODAY);
    return { book, cash };
  }

  const hisPortfolio = () => ({
    series: portfolioSeries(bundle.db),
    returnDays: portfolioReturnDays(bundle.db),
    overview: portfolioOverview(bundle.db),
    realized: [...portfolioRealizedPl(bundle.db).byLeg.entries()],
    rows: holdingRows(bundle.db, TODAY),
    calendar: pnlCalendarMonth(bundle.db, "2026-03", TODAY),
    day: pnlDayDetail(bundle.db, D3),
  });

  test("everything his portfolio reports reads exactly what it read before the book existed", () => {
    seedMixedBook();
    const before = hisPortfolio();

    pairedBook("Robinhood Agentic");

    expect(hisPortfolio()).toEqual(before);
  });

  test("…and the book IS valued when asked for by id — the scope ledger-check's witness and the account use", () => {
    seedMixedBook();
    const { book } = pairedBook("Robinhood Agentic");
    // D2: 0.25 WMT × $104 + 0.5 AAPL × $110; D3: 0.1 WMT × $110 + 0.5 AAPL × $120
    expect(portfolioSeries(bundle.db, [book]).map((p) => [p.day, p.valueCents, p.complete])).toEqual([
      [D2, 2_600 + 5_500, true],
      [D3, 1_100 + 6_000, true],
    ]);
  });

  test("a book paired with a cash account on his investment side IS his — the link decides, never the pairing alone", () => {
    seedMixedBook();
    const before = portfolioSeries(bundle.db).map((p) => p.valueCents);

    pairedBook("Robinhood Cash");

    expect(portfolioSeries(bundle.db).map((p) => p.valueCents)).toEqual([before[0], before[1]! + 8_100, before[2]! + 7_100]);
  });
});
