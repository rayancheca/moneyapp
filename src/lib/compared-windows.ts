import { compareDates } from "./dates";
import { formatDayFull } from "./format-date";
import { resolvePeriod, stepPeriodParams, type ResolvedPeriod } from "./period";

/**
 * Whether a period may be set against the one before it — and if not, why not,
 * in a sentence.
 *
 * `/spending` states a change in four places: "What moved", the relief's
 * heights and the Table lens's Prior/Change/% columns, the List lens's delta,
 * and the cash-flow card's prior-period ghost. Every one of them used to take
 * `resolvePeriod(stepPeriodParams(period, -1))` — the PAGING rule — and set it
 * beside the page's period without once asking whether the ledger holds that
 * window. This is the question, asked once, and every lens reads the answer.
 *
 * ## ⛔ The opening edge
 *
 * A prior window must start on or after the ledger's first active row. Measured
 * on the owner's ledger 2026-09-14, whose first row is 2022-08-25:
 *
 *     /spending?period=ALL    "All time against Aug 4, 2018 – Aug 24, 2022 —
 *                              20 up · 0 down" over a window holding 0 rows
 *     /spending?period=2023   "2023 against 2022 — 15 up · 0 down", largest
 *                              "Education, up $11,446.69"
 *     /spending?period=2022-09  "8 up · 0 down" against an August the ledger
 *                              holds 7 days of, and a "Spent, August 2022"
 *                              column over $0.00 rows for Aug 1–24
 *
 * while /summary/2023 already refused the same comparison ("There is no
 * comparison with 2022 …"). Every category that spent anything read as a rise:
 * a window nobody imported is not a measured zero.
 *
 * The rule is /summary's gate three (`year-insights`, `priorFrom >=
 * ledgerStart`) and `emptyPeriodReason`'s strictness at the same edge: a window
 * that STARTS on the first day is wholly inside the records. The sentences are
 * /summary's two, generalised from a year to any window — a predecessor the
 * ledger holds NONE of is not a baseline at all, one it holds PART of is a
 * misleading one, and those are different sentences.
 *
 * ⚠️ Not `emptyPeriodReason` itself: its far end is the whole ledger's newest
 * TRANSACTION, which is not what bounds a comparison's closing edge.
 */

export interface ComparedWindow {
  from: string;
  to: string;
  label: string;
}

export type ComparisonRefusal =
  /** the ledger holds no active row at all */
  | "no-ledger"
  /** every day of the prior window is before the ledger opens */
  | "before-records"
  /** the prior window straddles the ledger's first day */
  | "partly-covered";

export type PeriodComparison =
  | {
      kind: "whole";
      current: ComparedWindow;
      prior: ComparedWindow;
      /** the prior as a period, for the surfaces that bucket it (the cash-flow ghost) */
      priorPeriod: ResolvedPeriod;
    }
  | {
      kind: "refused";
      reason: ComparisonRefusal;
      /** why there is no comparison, said rather than left as an absence */
      sentence: string;
    };

export interface ComparePeriodsInput {
  period: ResolvedPeriod;
  today: string;
  /** the ledger's first ACTIVE row (`ledgerOpens`), or null when it holds none */
  ledgerOpens: string | null;
}

function windowOf(period: ResolvedPeriod): ComparedWindow {
  return { from: period.from, to: period.to, label: period.label };
}

/**
 * The refusal at the opening edge, or null when the prior window starts inside
 * the records.
 *
 * ⚠️ `formatDayFull`, always with its year: the date is forensic, and on
 * `?period=ALL` the prior window's own label spans four years — a bare "Aug 25"
 * would not say which.
 */
function openingEdge(prior: ComparedWindow, ledgerOpens: string): PeriodComparison | null {
  if (compareDates(prior.from, ledgerOpens) >= 0) return null;
  const opens = formatDayFull(ledgerOpens);
  return compareDates(prior.to, ledgerOpens) < 0
    ? {
        kind: "refused",
        reason: "before-records",
        sentence: `There is no comparison with ${prior.label}: the ledger opens on ${opens}, after all of it.`,
      }
    : {
        kind: "refused",
        reason: "partly-covered",
        sentence: `There is no comparison with ${prior.label}: the ledger opens on ${opens}, so that window is only partly in it and a change measured against it would describe when importing started.`,
      };
}

export function comparePeriods(input: ComparePeriodsInput): PeriodComparison {
  const { period, today, ledgerOpens } = input;
  if (ledgerOpens === null) {
    return { kind: "refused", reason: "no-ledger", sentence: "Nothing has been imported, so there is nothing to compare." };
  }
  const priorPeriod = resolvePeriod(stepPeriodParams(period, -1), today);
  const prior = windowOf(priorPeriod);
  return openingEdge(prior, ledgerOpens) ?? { kind: "whole", current: windowOf(period), prior, priorPeriod };
}
