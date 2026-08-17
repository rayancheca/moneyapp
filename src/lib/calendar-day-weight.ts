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
 * So each day now carries three things:
 *
 *   `netCents`  the day's signed total — the number, not a symbol for it
 *   `weight`    0..1, its magnitude against the heaviest day in the month, so
 *               the month reads as a RHYTHM: rent day is visibly heavy and a
 *               subscription is a hairline
 *   `state`     the most urgent state present, which keeps the existing
 *               colour/glyph grammar for colour-blind and screen-reader users
 *
 * `weight` is deliberately relative to the month, not to an absolute scale: a
 * quiet month should still show its own shape rather than flatlining because
 * some other month had rent in it.
 */

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
}

export interface WeighableEntry {
  amountCents: number;
  state: DayStateKind;
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
 * One day's weight. Returns null for a day with no entries — an empty cell must
 * stay empty, not render a zero bar.
 *
 * A day whose entries net to exactly zero (rent out, rent refunded in) keeps a
 * MINIMUM visible weight rather than vanishing: something happened there, and a
 * cell that draws nothing is indistinguishable from a day with no activity. The
 * amount it prints is the honest $0.00.
 */
export const MIN_VISIBLE_WEIGHT = 0.08;

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
  const raw = heaviestCents > 0 ? Math.abs(netCents) / heaviestCents : 0;

  return {
    netCents,
    weight: Math.max(MIN_VISIBLE_WEIGHT, Math.min(1, raw)),
    state,
    count: entries.length,
  };
}
