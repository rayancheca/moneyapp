import type { RatePeriod, SeriesKind } from "@/db/schema/recurring";
import { compareDates, isValidIsoDate } from "./dates";

/**
 * Whether a recurring series' money is his income or his spending — every kind's is, by its sign, except a
 * transfer's.
 *
 * ⚖️ A transfer series moves his money between his own accounts. The analytics law is authoritative (a transfer is
 * never income or spending), and counting both legs would double-book cash that never leaves the household. So no
 * NET counts one: not the forecast's lines (`fixedComponents`, `arrearsComponents`), not what a calendar mark adds to
 * its month (`flowEntryOf` — the strip, each day's figure, the footer), not the Upcoming tab's 30-day net, and no
 * series page ranks one among his commitments or his deposits (`recurringInsightInput`). The grid and the list still
 * DRAW it, because it is a real scheduled movement of his money; they just do not add it up.
 *
 * 🔴 This was the forecast's private test, `series.kind === "transfer"`, and the /recurring strip printed directly
 * under the forecast card's net summed every mark the grid draws. A one-legged transfer series — the card autopay
 * out of checking, with no PAYMENT THANK YOU leg imported to cancel it — moved "as scheduled", the calendar's footer
 * and the Upcoming tab's 30-day net by its whole amount while the card above them left it out. A pair on one day
 * hides it: on the e2e ledger after "Detect now", eight transfer series in four such pairs moved no total at all.
 *
 * Client-safe (no database), because `flowEntryOf` runs in the calendar's browser bundle.
 */
export function seriesIsIncomeOrSpending(kind: SeriesKind): boolean {
  return kind !== "transfer";
}

/**
 * What a series schedules per occurrence, net-worth-signed — the owner's amount first, then detection's: the amount
 * every projection of it walks (`effectiveSeries`), and the sign that says whether its money comes in or goes out.
 * Null when neither is known; such a series projects nothing.
 */
export function seriesAmountCents(series: {
  readonly userAmountCents: number | null;
  readonly nextExpectedAmountCents: number | null;
}): number | null {
  return series.userAmountCents ?? series.nextExpectedAmountCents;
}

/**
 * What `rateOn` reads: the rate in force NOW and the dated periods before it — an `EffectiveSeries`, whose
 * `nextExpectedAmountCents` is `seriesAmountCents` already (user first) and whose `amountHistory` is parsed.
 *
 * ⛔ Never a raw series row: its `nextExpectedAmountCents` is detection's alone, and reading it as "now" would skip
 * the owner's own amount — the second spelling of "the amount" this reader exists to end. `userAmountCents` is
 * refused here so a row spread into the shape does not typecheck; read a row through `effectiveSeries`.
 */
export interface RateSchedule {
  /** the rate now — `seriesAmountCents`; null when neither amount is known */
  readonly nextExpectedAmountCents: number | null;
  /** past periods, oldest first (`parseAmountHistory`); null = the rate has never changed */
  readonly amountHistory: readonly RatePeriod[] | null;
  readonly userAmountCents?: never;
}

/**
 * Which rate era a day belongs to — the index of the past period whose rate `rateOn` reads for it, or
 * `amountHistory.length` for the rate in force now. A series with no history has one era, 0. Two days of one era are
 * priced alike; the payday settlement keeps money inside the era it was paid in (§6A 55a).
 */
export function ratePeriodOf(series: Pick<RateSchedule, "amountHistory">, day: string): number {
  const history = series.amountHistory ?? [];
  const era = history.findIndex((period) => compareDates(period.throughOn, day) >= 0);
  return era === -1 ? history.length : era;
}

/** The rate era in force NOW — the one `ratePeriodOf` gives every day past the last dated period. */
export function currentRatePeriod(series: Pick<RateSchedule, "amountHistory">): number {
  return (series.amountHistory ?? []).length;
}

/**
 * What one occurrence of a series is worth on `day`, net-worth-signed: the first past period that runs through it,
 * else the rate in force now. ⚖️ Each payday is measured against its OWN time's rate (owner decision 2026-10-08,
 * §6A 55) — his cash weeks through Aug 26 at $1,047.00, Aug 27 on at $1,141.92. 🔴 With one amount for all time, the
 * $1,141.92 set on Sep 22 re-priced twelve cash weeks he was paid $1,047.00 for, and Earned vs banked
 * said $12,256.04 never reached a bank — $1,139.04 of it pay he was never owed.
 */
export function rateOn(series: RateSchedule, day: string): number | null {
  const era = ratePeriodOf(series, day);
  const history = series.amountHistory ?? [];
  return era < history.length ? history[era]!.amountCents : series.nextExpectedAmountCents;
}

/** A stored rate history the reader refuses, saying what it could not read. */
export class AmountHistoryError extends Error {
  constructor(reason: string) {
    super(`user_amount_history: ${reason}`);
    this.name = "AmountHistoryError";
  }
}

const PERIOD_KEYS = ["amountCents", "throughOn"] as const;

/**
 * The one reader of a stored rate history — the decoded JSON of `user_amount_history` — and a strict one: NULL is no
 * history, and anything it cannot read in exactly one way THROWS (`AmountHistoryError`). The column has no
 * constraint, and a history read as "none" would price every past occurrence at today's rate without a word.
 *
 * It refuses: an empty list (no history is NULL, said one way), anything but a list of `{throughOn, amountCents}`
 * with no other key, a day that is not a real `YYYY-MM-DD`, an amount that is not a whole, non-zero number of cents,
 * periods that do not end strictly later one after another, and — when the rate now is known (`currentCents`) — a
 * past rate whose money went the other way: a history never turns his pay into a bill.
 */
export function parseAmountHistory(raw: unknown, currentCents: number | null): readonly RatePeriod[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new AmountHistoryError(`expected a list of past periods, read ${JSON.stringify(raw)}`);
  }
  if (raw.length === 0) throw new AmountHistoryError("an empty list — a series with no history stores NULL");
  const periods = raw.map((entry: unknown, i): RatePeriod => {
    const where = `period ${i + 1} (${JSON.stringify(entry)})`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AmountHistoryError(`${where} is not {throughOn, amountCents}`);
    }
    if (Object.keys(entry).sort().join() !== PERIOD_KEYS.join()) {
      throw new AmountHistoryError(`${where} must have exactly throughOn and amountCents`);
    }
    const { throughOn, amountCents } = entry as Record<(typeof PERIOD_KEYS)[number], unknown>;
    if (typeof throughOn !== "string" || !isValidIsoDate(throughOn)) {
      throw new AmountHistoryError(`${where}: throughOn is not a real YYYY-MM-DD day`);
    }
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents === 0) {
      throw new AmountHistoryError(`${where}: amountCents is not a whole, non-zero number of cents`);
    }
    if (currentCents !== null && currentCents !== 0 && Math.sign(amountCents) !== Math.sign(currentCents)) {
      throw new AmountHistoryError(
        `${where}: its money went the other way from the series' amount now (${currentCents})`,
      );
    }
    return { throughOn, amountCents };
  });
  periods.forEach((period, i) => {
    const before = periods[i - 1];
    if (before !== undefined && compareDates(before.throughOn, period.throughOn) >= 0) {
      throw new AmountHistoryError(`period ${i + 1} ends ${period.throughOn}, not after ${before.throughOn}`);
    }
  });
  return periods;
}

/**
 * The column's own TEXT, read raw (a script's SQL, `pnpm ledger-check`) — decoded once, then `parseAmountHistory`.
 * Text that is not JSON is refused as a history, never thrown as a syntax error; a list stored twice-encoded decodes
 * to a string and is refused with it.
 */
export function parseAmountHistoryText(text: string | null, currentCents: number | null): readonly RatePeriod[] | null {
  if (text === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new AmountHistoryError(`not JSON: ${text}`);
  }
  return parseAmountHistory(decoded, currentCents);
}
