import type { AppDatabase } from "@/db/client";
import { isValidIsoDate } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { deltaFact, scalarFact, type Fact } from "@/lib/insight-facts";
import { surfaceInsights, type InsightInput } from "./insight-surface";
import type { InsightCandidate, SurfaceInsights } from "./insights";
import { observationFrontier } from "./observation-frontier";
import { provenanceFor } from "./provenance";
import { ledgerFirstDay, periodTotals } from "./spending";

/**
 * What `/summary/[year]` can say about SPENDING — the one subject that page
 * deliberately excludes everywhere else.
 *
 * Every section on that page is money IN: what he earned, what the investments
 * returned, what arrived without being earned, what passed through. Owner
 * approved adding this one thread of money out, on the same-days window below,
 * because year-over-year is the question a year summary is opened to answer and
 * nothing on the page could answer it.
 *
 * ## ⛔ Comparing a part-year against a whole one is not a comparison
 *
 * The ledger runs 2022-08-25 → 2026-08-24, so 2026 holds eight months and 2025
 * holds twelve. Setting those two totals side by side is the defect this module
 * exists to prevent, and the previous handoff got both its size and its
 * DIRECTION wrong while warning about it — it predicted a line reading
 * "spending fell by $22,000". Measured, the naive full-year line says spending
 * **rose** $24,486.91 (+59%), and like-for-like through the same days it rose
 * $34,849.14 (+160%). So the naive comparison here does not flip the sign; it
 * understates a rise by eighteen thousand dollars while looking entirely
 * plausible, which is worse than being obviously wrong.
 *
 * ## Three gates, not one
 *
 * 1. **The end day is the OBSERVATION FRONTIER, not the ledger's last row.**
 *    The newest active row is 2026-08-24, but SoFi Checking and SoFi Savings
 *    have only been shown through 2026-07-31 — measured, $9,503.76 of spending
 *    sits in a window two accounts have not reported into. Ending at the last
 *    row would compare a fully-reported 2025 against a 2026 missing whole
 *    accounts for three weeks, which is the statement-lag trap that dropped his
 *    rent out of the committed book for being one day late.
 *
 * 2. **Both windows cover the SAME calendar days.** Jan 1 → the frontier, in
 *    each year.
 *
 * 3. **The earlier window must lie wholly inside the ledger.** Without this,
 *    2023 would be compared against a 2022 the ledger has four months of and
 *    publish "+622.8%" — a measurement of when importing started, not of when
 *    spending changed. On the real ledger this gate is what silently withholds
 *    2022 and 2023, and it is why 2024, 2025 and 2026 are the only years that
 *    get a line at all.
 *
 * ⛔ The window is IN the sentence, never only beside it. "Spending rose by
 * $34,849.14 between 2025 and 2026" would be false of the figure it prints; the
 * labels carry `Jan 1 – Jul 31, 2025` and `Jan 1 – Jul 31, 2026` into the words
 * themselves, which is the rule `recurring-insights` arrived at after a rank
 * printed a yearly figure onto a page of monthly ones.
 */

interface ComparedWindows {
  from: string;
  to: string;
  label: string;
  priorFrom: string;
  priorTo: string;
  priorLabel: string;
  /** the year stops before its December — so both sides had to be cut short */
  truncated: boolean;
}

/**
 * The same calendar day, a given year earlier.
 *
 * ⚠️ Feb 29 is the ONLY day whose existence depends on the year, so it is the
 * only case that needs handling — and it needs handling rather than ignoring,
 * because SQLite would compare `'2027-02-29'` lexicographically without
 * complaint (quietly meaning "through the 28th") while the label beside the
 * figure printed a date that has never existed.
 */
function sameDayIn(year: number, iso: string): string | null {
  const candidate = `${year}-${iso.slice(5)}`;
  if (isValidIsoDate(candidate)) return candidate;
  return iso.slice(5) === "02-29" ? `${year}-02-28` : null;
}

/** "2025" for a whole year, "Jan 1 – Jul 31, 2026" for one cut at the frontier. */
function windowLabel(from: string, to: string, year: number, truncated: boolean): string {
  return truncated ? `${formatDayShort(from)} – ${formatDayShort(to)}, ${year}` : String(year);
}

function comparedWindows(db: AppDatabase, year: number): ComparedWindows | null {
  const ledgerStart = ledgerFirstDay(db);
  if (ledgerStart === null) return null;

  /*
   * The EARLIEST frontier across ledger-bearing accounts — the last day every
   * one of them has been shown. Taking the latest instead would let the
   * best-reported account speak for the ones that have not sent a statement
   * yet, which is exactly how a window comes to be missing whole accounts.
   */
  const frontier = [...observationFrontier(db).byAccount.values()].sort()[0];
  if (frontier === undefined) return null;

  const from = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const to = frontier < yearEnd ? frontier : yearEnd;
  /*
   * A year the ledger has not reached at all has no window, not an empty one.
   *
   * ⚠️ Redundant TODAY and kept anyway, measured rather than assumed: an
   * inverted window makes `periodTotals` return zero, and the zero guard in
   * `yearInsights` then refuses it — so deleting this line changes no output and
   * breaks no test. It stays because the reason it is safe lives in a different
   * function, and because without it two full-window walks run for a year this
   * ledger provably cannot speak about.
   */
  if (to < from) return null;

  const priorFrom = `${year - 1}-01-01`;
  const priorTo = sameDayIn(year - 1, to);
  if (priorTo === null) return null;
  // gate 3: an earlier window the ledger only partly covers measures the import
  // history rather than the spending
  if (priorFrom < ledgerStart) return null;

  const truncated = to !== yearEnd;
  return {
    from,
    to,
    label: windowLabel(from, to, year, truncated),
    priorFrom,
    priorTo,
    priorLabel: windowLabel(priorFrom, priorTo, year - 1, truncated),
    truncated,
  };
}

/**
 * Which years this ledger can speak about at all.
 *
 * ⛔ Derived from `comparedWindows`' own three gates rather than from a range of
 * years, because the gates are the answer: a year with no predecessor wholly
 * inside the ledger publishes a measurement of when importing started, and this
 * is the function that must not disagree with the page about which years those
 * are. Used by the selection run so it does not pay for a year that renders
 * nothing.
 */
export function yearsWithInsights(db: AppDatabase): number[] {
  const first = ledgerFirstDay(db);
  if (first === null) return [];
  const frontier = [...observationFrontier(db).byAccount.values()].sort()[0];
  if (frontier === undefined) return [];
  const out: number[] = [];
  for (let year = Number(first.slice(0, 4)); year <= Number(frontier.slice(0, 4)); year += 1) {
    if (yearInsightInput(db, year) !== null) out.push(year);
  }
  return out;
}

export function yearInsights(db: AppDatabase, year: number): SurfaceInsights | null {
  return surfaceInsights(db, "year", yearInsightInput(db, year));
}

/** What the year page measured, before the kill switch and before any proof. */
export function yearInsightInput(db: AppDatabase, year: number): InsightInput | null {
  const w = comparedWindows(db, year);
  if (w === null) return null;

  const currentCents = periodTotals(db, { from: w.from, to: w.to }).spentCents;
  /*
   * ⛔ A measured zero is not a finding. `measured_total` carries no `holds`
   * guard of its own — a scalar is just a quantity — so "Spending in 2019 came
   * to $0.00" would render as an insight about a year with no ledger in it. The
   * same rule `count_in_subject` states for counts, applied where the grammar
   * cannot apply it.
   */
  if (currentCents <= 0) return null;
  const priorCents = periodTotals(db, { from: w.priorFrom, to: w.priorTo }).spentCents;

  const facts: Fact[] = [
    scalarFact("f1", `Spending in ${w.label}`, currentCents, "money"),
    deltaFact("f2", "Spending", currentCents - priorCents, "money", w.priorLabel, w.label),
  ];

  const candidates: InsightCandidate[] = [
    {
      claimId: "measured_total",
      a: "f1",
      prove: () => provenanceFor(db, { kind: "allSpend", from: w.from, to: w.to, label: w.label }),
    },
    {
      claimId:
        currentCents > priorCents
          ? "rose_between"
          : currentCents < priorCents
            ? "fell_between"
            : "unchanged_between",
      a: "f2",
      /*
       * Proved across BOTH windows. A change stands on last year's documents
       * exactly as much as on this year's, and `allSpend`'s `against` exists so
       * this sentence's badge answers for every row underneath it rather than
       * for the half that happens to be the page's subject.
       */
      prove: () =>
        provenanceFor(db, {
          kind: "allSpend",
          from: w.from,
          to: w.to,
          label: w.label,
          against: { from: w.priorFrom, to: w.priorTo, label: w.priorLabel },
        }),
    },
  ];

  /**
   * ⛔ The direction is stated whether or not the window needs explaining.
   *
   * Every other total on this page is money IN, and the page's own design note
   * says the three it prints side by side are "the figures a reader most often
   * conflates". Dropping a fourth subject in without naming it is how a spending
   * figure gets added to an earnings figure. Position-free wording on purpose —
   * "the totals above" stops being true the moment the card moves.
   */
  const direction = "These are money out — counted in none of this page's totals, which are all money in.";
  /*
   * ⚠️ The truncation clause is only ever printed about the year the frontier
   * falls in: truncation requires the frontier to land before this year's
   * December, and a window ending before its own January is refused above. So
   * "still being imported" cannot appear on a year that finished long ago.
   */
  const window = w.truncated
    ? `${year} is still being imported, so both years are measured through ${formatDayShort(w.to)} — the last day every account has been shown to the ledger. A part-year set beside a whole one is not a comparison. `
    : "";

  return { facts, candidates, window: { label: w.label, note: `${window}${direction}` } };
}
