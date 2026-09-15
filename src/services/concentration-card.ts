import type { AppDatabase } from "@/db/client";
import type { AssetType } from "@/db/schema/holdings";
import { formatNameList } from "@/lib/coverage-label";
import { diffDays, todayIso } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { priceColumnAge, type HoldingPriceAge } from "@/lib/holding-price-age";
import { sharePercent, sumOfPrintedShares } from "@/lib/insight-facts";
import { formatCents } from "@/lib/money";
import { latestBridgedNetWorthCents } from "./in-flight";
import { allocationSlices, holdingRows } from "./portfolio";
import { provenanceFor, type Provenance } from "./provenance";

/**
 * What the portfolio is riding on — how much of everything he owns depends on
 * one thing going right.
 *
 * /investments already answers "what do I hold" and answers it well. It does
 * not answer this one, because a ten-row table sorted by value shows a reader
 * ten numbers and leaves the arithmetic between them to him. Measured
 * 2026-08-26 that arithmetic is the whole story: one coin is a third of the
 * portfolio, the top two single names are more than half of it, and the
 * portfolio itself is nearly all of his net worth — so the top position alone
 * is several times everything else he owns put together.
 *
 * ## ⛔ Not one market value is computed here
 *
 * `holdingRows` is the app's ONLY producer of a per-holding market value and
 * `valueCentsOf` is its single rounding rule; `allocationSlices` is the ONLY
 * aggregation of those legs by `(assetType, symbol)`. Both are imported and
 * neither is re-implemented — this module does not even call `valueCentsOf`,
 * because everything it publishes has already been through it. A second
 * qty × close in this file would give the app two answers to one question and
 * make this card disagree with /investments by a cent nobody could explain.
 *
 * Even the per-position percentages are `allocationSlices`' own `allocationPct`
 * rather than a fresh `value / total`, and every share this module DOES compute
 * (the top two together, each asset class) is the SUM of those published
 * percentages rather than an independent division.
 *
 * 🔴 That was meant to make the rows a reader adds up in his head agree with
 * the subtotals printed beside them, and it did not: the card rounded each
 * float sum ONCE, and a reader adds rows rounded EACH. Measured on the owner's
 * ledger 2026-09-15: "Individual stocks 51.5%" under stock lines adding to 51.6.
 * Every percentage now leaves this module written (`shareLabel`), and a subtotal
 * is `sumOfPrintedShares` of the lines above it — owner decision 2026-09-14,
 * the sum of the rounded rows, so no holding's share moves anywhere.
 *
 * ## 🔴 An index fund is not the same kind of concentration as one company
 *
 * This is the judgement that makes the card worth having, and it is made here
 * rather than left to the reader.
 *
 * Ranked purely by market value, SPY sits third — between MSFT and AMZN — and a
 * card that printed those three in a column would be saying they are three
 * comparable risks. They are not. MSFT is one company: one earnings miss, one
 * regulator, one executive. SPY is one TICKER holding hundreds of companies,
 * and the only event that takes it down is the market itself going down, which
 * is a thing that happens to every other row on this card at the same time.
 * Calling that "concentration" would inflate the very number the card exists to
 * publish, and worse, it would tell someone the fix for it is to diversify —
 * which is precisely what the fund already is.
 *
 * So funds are counted in every total (the money is genuinely at risk of the
 * market) and are shown in the list with what they are, but the CONCENTRATION
 * figures — the headline, the top position, the top two — are drawn from single
 * names only. `isSingleName` is the one predicate that decides it, so nothing
 * here can rank a fund beside a stock by accident.
 *
 * ⚠️ Crypto counts as a single name. ETH is one protocol with one price; there
 * is nothing inside it to spread a shock across.
 *
 * ## Prices are stored closes, not live quotes
 *
 * `priceColumnAge` (and `isStaleClose` under it) owns where staleness is stated
 * and what counts as stale. It is called here exactly as the two holdings
 * tables call it, so this card can never draw the boundary in a different place
 * from the page it links to.
 */

/**
 * How many positions the card names before the tail becomes one line.
 *
 * A DISPLAY cap, not a measurement threshold — the remainder line carries the
 * value and the share of everything it hides, so no money leaves the card. The
 * top two single names are force-included regardless of where they rank by
 * value, because they are the figures the headline is about and a card whose
 * headline names a row it does not show is a card that cannot be checked.
 */
const NAMED_POSITIONS = 5;

/**
 * Is this asset ONE thing that can go wrong?
 *
 * `etf` is the only `AssetType` that is not, and it is written as an exclusion
 * rather than a list of the two that are, so a new asset type is treated as a
 * single name until somebody decides otherwise — the safe direction, because
 * the failure mode is over-reporting concentration rather than hiding it.
 */
function isSingleName(assetType: AssetType): boolean {
  return assetType !== "etf";
}

/** What each asset class is called, in the card's own voice. */
const KIND_LABEL: Record<AssetType, string> = {
  crypto: "Crypto",
  stock: "Individual stocks",
  etf: "Funds",
};

/** The clause a fund row wears, so its rank cannot be misread as a single risk. */
const FUND_ROW_NOTE = "a fund, not one company";

export interface ConcentrationPosition {
  symbol: string;
  assetType: AssetType;
  /** market value, straight from `allocationSlices` */
  valueCents: number;
  /** `allocationSlices`' own share of the priced portfolio, never recomputed */
  portfolioPct: number;
  /**
   * That share as the card prints it — `sharePercent`, the rule every holding's
   * share follows on every page, so a subtotal can add exactly this.
   */
  shareLabel: string;
  /**
   * Share of everything he owns.
   *
   * ⛔ Null when net worth is not positive. `x / 0` is `Infinity` and a share of
   * a NEGATIVE net worth is worse than useless — it prints a minus sign on a
   * position that has not lost anything. The card says something else instead.
   */
  netWorthPct: number | null;
  /** false for a fund — see the header note */
  isSingleName: boolean;
  /** the fund clause, or null for a single name */
  spreadNote: string | null;
}

/** The positions the card does not name individually, as one honest line. */
export interface ConcentrationRemainder {
  count: number;
  valueCents: number;
  portfolioPct: number;
  /**
   * The SUM of the shares its positions print. They are not on the card, but
   * each is a row on /investments, and one set of holdings reads one way on
   * every page — so this is exactly the Share that ticking them there prints.
   *
   * 🔴 It was its own sum rounded once, "a part, not a subtotal": on the owner's
   * ledger 2026-09-15 "5 smaller positions 18.4%" here, and "Share 18.3%" for
   * ticking exactly those five holdings on /investments.
   */
  shareLabel: string;
}

/** One asset class, summed from the published position shares. */
export interface ConcentrationKind {
  assetType: AssetType;
  label: string;
  valueCents: number;
  portfolioPct: number;
  /**
   * The SUM of the shares this class's positions print — named on the card or
   * inside the remainder line. Its named lines plus a remainder wholly of this
   * class add to it on the card, and ticking the class on /investments prints
   * it. See `kindShareLabel`.
   */
  shareLabel: string;
  isSingleName: boolean;
}

/** The two largest single names together — the "over half" figure. */
export interface ConcentrationTopTwo {
  symbols: string[];
  valueCents: number;
  portfolioPct: number;
  /** the sum of the two rows' printed shares — both rows are always named */
  shareLabel: string;
  netWorthPct: number | null;
}

export interface ConcentrationCard {
  /** the big figure, already written — see the note on the three cases below */
  headline: string;
  /** the small words after it */
  headlineNoun: string;
  /** the sentence under the headline */
  summary: string;
  /** the largest position that is ONE company or ONE coin; null when all funds */
  top: ConcentrationPosition | null;
  /** null when the ledger holds fewer than two single names */
  topTwo: ConcentrationTopTwo | null;
  /** null when there is no second single name to say it about */
  topTwoNote: string | null;
  /** the positions the card names, largest first */
  positions: ConcentrationPosition[];
  /** everything below the named ones; null when nothing is left over */
  remainder: ConcentrationRemainder | null;
  /** crypto, stocks, funds — largest first */
  byKind: ConcentrationKind[];
  /** the priced portfolio, `allocationSlices`' own total */
  portfolioCents: number;
  /** everything he owns, debts netted — `latestBridgedNetWorthCents` */
  netWorthCents: number;
  /** the portfolio's share of net worth; null when net worth is not positive */
  portfolioSharePct: number | null;
  /**
   * Net worth minus these positions: cash and anything else, debts already
   * netted off. Signed, and legitimately negative when the debts outweigh
   * everything held outside the portfolio.
   */
  restOfNetWorthCents: number;
  /**
   * How many times over the rest of net worth the top position is.
   *
   * ⛔ Null when the rest is zero (`x / 0` is `Infinity`) AND when it is
   * negative — "-4.2× everything else" is arithmetic nobody can read. Both
   * cases get a different sentence rather than a broken multiple.
   */
  topOverRest: number | null;
  /** the rest-of-net-worth sentence, written for all three signs */
  restNote: string;
  /** what the funds are, and why they are not ranked as single risks */
  fundNote: string | null;
  /** one stale close that describes EVERY position — `priceColumnAge`'s header */
  priceAge: HoldingPriceAge | null;
  /** the stale ones, when they do not share a date — `priceColumnAge`'s rows */
  stalePositions: { symbol: string; age: HoldingPriceAge }[];
  /** the staleness sentence, or null when every close is today's */
  priceNote: string | null;
  /** held, active, and carrying no close at all — invisible to every figure here */
  unpricedSymbols: string[];
  unpricedNote: string | null;
  /** how proven the net-worth total is; the badge beside the share sits on this */
  netWorthProvenance: Provenance | null;
  today: string;
}

export function concentrationCard(
  db: AppDatabase,
  today: string = todayIso(),
): ConcentrationCard | null {
  /*
   * The legs, for the two facts the aggregate cannot carry: which closes are
   * stale, and which holdings have no close at all. `quantityE8 > 0` is
   * /investments' own definition of an ACTIVE position — a flag row left
   * `is_active` with nothing in it is a closed position, not a holding, and
   * reporting it as "unpriced" would invent a problem.
   */
  const legs = holdingRows(db).filter((r) => r.quantityE8 > 0);
  /*
   * ⚠️ KNOWINGLY unkillable by test, and kept anyway. Every ledger that reaches
   * here with no active holdings also prices to nothing, so the total guard
   * below returns null for the same input and a mutation deleting this line
   * leaves all 30 tests green. It stays because the two conditions are
   * different claims — "he holds nothing" and "nothing he holds can be priced"
   * — and only this one states the card's contract. The precedent is
   * `carCard`'s own null return, not the dead `continue` `spendBaseline`
   * deleted: that line changed no result at all, this one changes which
   * question was asked.
   */
  if (legs.length === 0) return null;

  /*
   * ⚠️ `allocationSlices` runs `holdingRows` again rather than taking the legs
   * above. That is a second pass over the same query and it is deliberate:
   * making the aggregation take an argument would turn the app's one producer
   * of an allocation into two call shapes, and the cheaper of the two would be
   * the one nothing else uses. A repeated read is worth less than a second
   * definition of a share.
   */
  const { slices, totalCents: portfolioCents } = allocationSlices(db);

  /*
   * ⛔ Every percentage below divides by this. A ledger holding positions that
   * nothing can price has no shares to publish — not zeroes, which would read
   * as "you own nothing" beside a table showing that he does.
   */
  if (portfolioCents <= 0) return null;

  const netWorthCents = latestBridgedNetWorthCents(db);
  const shareOfNetWorth = (cents: number): number | null =>
    netWorthCents > 0 ? (cents / netWorthCents) * 100 : null;

  /*
   * A slice that rounds to nothing is not a position. DUST is the real case:
   * a held, active, genuinely priced holding worth less than half a cent, which
   * `valueCentsOf` rounds to exactly zero. It survives `allocationSlices`, and
   * printing it spends a row saying that nothing is there — the rule
   * `eatingOutCard` follows for an empty child category.
   */
  const positions: ConcentrationPosition[] = slices
    .filter((s) => s.valueCents > 0)
    .map((s) => ({
      symbol: s.symbol,
      assetType: s.assetType,
      valueCents: s.valueCents,
      portfolioPct: s.allocationPct,
      shareLabel: sharePercent(s.allocationPct),
      netWorthPct: shareOfNetWorth(s.valueCents),
      isSingleName: isSingleName(s.assetType),
      spreadNote: isSingleName(s.assetType) ? null : FUND_ROW_NOTE,
    }));
  /*
   * ⛔ There is deliberately NO `positions.length === 0` guard here. It reads
   * like one and is dead: `portfolioCents` IS the sum of these slices, so an
   * empty list can only mean a non-positive total, which the line above already
   * refused. A mutation deleting such a guard changes no result — the shape
   * `spendBaseline` removed a dead `continue` for, because the next edit to
   * this block would trust it.
   */

  // `allocationSlices` sorts largest first, so these inherit that order
  const singleNames = positions.filter((p) => p.isSingleName);
  const funds = positions.filter((p) => !p.isSingleName);
  const top = singleNames[0] ?? null;
  const second = singleNames[1] ?? null;

  /*
   * Summed from the PUBLISHED shares, not divided afresh. A reader adding the
   * two rows above must land on this number exactly; an independent division
   * is a second author for one figure, which is how "54.9%" ends up beside two
   * rows reading 33.7% and 21.2%.
   *
   * 🔴 …AND ADDED AS PRINTED. A float sum rounded once is not two rows rounded
   * each: this module's own test book printed "ETH and AAPL together are 68.3%"
   * under rows of 54.7% and 13.5%. Both rows are forced into the named list
   * below, so both are always on the card for the reader to add.
   */
  const topTwo: ConcentrationTopTwo | null =
    top && second
      ? {
          symbols: [top.symbol, second.symbol],
          valueCents: top.valueCents + second.valueCents,
          portfolioPct: top.portfolioPct + second.portfolioPct,
          shareLabel: sumOfPrintedShares([top.portfolioPct, second.portfolioPct]),
          netWorthPct: shareOfNetWorth(top.valueCents + second.valueCents),
        }
      : null;

  const keyOf = (p: ConcentrationPosition): string => `${p.assetType}|${p.symbol}`;
  const namedKeys = new Set(positions.slice(0, NAMED_POSITIONS).map(keyOf));
  // the headline's own rows, wherever they rank by value
  for (const p of [top, second]) if (p) namedKeys.add(keyOf(p));
  const named = positions.filter((p) => namedKeys.has(keyOf(p)));
  const rest = positions.filter((p) => !namedKeys.has(keyOf(p)));
  const remainderPct = rest.reduce((s, p) => s + p.portfolioPct, 0);
  const remainder: ConcentrationRemainder | null =
    rest.length === 0
      ? null
      : {
          count: rest.length,
          valueCents: rest.reduce((s, p) => s + p.valueCents, 0),
          portfolioPct: remainderPct,
          shareLabel: sumOfPrintedShares(rest.map((p) => p.portfolioPct)),
        };

  const kindTotals = new Map<AssetType, { valueCents: number; portfolioPct: number }>();
  for (const p of positions) {
    const cur = kindTotals.get(p.assetType) ?? { valueCents: 0, portfolioPct: 0 };
    kindTotals.set(p.assetType, {
      valueCents: cur.valueCents + p.valueCents,
      portfolioPct: cur.portfolioPct + p.portfolioPct,
    });
  }

  /*
   * A class is the sum of the shares its positions print — every one of them,
   * named on the card or inside the remainder line.
   *
   * 🔴 Measured on the owner's ledger 2026-09-15: "Individual stocks 51.5%"
   * under stock lines MSFT 18.2% · AMZN 8.2% · UNH 6.8% and "5 smaller
   * positions 18.4%" — all five of them stocks — which add to 51.6.
   *
   * 🔴 …and then "51.6%" beside /investments' "Share 51.5%" for ticking those
   * same eight stocks, because the remainder line was its own sum rounded once
   * (second reader on uc/shares-rounding, 2026-09-15). The remainder is written
   * as the sum of its positions now, so a class's named lines plus a remainder
   * wholly of that class add to exactly this, and so does the tick bar.
   *
   * ⚖️ Owner decision 2026-09-14 (F2): the sum of the rounded rows. A remainder
   * that MIXES classes cannot be split by class on the card, but each position
   * inside it is a row on /investments, so the class is still that sum — never
   * round(Σ), the figure F2 replaced. Not reachable on the owner's ledger today:
   * AAPL, COKE, GOOG, META and WMT are all stocks.
   */
  const kindShareLabel = (assetType: AssetType): string =>
    sumOfPrintedShares(positions.filter((p) => p.assetType === assetType).map((p) => p.portfolioPct));
  const byKind: ConcentrationKind[] = [...kindTotals.entries()]
    .map(([assetType, t]) => ({
      assetType,
      label: KIND_LABEL[assetType],
      valueCents: t.valueCents,
      portfolioPct: t.portfolioPct,
      shareLabel: kindShareLabel(assetType),
      isSingleName: isSingleName(assetType),
    }))
    .sort((a, b) => b.valueCents - a.valueCents);

  const portfolioSharePct = shareOfNetWorth(portfolioCents);

  /*
   * Net worth minus what is listed above.
   *
   * ⚠️ NOT re-summed from cash and card balances. `runwayCard` already publishes
   * those two figures and re-deriving them here would put a third author on
   * "what is cash"; subtracting one published total from another is exact by
   * construction and needs no opinion about which account types are liquid.
   *
   * A subtraction of two equal integers is +0 in JavaScript, never -0, so this
   * cannot reach `formatCents` as "-$0.00" — the trap rule 7 names. Nothing in
   * this module flips a sign: every magnitude it prints is already positive, and
   * the one place a negative is READ (the note below) takes `Math.abs`, which
   * returns +0 for -0 as well.
   */
  const restOfNetWorthCents = netWorthCents - portfolioCents;
  const topOverRest =
    top !== null && restOfNetWorthCents > 0 ? top.valueCents / restOfNetWorthCents : null;

  /* ── the words ─────────────────────────────────────────────────────────── */

  /*
   * 🔴 A third rounding author lived here: `pct`, a bare `toFixed(1)` with no
   * floors, wrote the headline, the summary and both notes while the rows used
   * `sharePercent` — so a fund at 99.96% of the portfolio read "100.0%" in the
   * fund note under a Funds line reading ">99.9%". Every percentage below is a
   * printed line's own label, or `sharePercent` for the figures no line prints.
   */
  const headline =
    top === null
      ? "Nothing"
      : top.netWorthPct !== null
        ? sharePercent(top.netWorthPct)
        : top.shareLabel;
  /*
   * 🔴 "everything you own" is ASSETS; this denominator is net worth, which is
   * assets minus debts. Read on the owner's ledger 2026-09-04: assets
   * $114,498.97, net worth $113,656.08, and the headline said "32.2% of
   * everything you own is ETH" of a figure struck against the smaller one —
   * 32.0% against what he actually owns. The card's own `restNote` two lines
   * below already says "debts already netted off"; the two sentences above it
   * did not, and the field they read is documented as "everything he owns,
   * debts netted". Name the denominator instead of describing it loosely.
   */
  const headlineNoun =
    top === null
      ? "of your net worth rides on one company"
      : top.netWorthPct !== null
        ? `of your net worth is ${top.symbol}`
        : `of your portfolio is ${top.symbol}`;

  const summary =
    top === null
      ? `Every position here is a fund, so this ${formatCents(portfolioCents)} portfolio is spread ` +
        `across hundreds of companies rather than resting on any one of them.`
      : portfolioSharePct === null
        ? `${top.symbol} is ${formatCents(top.valueCents)} of a ${formatCents(portfolioCents)} ` +
          `portfolio, ${top.shareLabel} of it. Your net worth is not positive, so there is ` +
          `no share of it to measure this against.`
        : `${top.symbol} is ${formatCents(top.valueCents)} of a ${formatCents(portfolioCents)} ` +
          `portfolio — ${top.shareLabel} of it — and the portfolio is ` +
          `${sharePercent(portfolioSharePct)} of your net worth — what you own with your debts netted off.`;

  const topTwoNote =
    topTwo === null
      ? null
      : `${topTwo.symbols[0]} and ${topTwo.symbols[1]} together are ${topTwo.shareLabel} of ` +
        `the portfolio, ${formatCents(topTwo.valueCents)}.`;

  const restNote =
    restOfNetWorthCents > 0
      ? topOverRest !== null && top !== null
        ? `The rest of your net worth comes to ${formatCents(restOfNetWorthCents)}, debts already ` +
          `netted off — ${top.symbol} on its own is ${topOverRest.toFixed(1)} times that.`
        : `The rest of your net worth comes to ${formatCents(restOfNetWorthCents)}, debts already ` +
          `netted off.`
      : restOfNetWorthCents === 0
        ? `These positions are your entire net worth — there is nothing else, and nothing owed.`
        : /*
           * 🔴 THE CLAUSE AFTER THE COMMA WAS FALSE FOR EVERY INPUT THAT
           * REACHES THIS BRANCH. With A = assets, L = liabilities, P = the
           * portfolio and R = A − P the non-portfolio assets,
           * `restOfNetWorthCents` is (A − L) − P = R − L. The branch fires when
           * R < L. The old sentence concluded P > A, which since A = P + R
           * means R < 0 — and R is a sum of asset balances, so it never is.
           * The true reading is the one the figure actually supports: the DEBT
           * outside these positions is bigger than what is held outside them.
           *
           * ⚠️ Not reachable on this ledger today ($4,675.37 outside the
           * portfolio against $842.89 of debt), which is why no screenshot and
           * no reading has ever shown it. It is one bad month away.
           */
          `Outside these positions you owe ${formatCents(Math.abs(restOfNetWorthCents))} more than ` +
          `you hold, so your net worth rests entirely on the portfolio — everything else nets to a debt.`;

  // the Funds line itself — `etf` is the one class that is not a single name —
  // so the sentence quotes that line's value and label rather than re-summing them
  const fundKind = byKind.find((k) => !k.isSingleName) ?? null;
  const fundNote =
    fundKind === null
      ? null
      : `${formatNameList(funds.map((f) => f.symbol), 3)} ` +
        `${funds.length === 1 ? "is a fund" : "are funds"}, not ` +
        `${funds.length === 1 ? "a company" : "companies"} — one ticker holding hundreds of them. ` +
        `That is ${formatCents(fundKind.valueCents)}, ${fundKind.shareLabel} of the portfolio: counted in every total ` +
        `here, but never ranked beside a single stock, because a fund falling is the market falling ` +
        `rather than one thing going wrong.`;

  /* ── what the figures are standing on ──────────────────────────────────── */

  /*
   * `priceColumnAge` decides whether one date speaks for every position or each
   * stale one speaks for itself, and `isStaleClose` under it owns where the
   * boundary is. Both are reused rather than re-picked so this card and the two
   * holdings tables can only ever disagree about which rows they cover, never
   * about what "stale" means.
   */
  const pricedLegs = legs.filter((r) => r.valueCents !== null);
  const priceCol = priceColumnAge(pricedLegs, today, diffDays, formatDayShort);
  const seen = new Set<string>();
  const stalePositions: { symbol: string; age: HoldingPriceAge }[] = [];
  for (const r of pricedLegs) {
    const key = `${r.assetType}|${r.symbol}`;
    if (seen.has(key)) continue; // one symbol, one close — two accounts are not two dates
    seen.add(key);
    const age = priceCol.row(r.quotedOn);
    if (age) stalePositions.push({ symbol: r.symbol, age });
  }

  const priceNote = priceCol.header
    ? `Every figure here is struck at a stored close ${priceCol.header.text}, not a live quote.`
    : stalePositions.length > 0
      ? `Not every close here is today's — ` +
        `${formatNameList(stalePositions.map((s) => `${s.symbol} ${s.age.text}`), 3)}. ` +
        `${stalePositions.length === 1 ? "That share is" : "Those shares are"} as old as the ` +
        `price behind ${stalePositions.length === 1 ? "it" : "them"}.`
      : null;

  /*
   * A held position with no close is not in `portfolioCents`, so every share on
   * this card is a share of a total that cannot see it. That is the one thing
   * here a reader could act on, so it is said rather than silently excluded.
   */
  const unpricedSymbols = [
    ...new Set(legs.filter((r) => r.valueCents === null).map((r) => r.symbol)),
  ].sort();
  const unpricedNote =
    unpricedSymbols.length === 0
      ? null
      : `${formatNameList(unpricedSymbols, 3)} ` +
        `${unpricedSymbols.length === 1 ? "has" : "have"} no stored price, so ` +
        `${unpricedSymbols.length === 1 ? "it is" : "they are"} missing from every share above.`;

  return {
    headline,
    headlineNoun,
    summary,
    top,
    topTwo,
    topTwoNote,
    positions: named,
    remainder,
    byKind,
    portfolioCents,
    netWorthCents,
    portfolioSharePct,
    restOfNetWorthCents,
    topOverRest,
    restNote,
    fundNote,
    priceAge: priceCol.header,
    stalePositions,
    priceNote,
    unpricedSymbols,
    unpricedNote,
    netWorthProvenance: provenanceFor(db, { kind: "netWorth", day: today }),
    today,
  };
}
