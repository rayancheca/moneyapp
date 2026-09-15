import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { addDays, todayIso } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { accountDayChange, groupDayChange } from "./account-day-change";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { rebuildInvestmentHistory } from "./crypto-history";
import { observedSeries } from "./derivation";
import { listAccountHoldings, upsertHolding } from "./holdings";

process.env.MONEYAPP_FAKE_PRICES = "1";

const [THU, FRI, SAT, SUN, MON, TUE] = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"];

let dir: string;
let bundle: DbBundle;
let robinhood: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-account-day-change-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function cache(symbol: string, assetType: "stock" | "crypto", day: string, close: number): void {
  bundle.db
    .insert(priceCache)
    .values({ symbol, assetType, quotedOn: day, close, source: assetType === "crypto" ? "coinbase" : "yahoo", fetchedAt: `${day}T20:00:00.000Z` })
    .run();
}

/** the page's and the card's own read: the account's covered series, in cents */
function seriesOf(accountId: string): { day: string; cents: number }[] {
  return observedSeries(bundle.db, accountId).map((p) => ({ day: p.day, cents: p.balanceCents }));
}

function investment(name: string, subtype: "brokerage" | "crypto"): { id: string; type: "investment" } {
  return { id: createAccount(bundle.db, { institutionId: robinhood, name, type: "investment", subtype }), type: "investment" };
}

/**
 * THE REAL LEDGER'S SHAPE, read Tue 2026-09-15: stocks closed Fri and Mon, the
 * coin every day through Mon, and `rebuildInvestmentHistory` carries both
 * accounts to today.
 */
function seedMondayCloses(through: string): { brokerage: { id: string; type: "investment" }; crypto: { id: string; type: "investment" } } {
  const brokerage = investment("Robinhood Brokerage", "brokerage");
  const crypto = investment("Robinhood Crypto", "crypto");
  cache("AAPL", "stock", THU, 100);
  cache("AAPL", "stock", FRI, 110);
  cache("AAPL", "stock", MON, 121);
  for (const [day, close] of [[THU, 2000], [FRI, 2010], [SAT, 2020], [SUN, 2030], [MON, 2100]] as const) {
    cache("ETH", "crypto", day, close);
  }
  upsertHolding(bundle.db, { accountId: brokerage.id, symbol: "AAPL", assetType: "stock", quantityE8: 200_000_000, avgCostCents: 10_000, occurredOn: THU });
  upsertHolding(bundle.db, { accountId: crypto.id, symbol: "ETH", assetType: "crypto", quantityE8: 100_000_000, avgCostCents: 200_000, occurredOn: THU });
  rebuildInvestmentHistory(bundle.db, brokerage.id, through);
  rebuildInvestmentHistory(bundle.db, crypto.id, through);
  return { brokerage, crypto };
}

/*
 * 🔴 /accounts/[id]'s header chip, and the account's card on /accounts and the
 * dashboard, read an investment account's day change off its balance series.
 * `rebuildInvestmentHistory` carries that series to today whatever the newest
 * close. Measured on the real ledger, Tue 2026-09-15: Robinhood Brokerage read
 * "Today $0.00" (Sep 14 → Sep 15, carried) directly above a Day column dated
 * "Sep 14 vs Sep 11" whose nine rows summed to +$1,110.27, and Robinhood Crypto
 * "Today $0.00" above ETH's +$794.72 "Sep 14 vs Sep 13". Both cards: "$0.00 today".
 */
describe("accountDayChange — an account priced from holdings is measured into its newest close", () => {
  test("read the day after Monday's closes, each account says Monday's move — not the $0.00 of a carried Tuesday", () => {
    const { brokerage, crypto } = seedMondayCloses(TUE);

    // the shape: each series runs to Tuesday, flat from Monday — the old rule's $0.00 "Today"
    expect(seriesOf(brokerage.id).slice(-2)).toEqual([{ day: MON, cents: 24_200 }, { day: TUE, cents: 24_200 }]);
    expect(seriesOf(crypto.id).slice(-2)).toEqual([{ day: MON, cents: 210_000 }, { day: TUE, cents: 210_000 }]);

    // 2 AAPL × ($121 − $110), named by the closes it is made of
    expect(accountDayChange(bundle.db, brokerage, seriesOf(brokerage.id), TUE, formatDayShort)).toEqual({
      cents: 2_200,
      asOf: MON,
      vsDay: SUN,
      heading: { label: "Last close", interval: "Sep 14 vs Sep 11" },
    });
    // 1 ETH × ($2,100 − $2,030) — THIS account's move, not the portfolio's +$92.00
    expect(accountDayChange(bundle.db, crypto, seriesOf(crypto.id), TUE, formatDayShort)).toEqual({
      cents: 7_000,
      asOf: MON,
      vsDay: SUN,
      heading: { label: "Last close", interval: "Sep 14 vs Sep 13" },
    });
    // …which is the account's own Day column, summed
    const rows = listAccountHoldings(bundle.db, brokerage.id);
    expect(rows.reduce((sum, r) => sum + (r.dayChangeCents ?? 0), 0)).toBe(2_200);
  });

  test("a move into a close dated today is still called Today, at the figure it always was", () => {
    // the e2e fixture's shape: every close is today's, so nothing it paints may move
    const { brokerage } = seedMondayCloses(MON);
    const series = seriesOf(brokerage.id);
    expect(series.at(-1)!.cents - series.at(-2)!.cents).toBe(2_200); // the series' own pair agrees
    expect(accountDayChange(bundle.db, brokerage, series, MON, formatDayShort)).toEqual({
      cents: 2_200,
      asOf: MON,
      vsDay: SUN,
      heading: { label: "Today", interval: null },
    });
  });

  test("a buy on the day of the newest close is not a gain", () => {
    const { brokerage } = seedMondayCloses(TUE);
    // one more share on Monday, at Monday's close
    upsertHolding(bundle.db, { accountId: brokerage.id, symbol: "AAPL", assetType: "stock", quantityE8: 300_000_000, avgCostCents: 10_000, occurredOn: MON });
    rebuildInvestmentHistory(bundle.db, brokerage.id, TUE);

    const series = seriesOf(brokerage.id);
    // the balance moved $143.00 into Monday — $121.00 of it is the purchase
    expect(series.find((p) => p.day === MON)!.cents - series.find((p) => p.day === SUN)!.cents).toBe(14_300);
    expect(accountDayChange(bundle.db, brokerage, series, TUE, formatDayShort).cents).toBe(2_200);
  });

  test("a holding with one close has no move to measure: no figure, rather than a flat one", () => {
    const brokerage = investment("Robinhood Brokerage", "brokerage");
    cache("AAPL", "stock", THU, 100);
    upsertHolding(bundle.db, { accountId: brokerage.id, symbol: "AAPL", assetType: "stock", quantityE8: 200_000_000, avgCostCents: 10_000, occurredOn: THU });
    rebuildInvestmentHistory(bundle.db, brokerage.id, TUE);

    expect(seriesOf(brokerage.id).slice(-2).map((p) => p.cents)).toEqual([20_000, 20_000]);
    expect(accountDayChange(bundle.db, brokerage, seriesOf(brokerage.id), TUE, formatDayShort)).toEqual({
      cents: null,
      asOf: null,
      vsDay: null,
      heading: { label: "Day change", interval: null },
    });
  });
});

describe("groupDayChange — an institution's heading", () => {
  const combined = [{ day: SUN, cents: 100_00 }, { day: MON, cents: 150_00 }];

  test("a group that mixes an account priced from holdings with a ledger account keeps its combined series", () => {
    // the real Robinhood group's shape: its combined series is cut where the ledger child was observed
    const { brokerage } = seedMondayCloses(TUE);
    const cash = { id: createAccount(bundle.db, { institutionId: robinhood, name: "Robinhood Cash", type: "checking" }), type: "checking" as const };
    expect(groupDayChange(bundle.db, [brokerage, cash], combined, TUE, formatDayShort)).toEqual({
      cents: 50_00,
      asOf: MON,
      vsDay: SUN,
      heading: { label: "Last close", interval: "Sep 14 vs Sep 13" },
    });
  });

  test("no accounts at all is not 'every account priced from holdings' — an empty scope would be the whole portfolio", () => {
    seedMondayCloses(TUE);
    expect(groupDayChange(bundle.db, [], combined, TUE, formatDayShort).cents).toBe(50_00);
  });
});

describe("accountDayChange — every other account is measured between its series' last two covered days", () => {
  const today = todayIso();

  test("an investment account with no holding events keeps its recorded balances' move", () => {
    // `derivesFromHoldings` is false: the rebuild prices it from its balances, and so does this
    const valued = investment("Robinhood Brokerage", "brokerage");
    addManualAnchor(bundle.db, { accountId: valued.id, anchoredOn: addDays(today, -1), enteredCents: 60_000_00 });
    addManualAnchor(bundle.db, { accountId: valued.id, anchoredOn: today, enteredCents: 61_000_00 });
    expect(accountDayChange(bundle.db, valued, seriesOf(valued.id), today, formatDayShort)).toEqual({
      cents: 1_000_00,
      asOf: today,
      vsDay: addDays(today, -1),
      heading: { label: "Today", interval: null },
    });
  });

  test("a balance last observed in the past names the two days it moved between", () => {
    const checking = { id: createAccount(bundle.db, { institutionId: robinhood, name: "Robinhood Cash", type: "checking" }), type: "checking" as const };
    const [before, observed] = [addDays(today, -4), addDays(today, -3)];
    addManualAnchor(bundle.db, { accountId: checking.id, anchoredOn: before, enteredCents: 1_000_00 });
    addManualAnchor(bundle.db, { accountId: checking.id, anchoredOn: observed, enteredCents: 1_050_00 });
    expect(accountDayChange(bundle.db, checking, seriesOf(checking.id), today, formatDayShort)).toEqual({
      cents: 50_00,
      asOf: observed,
      vsDay: before,
      heading: { label: "Last close", interval: `${formatDayShort(observed)} vs ${formatDayShort(before)}` },
    });
  });

  test("one covered day is no change at all", () => {
    const checking = { id: createAccount(bundle.db, { institutionId: robinhood, name: "Robinhood Cash", type: "checking" }), type: "checking" as const };
    addManualAnchor(bundle.db, { accountId: checking.id, anchoredOn: today, enteredCents: 1_000_00 });
    expect(accountDayChange(bundle.db, checking, seriesOf(checking.id), today, formatDayShort)).toEqual({
      cents: null,
      asOf: null,
      vsDay: null,
      heading: { label: "Day change", interval: null },
    });
  });
});
