import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { holdings, priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { todayIso } from "@/lib/dates";
import { createAccount } from "./accounts";
import { rebuildInvestmentHistory } from "./crypto-history";
import { upsertHolding } from "./holdings";
import { performanceCard } from "./performance-card";
import { portfolioOverview } from "./portfolio";

process.env.MONEYAPP_FAKE_PRICES = "1";

/**
 * The card publishes no return of its own, so the tests that matter are about
 * the three things a presenter can still get wrong: which measure the headline
 * is, whether a percentage can ever be separated from the word that scales it,
 * and what happens on the days `portfolioOverview` deliberately answers null.
 */

const D1 = "2026-03-02";
const D2 = "2026-03-03";
const D3 = "2026-03-04";
/** deliberately a day AFTER the last close, so price staleness is exercised */
const TODAY = "2026-03-05";

let dir: string;
let bundle: DbBundle;
let brokerage: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-perf-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  brokerage = createAccount(bundle.db, {
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

function cache(symbol: string, day: string, close: number): void {
  bundle.db
    .insert(priceCache)
    .values({ symbol, assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T20:00:00.000Z` })
    .run();
}

function hold(day: string, quantityE8: number, avgCostCents: number, symbol = "AAPL"): void {
  upsertHolding(bundle.db, {
    accountId: brokerage,
    symbol,
    assetType: "stock",
    quantityE8,
    avgCostCents,
    occurredOn: day,
  });
}

/** 1 AAPL bought at $100 on D1, marked $110 (D2) then $120 (D3): a rising book. */
function seedRising(): void {
  cache("AAPL", D1, 100);
  cache("AAPL", D2, 110);
  cache("AAPL", D3, 120);
  hold(D1, 100_000_000, 10_000);
  rebuildInvestmentHistory(bundle.db, brokerage, D3);
}

/** The same book falling: $100 → $90 → $80. */
function seedFalling(): void {
  cache("AAPL", D1, 100);
  cache("AAPL", D2, 90);
  cache("AAPL", D3, 80);
  hold(D1, 100_000_000, 10_000);
  rebuildInvestmentHistory(bundle.db, brokerage, D3);
}

/** …and flat: the price never moves, so the market did exactly nothing. */
function seedFlat(): void {
  cache("AAPL", D1, 100);
  cache("AAPL", D2, 100);
  cache("AAPL", D3, 100);
  hold(D1, 100_000_000, 10_000);
  rebuildInvestmentHistory(bundle.db, brokerage, D3);
}

/**
 * A fourteen-month book with a second purchase part-way through — the shape
 * that makes XIRR definable at all, and the shape that reproduces the real
 * ledger's trap: a time-weighted TOTAL that looks bigger than a money-weighted
 * RATE PER YEAR. Measured on this fixture: +32.00% in total, +28.01% a year,
 * +18.92% of cost. Three numbers a reader would rank if nothing scaled them.
 *
 * The two-day books above cannot do this job: a 20% move over two days
 * annualizes past anything the XIRR solver can bracket, so `xirrPct` comes back
 * null and the " a year" label is never reached.
 */
function seedLongBook(): void {
  const prices: [string, number][] = [
    ["2025-01-06", 100],
    ["2025-04-01", 105],
    ["2025-07-01", 112],
    ["2025-10-01", 118],
    ["2026-01-02", 125],
    [D3, 132],
  ];
  for (const [day, close] of prices) cache("AAPL", day, close);
  hold("2025-01-06", 100_000_000, 10_000);
  hold("2025-10-01", 200_000_000, 11_100); // a second share, bought at $118
  rebuildInvestmentHistory(bundle.db, brokerage, D3);
}

describe("performanceCard — the headline", () => {
  test("the headline is the time-weighted gain, and every figure matches the service it came from", () => {
    seedRising();
    const o = portfolioOverview(bundle.db);
    const card = performanceCard(bundle.db, TODAY)!;

    // 1 share: $100 → $120, and nothing was bought after the anchor day
    expect(o.twrGainCents).toBe(2_000);
    expect(card.headline).toBe("$20.00");
    expect(card.headlineCents).toBe(o.twrGainCents);
    expect(card.direction).toBe("up");
    expect(card.headlineNoun).toBe("up since Mar 2026");

    // ⛔ not one return is re-derived: each row is the overview's own figure
    const twr = card.measures.find((m) => m.key === "twr")!;
    expect(twr.isHeadline).toBe(true);
    expect(twr.cents).toBe(o.twrGainCents);
    expect(twr.pctLabel).toBe(`+${o.twrPct!.toFixed(2)}% in total`);
    const unrealized = card.measures.find((m) => m.key === "unrealized")!;
    expect(unrealized.cents).toBe(o.costBasisPlCents);
  });

  /**
   * ⛔ WHICH measure the headline is. The two-day book above happens to give
   * the time-weighted gain and the cost-basis P/L the same figure, so it cannot
   * tell them apart; this one deliberately separates them ($46.00 against
   * $42.00) because a headline silently taken from the narrower measure is the
   * most plausible way this card goes wrong.
   */
  test("the headline is the time-weighted figure even when a neighbouring one is close by", () => {
    seedLongBook();
    const o = portfolioOverview(bundle.db);
    const card = performanceCard(bundle.db, TODAY)!;

    expect(o.twrGainCents).toBe(4_600);
    expect(o.costBasisPlCents).toBe(4_200); // near enough to hide a mix-up
    expect(card.headlineCents).toBe(4_600);
    expect(card.headline).toBe("$46.00");
    expect(card.measures.find((m) => m.isHeadline)!.key).toBe("twr");
    expect(card.measures.filter((m) => m.isHeadline)).toHaveLength(1);
  });

  /**
   * 🔴 THE point of the card. A percentage and the word that scales it are one
   * string, because two fields are two things a component can render one of:
   * a total across the span and a rate per year sitting bare in one column is
   * a ranking, and on the real ledger that ranking is inverted.
   */
  test("no percentage is published without the word that scales it", () => {
    seedLongBook();
    const card = performanceCard(bundle.db, TODAY)!;

    // all three rates exist on this book — the assertion below is a real one,
    // not a loop over an array that happens to be short
    expect(card.measures.map((m) => m.key)).toEqual(["twr", "xirr", "unrealized"]);
    expect(card.measures.find((m) => m.key === "twr")!.pctLabel).toBe("+32.00% in total");
    expect(card.measures.find((m) => m.key === "xirr")!.pctLabel).toBe("+28.01% a year");
    expect(card.measures.find((m) => m.key === "unrealized")!.pctLabel).toBe("+18.92% of cost");

    // 🔴 and the trap itself: bare, the time-weighted number is the biggest of
    // the three, and it is the one measured over the LONGEST unit. Every label
    // must carry its own scale, and no two may carry the same one.
    const scales = card.measures
      .map((m) => m.pctLabel)
      .filter((l): l is string => l !== null)
      .map((l) => l.replace(/^[+-]?[\d.]+%/, ""));
    expect(scales).toEqual([" in total", " a year", " of cost"]);
    expect(new Set(scales).size).toBe(scales.length);
  });

  /** Sorting by size is the reader's mistake; a card that sorts commits it. */
  test("rows keep their fixed order and are never ranked by size", () => {
    seedLongBook();
    hold(D3, 100_000_000, 11_100); // sell one, so the realized row exists too
    rebuildInvestmentHistory(bundle.db, brokerage, D3);
    const card = performanceCard(bundle.db, TODAY)!;

    expect(card.measures.map((m) => m.key)).toEqual(["twr", "xirr", "unrealized", "realized"]);
    // …which is NOT the order the figures would fall in if they were ranked
    const byPct = [...card.measures]
      .filter((m) => m.pctLabel !== null)
      .sort((a, b) => Number.parseFloat(b.pctLabel!.slice(1)) - Number.parseFloat(a.pctLabel!.slice(1)))
      .map((m) => m.key);
    expect(byPct[0]).toBe("twr");
    expect(card.measures[0]!.isHeadline).toBe(true);
    expect(card.measures.filter((m) => m.isHeadline)).toHaveLength(1);
  });
});

describe("performanceCard — sign handling", () => {
  test("a losing portfolio reports a POSITIVE magnitude under a 'down' noun", () => {
    seedFalling();
    const o = portfolioOverview(bundle.db);
    const card = performanceCard(bundle.db, TODAY)!;

    expect(o.twrGainCents).toBe(-2_000);
    expect(card.direction).toBe("down");
    // ⛔ the magnitude, never the negated figure: `formatCents(-0)` renders
    // "-$0.00" (measured), which is how a negative zero once shipped here
    expect(card.headlineCents).toBe(2_000);
    expect(card.headline).toBe("$20.00");
    expect(card.headlineNoun).toBe("down since Mar 2026");
    // the signed figure survives intact on the row, where `Money flow` tones it
    expect(card.measures.find((m) => m.key === "twr")!.cents).toBe(-2_000);
    // …and so does the percentage. A loss printed as "+20.00%" under a "down"
    // noun is a card contradicting itself in adjacent words.
    expect(card.measures.find((m) => m.key === "twr")!.pctLabel).toBe("-20.00% in total");
    expect(card.measures.find((m) => m.key === "unrealized")!.pctLabel!.startsWith("-")).toBe(true);
  });

  /**
   * ⛔ NEGATIVE ZERO. A zero gain is a real measurement and gets a word, not a
   * figure whose sign the reader has to interpret — and `headlineCents` is
   * pinned as +0 so a future `-gain` cannot slip a "-$0.00" onto the page.
   */
  test("a flat portfolio says so in words, and its magnitude is never a negative zero", () => {
    seedFlat();
    const card = performanceCard(bundle.db, TODAY)!;

    expect(card.direction).toBe("flat");
    expect(card.headline).toBe("Level");
    expect(card.headline).not.toContain("$");
    expect(card.headlineNoun).toBe("since Mar 2026");
    expect(card.headlineCents).toBe(0);
    expect(Object.is(card.headlineCents, -0)).toBe(false);
  });

  /**
   * ⛔ A gain that ROUNDS to nothing is not the same as no gain, and the sign
   * has to be decided after the rounding rather than before it: one cent on a
   * hundred-thousand-dollar book is +0.00001%, which prints as "0.00%". A "+"
   * in front of that claims a rise the two visible decimals cannot support.
   */
  test("a gain too small to print does not wear a plus sign it cannot support", () => {
    cache("AAPL", D1, 1_000);
    cache("AAPL", D2, 1_000.0001); // 100 shares → exactly one cent
    hold(D1, 100_00000000, 100_000);
    rebuildInvestmentHistory(bundle.db, brokerage, D2);

    const o = portfolioOverview(bundle.db);
    expect(o.twrGainCents).toBe(1);
    expect(o.twrPct).toBeGreaterThan(0); // a real, positive, sub-visible return

    const card = performanceCard(bundle.db, TODAY)!;
    expect(card.measures.find((m) => m.key === "twr")!.pctLabel).toBe("0.00% in total");
    // the DOLLAR figure is still a cent, and still says which way it went
    expect(card.direction).toBe("up");
    expect(card.headlineCents).toBe(1);
  });

  test("a return that rounds to nothing wears no plus sign", () => {
    seedFlat();
    const card = performanceCard(bundle.db, TODAY)!;
    // ⛔ the sign is decided on the ROUNDED value, so nothing that rounds away
    // can still claim a rise — `formatCentsSigned`'s "zero is not a gain" rule
    expect(card.measures.find((m) => m.key === "twr")!.pctLabel).toBe("0.00% in total");
    for (const m of card.measures) {
      if (m.pctLabel?.startsWith("0.00%")) expect(m.pctLabel).not.toContain("+");
    }
  });
});

describe("performanceCard — the null paths", () => {
  test("no investment account at all returns null rather than a card of zeroes", () => {
    expect(performanceCard(bundle.db, TODAY)).toBeNull();
  });

  test("an account with nothing priced returns null", () => {
    // a holding with no close anywhere: the engine can build no series for it
    hold(D1, 100_000_000, 10_000);
    rebuildInvestmentHistory(bundle.db, brokerage, D3);
    expect(portfolioOverview(bundle.db).asOf).toBeNull();
    expect(performanceCard(bundle.db, TODAY)).toBeNull();
  });

  /**
   * ⛔ THE trap. `aggregateReturn([])` returns `gainCents: 0`, so a portfolio
   * with ONE covered day reports a zero gain beside a null return. Headlining
   * the dollar figure alone would publish "Level" over a portfolio whose return
   * nobody has ever measured — a measurement nobody made, which is the fault
   * `dayChangeCents`' own docstring exists to describe.
   */
  test("one covered day returns null — a zero gain beside a null return is not a flat card", () => {
    const day = todayIso();
    cache("AAPL", day, 100);
    hold(day, 100_000_000, 10_000);

    const o = portfolioOverview(bundle.db);
    expect(o.asOf).toBe(day);
    expect(o.twrPct).toBeNull();
    expect(o.twrGainCents).toBe(0); // the figure that would have been published
    expect(o.twrAnchor).not.toBeNull(); // …and the anchor that would have dated it

    expect(performanceCard(bundle.db, day)).toBeNull();
  });
});

describe("performanceCard — absences and estimates", () => {
  /**
   * ⛔ EMPTY IS NOT A WEAKNESS. Nothing sold is not "unchecked" and not
   * "missing" — it is a thing that has not happened, and the note says so.
   */
  test("no sells is described as empty, in those words, and never as a zero row", () => {
    seedRising();
    const card = performanceCard(bundle.db, TODAY)!;

    expect(portfolioOverview(bundle.db).realizedPlCents).toBeNull();
    expect(card.measures.some((m) => m.key === "realized")).toBe(false);
    const note = card.notes.find((n) => n.includes("locked in"))!;
    expect(note).toBe("You have not sold anything yet, so nothing has been locked in.");
    expect(card.notes.join(" ")).not.toMatch(/unchecked|missing|unverified/i);
  });

  test("selling produces a realized row, marked ≈ when the walk was estimated", () => {
    seedRising();
    hold(D3, 50_000_000, 10_000); // sold half on D3
    rebuildInvestmentHistory(bundle.db, brokerage, D3);

    const o = portfolioOverview(bundle.db);
    const card = performanceCard(bundle.db, TODAY)!;
    const realized = card.measures.find((m) => m.key === "realized")!;

    expect(realized.cents).toBe(o.realizedPlCents);
    expect(realized.pctLabel).toBeNull(); // no single base to divide 88 sales by
    expect(realized.meaning).toBe("one sale, valued at the close on the day it happened");
    expect(realized.approximate).toBe(!o.realizedPlExact);
    expect(card.notes.some((n) => n.includes("locked in."))).toBe(false);
  });

  /**
   * ⛔ `realizedPlExact` is FALSE on the real ledger. A book where every trade
   * happened to have a close cannot tell an honest ≈ from a suppressed one, so
   * this one gives a second position a purchase that predates its own price
   * history — which is exactly why the real walk is inexact.
   */
  test("an estimated realized figure carries its ≈ instead of being printed as an exact cent", () => {
    cache("AAPL", D1, 100);
    cache("AAPL", D2, 110);
    cache("AAPL", D3, 120);
    hold(D1, 200_000000, 10_000);
    hold(D3, 100_000000, 10_000); // a clean, priced sale

    cache("MSFT", D2, 50);
    cache("MSFT", D3, 55);
    hold("2026-03-01", 100_000000, 5_000, "MSFT"); // bought before MSFT had any close
    rebuildInvestmentHistory(bundle.db, brokerage, D3);

    const o = portfolioOverview(bundle.db);
    expect(o.realizedSellCount).toBe(1);
    expect(o.realizedPlExact).toBe(false);

    const card = performanceCard(bundle.db, TODAY)!;
    const realized = card.measures.find((m) => m.key === "realized")!;
    expect(realized.approximate).toBe(true);
    expect(card.notes.some((n) => n.includes("marked ≈"))).toBe(true);
  });

  /**
   * An undefined rate is not an empty one. XIRR needs a sign change to have a
   * root at all; saying "empty" there would claim there is no data when there
   * is data and no answer.
   */
  test("an undefined money-weighted rate is described as undefined, not as empty", () => {
    // two days of flows: a +20% move annualizes past anything the solver can
    // bracket, so the rate genuinely has no value — real data, no answer
    seedRising();
    const card = performanceCard(bundle.db, TODAY)!;

    expect(portfolioOverview(bundle.db).xirrPct).toBeNull();
    expect(card.measures.some((m) => m.key === "xirr")).toBe(false);
    // ⛔ UNDEFINED, not empty and not missing — three different absences, and
    // this note may not borrow either of the other two's words
    expect(card.notes).toContain(
      "Money in and out has not changed direction often enough for a money-weighted rate to be defined, so there is no per-year figure to show.",
    );
  });

  test("a definable money-weighted rate is published as a rate per year", () => {
    seedLongBook();
    const o = portfolioOverview(bundle.db);
    const card = performanceCard(bundle.db, TODAY)!;

    expect(o.xirrPct).not.toBeNull();
    expect(card.measures.find((m) => m.key === "xirr")!.pctLabel).toContain(" a year");
    // a rate has no dollar companion, and borrowing one from a neighbouring
    // measure to fill the column is the conflation this card exists to prevent
    expect(card.measures.find((m) => m.key === "xirr")!.cents).toBeNull();
    expect(card.notes.some((n) => n.includes("money-weighted rate to be defined"))).toBe(false);
  });

  /**
   * `isStaleClose` is the codebase's one definition of an old close, imported
   * rather than re-stated as `days > 0` — and a close dated in the FUTURE is
   * wrong rather than old, so it must not read as stale either.
   */
  test("prices behind today are disclosed; prices current with today are not", () => {
    seedRising();
    expect(performanceCard(bundle.db, TODAY)!.pricesAreStale).toBe(true);
    expect(performanceCard(bundle.db, TODAY)!.notes.some((n) => n.includes("refresh prices"))).toBe(true);

    const sameDay = performanceCard(bundle.db, D3)!;
    expect(sameDay.pricesAreStale).toBe(false);
    expect(sameDay.notes.some((n) => n.includes("refresh prices"))).toBe(false);

    // a close dated in the future is not old — it is wrong, and "-1 days ago"
    // would be worse than silence
    const future = performanceCard(bundle.db, D2)!;
    expect(future.pricesAreStale).toBe(false);
  });
});

describe("performanceCard — the span", () => {
  test("a short book is dated in days rather than in 0 months", () => {
    seedRising();
    const card = performanceCard(bundle.db, TODAY)!;
    expect(card.spanDays).toBe(2);
    expect(card.spanLabel).toBe("2 days");
    expect(card.summary).toContain("2 days");
  });

  test("the span counts only months that have actually completed", () => {
    // anchor Jan 31, last close Mar 1: two calendar-month NUMBERS apart, but
    // only one whole month has elapsed
    cache("AAPL", "2026-01-31", 100);
    cache("AAPL", "2026-03-01", 120);
    hold("2026-01-31", 100_000_000, 10_000);
    rebuildInvestmentHistory(bundle.db, brokerage, "2026-03-01");

    const card = performanceCard(bundle.db, "2026-03-02")!;
    expect(card.anchor).toBe("2026-01-31");
    expect(card.spanLabel).toBe("1 month");
  });

  test("the anchor is labelled the way /investments labels it", () => {
    seedRising();
    const card = performanceCard(bundle.db, TODAY)!;
    // "time-weighted · since Mar 2026" on the portfolio stat row
    expect(card.anchorLabel).toBe("Mar 2026");
    expect(card.headlineNoun).toContain("Mar 2026");
  });
});

describe("performanceCard — the argument", () => {
  test("the scale note says the largest is not the best, and carries no figure", () => {
    seedLongBook();
    const card = performanceCard(bundle.db, TODAY)!;
    expect(card.scaleNote).toContain("not competing answers");
    expect(card.scaleNote).toContain("largest is not the best");
    expect(card.scaleNote).not.toMatch(/\d/);
  });

  /**
   * ⛔ Named, never numbered. "the second" points at whichever row happens to
   * be second, and the rows are conditional — so on a book with no definable
   * money-weighted rate an ordinal sentence describes something not on screen.
   */
  test("the scale note names only the measures the card is actually showing", () => {
    seedRising(); // no XIRR on a two-day book, and nothing sold
    const card = performanceCard(bundle.db, TODAY)!;

    expect(card.measures.map((m) => m.key)).toEqual(["twr", "unrealized"]);
    expect(card.scaleNote).toContain("time-weighted");
    expect(card.scaleNote).toContain("comparison to cost");
    expect(card.scaleNote).not.toContain("rate for each year");
    expect(card.scaleNote).not.toContain("locked in");
    expect(card.scaleNote).not.toMatch(/\bthe (first|second|third)\b/);
  });

  /**
   * ⛔ The THIRD absence: not empty and not undefined but MISSING — a holding
   * with a price and no recorded cost. `avg_cost_cents` is nullable in the
   * schema, so this is the shape, not a contrivance.
   */
  test("one measure alone gets no scale note — there is nothing to rank it against", () => {
    seedRising();
    bundle.db.update(holdings).set({ avgCostCents: null }).run();

    const o = portfolioOverview(bundle.db);
    expect(o.costBasisPlCents).toBeNull();
    const card = performanceCard(bundle.db, TODAY)!;

    expect(card.measures.map((m) => m.key)).toEqual(["twr"]);
    expect(card.scaleNote).toBeNull();
    // missing inputs, said as missing — neither "empty" nor "undefined"
    expect(card.notes).toContain(
      "No holding carries both a price and a recorded cost, so there is nothing to set today's positions against.",
    );
  });

  test("the value is quoted from the same call the teaser reads, so it cannot disagree", () => {
    seedRising();
    const o = portfolioOverview(bundle.db);
    const card = performanceCard(bundle.db, TODAY)!;
    expect(card.footer).toBe("On a portfolio worth $120.00.");
    expect(o.valueCents).toBe(12_000);
  });
});
