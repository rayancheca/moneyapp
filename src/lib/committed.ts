/**
 * The committed book: money the owner has already agreed to pay.
 *
 * Pure roll-up over occurrences the recurring engine has already projected —
 * this module decides nothing about WHICH series are live, when they step, or
 * whether their evidence has lapsed. `services/recurring` owns all of that and
 * has the anchor-day and `userEndsOn` arithmetic to prove it; duplicating any
 * of it here would create two places that must agree about a date, which is the
 * defect pass 54 was written to stop.
 *
 * What this module owns is the ARITHMETIC OF THE TOTAL, and one rule about it:
 *
 * ⛔ **Money in is never netted against money out.** `upcomingOccurrences`
 * returns income and bills from a single call, so a caller that forgets to
 * filter would hand a $4,188 salary series to a $3,211 rent book and publish a
 * commitment of roughly nothing. That is pass 62's "$0.14 expected income" in a
 * new costume: arithmetic that defends itself and a figure that is false.
 * Inflows are therefore PARTITIONED — counted, reported, and left out of the
 * total — rather than netted (silent) or thrown (a crash in a render path,
 * which pass 62 also shipped). `attribution.ts` sets the precedent: a
 * disagreement is disclosed, never clamped away.
 */

import type { Cadence } from "@/db/schema/recurring";
import { addCalendarMonths, compareDates, daysInMonthOf, monthKey, withDayOfMonth } from "@/lib/dates";
import { monthWindowLabel } from "@/lib/format-date";
import { levelledMonthlyCents } from "@/lib/income-basis";
import { formatCents } from "@/lib/money";

/** Where a committed payment came from — already late, or still to come. */
export const COMMITTED_ORIGIN_LABEL = {
  overdue: "already late",
  upcoming: "scheduled",
} as const;

export type CommittedOrigin = keyof typeof COMMITTED_ORIGIN_LABEL;

/**
 * One projected (or overdue) payment. Structurally a subset of
 * `SeriesOccurrence` + `SeriesStaleness` from `services/recurring`, restated so
 * `lib` keeps not importing from `services` — the idiom `section-notes` and
 * `budget-verdict` already follow.
 */
export interface CommittedOccurrence {
  seriesId: string;
  name: string;
  /** iso date */
  date: string;
  /** net-worth signed: NEGATIVE is money out, as everywhere else in the app */
  amountCents: number;
  /** newest matched charge, or null when nothing has ever matched the series */
  lastMatchedOn: string | null;
  /** the series' evidence is older than its own tolerance, or absent entirely */
  isStale: boolean;
  /**
   * The series' own cadence — what a FULL horizon would have billed. Carried
   * rather than inferred from the occurrence count, because the two differ for
   * exactly the series this exists to describe: one that STOPS inside the
   * horizon bills fewer times than its cadence says, and inferring the cadence
   * from the count would make every such series look like it runs throughout.
   */
  cadence: Cadence;
  /** the day the series stops, or null when it runs on past this horizon */
  endsOn: string | null;
}

export interface CommittedInput {
  /** iso, inclusive — the first day of the horizon */
  from: string;
  /** iso, EXCLUSIVE — the horizon is `[from, to)`, exactly `months` months */
  to: string;
  /** whole calendar months spanned by [from, to); the per-month denominator */
  months: number;
  /** projected payments inside the horizon */
  occurrences: readonly CommittedOccurrence[];
  /** payments that came due before `from` and never posted — ARREARS, outside it */
  overdue: readonly CommittedOccurrence[];
}

export interface CommittedLine {
  seriesId: string;
  name: string;
  /** payments inside the horizon; arrears are not among them */
  occurrences: number;
  /** positive magnitude of money out across the whole horizon */
  totalCents: number;
  /**
   * `totalCents ÷ months`, NOT `totalCents ÷ occurrences`.
   *
   * The two differ for exactly the series worth getting right: car insurance
   * pays five times across a six-month horizon because it ends inside it, and
   * dividing by its own occurrence count would republish $361.49 as the monthly
   * burden of a commitment that costs $301.24 a month over the window actually
   * being asked about. The horizon is the question; the occurrence count is an
   * answer, and it is reported separately so the reader can see both.
   */
  perMonthCents: number;
  /** arrears on this series — money that came due before the horizon opened and
   *  never posted. ⛔ NOT part of `totalCents`; see `CommittedOutflows`. */
  overdueCents: number;
  /** the series' evidence is stale or absent */
  isStale: boolean;
  /** nothing has ever posted against this series */
  neverPosted: boolean;
  /** the series' cadence, so a reader can check the two figures below */
  cadence: Cadence;
  /** the day the series stops, or null */
  endsOn: string | null;
  /**
   * The series stops BEFORE the horizon closes, so it is billed across only
   * part of the window the rate is divided over.
   *
   * ⛔ This is the CAUSE, and every claim about a shrunken rate is gated on it
   * rather than on an arithmetic comparison. `levelledMonthlyCents` rounds, so
   * a full-horizon annual line can miss its own rate by a cent — and a
   * threshold on that difference would be a magic number standing where a fact
   * belongs.
   */
  endsInHorizon: boolean;
  /** what ONE payment costs, as a positive magnitude */
  perOccurrenceCents: number;
  /**
   * What this line would contribute per month if it ran the WHOLE horizon —
   * its cadence annualised, which is the basis the subscriptions card publishes.
   * Equal to `perMonthCents` (to rounding) for every line that does run it.
   */
  levelledPerMonthCents: number;
  /**
   * How much LOWER this line's contribution to the rate is than its own bill
   * levels to. Zero unless `endsInHorizon` — see the note there.
   */
  shortfallPerMonthCents: number;
}

export interface CommittedOutflows {
  from: string;
  to: string;
  months: number;
  /** positive magnitude of all committed money out INSIDE the horizon */
  totalCents: number;
  /** `totalCents ÷ months` */
  perMonthCents: number;
  /**
   * Arrears: money that came due before the horizon opened and never posted.
   *
   * ⛔ NOT part of `totalCents`, and this is the whole point of the split. The
   * horizon is `[from, to)` — exactly `months` calendar months — so a monthly
   * series contributes exactly `months` payments to it whatever day it is
   * asked on. A debt that came due BEFORE `from` is not inside those months,
   * and adding it to the numerator while leaving `months` as the denominator
   * is how a $2,109.00 rent came to publish $2,284.75 as its monthly cost.
   *
   * Counted, reported, left out — the treatment `inflowCents` already gets,
   * for the same reason. A caller that wants "everything I still owe" adds the
   * two; a caller that wants a RATE uses `perMonthCents` and says the arrears
   * separately, which is what the runway card does.
   */
  overdueCents: number;
  /** how many arrears payments `overdueCents` is made of */
  overdueCount: number;
  /**
   * Committed money INSIDE THE HORIZON whose series has never posted —
   * registered, not evidenced.
   *
   * ⚠️ Sums `lines[].totalCents`, so it narrowed when arrears left that figure:
   * a never-posted series' arrears are no longer part of it. That is consistent
   * — the horizon is what this describes — and it is stated because the change
   * happened underneath this field rather than to it.
   */
  unevidencedCents: number;
  /**
   * How much the ending series lower `perMonthCents` between them.
   *
   * 🔴 THIS IS THE $210.87 BETWEEN TWO CARDS ON HIS DASHBOARD. The runway card
   * publishes a RATE over the horizon; the subscriptions card LEVELS each bill
   * to a month. Both are right, and on 2026-09-02 the whole difference was one
   * series — car insurance, evidenced through 2027-01-11 with no renewal in the
   * ledger, billed five times out of twelve. He asked this card to say so, so
   * the figure is computed here rather than left for a reader to subtract.
   */
  shortfallPerMonthCents: number;
  /** largest commitment first */
  lines: CommittedLine[];
  /**
   * Money IN that was passed to a committed-OUTFLOW roll-up. Always a caller
   * bug; reported rather than netted or thrown. Non-zero here means some read
   * path is feeding income into a bills figure.
   */
  inflowCents: number;
  inflowCount: number;
}

interface Accumulator {
  seriesId: string;
  name: string;
  occurrences: number;
  totalCents: number;
  overdueCents: number;
  isStale: boolean;
  neverPosted: boolean;
  cadence: Cadence;
  endsOn: string | null;
}

/**
 * Does a commitment STOP inside a horizon that closes at `toExclusive`?
 *
 * ⛔ `to` is EXCLUSIVE, so a series ending ON it runs the whole horizon.
 *
 * ⚠️ TWO SURFACES ASK THIS AND MUST NOT ANSWER DIFFERENTLY. This book gates
 * `shortfallPerMonthCents` and `shrinkCaption` on it; `/recurring/<id>` gates
 * the caveat under its ANNUALIZED figure on it (`annualizedCaveat`). That
 * caveat hand-rolled `endsOn !== null` — the mere EXISTENCE of an end date —
 * and so told the owner his `Car lease`, which ends 2028-08-15 and bills the
 * next twelve months in full for $8,340.48, that it was "scheduled only to
 * 2028-08-15".
 */
export function endsInsideHorizon(endsOn: string | null, toExclusive: string): boolean {
  return endsOn !== null && compareDates(endsOn, toExclusive) < 0;
}

export function committedOutflows(input: CommittedInput): CommittedOutflows {
  const { months } = input;
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`committedOutflows: months must be a positive integer, got ${months}`);
  }

  const bySeries = new Map<string, Accumulator>();
  let inflowCents = 0;
  let inflowCount = 0;
  let overdueCount = 0;

  const take = (o: CommittedOccurrence, origin: CommittedOrigin): void => {
    if (o.amountCents > 0) {
      inflowCents += o.amountCents;
      inflowCount += 1;
      return;
    }
    // A zero-amount occurrence moves no money and earns no row. It is neither
    // an outflow nor an inflow, and giving it a line would print a commitment
    // of $0.00 — the shape pass 62 drew as a 77.97px bar labelled "$0.00".
    if (o.amountCents === 0) return;

    const magnitude = -o.amountCents;
    const isArrears = origin === "overdue";
    if (isArrears) overdueCount += 1;
    const acc = bySeries.get(o.seriesId) ?? {
      seriesId: o.seriesId,
      name: o.name,
      occurrences: 0,
      totalCents: 0,
      overdueCents: 0,
      isStale: o.isStale,
      neverPosted: o.lastMatchedOn === null,
      cadence: o.cadence,
      endsOn: o.endsOn,
    };
    bySeries.set(o.seriesId, {
      ...acc,
      // ⛔ arrears fall OUTSIDE the horizon, so they raise neither the count
      // nor the total the per-month figure is divided from
      occurrences: acc.occurrences + (isArrears ? 0 : 1),
      totalCents: acc.totalCents + (isArrears ? 0 : magnitude),
      overdueCents: acc.overdueCents + (isArrears ? magnitude : 0),
    });
  };

  for (const o of input.overdue) take(o, "overdue");
  for (const o of input.occurrences) take(o, "upcoming");

  const lines: CommittedLine[] = [...bySeries.values()]
    .map((a) => {
      const perMonthCents = Math.round(a.totalCents / months);
      /*
       * ⛔ `totalCents / occurrences`, NOT the series' stored amount: this line
       * is built from the occurrences that landed inside the horizon, and the
       * two agree only when nothing else does. An arrears-only line has no
       * occurrences at all, so it is guarded rather than divided by zero.
       */
      const perOccurrenceCents = a.occurrences === 0 ? 0 : Math.round(a.totalCents / a.occurrences);
      const levelledPerMonthCents = levelledMonthlyCents(perOccurrenceCents, a.cadence);
      const endsInHorizon = endsInsideHorizon(a.endsOn, input.to);
      return {
        seriesId: a.seriesId,
        name: a.name,
        occurrences: a.occurrences,
        totalCents: a.totalCents,
        perMonthCents,
        overdueCents: a.overdueCents,
        isStale: a.isStale,
        neverPosted: a.neverPosted,
        cadence: a.cadence,
        endsOn: a.endsOn,
        endsInHorizon,
        perOccurrenceCents,
        levelledPerMonthCents,
        // gated on the CAUSE, and floored: an ending series whose remaining
        // payments happen to over-cover the window is not "short" by a negative
        shortfallPerMonthCents: endsInHorizon
          ? Math.max(0, levelledPerMonthCents - perMonthCents)
          : 0,
      };
    })
    // arrears-only lines have a zero horizon total; they still rank by the money
    // they represent rather than tying at zero in name order
    .sort(
      (x, y) =>
        y.totalCents - x.totalCents || y.overdueCents - x.overdueCents || x.name.localeCompare(y.name),
    );

  const totalCents = lines.reduce((s, l) => s + l.totalCents, 0);

  return {
    from: input.from,
    to: input.to,
    months,
    totalCents,
    perMonthCents: Math.round(totalCents / months),
    overdueCents: lines.reduce((s, l) => s + l.overdueCents, 0),
    overdueCount,
    unevidencedCents: lines.reduce((s, l) => s + (l.neverPosted ? l.totalCents : 0), 0),
    shortfallPerMonthCents: lines.reduce((s, l) => s + l.shortfallPerMonthCents, 0),
    lines,
    inflowCents,
    inflowCount,
  };
}

/**
 * ⭐ WHAT SHRANK THE RATE — the sentence the owner asked for on 2026-09-02.
 *
 * Two cards on his dashboard state the monthly cost of the same thirteen
 * recurring series and differ by $210.87:
 *
 *     RUNWAY         "Committed bills come to $3,542.21 a month"
 *     SUBSCRIPTIONS  "$3,753.08 a month, still forecast"
 *
 * Both are right. The runway card publishes a RATE over its twelve-month
 * horizon, so a series that stops inside it contributes fewer payments; the
 * subscriptions card LEVELS each bill to a month, which is the right basis for
 * a list of what he pays. He chose to have this card name what shrank it.
 *
 * ⛔ IT NAMES ONLY WHAT THIS BOOK CAN PROVE. Every figure comes from the line
 * itself — the series' end day, its payments inside the horizon, its own two
 * per-month figures. It deliberately does NOT quote the other card's total: the
 * two cards choose their series independently (`COMMITTED_KINDS` here), so a
 * sentence asserting a number computed on the other side would be one card
 * speaking for another, and would go quietly false the day the sets diverge.
 *
 * ⛔ AND IT DOES NOT CREDIT ONE SERIES WITH THE WHOLE DIFFERENCE. When more than
 * one ends inside the horizon, the named one carries only its own shortfall and
 * the rest are counted out loud.
 *
 * Null when nothing ends — silence, never "nothing shrank it", which is the
 * measured-zero rule the rest of this file follows.
 */
export function shrinkCaption(book: {
  lines: readonly CommittedLine[];
  shortfallPerMonthCents: number;
}): string | null {
  const ending = book.lines
    .filter((l) => l.endsInHorizon && l.shortfallPerMonthCents > 0)
    .sort((a, b) => b.shortfallPerMonthCents - a.shortfallPerMonthCents);
  const lead = ending[0];
  if (lead === undefined || lead.endsOn === null) return null;

  const others = ending.length - 1;
  const rest =
    others === 0 ? "" : others === 1 ? ", and one other does too" : `, and ${others} others do too`;
  const times = lead.occurrences === 1 ? "once" : `${lead.occurrences} times`;

  return (
    `${lead.name} stops inside that window — evidenced through ${lead.endsOn}, with no renewal ` +
    `in the ledger${rest} — so it is billed ${times} rather than throughout, and counts ` +
    `${formatCents(lead.perMonthCents)} a month here against the ${formatCents(lead.perOccurrenceCents)} ` +
    `it charges. The rate above is ${formatCents(book.shortfallPerMonthCents)} a month lower for it.`
  );
}

/**
 * What to CALL the trailing window a spending average was taken over.
 *
 * ⛔ ZERO MONTHS IS NOT A RANGE. `baselineWindow` floors the window at the
 * first month the ledger covers in full and falls back to the CURRENT month
 * for its labels when there is no such month — so the obvious sentence reads
 * "0 complete months, 2022-09 to 2022-09. This month is still running and is
 * not counted", naming as the range it averaged the one month it says it did
 * not count. A caption is a claim like any other figure on the card.
 *
 * Pure, and here rather than inside the card, because the branch a pinned e2e
 * clock can never render is exactly the one worth a test — the same reason
 * `pace-geometry` lives in `lib`.
 */
export function baselineCaption(window: { months: number; fromMonth: string; toMonth: string }): string {
  if (window.months < 1) {
    return "No complete month has been imported yet, so there is no spending average to stand on.";
  }
  const span = monthWindowLabel(window.fromMonth, window.toMonth);
  return `Spending averaged over ${window.months} complete month${
    window.months === 1 ? "" : "s"
  }, ${span}. This month is still running and is not counted.`;
}

/**
 * A window of exactly `months` CALENDAR MONTHS opening on `from`.
 *
 * 🔴 IT CANNOT BE EXPRESSED AS A PAIR OF DATES, and that is the whole reason
 * this type exists. `addCalendarMonths("2026-08-29", 6)` is `2027-02-28`,
 * because 29 February 2027 does not exist — so a half-open `[from, to)` is a
 * day short of six whole months, and a bill anchored on the 28th loses its
 * sixth payment while the rate still divides by six. Five payments over a
 * six-month divisor: the same shape as every other defect in this file.
 *
 * ⛔ AND THE OBVIOUS FIX IS THE SAME DEFECT MIRRORED — measured, not guessed.
 * The recurring engine clamps too, so the series anchored on the 28th, 29th,
 * 30th AND 31st all project onto 2027-02-28. Making that day inclusive fixes
 * the 28th and hands the 29th and 30th a SEVENTH payment. No date cut can
 * separate four anchors that share a date.
 *
 * So membership is decided in MONTH SPACE, against the day the series is really
 * billed on rather than the day the calendar could fit:
 *
 *   - any month strictly before `endMonth` is inside;
 *   - inside `endMonth`, an occurrence is in iff its ANCHOR day-of-month is
 *     before `endDay` — the day-of-month the window opened on.
 *
 * That is exactly the date comparison whenever nothing clamps (the occurrence's
 * own day IS its anchor day), and it is the only thing that separates the four
 * when something does.
 */
export interface MonthHorizon {
  /** inclusive first day */
  from: string;
  /** whole calendar months spanned; the per-month denominator */
  months: number;
  /** "YYYY-MM" — the last month any occurrence can fall in */
  endMonth: string;
  /** the day-of-month the window opened on, and so ends BEFORE */
  endDay: number;
  /**
   * The last day occurrences must be PROJECTED to, so none inside the window is
   * missed. Always the end of `endMonth`: a clamped occurrence can land after
   * the nominal end and still be inside.
   */
  projectThrough: string;
  /**
   * `addCalendarMonths(from, months)`, kept for reporting only.
   * ⚠️ NOT the membership test — see the class docstring. It is what a reader
   * means by "six months from today" and it is what `CommittedOutflows.to`
   * publishes, but a day inside `endMonth` after it may still be in the window.
   */
  nominalEnd: string;
}

export function monthHorizon(from: string, months: number): MonthHorizon {
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`monthHorizon: months must be a positive integer, got ${months}`);
  }
  const nominalEnd = addCalendarMonths(from, months);
  const endMonth = monthKey(nominalEnd);
  return {
    from,
    months,
    endMonth,
    endDay: Number(from.slice(8, 10)),
    projectThrough: withDayOfMonth(`${endMonth}-01`, daysInMonthOf(`${endMonth}-01`)),
    nominalEnd,
  };
}

/**
 * Is one occurrence inside the horizon?
 *
 * `anchorDayOfMonth` is the day the series is really billed on — null for a
 * day-stepped cadence (weekly, biweekly), which never clamps, so the
 * occurrence's own day is the truth and the test degrades to the plain date
 * comparison.
 */
export function withinMonthHorizon(
  h: MonthHorizon,
  day: string,
  anchorDayOfMonth: number | null,
): boolean {
  if (day < h.from) return false;
  const month = monthKey(day);
  if (month < h.endMonth) return true;
  if (month > h.endMonth) return false;
  return (anchorDayOfMonth ?? Number(day.slice(8, 10))) < h.endDay;
}
