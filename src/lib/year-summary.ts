/**
 * A calendar year, partitioned the way the owner actually separates his money.
 *
 * ⛔ **The grouping is not this module's opinion.** It is the rule in
 * `docs/income-ground-truth.md`, which the owner set and which every tab in the
 * app already follows:
 *
 *   Earnings = Fordham work-study wages + Knack tutoring payouts
 *            + SoFi savings interest.
 *
 * and explicitly NOT earnings: financial-aid refunds ("Papa money" — tuition is
 * paid from an account this ledger does not hold and the balance refunded),
 * dad's money, ATM cash of mixed origin, money moved into investing, and peer
 * Zelle reimbursements. Measured on 2025, adding the financial-aid refund to
 * his wages would overstate what he earned by 43%.
 *
 * So the partition is the product. This module's job is to make it impossible
 * to blur: a line belongs to exactly one section, the section totals sum to
 * every line handed in, and the headline figure adds up ONLY the earned ones.
 *
 * ⚠️ This is a summary of records, not tax advice and not a tax document. The
 * page says so in its own words; this module keeps the figures honest enough
 * for that sentence to be true — every line carries its row count, its source
 * documents, and any caveat that applies to it.
 */

export const YEAR_SECTION_ORDER = ["earned", "investment", "notEarned", "excluded"] as const;
export type YearSectionId = (typeof YEAR_SECTION_ORDER)[number];

export const YEAR_SECTION_TITLE: Record<YearSectionId, string> = {
  earned: "What you earned",
  investment: "What your investments returned",
  notEarned: "Money in that you did not earn",
  excluded: "Money that passed through, and is counted nowhere above",
};

/** The lowest and highest year this ledger could plausibly describe. */
const YEAR_MIN = 1900;
const YEAR_MAX = 2200;

/** A year this engine describes — the one bound its throw and the route share. */
export function isSummaryYear(year: number): boolean {
  return Number.isInteger(year) && year >= YEAR_MIN && year <= YEAR_MAX;
}

/**
 * A `/summary/[year]` segment as a year, or null.
 *
 * 🔴 The route copied a different rule — any four digits — so 0000–1899 and
 * 2201–9999 reached the throw below and rendered "This page didn't render."
 * under the title "1899 summary" (measured 2026-09-14). Parsing through the
 * engine's own bound means the two cannot drift.
 */
export function parseSummaryYear(raw: string): number | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return isSummaryYear(year) ? year : null;
}

export interface YearLineInput {
  /** stable identity, unique within the year */
  id: string;
  label: string;
  section: YearSectionId;
  /** positive magnitude of money in (or of realized gain) */
  amountCents: number;
  /** ledger rows behind the figure; for a derived walk, the events behind it */
  rowCount: number;
  /** how many of those rows carry an import file */
  sourcedRowCount: number;
  /** the source documents behind it */
  sources: readonly string[];
  /** why this line sits in this section, in the ground-truth doc's terms */
  basis: string;
  /** the figure is estimated or partial, and why. Travels WITH the number. */
  caveat?: string;
  /**
   * The RETURNING leg of a pass-through, shown beside the figure and summed
   * into nothing.
   *
   * Without it the family line reads "$49,100.00 passed through" with the trip
   * back invisible, which is a half-truth in the one section whose whole job is
   * to say that money did not stay. It is deliberately not netted into
   * `amountCents`: the gross that arrived and the gross that left are both real,
   * and a single net figure would hide the size of the flow.
   */
  counterCents?: number;
  counterLabel?: string;
}

export interface YearLine extends YearLineInput {
  /** rows with no source document behind them */
  unsourcedRowCount: number;
}

export interface YearSection {
  id: YearSectionId;
  title: string;
  totalCents: number;
  lines: YearLine[];
}

export interface YearProvenance {
  rowCount: number;
  sourcedRowCount: number;
  unsourcedRowCount: number;
  /** labels of lines with at least one unsourced row — named, never averaged away */
  unsourcedLines: string[];
  /** every distinct source document, sorted */
  documents: string[];
  /** every row traces to a document */
  complete: boolean;
}

export interface YearSummary {
  year: number;
  sections: YearSection[];
  /** the headline: earned money only */
  earnedCents: number;
  investmentCents: number;
  notEarnedCents: number;
  /**
   * Money that arrived and is counted nowhere in `totalReceivedCents`. Reported
   * so its absence is visible — a figure left out silently is indistinguishable
   * from one nobody found.
   */
  excludedCents: number;
  /** earned + investment + notEarned. Deliberately EXCLUDES `excludedCents`. */
  totalReceivedCents: number;
  provenance: YearProvenance;
  /** at least one figure carries a caveat */
  hasCaveats: boolean;
  isEmpty: boolean;
}

export interface YearSummaryInput {
  year: number;
  lines: readonly YearLineInput[];
}

export function yearSummary({ year, lines }: YearSummaryInput): YearSummary {
  if (!isSummaryYear(year)) {
    throw new RangeError(`yearSummary: year must be an integer in [${YEAR_MIN}, ${YEAR_MAX}], got ${year}`);
  }

  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.id)) {
      throw new Error(`yearSummary: duplicate line id "${l.id}" — a line would be counted twice`);
    }
    seen.add(l.id);
    if (l.sourcedRowCount > l.rowCount) {
      throw new RangeError(
        `yearSummary: "${l.id}" reports ${l.sourcedRowCount} sourced rows of ${l.rowCount}`,
      );
    }
  }

  const enriched: YearLine[] = lines.map((l) => ({
    ...l,
    unsourcedRowCount: l.rowCount - l.sourcedRowCount,
  }));

  const sectionOf = (id: YearSectionId): YearSection => {
    const mine = enriched
      .filter((l) => l.section === id)
      // equal-sized lines sort by label, so a section's order is stable between
      // renders rather than inherited from input order
      .sort((a, b) => b.amountCents - a.amountCents || a.label.localeCompare(b.label));
    return {
      id,
      title: YEAR_SECTION_TITLE[id],
      totalCents: mine.reduce((t, l) => t + l.amountCents, 0),
      lines: mine,
    };
  };

  /*
   * Keyed by id rather than searched for. A `sections.find(...)?.total ?? 0`
   * lookup reads like a guard and cannot fire — `YEAR_SECTION_ORDER` builds
   * every id — so the fallback would be an untestable branch pretending to be
   * defensive. Pass 62's rule: make it unrepresentable, do not test around it.
   */
  const byId = {
    earned: sectionOf("earned"),
    investment: sectionOf("investment"),
    notEarned: sectionOf("notEarned"),
    excluded: sectionOf("excluded"),
  } satisfies Record<YearSectionId, YearSection>;
  const sections: YearSection[] = YEAR_SECTION_ORDER.map((id) => byId[id]);

  const earnedCents = byId.earned.totalCents;
  const investmentCents = byId.investment.totalCents;
  const notEarnedCents = byId.notEarned.totalCents;

  const rowCount = enriched.reduce((t, l) => t + l.rowCount, 0);
  const sourcedRowCount = enriched.reduce((t, l) => t + l.sourcedRowCount, 0);

  return {
    year,
    sections,
    earnedCents,
    investmentCents,
    notEarnedCents,
    excludedCents: byId.excluded.totalCents,
    totalReceivedCents: earnedCents + investmentCents + notEarnedCents,
    provenance: {
      rowCount,
      sourcedRowCount,
      unsourcedRowCount: rowCount - sourcedRowCount,
      unsourcedLines: enriched.filter((l) => l.unsourcedRowCount > 0).map((l) => l.label).sort(),
      documents: [...new Set(enriched.flatMap((l) => l.sources))].sort(),
      complete: rowCount === sourcedRowCount,
    },
    hasCaveats: enriched.some((l) => l.caveat !== undefined),
    isEmpty: enriched.length === 0,
  };
}

/**
 * The coverage sentence, WITH ITS SUBJECT NAMED.
 *
 * 🔴 `/summary/2026` printed, under a heading reading "Where these figures come
 * from":
 *
 *     92 of 149 rows behind this page trace to one of 11 imported documents.
 *
 * `provenance.rowCount` is built by `lineFor`, which walks the MONEY-IN lines
 * and nothing else. The page's largest figure is $56,576.24 of spending, and it
 * rests on 1,394 further rows the sentence neither counts nor lists — so "rows
 * behind this page" names a population an order of magnitude larger than the
 * one it measures, under a heading claiming to cover "these figures".
 *
 * ⛔ The FIGURE is right: 92/149/11 is a correct measurement of the money-in
 * lines, and widening it halfway — spending but not the XIRR's price basis, the
 * current window but not the prior one the delta badge also proves — would only
 * relocate the claim. The sentence is the defect, so the sentence says what it
 * counted.
 *
 * ⚠️ The page already draws this distinction one card up, in the spending
 * note: "These are money out — counted in none of this page's totals, which
 * are all money in." This card now agrees with it.
 */
export function coverageSentence(p: {
  sourcedRowCount: number;
  rowCount: number;
  documents: readonly string[];
}): string {
  const docs = `${p.documents.length} imported ${p.documents.length === 1 ? "document" : "documents"}`;
  return `${p.sourcedRowCount} of the ${p.rowCount} rows behind the money-in totals above trace to one of ${docs}.`;
}
