import { compareDates } from "./dates";
import type { SettlementPortion } from "./payday-settlement";
import { ratePeriodOf, rateOn, type RateSchedule } from "./series-kind";

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
  /**
   * Set when the row's DAY held money out too — a payroll partly returned the same day: the figure is the day's NET
   * read per payday, and this many rows of money out were netted into it. Absent for a day of deposits alone.
   */
  returns?: number;
}

export interface PaydayReading {
  /**
   * Set when the row's money paid TWO OR MORE paydays on its own — a lump, held
   * to the expectation at `cents` a payday — or when its day held other deposits
   * and the day's money paid any payday on its own. Null for a row read as the
   * one amount it is. ⚖️ …or money out netted into the day's figure (`returns`,
   * decision 75): the day is read at its net.
   */
  perPayday: PerPayday | null;
  /**
   * False for a row whose money only went into paydays other deposits' money
   * also paid: a PART of a payday's pay. One week sent as two transfers a day
   * apart — $500.00 on Fri Sep 25 and $641.92 on Sat Sep 26, paying Sep 17
   * together — and as samples of what a payday pays they measure how his payer
   * split a transfer, not his pay. Such a row is still held to the expectation as
   * the amount it is; it is only left out of the spread.
   *
   * False, too, for every deposit of a day read per payday but its first: the
   * day is one sample, and one row carries it — and for a row whose day's money
   * paid no payday at all (`towardNoPayday`).
   *
   * ⛔ False for money out: it is no deposit, and paid no payday. 🔴 A sample, a -$50.00 clawback linked to his pay
   * was a residual of -$1,191.92 in the calendar's spread — a band that read a $1,200.00 week `paid` — and a payroll
   * returned the same day a "-$1,141.92" deposit of the posted average, $380.64 beside two weeks at $1,141.92 (review
   * of 6c59cdb, hypothetical: no money out is linked to his pay, a copy of his ledger 2026-10-12).
   */
  isPaydaySample: boolean;
  /**
   * What the row is held to: the rate (`rateOn`) of the first payday its day's money paid — money out, its own day's.
   * ⚖️ Each payday is measured against its OWN time's rate (owner decision 2026-10-08, §6A 55), and settlement keeps
   * a deposit's money inside one rate era (55a), so every payday a day's money paid has this one rate. 🔴 Held to the
   * rate NOW, his cash week of Jun 4 — $1,047.00, exactly what a cash week paid — read $94.92 short of $1,141.92.
   *
   * ⛔ Null for money that paid NO payday (`towardNoPayday`): it answers no week, so no week's rate is what it is held
   * to, and every surface that grades a row reads this one field (`expectedCentsOf`). 🔴 Held to its own day's rate,
   * his Jun 5 $400.00 read "-$647.00" and "expected $1,047.00" on the series page, one tab over from a calendar that
   * drew it ungraded, "paid (toward no payday)" — one rule, two callers, two answers (a copy of his ledger,
   * 2026-10-08). Null, too, when the series has no rate at all.
   *
   * ⛔ And null for MONEY OUT (decision 75, 2026-10-13): it is no payday's pay — back the same day it is netted into
   * its day's figure, which its deposit is held to the week as (`dayPerPayday`); on a day of its own it banked nothing
   * and paid no payday. 🔴 Held to its own day's rate, $500.00 back on Sep 17 read amber and, stored before its
   * deposit, put "It America LLC (weekly pay) fell by $641.92 between its usual amount and Sep 17." on the dashboard
   * for a day $500.00 short, beside "vs expected -$641.92" on the series page; a $50.00 clawback "fell by $1,091.92"
   * (review of bbf17cb, hypothetical: no money out is linked to his pay, a copy of his ledger 2026-10-13).
   */
  expectedCents: number | null;
  /**
   * The rate era (`ratePeriodOf`) of the first payday the day's money paid, else of its own day. The posted average
   * reads only the era in force now (`lib/posted-average`): a dated rate change is not a change in what posted
   * (§6A 55).
   */
  ratePeriod: number;
  /**
   * The row's day's money paid NO payday at all — left over after the paydays it could reach (§6A 55b: it reaches
   * its own date plus the tolerance and no further), or landed before the first payday the ledger draws. The
   * calendar says so, "toward no payday", and does not grade it: it answers no week, so it is no price of one.
   * 🔴 Before the reach bound June's $400.00 rode forward to pay Aug 27; read without this, the row it stays on would
   * stand graded against a week it never paid.
   */
  towardNoPayday: boolean;
}

/**
 * ⚖️ A DEPOSIT WHOSE MONEY PAID NO PAYDAY SAYS SO (`PaydayReading.towardNoPayday`, §6A 55b): its money pays nothing
 * past its own date plus the tolerance, so what is left of it after the paydays it reached answers no week — and is
 * graded against none. One phrase for the calendar's cell and Day Sheet, the series page's history and /spending's
 * shortfall note, so no two can word the same row two ways. 🔴 Before the reach bound June's $400.00 read "paid
 * (toward the payday of Aug 27, 2026)"; after it, the series page still graded the row "-$647.00" beside the
 * calendar's "toward no payday". Here, in `lib`, since a /spending note needs it too (`components` re-exports it).
 */
export const TOWARD_NO_PAYDAY = "toward no payday";

/** The rows a reading is taken of: a series' postings. */
export interface ReadableRow {
  id: string;
  postedOn: string;
  amountCents: number;
  /**
   * Linked to the pay but no row of its pay days (`payDayRows`, services/analytics; flagged by `asPayRows`): his
   * SPENDING — an unfiled debit, or a row filed under a spending category (orchestrator's default 2026-10-14, his call
   * open) — or money on a day no row of it is filed as his pay, a credit left unfiled or filed as a transfer. ⚖️
   * Settlement never reads it, so no reading nets it into its day's money or takes it for a deposit: it is drawn as
   * the money it is, held to no week, and a credit of it paid no payday. Absent, the row is its pay day's.
   */
  offPayDay?: boolean;
}

/** Whether a row is its pay day's — every row but the ones settlement never read (`ReadableRow.offPayDay`). */
export const onPayDay = (r: Pick<ReadableRow, "offPayDay">): boolean => r.offPayDay !== true;

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
 *
 * ⚖️ THE DAY'S NET, money out too (his decision 75, 2026-10-13): settlement spends a day's rows by their net
 * (`daysThatBanked`), so a day's money is what it divides — from ONE payday up when money out was netted into it, as a
 * deposit of that net alone would read. $1,141.92 in and $500.00 back the same day is one payday at $641.92; a lump of
 * $4,567.68 with $500.00 back paid three paydays and is $4,067.68 ÷ 3. 🔴 The gross was divided by the paydays the net
 * paid: that lump read $1,522.56 a payday — "rose by $380.64" — and the week $1,141.92, a payday paid in full beside
 * Earned vs banked's $641.92 (review of b0219f5, hypothetical: no money out is linked to his pay).
 */
function dayPerPayday(
  deposits: readonly ReadableRow[],
  returns: readonly ReadableRow[],
  paydays: number,
): PerPayday | null {
  const dayCents = [...deposits, ...returns].reduce((sum, d) => sum + d.amountCents, 0);
  if (deposits.length === 1 && returns.length === 0) {
    return paydays > 1 ? { paydays, cents: amountPerPayday(dayCents, paydays) } : null;
  }
  if (paydays === 0) return null;
  return {
    paydays,
    cents: amountPerPayday(dayCents, paydays),
    ...(deposits.length > 1 ? { deposits: deposits.length } : {}),
    ...(returns.length > 0 ? { returns: returns.length } : {}),
  };
}

/** Per deposit day, the first (oldest) payday its money went into. */
function firstPaydayByDeposit(portions: readonly SettlementPortion[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const p of portions) {
    const first = out.get(p.depositOn);
    if (first === undefined || compareDates(p.paydayOn, first) < 0) out.set(p.depositOn, p.paydayOn);
  }
  return out;
}

/**
 * Each row's reading, from the series' settlement (`portions`), held to the
 * series' rate at the payday it paid (`schedule`, `rateOn`).
 *
 * Read as the one amount it is: money out (settlement spends a day's net, never a row of money out), no sample of
 * what a payday pays, and a day's deposits whose money paid no payday on its own (`dayPerPayday`) — among them a
 * payroll returned the same day, whose day banked nothing (decision 75): no portion names it, so it reads toward no
 * payday. ⚖️ A day that banked is read by its net (`dayPerPayday`): money out the same day is netted into its
 * deposits' figure, and is itself still drawn as the money out it is — held to no week (`expectedCents`). ⛔ Only its
 * pay days' rows (`onPayDay`): a row linked to the pay off them — his spending, or money on a day no row of it is filed
 * as his pay — is in no day's money, as settlement never read it: a debit of it is drawn as money out, a credit as
 * money toward no payday, each held to no week.
 */
export function paydayReadings(
  rows: readonly ReadableRow[],
  portions: readonly SettlementPortion[],
  schedule: RateSchedule,
): ReadonlyMap<string, PaydayReading> {
  const alone = paydaysPaidAloneByDeposit(portions);
  const firstPayday = firstPaydayByDeposit(portions);
  const depositsByDay = new Map<string, readonly ReadableRow[]>();
  // …and each day's money out, netted into its deposits' figure (decision 75)
  const returnsByDay = new Map<string, readonly ReadableRow[]>();
  for (const r of rows.filter(onPayDay)) {
    const byDay = r.amountCents > 0 ? depositsByDay : returnsByDay;
    byDay.set(r.postedOn, [...(byDay.get(r.postedOn) ?? []), r]);
  }

  const out = new Map<string, PaydayReading>(
    rows
      .filter((r) => r.amountCents <= 0 || !onPayDay(r))
      .map((r) => [
        r.id,
        {
          perPayday: null,
          isPaydaySample: false,
          // no payday's pay, so no week's rate is what it is held to (decision 75) — its era is its own day's
          expectedCents: null,
          ratePeriod: ratePeriodOf(schedule, r.postedOn),
          // money in off its pay days paid no payday — settlement never read it
          towardNoPayday: r.amountCents > 0,
        },
      ]),
  );
  for (const [day, deposits] of depositsByDay) {
    const paydays = alone.get(day) ?? 0;
    const paid = firstPayday.get(day);
    const towardNoPayday = paid === undefined;
    // money that paid no payday is held to no week's rate — it answers none
    const expectedCents = towardNoPayday ? null : rateOn(schedule, paid);
    const ratePeriod = ratePeriodOf(schedule, paid ?? day);
    const perPayday = dayPerPayday(deposits, returnsByDay.get(day) ?? [], paydays);
    if (perPayday === null) {
      // a sample only of a payday it paid on its own — never of a part of one, nor of no payday at all
      const isPaydaySample = paydays === 1;
      for (const d of deposits) {
        out.set(d.id, { perPayday: null, isPaydaySample, expectedCents, ratePeriod, towardNoPayday });
      }
      continue;
    }
    // the day is ONE sample of a payday's pay, as one lump is — counted on each
    // of its deposits, one day would weigh in the spread as several
    deposits.forEach((d, i) =>
      out.set(d.id, { perPayday, isPaydaySample: i === 0, expectedCents, ratePeriod, towardNoPayday }),
    );
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

/**
 * What a row is held to — ONE rule for every surface that grades or draws a row against the series' amount: a pay
 * row's reading (`PaydayReading.expectedCents`, the rate of the payday its money paid, and nothing for money that paid
 * none, nor for money out), else the series' rate on the row's own day (`rateOn`). ⚖️ Each row against its own time's
 * rate (owner decision 2026-10-08, §6A 55). Null means ungraded — the calendar draws it `paid`, the series page grades
 * nothing.
 */
export function expectedCentsOf(
  reading: PaydayReading | undefined,
  schedule: RateSchedule,
  postedOn: string,
): number | null {
  return reading ? reading.expectedCents : rateOn(schedule, postedOn);
}

/**
 * A row's RESIDUAL for the series' spread: its sample (`spreadSampleCents`) less what it is held to — null when it
 * is no sample. With no rate known the residual is the sample itself.
 *
 * ⚖️ The spread is measured on residuals, so a dated rate change (§6A 55) is not variance: at a constant rate the
 * residuals' spread IS the samples' spread, and across a change it is the spread around each era's own rate. 🔴 On
 * raw samples his $1,047.00 cash week and his $1,141.92 payroll weeks would read as $94.92 of wobble — a band wide
 * enough that a $1,200.00 week read `paid`.
 */
export function spreadResidualCents(
  amountCents: number,
  reading: PaydayReading | undefined,
  expectedCents: number | null,
): number | null {
  const sample = spreadSampleCents(amountCents, reading);
  return sample === null ? null : sample - (expectedCents ?? 0);
}
