/**
 * What a merchant costs, and what the ledger is entitled to say about it.
 *
 * Two measurements taken on the real ledger before this module was written, and
 * both of them are refusals rather than features:
 *
 *   **454 of 702 merchants have exactly ONE visit** — 65%. "You spend $X a month
 *   here" is the number a merchant page exists to give, and for two thirds of
 *   merchants it cannot be given: one purchase does not establish a rate, and
 *   dividing it by an arbitrary window would invent one.
 *
 *   **The mean ticket runs 2–2.7× the median** wherever there are enough visits
 *   to matter — Target's mean is $34.40 against a $16.75 median across 77 rows,
 *   CVS's $15.90 against $6.23. Publishing the mean alone would describe a
 *   typical visit that mostly does not happen, so the MEDIAN leads and the mean
 *   is shown beside it whenever the two disagree.
 */

import { diffDays } from "./dates";

/** Visits below this cannot establish a rate, however long the span. */
export const MIN_VISITS_FOR_RATE = 3;
/** Nor can a span shorter than this, however many visits are in it. */
export const MIN_SPAN_DAYS_FOR_RATE = 60;
/** Above this ratio the mean is describing outliers, and is shown alongside. */
export const TICKET_SKEW_DISCLOSE = 1.25;

const DAYS_PER_MONTH = 365.2425 / 12;

export interface MerchantVisit {
  /** iso day */
  day: string;
  /** positive magnitude spent */
  amountCents: number;
  categoryName: string;
}

export interface MerchantYear {
  year: string;
  cents: number;
  visits: number;
  /** the year is still running, so it cannot be compared like for like */
  partial: boolean;
}

export interface MerchantCategorySlice {
  name: string;
  cents: number;
  /** share of `totalCents`, 0–100 */
  pct: number;
}

export interface MerchantProfile {
  visitCount: number;
  totalCents: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /**
   * Days the merchant was observed over: first visit through last, BOTH ENDS
   * INCLUDED. Purchases all on one day span one day.
   *
   * 🔴 This was the exclusive difference while both sentences it feeds name a
   * count of days from first to last. Measured on the real ledger, all 152
   * merchants printing one of those sentences printed a count one short, and
   * four printed "N visits inside 0 days" over purchases that all fell on a
   * single day — a sentence that refutes itself.
   */
  spanDays: number;
  /**
   * The headline — spend per month across the ACTIVE span, or null when the
   * evidence cannot carry one. Null is the common case by design: see the class
   * docstring.
   */
  monthlyCents: number | null;
  /** why the rate is stated, or why it is not. Chosen with the figure. */
  monthlyBasis: string;
  /** the typical visit. Leads, because the mean is skewed by outliers. */
  medianTicketCents: number;
  meanTicketCents: number;
  /** mean ÷ median; above TICKET_SKEW_DISCLOSE the two are worth showing apart */
  ticketSkew: number;
  /** true when the mean materially overstates a typical visit */
  ticketIsSkewed: boolean;
  /** largest share first */
  categoryMix: MerchantCategorySlice[];
  /** newest year first */
  years: MerchantYear[];
  /**
   * Active rows at this merchant that are NOT purchases — money in, transfers,
   * investments, or rows with no category.
   *
   * 🔴 The card already knew "Purchases" and "transactions" were different
   * numbers (Target reads 79 and 77) and never said by how much or why. On
   * `Zelle` the two read **140 and 2**: 138 of its rows are transfer-kind, and
   * the card's own explanation for having no monthly rate was *"2 visits. Too
   * few to describe a monthly habit."* — blaming sparsity at a merchant seen
   * 140 times, over four months, whose latest row is a fortnight newer than the
   * "SEEN" range printed beside it.
   */
  uncountedRows: number;
  /** what those rows are, or null when every row is a purchase */
  countedNote: string | null;
}

/**
 * ⛔ Not folded into `monthlyBasis`. The exclusion is true whether or not a rate
 * could be given, and a merchant with a perfectly good rate built from 4 of its
 * 200 rows needs saying just as much as one without.
 */
function countedNoteFor(visitCount: number, uncountedRows: number): string | null {
  if (uncountedRows === 0) return null;
  const purchases = `${visitCount} ${visitCount === 1 ? "purchase" : "purchases"}`;
  const other = `${uncountedRows} other ${uncountedRows === 1 ? "row" : "rows"}`;
  return uncountedRows === 1
    ? `Measured from ${purchases}. The 1 other row here is money in, a transfer, or uncategorized — not a purchase, so nothing on this card counts it.`
    : `Measured from ${purchases}. The ${other} here are money in, transfers, or uncategorized — none of them a purchase, so nothing on this card counts them.`;
}

export function merchantProfile(
  visits: readonly MerchantVisit[],
  today: string,
  /**
   * Every ACTIVE row at this merchant, purchases and everything else — the same
   * number the page's own heading prints. Defaults to the visit count, which is
   * the "nothing was excluded" case.
   */
  rowCount: number = visits.length,
): MerchantProfile {
  const uncountedRows = Math.max(0, rowCount - visits.length);
  if (visits.length === 0) {
    return {
      uncountedRows,
      countedNote: countedNoteFor(0, uncountedRows),
      visitCount: 0,
      totalCents: 0,
      firstSeen: null,
      lastSeen: null,
      spanDays: 0,
      monthlyCents: null,
      monthlyBasis: "Nothing has been spent here.",
      medianTicketCents: 0,
      meanTicketCents: 0,
      ticketSkew: 0,
      ticketIsSkewed: false,
      categoryMix: [],
      years: [],
    };
  }

  const days = visits.map((v) => v.day).sort();
  const firstSeen = days[0]!;
  const lastSeen = days[days.length - 1]!;
  // +1: an inclusive count of days, so one day of purchases is one day. The
  // rate below divides by this same number — see the branch comment further
  // down: the figure and the sentence describing it are chosen together.
  const spanDays = diffDays(firstSeen, lastSeen) + 1;
  const totalCents = visits.reduce((t, v) => t + v.amountCents, 0);

  /*
   * Median inline rather than in a helper. The helper carried an
   * `if (empty) return 0` guard that could never run — the empty case returns
   * above — and a branch shaped like a guard that cannot execute is worse than
   * none, because the next reader trusts it. Here the non-emptiness is visible
   * from four lines up.
   */
  const amounts = visits.map((v) => v.amountCents).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const medianTicketCents =
    amounts.length % 2 === 1 ? amounts[mid]! : Math.round((amounts[mid - 1]! + amounts[mid]!) / 2);
  const meanTicketCents = Math.round(totalCents / visits.length);
  const ticketSkew = medianTicketCents > 0 ? meanTicketCents / medianTicketCents : 0;

  /*
   * The rate, and the sentence explaining it, chosen by ONE branch — the rule
   * `budgetVerdict` follows, so a figure can never end up beside a description
   * of a different figure.
   */
  let monthlyCents: number | null = null;
  let monthlyBasis: string;
  if (visits.length < MIN_VISITS_FOR_RATE) {
    /*
     * ⛔ "purchases", not "visits" — the word the card's Purchases tile already
     * uses for this same count, and the word its own comment says to use. Said
     * of `Zelle`, "2 visits" described a merchant with 140 rows in the ledger.
     */
    monthlyBasis =
      visits.length === 1
        ? "One purchase. A single purchase is not a rate, so none is given."
        : `${visits.length} purchases. Too few to describe a monthly habit.`;
  } else if (spanDays < MIN_SPAN_DAYS_FOR_RATE) {
    monthlyBasis = `${visits.length} purchases inside ${spanDays} ${spanDays === 1 ? "day" : "days"} — too short a stretch to call it monthly.`;
  } else {
    // spread across the span that was actually observed, not a calendar window
    monthlyCents = Math.round(totalCents / (spanDays / DAYS_PER_MONTH));
    monthlyBasis = `Spread across the ${spanDays} days from ${firstSeen} to ${lastSeen}.`;
  }

  const byCategory = new Map<string, number>();
  for (const v of visits) byCategory.set(v.categoryName, (byCategory.get(v.categoryName) ?? 0) + v.amountCents);
  const categoryMix: MerchantCategorySlice[] = [...byCategory.entries()]
    .map(([name, cents]) => ({ name, cents, pct: totalCents > 0 ? (cents / totalCents) * 100 : 0 }))
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));

  const byYear = new Map<string, { cents: number; visits: number }>();
  for (const v of visits) {
    const y = v.day.slice(0, 4);
    const e = byYear.get(y) ?? { cents: 0, visits: 0 };
    byYear.set(y, { cents: e.cents + v.amountCents, visits: e.visits + 1 });
  }
  const thisYear = today.slice(0, 4);
  const years: MerchantYear[] = [...byYear.entries()]
    .map(([year, e]) => ({ year, ...e, partial: year >= thisYear }))
    .sort((a, b) => b.year.localeCompare(a.year));

  return {
    uncountedRows,
    countedNote: countedNoteFor(visits.length, uncountedRows),
    visitCount: visits.length,
    totalCents,
    firstSeen,
    lastSeen,
    spanDays,
    monthlyCents,
    monthlyBasis,
    medianTicketCents,
    meanTicketCents,
    ticketSkew,
    ticketIsSkewed: ticketSkew > TICKET_SKEW_DISCLOSE,
    categoryMix,
    years,
  };
}
