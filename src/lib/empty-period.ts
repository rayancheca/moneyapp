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
  /**
   * the day the ledger is imported through — its newest active row or newest
   * non-investment statement end (`ledgerReaches`), or null when empty
   */
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

/** the kinds of window whose zero is not a measurement */
export type UnreachedKind = Exclude<EmptyPeriodKind, "measured" | "partly-covered">;

/**
 * Whether a window's figures can be read at all — null when they are a
 * measurement, or which world it sits in when they are not: it has not
 * happened, it is before the records begin, or nothing has been imported for it.
 * A window the ledger opens or stops INSIDE has been looked at, and is a figure.
 *
 * 🔴 TWO SURFACES ZERO-FILLED A CALENDAR WINDOW AND ASKED AT MOST ONE END.
 * Measured on the owner's ledger 2026-09-14 (first active row 2022-08-25, newest
 * 2026-09-12):
 *
 *   - the heatmap on `/spending?period=2022-08` read "Aug 1: nothing spent or
 *     earned" … "Aug 24: nothing spent or earned", while on `?period=2026-09`
 *     the same component said "Sep 13: not imported yet";
 *   - the cash-flow table printed $0.00 under Earned, Spent and Net for those 24
 *     days, for Sep 13–30, 2026, and for Oct–Dec on `?period=2026`, and asked
 *     neither end.
 *
 * `emptyPeriodReason` already sorted a window into these worlds, with one caller.
 *
 * ⛔ The future is asked FIRST. `emptyPeriodReason` answers "no-ledger" before
 * it looks at the calendar, so forwarding its kind would call a day that has not
 * happened "not imported yet" on an empty ledger — the precedence the heatmap's
 * label already pinned.
 */
export function unreachedKind(input: EmptyPeriodInput): UnreachedKind | null {
  if (compareDates(input.from, input.today) > 0) return "future";
  const { kind } = emptyPeriodReason(input);
  return kind === "measured" || kind === "partly-covered" ? null : kind;
}

/**
 * What a single cell or point says in place of a figure it cannot give — the
 * words the heatmap's cells have used since 2026-09-10, now one map for every
 * surface that labels an unreached window.
 */
export const UNREACHED_PHRASE: Readonly<Record<UnreachedKind, string>> = {
  future: "has not happened yet",
  "before-records": "before your records begin",
  "after-records": "not imported yet",
  "no-ledger": "not imported yet",
};

/**
 * Each world as the predicate of a sentence about the windows in it — "a day
 * that IS before your records begin", "3 months ARE" — in calendar order.
 *
 * ⛔ One table for the table's dash note and the trend's absence line, so the
 * two cannot sort the worlds differently or name one of them in other words.
 */
const UNREACHED_PREDICATES: readonly { kinds: readonly UnreachedKind[]; one: string; many: string }[] = [
  { kinds: ["before-records"], one: "is before your records begin", many: "are before your records begin" },
  { kinds: ["after-records", "no-ledger"], one: "has not been imported yet", many: "have not been imported yet" },
  { kinds: ["future"], one: "has not happened yet", many: "have not happened yet" },
];

/** "a", "a or b", "a, b, or c" */
function listOf(items: readonly string[], conjunction: "and" | "or"): string {
  return items.length === 1
    ? items[0]!
    : `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * The line a table prints about its dashes — naming only the worlds its dashes
 * are actually in. Null when nothing is dashed.
 *
 * ⛔ "—", never "$0.00", is the mark: the prior-period column beside these
 * cells already uses it for a bucket the prior period does not have, and the
 * dashboard's pace tile for a month nobody has imported ("an em dash, not a
 * $0.00"). A dash with no sentence would read as a rendering gap, so the table
 * says why (owner decision 2026-09-14, E1a).
 */
export function unreachedDashNote(kinds: Iterable<UnreachedKind>, bucketNoun: "day" | "month"): string | null {
  const present = new Set(kinds);
  const phrases = UNREACHED_PREDICATES.filter(({ kinds: ks }) => ks.some((k) => present.has(k))).map(({ one }) => one);
  if (phrases.length === 0) return null;
  return `A dash is not a zero: it marks a ${bucketNoun} that ${listOf(phrases, "or")}.`;
}

/**
 * How many ELAPSED days of a window lie past the day the ledger is imported
 * through (`ledgerReaches`: its newest row or non-investment statement end) —
 * the days a pace figure has not seen, and the reason it is a lower bound.
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
 *
 * ⚠️ `/budgets` is the third caller and hands it a different frontier: the day
 * every account a budget's category is spent from has been imported through
 * (`services/budgets`), not the whole ledger's. The clamp is shared; the
 * population is the caller's. Fed the ledger-wide day, Fees would read 2 days
 * where its account leaves 15 (measured 2026-09-15).
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
    /**
     * the window holds money the agent's own account paid or was paid — none of his spending or income (owner
     * decisions 2026-09-28, 2026-10-02, 2026-10-05) — so a measured zero says it was left out (`agentsMoneyRowCount`)
     */
    agentsMoney?: boolean;
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
    /*
     * 🔴 S32(b) — "IMPORTED THROUGH", NOT "THE LEDGER STOPS ON". Once a
     * statement's end counts as imported (`ledgerReaches`), the day named here
     * can be a statement close with no row posted on it: Venture X closes Sep
     * 13, 2026 and the newest row is Sep 12, so "the ledger stops on Sun, Sep 13"
     * would name a day on which nothing stopped. "imported through" is what the
     * frontier measures, and it is MoversCard's word for the same day ("Venture
     * X imported through Sep 13"). Owner's decision, 2026-09-14.
     */
    case "after-records":
      return {
        title: `${label} has not been imported yet`,
        description:
          `Nothing has been imported for ${days(reason.uncoveredDays)} of it${through ? `; the ledger is imported through ${through}` : ""}. ` +
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
        // the frontier's own word — see `after-records` above
        ...(reason.uncoveredDays - beforeDays > 0 && through ? [`the ledger is imported through ${through}`] : []),
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
       *
       * 🔴 S22: both now say "spending or income", because "earned" named every
       * positive income-kind row — financial aid included — while /summary's
       * "Earned" does not. The two readers moved together, on purpose.
       *
       * ⚖️ …AND THE BUCKET IS HIS. Money leaving the agent's own account unfiled
       * is in no bucket of his (owner decision 2026-10-05), and what the agent's
       * account pays or is paid in any category is none of his spending or income
       * (2026-10-02, 2026-09-28) — so a period holding only the agent's money
       * lands here. 🔴 It said "Uncategorized outflows would show up above" over
       * the agent's unfiled ACH withdrawal, which shows up nowhere on the page.
       * The bucket is named as his own, and the agent's money is said to be left
       * out where the window holds some.
       */
      return {
        title: "No spending or income in this period",
        description:
          "This window sits inside what has been imported, so it holds no spending and no income — a measured zero rather than an unread window. Transfers, card payments and investment flows are not counted here and can still have posted; the ledger lists them. Accounts imported less far than the ledger as a whole could also be holding rows here; /imports says which." +
          (opts.uncategorizedBucket
            ? " Your own uncategorized outflows would show up above, as their own explicit bucket."
            : "") +
          (opts.agentsMoney
            ? " The agent's own account paid or was paid money in this period, and none of it is counted here: it is the agent's, not yours."
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
 *
 * 🔴 …AND EACH END IS NAMED BY ITS OWN CAUSE. The months before the ledger
 * opens were discounted and then called "not been imported" — the words for the
 * months past its newest row — because the points carried one boolean for both.
 * Measured on the owner's ledger 2026-09-15 (first row 2022-08-25):
 * `/categories/<Interest>?period=2023-06` read "The other 1 month has not been
 * imported" of July 2022, and `<Income>?period=2021-01` "None of Feb 2020 to
 * Jan 2021 has been imported" over the page's own "January 2021 is before your
 * records begin"; 2,032 (category × month) pages printed this line over a window
 * holding a month before the records begin. The worlds and their words are
 * `UNREACHED_PREDICATES`, the dash note's own table.
 */
export function emptyTrendCopy(
  points: readonly { month: string; unreached: UnreachedKind | null }[],
  /** what the page calls this figure — "Spent", "Received", "Net" */
  flowNoun = "activity",
): string {
  const first = points[0]?.month;
  const last = points[points.length - 1]?.month;
  const window = first === undefined || last === undefined ? "this window" : monthWindowLabel(first, last);
  const unreached = points.filter((p) => p.unreached !== null);
  const covered = points.length - unreached.length;
  const worlds = UNREACHED_PREDICATES.flatMap((w) => {
    const n = unreached.filter((p) => w.kinds.includes(p.unreached!)).length;
    return n === 0 ? [] : [{ ...w, clause: `${monthsWord(n)} ${n === 1 ? w.one : w.many}` }];
  });
  // covered first: an EMPTY run has nothing unreached AND nothing reached, and it
  // is the second fact — no month measured — that the sentence must state
  if (covered === 0) {
    const only = worlds.length === 1 ? worlds[0]! : null;
    if (worlds.length === 0 || only?.kinds.includes("after-records")) {
      return `None of ${window} has been imported — there is nothing here to measure.`;
    }
    // one world names the window in it, as the page's own empty state names a period
    if (only) return `${window} ${only.one} — there is nothing here to measure.`;
    return `None of ${window} can be measured: ${listOf(worlds.map((w) => w.clause), "and")}.`;
  }
  if (unreached.length === 0) return `No ${flowNoun} in ${window}.`;
  const n = unreached.length;
  const rest =
    worlds.length === 1
      ? `The other ${worlds[0]!.clause}`
      : `Of the other ${monthsWord(n)}, ${listOf(worlds.map((w) => w.clause), "and")}`;
  return (
    `No ${flowNoun} in the ${monthsWord(covered)} of ${window} the ledger covers. ` +
    `${rest}, so ${n === 1 ? "it is" : "they are"} a window nobody has looked at rather than an empty one.`
  );
}

function monthsWord(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`;
}
