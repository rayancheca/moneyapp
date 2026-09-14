import { compareDates } from "./dates";
import { formatDayFull } from "./format-date";
import { dayWindowLabel, resolvePeriod, stepDayWithin, stepPeriodParams, type ResolvedPeriod } from "./period";

/**
 * Whether a period may be set against the one before it — over which days, and
 * if not at all, why not, in a sentence.
 *
 * `/spending` states a change in four places: "What moved", the relief's
 * heights and the Table lens's Prior/Change/% columns, the List lens's delta,
 * and the cash-flow card's prior-period ghost. Every one of them used to take
 * `resolvePeriod(stepPeriodParams(period, -1))` — the PAGING rule — and set it
 * beside the page's period without once asking whether the ledger holds either
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
 * while /summary/2023 already refused the same comparison. The rule is
 * /summary's gate three (`year-insights`, `priorFrom >= ledgerStart`) and
 * `emptyPeriodReason`'s strictness at the same edge: a window that STARTS on
 * the first day is wholly inside the records. The sentences are /summary's two,
 * generalised from a year to any window.
 *
 * ## ⛔ The closing edge — CUT, not refuse (owner decision 2026-09-14)
 *
 * The same day on /spending: "September 2026 against August 2026 — 2 up · 7
 * down", and the relief's "Housing … -$2,229.85 on August 2026". Fourteen days of
 * September — two of them unimported for every account, and nothing past Aug 12
 * for Chase Checking — against a whole August holding the Aug 4 rent.
 *
 * Both windows are cut to the same days, ending at the earliest of the period's
 * own end, today, and `importedThrough` — the last day every account he spends
 * from has been imported through (`spendingCoverageThrough`, the dashboard's
 * live-spender rule). The cut windows are NAMED ("Aug 1 – 12, 2026 against Jul
 * 1 – 12, 2026") and the note says where they stop. Only a window with no day
 * before the cut is refused. The prior window's cut end steps by the period's
 * own rule (`stepDayWithin`), so a year and year-to-date cut on one day agree.
 *
 * ⚠️ Measured insufficient, and so not the rule: cutting at the ledger's newest
 * row (Sep 12) still read Housing −$2,229.85, because the rent sits on an account
 * with no September rows. The cut has to be per account.
 *
 * ⚠️ Not `emptyPeriodReason`: its far end is the whole ledger's newest
 * TRANSACTION, which is the rule the paragraph above measured insufficient.
 */

export interface ComparedWindow {
  from: string;
  to: string;
  label: string;
}

export type ComparisonRefusal =
  /** the ledger holds no active row, or no account has been imported at all */
  | "no-ledger"
  /** the period has not started */
  | "future"
  /** not one day of the period is before the cut */
  | "not-imported"
  /** every day of the prior window is before the ledger opens */
  | "before-records"
  /** the prior window straddles the ledger's first day */
  | "partly-covered";

export type PeriodComparison =
  | {
      /** both periods, whole — every lens may state a change */
      kind: "whole";
      current: ComparedWindow;
      prior: ComparedWindow;
      /** the prior as a period, for the surfaces that bucket it (the cash-flow ghost) */
      priorPeriod: ResolvedPeriod;
    }
  | {
      /**
       * Both windows cut to the same days. ⛔ Only "What moved" states a change
       * over them: a relief block's footprint and the ghost's buckets are the
       * WHOLE period's, and cannot also carry a change measured over part of it
       * (owner decision 2026-09-14, 3a).
       */
      kind: "clipped";
      current: ComparedWindow;
      prior: ComparedWindow;
      /** the day both windows' current side stops on */
      through: string;
      /** where they stop and why, for the panel that shows them */
      note: string;
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
  /**
   * The last day every account you spend from has been imported through
   * (`spendingCoverageThrough`), or null when no account has been.
   */
  importedThrough: string | null;
  /** the ledger's first ACTIVE row (`ledgerOpens`), or null when it holds none */
  ledgerOpens: string | null;
}

function windowOf(period: ResolvedPeriod): ComparedWindow {
  return { from: period.from, to: period.to, label: period.label };
}

function earliestOf(first: string, ...rest: string[]): string {
  return rest.reduce((a, b) => (compareDates(a, b) <= 0 ? a : b), first);
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
  const { period, today, importedThrough, ledgerOpens } = input;
  if (ledgerOpens === null || importedThrough === null) {
    return { kind: "refused", reason: "no-ledger", sentence: "Nothing has been imported, so there is nothing to compare." };
  }
  const priorPeriod = resolvePeriod(stepPeriodParams(period, -1), today);

  // before "not imported": a month that has not begun is not a month nobody read
  if (compareDates(period.from, today) > 0) {
    return {
      kind: "refused",
      reason: "future",
      sentence: `${period.label} has not started, so there is nothing to set against ${priorPeriod.label}.`,
    };
  }

  const end = earliestOf(period.to, today, importedThrough);
  if (compareDates(end, period.from) < 0) {
    /*
     * 🔴 `importedThrough` is the EARLIEST frontier among the accounts you spend
     * from, not a day they all share. On 2026-09-14 this read "every account you
     * spend from has only been imported through Aug 12, 2026" for September
     * 2026 — Chase Checking's day — while Venture X was imported through Sep 13,
     * Discover Sep 8 and Chase Sapphire Sep 2. The dashboard says "at the
     * earliest"; the clipped note below says "the last day every account …".
     * This sentence now says the latter too.
     */
    return {
      kind: "refused",
      reason: "not-imported",
      sentence: `There is no comparison for ${period.label} yet: ${formatDayFull(importedThrough)}, the last day every account you spend from has been imported through, comes before any of it. A gap there would be missing statements, not less spending.`,
    };
  }

  if (end === period.to) {
    const prior = windowOf(priorPeriod);
    return openingEdge(prior, ledgerOpens) ?? { kind: "whole", current: windowOf(period), prior, priorPeriod };
  }

  const priorTo = stepDayWithin(period, end, -1);
  const prior = { from: priorPeriod.from, to: priorTo, label: dayWindowLabel(priorPeriod.from, priorTo) };
  const refused = openingEdge(prior, ledgerOpens);
  if (refused) return refused;

  // the imports stopped the window, not the calendar: say so, because the page's
  // own period label names days this panel deliberately did not read
  const stoppedByImports = end === importedThrough && compareDates(importedThrough, today) < 0;
  return {
    kind: "clipped",
    current: { from: period.from, to: end, label: dayWindowLabel(period.from, end) },
    prior,
    through: end,
    note: stoppedByImports
      ? `Both windows stop on ${formatDayFull(end)}, the last day every account you spend from has been imported through, so the same days are set side by side.`
      : `${period.label} is still running, so both windows stop on ${formatDayFull(end)}, today, and the same days are set side by side.`,
  };
}
