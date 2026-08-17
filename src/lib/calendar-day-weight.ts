import type { DayStateKind } from "@/services/recurring-calendar";

/**
 * What a day of the recurring calendar should SHOW.
 *
 * The grid used to render one glyph per entry — ✓ ! • ✕ — and nothing else. That
 * grammar is complete about state and silent about money, so a month of rent,
 * insurance and a $4.99 subscription drew as four identical ticks. The one
 * question the page exists to answer, "when does the big money leave?", could
 * not be read off it at all.
 *
 * So each day now carries four things:
 *
 *   `netCents`      the day's signed total — the number, not a symbol for it
 *   `weight`        0..1, its magnitude against the heaviest day in the month,
 *                   so the month reads as a RHYTHM: rent day is visibly heavy
 *                   and a subscription is a hairline
 *   `state`         the most urgent state present, which keeps the existing
 *                   colour/glyph grammar for colour-blind and screen-reader users
 *   `dominantName`  the series that OWNS the day, so a heavy cell can say which
 *                   bill it is without being opened
 *
 * `weight` is deliberately relative to the month, not to an absolute scale: a
 * quiet month should still show its own shape rather than flatlining because
 * some other month had rent in it.
 */

/**
 * A day total in the width of a calendar cell: "125", "-1.8k", "30k", "0".
 *
 * Cents are dropped on purpose — this is a magnitude for scanning, and the Day
 * Sheet behind the cell carries every exact figure.
 *
 * ⚠️ The WIDTH is the contract, not just the rounding. A 320px cell fits about
 * five characters, and the first version of this always used one decimal in the
 * thousands — so the e2e fixture's widest value, `-1.8k`, fit, while the real
 * ledger's largest amount ($29,800) would have rendered `-29.8k` and overflowed
 * the cell on the owner's own data. The fixture would never have shown it.
 *
 * So the decimal is spent only where it buys something: below $10k, where `1.8k`
 * and `1.2k` are genuinely different bills. Above that the magnitude alone is
 * the information. Every result below $1M is at most 4 characters plus a sign.
 *
 * The tier boundaries are the ROUNDED values (999.5, 9.95), not the raw ones —
 * otherwise $9,989 rounds up into "10.0k" and quietly costs a sixth character.
 */
export function compactDayTotal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  if (dollars < 999.5) return `${sign}${Math.round(dollars)}`;
  const k = dollars / 1000;
  if (k < 9.95) return `${sign}${k.toFixed(1)}k`;
  if (k < 999.5) return `${sign}${Math.round(k)}k`;
  return `${sign}${(k / 1000).toFixed(1)}M`;
}

/** Missed first (needs attention), then drift, then upcoming, then paid. */
const STATE_URGENCY: Record<DayStateKind, number> = {
  missed: 0,
  paid_different: 1,
  upcoming: 2,
  paid: 3,
};

export interface DayWeight {
  netCents: number;
  /** magnitude relative to the heaviest day in the month, 0..1 */
  weight: number;
  state: DayStateKind;
  count: number;
  /** the name of the largest-magnitude entry on the day */
  dominantName: string;
}

export interface WeighableEntry {
  amountCents: number;
  state: DayStateKind;
  name: string;
}

/**
 * The heaviest single day in the month, by absolute net.
 *
 * Absolute, and computed from the NET rather than from the largest single
 * entry: a day on which rent leaves and a paycheque lands is a quiet day for
 * this purpose, and drawing it as the month's heaviest would be a lie about
 * where the money went. Zero when the month is empty — callers divide by it, so
 * `dayWeight` guards rather than trusting it.
 */
export function heaviestDayCents(entriesByDay: Readonly<Record<string, readonly WeighableEntry[]>>): number {
  let max = 0;
  for (const entries of Object.values(entriesByDay)) {
    const net = Math.abs(entries.reduce((n, e) => n + e.amountCents, 0));
    if (net > max) max = net;
  }
  return max;
}

/**
 * A day with activity always shows SOMETHING. Small, because the square-root
 * scale below already lifts the low end — the floor now only has to catch a day
 * that nets to exactly zero (rent out, rent refunded in), where something really
 * happened but the magnitude is genuinely nil.
 */
export const MIN_VISIBLE_WEIGHT = 0.04;

/**
 * Magnitude → bar length, as a SQUARE ROOT of the linear share.
 *
 * The first version of this was linear with a 0.08 floor, and on real data that
 * made the bar say something false. Against the fixture's $3,200 heaviest day,
 * a $125 meal kit (3.9%), a $49 gym (1.5%) and a $15.99 Netflix (0.5%) all
 * landed under the floor and drew the IDENTICAL hairline — three different
 * amounts rendered as one. A scale whose bottom half is a single value is not a
 * scale; it is the tick grammar this module was written to replace.
 *
 * √ trades exact proportionality for separation at the bottom, which is the
 * honest trade here for one reason: the bar is not the quantitative channel.
 * Every cell prints its own signed total beside it, so the bar only has to
 * answer "is this a heavy day?" while the number answers "how much?". A linear
 * bar answers the second question a little better and the first one much worse,
 * because on a month containing rent every ordinary bill is a sub-pixel sliver.
 */
function barWeight(netCents: number, heaviestCents: number): number {
  if (heaviestCents <= 0) return MIN_VISIBLE_WEIGHT;
  const share = Math.min(1, Math.abs(netCents) / heaviestCents);
  return Math.max(MIN_VISIBLE_WEIGHT, Math.sqrt(share));
}

/**
 * One day's weight. Returns null for a day with no entries — an empty cell must
 * stay empty, not render a zero bar.
 *
 * `dominantName` is the largest-magnitude entry's name, which is what a cell
 * shows when it has room: on a day carrying rent and a $4.99 subscription, the
 * useful word is "Rent". Ties keep the FIRST entry, and the caller
 * (`recurringCalendar`) has already sorted each day by state then name — so the
 * choice is deterministic rather than dependent on row order from the database.
 */
export function dayWeight(
  entries: readonly WeighableEntry[] | undefined,
  heaviestCents: number,
): DayWeight | null {
  if (!entries || entries.length === 0) return null;

  const netCents = entries.reduce((n, e) => n + e.amountCents, 0);
  const state = entries.reduce<DayStateKind>(
    (worst, e) => (STATE_URGENCY[e.state] < STATE_URGENCY[worst] ? e.state : worst),
    "paid",
  );
  const dominant = entries.reduce((big, e) =>
    Math.abs(e.amountCents) > Math.abs(big.amountCents) ? e : big,
  );

  return {
    netCents,
    weight: barWeight(netCents, heaviestCents),
    state,
    count: entries.length,
    dominantName: dominant.name,
  };
}
