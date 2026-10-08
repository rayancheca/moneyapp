import type { SettlementPortion } from "./payday-settlement";

/**
 * A PAY DEPOSIT, READ PER PAYDAY — the one reading every surface that says
 * "the amount changed" takes of a pay series' rows: the recurring calendar's
 * `paid_different` (which the dashboard's "Worth a look" card reads), the spread
 * that state is measured against, and the series page's amount history.
 *
 * ⚖️ A pay row is a price change only when what it paid PER PAYDAY differs from
 * the week he expects. Settle backwards (his decision of 2026-09-28) spends one
 * deposit on as many paydays as its money covers, and the calendar chips each
 * of them to it — so a lump is one deposit for N weeks, and N weeks is what it
 * is measured against.
 *
 * 🔴 Measured against ONE payday, his 2026-09-23 lump of $4,567.68 — exactly
 * four weeks at $1,141.92, spent by settlement on Sep 24, 17, 10 and 3 — was
 * drawn amber, the dashboard read it back as "It America LLC (weekly pay) rose
 * by $3,425.76 between its usual amount and Sep 23.", and the series page
 * printed "vs expected +$3,425.76", beside an Earned-vs-banked card counting
 * four paydays.
 *
 * 🔴 And the SPREAD has to be read the same way. His series has no cached
 * spread, so one is measured from its rows; measured on raw amounts the lump
 * was a sample of its own, σ $1,629.39, and inside that ±$3,258.78 band a
 * $1,200.00 raise, a $4,000.00 partial lump and four weeks at $1,200.00 all
 * read `paid`.
 *
 * ⛔ THE UNIT IS THE DAY. Settlement names money by its deposit's day, so two
 * deposits on one day are the one deposit it sees, and are read as that.
 * 🔴 Read row by row, a lump landing beside the week's own deposit put every
 * sentence above back: $4,567.68 held to one week beside a day settlement says
 * paid five.
 */

/** A lump's reading: the paydays its money paid on its own, and what it paid each. */
export interface PerPayday {
  paydays: number;
  cents: number;
  /**
   * Set when the row's DAY held more than one deposit: the figure is that day's
   * money read per payday, and this many deposits made it up. Absent for a
   * deposit alone on its day.
   */
  deposits?: number;
}

export interface PaydayReading {
  /**
   * Set when the row's money paid TWO OR MORE paydays on its own — a lump, held
   * to the expectation at `cents` a payday — or when its day held other deposits
   * and the day's money paid any payday on its own. Null for a row read as the
   * one amount it is.
   */
  perPayday: PerPayday | null;
  /**
   * False for a row whose money only went into paydays other deposits' money
   * also paid: a PART of a payday's pay. June's $1,047.00 and $400.00 paid his
   * Aug 27 together, and as samples of what a payday pays they measure how his
   * payer split a transfer, not his pay. Such a row is still held to the
   * expectation as the amount it is; it is only left out of the spread.
   *
   * False, too, for every deposit of a day read per payday but its first: the
   * day is one sample, and one row carries it.
   */
  isPaydaySample: boolean;
}

/** The rows a reading is taken of: a series' postings. */
export interface ReadableRow {
  id: string;
  postedOn: string;
  amountCents: number;
}

const AS_ITSELF: PaydayReading = { perPayday: null, isPaydaySample: true };

/**
 * What a deposit paid PER PAYDAY, given how many paydays its money paid on its
 * own. The WHOLE amount is divided, so money that paid no week of its own —
 * left over (`lib/payday-settlement` never pre-pays with it), or spent topping
 * up a payday another deposit paid — counts against the deposit: a lump that is
 * not a whole number of weeks ($4,000.00 pays three, $1,333.33 a payday) still
 * reads changed. With one payday or none, this is the amount itself.
 */
export function amountPerPayday(amountCents: number, paydaysPaid: number): number {
  return paydaysPaid > 1 ? Math.round(amountCents / paydaysPaid) : amountCents;
}

/**
 * Per deposit day: how many paydays that day's money paid ON ITS OWN — every
 * cent settlement put into them came from it.
 *
 * ⛔ ON ITS OWN, not "touched". Settlement pools change across deposits, so a
 * deposit's money can also top up a payday another deposit mostly paid: a
 * $1,150.00 week whose $7.68 of change later finished an older payday touched
 * two paydays, and divided by two it would read as half a week. It paid one.
 */
export function paydaysPaidAloneByDeposit(portions: readonly SettlementPortion[]): ReadonlyMap<string, number> {
  const payersByPayday = new Map<string, ReadonlySet<string>>();
  for (const p of portions) {
    payersByPayday.set(p.paydayOn, new Set([...(payersByPayday.get(p.paydayOn) ?? []), p.depositOn]));
  }
  const out = new Map<string, number>();
  for (const payers of payersByPayday.values()) {
    if (payers.size !== 1) continue;
    for (const depositOn of payers) out.set(depositOn, (out.get(depositOn) ?? 0) + 1);
  }
  return out;
}

/**
 * What one deposit DAY paid per payday — null when its deposits are each read as
 * the amount they are.
 *
 * ⛔ A DAY, not a row: settlement names money by its deposit's day, so a day's
 * deposits are the ONE deposit it walked, and their own spending cannot be told
 * apart. Their money is read together — $4,567.68 and $1,141.92 on Sep 24 that
 * paid five paydays on their own are five at $1,141.92, not a raise and a week —
 * and, as for a lump, the WHOLE of it is divided (`amountPerPayday`).
 *
 * Alone on its day a deposit is unchanged: per payday from two paydays up, the
 * amount it is below that. With others, the day's money is the figure from ONE
 * payday up — one week sent as two transfers is that payday's pay, not two short
 * weeks — and with none of its own, each deposit is the amount it is.
 */
function dayPerPayday(deposits: readonly ReadableRow[], paydays: number): PerPayday | null {
  const dayCents = deposits.reduce((sum, d) => sum + d.amountCents, 0);
  if (deposits.length === 1) return paydays > 1 ? { paydays, cents: amountPerPayday(dayCents, paydays) } : null;
  return paydays > 0 ? { paydays, cents: amountPerPayday(dayCents, paydays), deposits: deposits.length } : null;
}

/**
 * Each row's reading, from the series' settlement (`portions`).
 *
 * Read as the one amount it is: money out (settlement reads deposits only), and
 * a day's deposits whose money paid no payday on its own (`dayPerPayday`).
 */
export function paydayReadings(
  rows: readonly ReadableRow[],
  portions: readonly SettlementPortion[],
): ReadonlyMap<string, PaydayReading> {
  const alone = paydaysPaidAloneByDeposit(portions);
  const spentFrom = new Set(portions.map((p) => p.depositOn));
  const depositsByDay = new Map<string, readonly ReadableRow[]>();
  for (const r of rows) {
    if (r.amountCents > 0) depositsByDay.set(r.postedOn, [...(depositsByDay.get(r.postedOn) ?? []), r]);
  }

  const out = new Map<string, PaydayReading>(rows.filter((r) => r.amountCents <= 0).map((r) => [r.id, AS_ITSELF]));
  for (const [day, deposits] of depositsByDay) {
    const paydays = alone.get(day) ?? 0;
    const perPayday = dayPerPayday(deposits, paydays);
    if (perPayday === null) {
      const isPaydaySample = paydays === 1 || !spentFrom.has(day);
      for (const d of deposits) out.set(d.id, { perPayday: null, isPaydaySample });
      continue;
    }
    // the day is ONE sample of a payday's pay, as one lump is — counted on each
    // of its deposits, one day would weigh in the spread as several
    deposits.forEach((d, i) => out.set(d.id, { perPayday, isPaydaySample: i === 0 }));
  }
  return out;
}

/** The figure a row is held to the expectation as — per payday for a lump, else its amount. */
export function comparableCents(amountCents: number, reading: PaydayReading | undefined): number {
  return reading?.perPayday?.cents ?? amountCents;
}

/** A row's sample for the series' spread, read as it is held to the expectation — or null for part of a payday's pay. */
export function spreadSampleCents(amountCents: number, reading: PaydayReading | undefined): number | null {
  return reading?.isPaydaySample === false ? null : comparableCents(amountCents, reading);
}
