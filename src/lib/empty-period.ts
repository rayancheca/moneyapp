import { compareDates, diffDays } from "./dates";

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
  if (covered > 0) return { kind: "partly-covered", uncoveredDays };
  return compareDates(from, ledgerReaches) > 0
    ? { kind: "after-records", uncoveredDays }
    : { kind: "before-records", uncoveredDays };
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
  opts: { uncategorizedBucket?: boolean } = {},
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
    case "partly-covered":
      return {
        title: `Nothing posted in the part of ${label} that has been imported`,
        description:
          `${days(reason.uncoveredDays)} of it ${reason.uncoveredDays === 1 ? "has" : "have"} not been imported` +
          `${through ? ` — the ledger stops on ${through}` : ""}, so this is a lower bound rather than a measurement.`,
      };
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
 * The 12-month trend chart's absence line.
 *
 * 🔴 "No activity in the last 12 months." is an assertion about 365 days, and on
 * 2026-09-11 the newest 11 of them had never been imported. The SAME PAGE said
 * so two cards below, out of `emptyPeriodCopy`'s `after-records` branch:
 * *"September 2026 has not been imported yet. Nothing has been imported for 11
 * days of it; the ledger stops on Mon, Aug 31, 2026. That is a window nobody has
 * looked at, not one in which nothing happened."*
 *
 * `MonthlyTrendBars` already carried this doctrine for the BARS — a point past
 * the frontier reads "not imported yet" rather than "$0.00, 0 transactions" —
 * and the sentence that replaces all twelve of them never read it. The
 * per-point `reached` flag it needs was already on the data.
 *
 * ⛔ Only the months the ledger has NOT reached are discounted. A month inside
 * the records that holds nothing really is a measured zero and still says so —
 * the same line `emptyPeriodCopy`'s `measured` branch draws.
 */
export function emptyTrendCopy(
  points: readonly { reached: boolean }[],
  /** what the page calls this figure — "Spent", "Received", "Net" */
  flowNoun = "activity",
): string {
  const unreached = points.filter((p) => !p.reached).length;
  const covered = points.length - unreached;
  if (unreached === 0) return `No ${flowNoun} in the last ${monthsWord(points.length)}.`;
  if (covered === 0) {
    return `None of the last ${monthsWord(points.length)} has been imported yet — there is nothing here to measure.`;
  }
  return (
    `No ${flowNoun} in the ${monthsWord(covered)} the ledger covers. ` +
    `The newest ${monthsWord(unreached)} ${unreached === 1 ? "has" : "have"} not been imported, ` +
    `so ${unreached === 1 ? "it is" : "they are"} a window nobody has looked at rather than an empty one.`
  );
}

function monthsWord(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`;
}
