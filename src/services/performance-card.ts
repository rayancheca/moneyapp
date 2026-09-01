import type { AppDatabase } from "@/db/client";
import { addCalendarMonths, calendarMonthsToReach, compareDates, diffDays, todayIso } from "@/lib/dates";
import { formatDayShort, formatMonthYear } from "@/lib/format-date";
import { isStaleClose } from "@/lib/holding-price-age";
import { formatCents } from "@/lib/money";
import { portfolioOverview } from "./portfolio";

/**
 * How the investments are actually doing — up, by how much, and by WHICH
 * measure.
 *
 * ## ⛔ Nothing here is computed. Not one return figure.
 *
 * `portfolioOverview` already answers every question this card asks, and its
 * own docstrings explain each answer's scope, nullability and exactness. This
 * module composes and labels; it never re-derives. Re-deriving a return would
 * give the app two answers to one question and the second would be the
 * untested one — provenance's recorded rule, and the reason `trustCard` grades
 * nothing. The single arithmetic operation in this file is `Math.abs` on the
 * headline, and the only dates it does anything to are ones the overview
 * published.
 *
 * ## 🔴 THE DESIGN PROBLEM: three returns, and the biggest is not the best
 *
 * Three percentages are available and they do not answer one question:
 *
 *   - **time-weighted** strips out when money went in — "how did the
 *     investments do"
 *   - **money-weighted (XIRR)** counts when money went in — "how did *I* do"
 *   - **cost-basis P/L** compares today's holdings to what was paid for them —
 *     neither of the above, and it is blind to everything already sold
 *
 * Stacking them invites the reader to keep the flattering one. That is bad
 * enough on its own, but on this ledger it is worse than a matter of taste,
 * because **the two rates are not even the same kind of number** (measured
 * 2026-08-27, `scripts/probe-performance-card.ts`):
 *
 *     TWR   30.42%   ← a TOTAL across 777 days (2.13 years)
 *     XIRR  28.56%   ← a rate PER YEAR
 *
 * Printed bare, 30.42% looks like the bigger achievement. Annualized, the
 * time-weighted figure is 13.30% a year — less than half the money-weighted
 * rate. The ranking a reader would take from two unlabelled numbers is exactly
 * inverted. So no percentage leaves this service without the word that scales
 * it welded to it: `pctLabel` is "+30.42% in total", "+28.56% a year",
 * "+21.53% of cost", one string each, and there is no separate field a
 * component could forget to render. (That is pass 50's rule — make the drift
 * unrepresentable rather than merely tested — applied to a label.)
 *
 * ⚠️ The annualized figure above is NOT published. It is a fourth return, and a
 * fourth return is the disease, not the cure. What is published instead is the
 * SPAN — "over 2 years and 1 month" — which is what lets a reader see that a
 * total and a rate are being compared without the card having to compute a
 * comparison for them.
 *
 * ## 🔴 The headline is the DOLLAR figure, and the measure behind it is TWR
 *
 * "Am I up, and by how much" has one answer that needs no scale caveat at all:
 * a dollar amount. `twrGainCents` is that answer, and it is chosen over the
 * other two dollar figures deliberately:
 *
 *   - it and its percentage come from the SAME engine over the SAME days as the
 *     `valueCents` the investments teaser prints three inches away, so the two
 *     cards cannot disagree about the portfolio;
 *   - `costBasisPlCents` is narrower — open positions only, at running-average
 *     cost, which `schema.md` marks display-only — so it cannot speak for money
 *     already sold;
 *   - `xirrPct` has no dollar companion at all, and a rate per year in a
 *     dashboard headline is an invitation to multiply it by a decade.
 *
 * ## ⛔ A gain of $0.00 is not always a measurement
 *
 * `aggregateReturn([])` returns `{ twrPct: 0, gainCents: 0 }`, and
 * `portfolioOverview` passes that through as `twrGainCents: 0` while setting
 * `twrPct: null` — so a portfolio with ONE covered day reports a zero gain and
 * no return. Headlining the dollar figure without checking the percentage would
 * publish "Level since Jul 10 2024" over a portfolio nobody has ever measured a
 * return for: a measurement nobody made, which is the exact fault
 * `dayChangeCents`' own docstring was written about. `twrPct === null` is
 * therefore the null gate, not `valueCents === 0`.
 *
 * ## ⛔ EMPTY, UNDEFINED and MISSING are three different absences
 *
 * All three occur here and the card says which is which, because they are not
 * interchangeable:
 *
 *   - no sells → `realizedPlCents` null. Nothing has been sold. That is
 *     **empty**, and empty is not a weakness — it is not "unchecked", and the
 *     note says so in those words.
 *   - too few flows → `xirrPct` null. The rate is **undefined**; there is no
 *     sign change for a root to exist between. Real data, no answer.
 *   - no holding priced AND costed → `costBasisPlCents` null. The inputs are
 *     **missing**.
 *
 * ## ⛔ Inexactness is carried, never rounded away
 *
 * `realizedPlExact` is FALSE on the real ledger — trades whose day had no
 * cached close are walked at the nearest one — and `xirrExact` goes false when
 * a crypto flow feeds it. Both ride out as `approximate`, the row wears a ≈,
 * and a note says which figure it belongs to. Printing an estimate as an exact
 * cent is the same class of error as printing a null as a zero.
 *
 * ## No day change here
 *
 * `InvestmentsTeaser` publishes value and today's move on this same dashboard.
 * This card is about return over TIME, and repeating the teaser's two figures
 * would spend the reader's attention on a number they have already read. The
 * value appears once, in the footer sentence, only so the gain has something to
 * be a gain OF — and it comes from the same `portfolioOverview` call the teaser
 * reads, so the two cannot contradict each other.
 */

/** One of the three returns (or the realized total), as it should be read. */
export interface PerformanceMeasure {
  /** stable identity for React keys and tests — never rendered */
  key: "twr" | "xirr" | "unrealized" | "realized";
  /** what this measure is called, e.g. "Time-weighted" */
  label: string;
  /**
   * The percentage WITH the word that scales it — "+30.42% in total",
   * "+28.56% a year". One string on purpose: see the header note. Null for a
   * measure that has no percentage rather than a percentage of zero.
   */
  pctLabel: string | null;
  /** the dollar figure, or null when this measure does not have one */
  cents: number | null;
  /** one clause saying what the figure is about, printed under the label */
  meaning: string;
  /** true when an input the overview flagged inexact feeds this figure (the ≈) */
  approximate: boolean;
  /** true for the one the headline was taken from, so the card can show which */
  isHeadline: boolean;
}

export interface PerformanceCard {
  /** unsigned magnitude — the direction lives in `headlineNoun`, never in a sign */
  headlineCents: number;
  /** "$20,937.85", or the word "Level" when the market did nothing at all */
  headline: string;
  headlineNoun: string;
  direction: "up" | "down" | "flat";
  /** which measure the headline is, and over what — the sentence under it */
  summary: string;

  /**
   * The measures, in a FIXED order: headline first, then the other two rates,
   * then what selling banked. ⛔ Never sorted by size — sorting by magnitude is
   * the reader's mistake this card exists to prevent, performed by the card.
   */
  measures: PerformanceMeasure[];

  /**
   * ⛔ The sentence that stops the percentages being read as rivals — built
   * from the measures that are actually present, and NULL when only one of
   * them is. A single figure cannot be mistaken for the best of several, and a
   * note warning about a comparison the card is not making would be noise.
   */
  scaleNote: string | null;
  /** absences and estimates, each named as the kind of absence it actually is */
  notes: string[];
  /** the value the teaser also prints — same call, so it cannot disagree */
  footer: string;

  /** the whole-portfolio TWR anchor and its span, for the headline's honesty */
  anchor: string;
  anchorLabel: string;
  spanDays: number;
  spanLabel: string;
  /** the last covered day, and whether it is behind `today` */
  asOf: string;
  pricesAreStale: boolean;
}

/**
 * "+30.42% in total" / "0.00%" / "-4.10% a year".
 *
 * The sign is decided on the ROUNDED value, so a return that rounds to nothing
 * cannot wear a "+" claiming a rise — `formatCentsSigned`'s stated rule ("zero
 * is not a gain") applied to a percentage. `Math.abs(-0)` is `0`, so a negative
 * zero can never reach the "-" branch either.
 *
 * ⚠️ Two decimals, matching `PortfolioStats`' `pctText` on /investments. A
 * reader who follows this card's link must find the identical figure; one
 * surface rounding to 30.4% and the other to 30.42% is a difference they would
 * have to resolve.
 */
function pctLabelOf(pct: number, scale: string): string {
  const rounded = Math.round(pct * 100) / 100;
  const body = `${Math.abs(rounded).toFixed(2)}%${scale}`;
  if (rounded === 0) return body;
  return rounded > 0 ? `+${body}` : `-${body}`;
}

/** "2 years and 1 month" / "7 months" / "12 days". */
function spanLabelOf(anchor: string, asOf: string, days: number): string {
  /*
   * Whole elapsed months, day-aware. `calendarMonthsToReach` is the smallest n
   * with `anchor + n >= asOf`, so n−1 is the last one that has completed —
   * EXCEPT on the day it lands exactly ON `asOf`, where n itself has.
   * (`calendarMonthsBetween` compares month numbers only and would call
   * Jul 31 → Aug 1 a whole month.)
   *
   * 🔴 Taking n−1 unconditionally lost a whole month on every anniversary. The
   * real ledger's TWR anchor is 2024-07-10, so on 2026-07-10 the dashboard read
   * "Time-weighted, over 1 year and 11 months since Jul 2024" over exactly two
   * years — one day per month, and always downward.
   */
  const reach = calendarMonthsToReach(anchor, asOf);
  const landsOnAsOf = compareDates(addCalendarMonths(anchor, reach), asOf) === 0;
  const months = Math.max(0, landsOnAsOf ? reach : reach - 1);
  if (months === 0) return `${days} ${days === 1 ? "day" : "days"}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearPart = years === 0 ? null : `${years} ${years === 1 ? "year" : "years"}`;
  const monthPart = rest === 0 ? null : `${rest} ${rest === 1 ? "month" : "months"}`;
  if (yearPart && monthPart) return `${yearPart} and ${monthPart}`;
  return yearPart ?? monthPart ?? `${days} days`;
}

export function performanceCard(db: AppDatabase, today: string = todayIso()): PerformanceCard | null {
  const o = portfolioOverview(db);

  // No investment account, or one that has never been priced: there is no
  // portfolio to report on, and a card of zeroes is worse than no card.
  if (o.asOf === null || o.twrAnchor === null) return null;
  // ⛔ and the one that actually bites — see "A gain of $0.00" above. A single
  // covered day yields twrGainCents 0 with twrPct null; publishing the dollar
  // figure alone would announce a flat return nobody measured.
  if (o.twrPct === null) return null;

  const anchor = o.twrAnchor;
  // "Jul 2024" — the SAME label /investments' own stat row prints under this
  // very figure ("time-weighted · since Jul 2024"). A reader following the link
  // must not find the anchor named two ways.
  const anchorLabel = formatMonthYear(anchor);
  const spanDays = diffDays(anchor, o.asOf);
  const spanLabel = spanLabelOf(anchor, o.asOf, spanDays);

  const gain = o.twrGainCents;
  const direction = gain === 0 ? "flat" : gain > 0 ? "up" : "down";
  // ⛔ Math.abs, never `-gain`: `formatCents(-0)` renders "-$0.00" (measured),
  // and unary minus on an exact zero produces exactly that. Math.abs(-0) is 0.
  const headlineCents = Math.abs(gain);

  const measures: PerformanceMeasure[] = [
    {
      key: "twr",
      label: "Time-weighted",
      pctLabel: pctLabelOf(o.twrPct, " in total"),
      cents: gain,
      meaning: "the holdings' own return, whenever money happened to go in",
      // the TWR engine values every trade at the same close the value uses, so
      // this figure has no inexact input of its own to disclose
      approximate: false,
      isHeadline: true,
    },
  ];

  if (o.xirrPct !== null) {
    measures.push({
      key: "xirr",
      label: "Money-weighted",
      pctLabel: pctLabelOf(o.xirrPct, " a year"),
      // XIRR is a rate and has no dollar companion; a figure borrowed from
      // another measure to fill the column would be the conflation this card
      // exists to prevent
      cents: null,
      meaning: "your own dollars, weighted by how long each one was in the market",
      approximate: !o.xirrExact,
      isHeadline: false,
    });
  }

  if (o.costBasisPlCents !== null) {
    measures.push({
      key: "unrealized",
      label: "Held, against what you paid",
      // costBasisPlPct is non-null whenever costBasisPlCents is (the service
      // returns them from one object), and it is 0 rather than Infinity when
      // the cost is zero — its own guard, not re-stated here
      pctLabel: o.costBasisPlPct === null ? null : pctLabelOf(o.costBasisPlPct, " of cost"),
      cents: o.costBasisPlCents,
      meaning: "positions you still hold, at average cost — measured against price, not against time",
      approximate: false,
      isHeadline: false,
    });
  }

  if (o.realizedPlCents !== null) {
    const n = o.realizedSellCount;
    measures.push({
      key: "realized",
      label: "Locked in by selling",
      // no percentage: there is no single base to divide by across 88 sales
      // spread over two years, and inventing one would be a fourth return
      pctLabel: null,
      cents: o.realizedPlCents,
      meaning:
        n === 1
          ? "one sale, valued at the close on the day it happened"
          : `${n} sales, each valued at the close on the day it happened`,
      approximate: !o.realizedPlExact,
      isHeadline: false,
    });
  }

  const notes: string[] = [];
  if (o.xirrPct === null) {
    notes.push(
      "Money in and out has not changed direction often enough for a money-weighted rate to be defined, so there is no per-year figure to show.",
    );
  }
  if (o.costBasisPlCents === null) {
    notes.push(
      "No holding carries both a price and a recorded cost, so there is nothing to set today's positions against.",
    );
  }
  if (o.realizedPlCents === null) {
    // ⛔ EMPTY, and it is said as empty. "Unchecked" or "missing" would turn
    // "you have not sold anything" into a fault of the ledger.
    notes.push("You have not sold anything yet, so nothing has been locked in.");
  }
  if (o.realizedPlCents !== null && !o.realizedPlExact) {
    notes.push(
      "Some sales happened on a day with no stored price, so what selling locked in is estimated from the nearest close and is marked ≈.",
    );
  }
  if (o.xirrPct !== null && !o.xirrExact) {
    notes.push(
      "A crypto movement feeds the money-weighted rate and is not separable to the cent, so that figure is marked ≈.",
    );
  }
  // `isStaleClose` is imported rather than re-stated as `days > 0`: it is the
  // one predicate /investments, the holdings table and the section notes all
  // share, and a close dated in the FUTURE is wrong rather than old.
  const pricesAreStale = isStaleClose(o.asOf, today, diffDays);
  if (pricesAreStale) {
    const behind = diffDays(o.asOf, today);
    notes.push(
      `Everything here is measured to the closes stored for ${formatDayShort(o.asOf)}, ${behind} ${behind === 1 ? "day" : "days"} ago — refresh prices to bring it up to date.`,
    );
  }

  /*
   * ⛔ Named, never numbered. An earlier draft said "the first … the second …
   * the third", which is wrong the moment a measure is absent: on a book with
   * no definable money-weighted rate, "the second" points at the cost
   * comparison and the sentence describes a row that is not on the screen.
   */
  const SCALE_CLAUSE: Record<PerformanceMeasure["key"], string> = {
    twr: "the time-weighted figure is a total across the whole span",
    xirr: "the money-weighted one is a rate for each year",
    unrealized: "the comparison to cost is measured against price rather than against time",
    realized: "and what selling locked in is money already banked, not a return at all",
  };
  const clauses = measures.map((m) => SCALE_CLAUSE[m.key]);
  const scaleNote =
    clauses.length < 2
      ? null
      : `These are different questions, not competing answers to one, and the largest is not the best of them: ${clauses.join(", ")}.`;

  return {
    headlineCents,
    // "Level" rather than "$0.00": a zero gain is a real measurement, and the
    // word says so without a figure the reader has to decide the sign of
    headline: direction === "flat" ? "Level" : formatCents(headlineCents),
    // the word is copy, deliberately not `${direction}` — renaming a union
    // member should never quietly rewrite what the dashboard says
    headlineNoun:
      direction === "flat"
        ? `since ${anchorLabel}`
        : `${direction === "up" ? "up" : "down"} since ${anchorLabel}`,
    direction,
    summary:
      `Time-weighted, over ${spanLabel} since ${anchorLabel}: what the holdings themselves did, ` +
      "with the timing of your deposits taken out. That is the whole span added up, not a rate for each year.",
    measures,
    scaleNote,
    notes,
    footer: `On a portfolio worth ${formatCents(o.valueCents)}.`,
    anchor,
    anchorLabel,
    spanDays,
    spanLabel,
    asOf: o.asOf,
    pricesAreStale,
  };
}
