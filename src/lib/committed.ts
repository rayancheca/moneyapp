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
}

export interface CommittedInput {
  /** iso, inclusive — the first day of the horizon */
  from: string;
  /** iso, inclusive — the last day of the horizon */
  to: string;
  /** whole calendar months spanned by [from, to]; the per-month denominator */
  months: number;
  /** projected payments inside the horizon */
  occurrences: readonly CommittedOccurrence[];
  /** payments that came due before `from` and never posted */
  overdue: readonly CommittedOccurrence[];
}

export interface CommittedLine {
  seriesId: string;
  name: string;
  /** payments in the horizon, overdue ones included */
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
  /** the part of `totalCents` that is already late */
  overdueCents: number;
  /** the series' evidence is stale or absent */
  isStale: boolean;
  /** nothing has ever posted against this series */
  neverPosted: boolean;
}

export interface CommittedOutflows {
  from: string;
  to: string;
  months: number;
  /** positive magnitude of all committed money out */
  totalCents: number;
  /** `totalCents ÷ months` */
  perMonthCents: number;
  /** the part of `totalCents` that is already late */
  overdueCents: number;
  /** committed money whose series has never posted — registered, not evidenced */
  unevidencedCents: number;
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
}

export function committedOutflows(input: CommittedInput): CommittedOutflows {
  const { months } = input;
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`committedOutflows: months must be a positive integer, got ${months}`);
  }

  const bySeries = new Map<string, Accumulator>();
  let inflowCents = 0;
  let inflowCount = 0;

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
    const acc = bySeries.get(o.seriesId) ?? {
      seriesId: o.seriesId,
      name: o.name,
      occurrences: 0,
      totalCents: 0,
      overdueCents: 0,
      isStale: o.isStale,
      neverPosted: o.lastMatchedOn === null,
    };
    bySeries.set(o.seriesId, {
      ...acc,
      occurrences: acc.occurrences + 1,
      totalCents: acc.totalCents + magnitude,
      overdueCents: acc.overdueCents + (origin === "overdue" ? magnitude : 0),
    });
  };

  for (const o of input.overdue) take(o, "overdue");
  for (const o of input.occurrences) take(o, "upcoming");

  const lines: CommittedLine[] = [...bySeries.values()]
    .map((a) => ({
      seriesId: a.seriesId,
      name: a.name,
      occurrences: a.occurrences,
      totalCents: a.totalCents,
      perMonthCents: Math.round(a.totalCents / months),
      overdueCents: a.overdueCents,
      isStale: a.isStale,
      neverPosted: a.neverPosted,
    }))
    .sort((x, y) => y.totalCents - x.totalCents || x.name.localeCompare(y.name));

  const totalCents = lines.reduce((s, l) => s + l.totalCents, 0);

  return {
    from: input.from,
    to: input.to,
    months,
    totalCents,
    perMonthCents: Math.round(totalCents / months),
    overdueCents: lines.reduce((s, l) => s + l.overdueCents, 0),
    unevidencedCents: lines.reduce((s, l) => s + (l.neverPosted ? l.totalCents : 0), 0),
    lines,
    inflowCents,
    inflowCount,
  };
}
