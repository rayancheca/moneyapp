import { compareDates, diffDays } from "./dates";
import { monthWindowLabel } from "./format-date";

/**
 * Why a window came back empty — "nothing happened" and "nobody has looked" are
 * different facts, and only one of them is a measurement.
 *
 * 🔴 `/spending` printed "No activity in this period" over September 2026 on
 * 2026-09-04, a month whose four elapsed days had not been imported for a single
 * account. The same doctrine is already written on the dashboard's pace tile —
 * *"an em dash, not a $0.00: when not one elapsed day of the month is imported,
 * 'you have spent nothing' is a claim about a month nobody has looked at"* — and
 * on `/budgets`, which refuses a verdict on days the ledger has not reached.
 * This is that refusal, for the surface those two link to.
 *
 * ⚠️ Whole-ledger, from `ledgerOpens` / `ledgerReaches`: the question is whether
 * ANY spending has been imported for these days, not whether every account has
 * been. A window inside the ledger's span that still comes back empty really is
 * a measured zero, and says so.
 */

export type EmptyPeriodKind =
  /** the ledger holds nothing at all */
  | "no-ledger"
  /** the window has not happened yet */
  | "future"
  /** every day of it is past the newest imported day */
  | "after-records"
  /** every day of it is before the oldest imported day */
  | "before-records"
  /** it straddles an end of the records */
  | "partly-covered"
  /** every day is inside the records, and nothing posted — a real zero */
  | "measured";

export interface EmptyPeriodInput {
  from: string;
  to: string;
  today: string;
  /** oldest day the ledger holds an active row for, or null when empty */
  ledgerOpens: string | null;
  /** newest such day */
  ledgerReaches: string | null;
}

export interface EmptyPeriodReason {
  kind: EmptyPeriodKind;
  /** how many days of the window nothing has been imported for; 0 when covered */
  uncoveredDays: number;
  /**
   * partly-covered only: how many of `uncoveredDays` lie BEFORE the oldest row —
   * the rest lie past the newest. A window can straddle either end, or both.
   */
  beforeDays?: number;
}

export function emptyPeriodReason(input: EmptyPeriodInput): EmptyPeriodReason {
  const { from, to, today, ledgerOpens, ledgerReaches } = input;
  if (ledgerOpens === null || ledgerReaches === null) return { kind: "no-ledger", uncoveredDays: 0 };
  if (compareDates(from, today) > 0) return { kind: "future", uncoveredDays: 0 };

  /*
   * ⛔ Clipped at today. A month still running is not "uncovered" for the days
   * that have not happened — the same cut `/budgets` and the pace tile make
   * before they count a day against an import.
   */
  const end = compareDates(to, today) > 0 ? today : to;
  const coveredFrom = compareDates(ledgerOpens, from) > 0 ? ledgerOpens : from;
  const coveredTo = compareDates(ledgerReaches, end) < 0 ? ledgerReaches : end;
  const elapsed = diffDays(from, end) + 1;
  const covered = compareDates(coveredFrom, coveredTo) > 0 ? 0 : diffDays(coveredFrom, coveredTo) + 1;
  const uncoveredDays = Math.max(0, elapsed - covered);

  if (uncoveredDays === 0) return { kind: "measured", uncoveredDays: 0 };
  if (covered > 0) {
    // the window's days earlier than the oldest row; every other uncovered day
    // lies past the newest one
    const beforeDays = compareDates(ledgerOpens, from) > 0 ? Math.min(diffDays(from, ledgerOpens), elapsed) : 0;
    return { kind: "partly-covered", uncoveredDays, beforeDays };
  }
  return compareDates(from, ledgerReaches) > 0
    ? { kind: "after-records", uncoveredDays }
    : { kind: "before-records", uncoveredDays };
}

/**
 * How many ELAPSED days of a window lie past the newest imported row — the days
 * a pace figure has not seen, and the reason it is a lower bound.
 *
 * 🔴 Two surfaces grade these days, and only one did. The dashboard's pace tile
 * computed them inline and printed "2 days of September 2026 not imported yet"
 * on 2026-09-14 (newest row Sep 12); /spending's cash-flow readout, one click
 * away, printed "On pace for ~$3,066.54 · $1,431.05 so far" over the same two
 * days and said nothing. Both read this now.
 *
 * ⚠️ Days BEFORE the oldest row are not counted — they are not "not imported
 * yet", and the tile never counted them. An empty ledger has imported none of
 * the elapsed days, so all of them count, as they did on the tile.
 */
export function daysNotImportedYet(input: EmptyPeriodInput): number {
  const { from, to, today } = input;
  if (compareDates(from, today) > 0) return 0;
  const reason = emptyPeriodReason(input);
  if (reason.kind === "no-ledger") return diffDays(from, compareDates(to, today) > 0 ? today : to) + 1;
  if (reason.kind === "before-records") return 0;
  return reason.uncoveredDays - (reason.beforeDays ?? 0);
}

const days = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * The empty state's heading and body, so the two cannot describe different
 * worlds. `label` is the period's own name ("September 2026").
 */
export function emptyPeriodCopy(
  reason: EmptyPeriodReason,
  label: string,
  ledgerReaches: string | null,
  formatDay: (iso: string) => string,
  /**
   * ⚠️ `/spending` prints an explicit Uncategorized bucket above this copy and
   * a measured zero there is only honest with that named. A category page has
   * no such bucket, so the clause would assert a control the reader cannot see.
   */
  opts: {
    uncategorizedBucket?: boolean;
    /** the oldest day the ledger holds — named when a window runs before it */
    ledgerOpens?: string | null;
  } = {},
): { title: string; description: string } {
  const through = ledgerReaches === null ? null : formatDay(ledgerReaches);
  switch (reason.kind) {
    case "no-ledger":
      return {
        title: "Nothing imported yet",
        description:
          "Import a statement to start the ledger — every figure on this page is read off one, so until then there is nothing to measure.",
      };
    case "future":
      return {
        title: `${label} has not happened yet`,
        description: "Pick a period that has started, or look at the forecast on /recurring.",
      };
    case "after-records":
      return {
        title: `${label} has not been imported yet`,
        description:
          `Nothing has been imported for ${days(reason.uncoveredDays)} of it${through ? `; the ledger stops on ${through}` : ""}. ` +
          "That is a window nobody has looked at, not one in which nothing happened — import the statements that cover it.",
      };
    case "before-records":
      return {
        title: `${label} is before your records begin`,
        description:
          `Nothing has been imported for any of its ${days(reason.uncoveredDays)}. ` +
          "Statements that reach further back would fill it; until then there is nothing here to measure.",
      };
    case "partly-covered": {
      /*
       * 🔴 Every partly-covered window used to be read as running past the
       * NEWEST row, so `?period=2022` on a category with no 2022 rows said
       * "236 days of it have not been imported — the ledger stops on Sep 12,
       * 2026" of Jan 1 – Aug 24, 2022, days before the records begin. Each side
       * that has uncovered days is named by its own cause, and only those.
       */
      const beforeDays = reason.beforeDays ?? 0;
      const opens = opts.ledgerOpens ? formatDay(opts.ledgerOpens) : null;
      const causes = [
        ...(beforeDays > 0 && opens ? [`your records begin on ${opens}`] : []),
        ...(reason.uncoveredDays - beforeDays > 0 && through ? [`the ledger stops on ${through}`] : []),
      ];
      return {
        title: `Nothing posted in the part of ${label} that has been imported`,
        description:
          `${days(reason.uncoveredDays)} of it ${reason.uncoveredDays === 1 ? "has" : "have"} not been imported` +
          // ", and": each cause ends on a date with its year ("Aug 25, 2022, and …")
          `${causes.length > 0 ? ` — ${causes.join(", and ")}` : ""}, so this is a lower bound rather than a measurement.`,
      };
    }
    case "measured":
      /*
       * ⚠️ "Inside what has been imported", NOT "every account is imported
       * through it". The frontier here is whole-ledger, and on this ledger the
       * accounts run to different days — Discover to Aug 9 while the ledger as a
       * whole reaches Aug 31. Claiming the stronger thing would be the same
       * over-reach this branch exists to stop.
       */
      /*
       * ⛔ …AND "NOTHING" IS THREE POPULATIONS, NOT THE LEDGER. The caller's
       * `hasActivity` gate counts expense-kind outflows, income-kind positives
       * and uncategorized outflows; a day holding only a transfer, a card
       * payment or an investment flow falls through all three. Measured
       * 2026-09-11: **79 day-windows print this over 298 posted rows**,
       * $54,457.34 of gross outflow among them — /spending?period=2025-04-11
       * alone holds 21 rows of savings transfers, Robinhood contributions and
       * buys.
       *
       * 🔴 The heatmap on this very page was corrected for the identical claim
       * earlier the same day — `/spending?period=2025-04` reads "Apr 11:
       * nothing spent or earned" — while the page-level state for the same day
       * still said "nothing posted in it". One fix, two readers, one of them
       * missed.
       */
      return {
        title: "Nothing spent or earned in this period",
        description:
          "This window sits inside what has been imported, so nothing was spent or earned in it — a measured zero rather than an unread window. Transfers, card payments and investment flows are not counted here and can still have posted; the ledger lists them. Accounts imported less far than the ledger as a whole could also be holding rows here; /imports says which." +
          (opts.uncategorizedBucket
            ? " Uncategorized outflows would show up above, as their own explicit bucket."
            : ""),
      };
  }
}

/**
 * The 12-month trend chart's absence line — naming the window the bars were
 * actually drawn over.
 *
 * 🔴 "No activity in the last 12 months." is an assertion about 365 days, and on
 * 2026-09-11 the newest 11 of them had never been imported. The SAME PAGE said
 * so two cards below, out of `emptyPeriodCopy`'s `after-records` branch.
 *
 * 🔴 …AND "THE LAST 12 MONTHS" STOPPED BEING TRUE THE MOMENT THE TREND WAS
 * ANCHORED ON THE PAGE'S PERIOD (4f13859). That commit rewrote the card heading
 * and the chart's accessible name to read the window off the points, and left
 * this third sentence — the one that REPLACES all twelve bars — saying "the last".
 * `/categories/<Dividends>?period=2023-03` printed "12-month trend · Apr 2022 to
 * Mar 2023" two lines above "No activity in the last 12 months."; measured
 * 2026-09-14, 802 of 2,844 (category × month) pages did the same.
 *
 * ⛔ Only the months the ledger has NOT reached — at either end, before it opens
 * or after it stops — are discounted. A window fully inside the records that
 * holds nothing really is a measured zero and still says so — the same line
 * `emptyPeriodCopy`'s `measured` branch draws.
 */
export function emptyTrendCopy(
  points: readonly { month: string; reached: boolean }[],
  /** what the page calls this figure — "Spent", "Received", "Net" */
  flowNoun = "activity",
): string {
  const first = points[0]?.month;
  const last = points[points.length - 1]?.month;
  const window = first === undefined || last === undefined ? "this window" : monthWindowLabel(first, last);
  const unreached = points.filter((p) => !p.reached).length;
  const covered = points.length - unreached;
  // covered first: an EMPTY run has nothing unreached AND nothing reached, and it
  // is the second fact — no month measured — that the sentence must state
  if (covered === 0) return `None of ${window} has been imported — there is nothing here to measure.`;
  if (unreached === 0) return `No ${flowNoun} in ${window}.`;
  return (
    `No ${flowNoun} in the ${monthsWord(covered)} of ${window} the ledger covers. ` +
    `The other ${monthsWord(unreached)} ${unreached === 1 ? "has" : "have"} not been imported, ` +
    `so ${unreached === 1 ? "it is" : "they are"} a window nobody has looked at rather than an empty one.`
  );
}

function monthsWord(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`;
}
