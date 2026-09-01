import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { carCost, type CarCost } from "@/lib/car-cost";
import { committedOutflows, type CommittedOccurrence, type CommittedOutflows } from "@/lib/committed";
import {
  addCalendarMonths,
  addDays,
  compareDates,
  diffDays,
  monthKey,
  periodBounds,
  todayIso,
} from "@/lib/dates";
import { runway, type Runway } from "@/lib/runway";
import { listAccounts } from "./accounts";
import { loadCategoryIndex, monthlySpending, recurringSeriesIdsForCategory } from "./analytics";
import { incomeExpectation, overdueForSeries } from "./budgets";
import { seriesStaleness, upcomingOccurrences } from "./recurring";

/**
 * The two decision cards of pass 63 — how long the money lasts, and what the
 * car costs — over one committed-outflow book.
 *
 * This module is I/O and composition only. Every figure it publishes is
 * computed by a 100%-covered pure module (`lib/committed`, `lib/runway`,
 * `lib/car-cost`), and every projection date comes from `services/recurring`,
 * which owns cadence, anchor days and `userEndsOn`. Nothing here re-derives a
 * date or an average that something else already decides.
 */

/** How far ahead the committed book looks. A year covers every cadence once. */
export const COMMITTED_HORIZON_MONTHS = 12;

/**
 * How many COMPLETE calendar months the spend baseline averages.
 *
 * Six, and the current month is excluded rather than prorated. A partial month
 * dragged into the mean understates the rate by however much of the month is
 * left — measured 2026-08-24, August alone reads $6,683.25 against a $8,025.92
 * six-month mean, and including it would publish a runway a fifth too long.
 */
export const SPEND_BASELINE_MONTHS = 6;

/** The term the car's upfront money buys: the lease, 2026-09-11 → 2028-08-11. */
const CAR_LEASE_TERM_MONTHS = 24;

export interface SpendBaseline {
  /** mean monthly spend across the complete months in the window */
  monthlyCents: number;
  /** how many complete months the mean divides by */
  months: number;
  /** first and last month key averaged, inclusive */
  fromMonth: string;
  toMonth: string;
}

/**
 * Mean spend over the last complete calendar months.
 *
 * A month inside the window with no spending counts as a zero, not as a missing
 * sample: dividing by "months that had rows" would let a quiet month RAISE the
 * average, which is the opposite of what happened.
 */
export function spendBaseline(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = SPEND_BASELINE_MONTHS,
): SpendBaseline {
  const currentMonth = monthKey(today);
  // one extra month back, because the current (incomplete) one is dropped
  const cells = monthlySpending(db, { months: months + 1, refDate: today });

  const byMonth = new Map<string, number>();
  for (const c of cells) {
    byMonth.set(c.month, (byMonth.get(c.month) ?? 0) + c.spentCents);
  }

  /*
   * The window, and the ONLY thing excluding the incomplete current month: it
   * runs from `currentMonth − months` to `currentMonth − 1`, so the current key
   * is never read out of `byMonth` above.
   *
   * ⚠️ There was a `if (c.month === currentMonth) continue;` filter here that
   * looked like the exclusion and was dead — a mutation that deleted it changed
   * no result. Dead code shaped like a guard is worse than none, because the
   * next edit to this loop trusts it. Anything that shortens this list is what
   * has to keep the current month out.
   */
  const keys: string[] = [];
  for (let i = months; i >= 1; i--) keys.push(monthKey(addCalendarMonths(`${currentMonth}-01`, -i)));

  const totalCents = keys.reduce((sum, k) => sum + (byMonth.get(k) ?? 0), 0);
  return {
    monthlyCents: Math.round(totalCents / months),
    months,
    fromMonth: keys[0] ?? currentMonth,
    toMonth: keys[keys.length - 1] ?? currentMonth,
  };
}

/**
 * The kinds that mean "a recurring payment I owe".
 *
 * 🔴 NOT simply "everything that is not income". `transfer` series move money
 * between accounts the owner already holds — nothing leaves, so committing them
 * to an outflow book counts money that never goes anywhere. Measured on the e2e
 * fixture, the looser filter admitted eight transfer series and published
 * $7,530.90 a month of "committed" spending against a $4,799.17 total — a
 * subset larger than the set it claims to be part of.
 *
 * `other` is excluded for a weaker but sufficient reason: it is the catch-all,
 * it is where a misread transfer lands, and a runway should not lean on a
 * series nobody has said what it is. A genuine bill sitting in `other` is fixed
 * by classifying it, which the recurring UI already does.
 */
export const COMMITTED_KINDS = ["bill", "subscription"] as const;

/** Every live series that represents a payment owed. */
function moneyOutSeriesIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ id: recurringSeries.id, kind: recurringSeries.kind })
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();
  const kinds = new Set<string>(COMMITTED_KINDS);
  return new Set(rows.filter((r) => kinds.has(r.kind)).map((r) => r.id));
}

function toCommitted(o: {
  seriesId: string;
  name: string;
  date: string;
  amountCents: number;
  staleness?: { lastMatchedOn: string | null; isStale: boolean };
}): CommittedOccurrence {
  return {
    seriesId: o.seriesId,
    name: o.name,
    date: o.date,
    amountCents: o.amountCents,
    lastMatchedOn: o.staleness?.lastMatchedOn ?? null,
    isStale: o.staleness?.isStale ?? false,
  };
}

/**
 * Money already agreed to, over the next `months`.
 *
 * Income series are filtered out HERE rather than left to the pure module.
 * `committedOutflows` partitions inflows and reports them, so passing income in
 * would work — but it would make `inflowCents` routinely non-zero and therefore
 * useless as an alarm. Filtered here, a non-zero `inflowCents` means a BILL
 * series projected a credit, which is worth seeing.
 *
 * Overdue is scoped to the current calendar month, matching `/budgets`. Reaching
 * further back would resurrect bills that are far more likely to be import gaps
 * than debts still owed.
 *
 * ## ⛔ The two windows ABUT. They must never overlap, and they used to.
 *
 * 🔴 Measured on the real ledger at today = 2026-09-01, this published
 * **$8,150.02 a month** of committed bills while the forecast card, reading the
 * same series for the same month, said **$3,567.60**. Two surfaces, one
 * question, a 2.3× disagreement — and the dashboard was the loud one.
 *
 * Rent was counted THREE times in a single month, from two independent
 * off-by-ones that only appear when a bill falls on `today`:
 *
 *   1. **The windows overlapped on `today`.** Overdue covers `[monthStart,
 *      today]` and the upcoming projection covered `[today, …]`, so a bill due
 *      exactly today landed in both. `budgets.ts` already had this right —
 *      `budgetTail` opens at `addDays(today, 1)` with the comment "strictly
 *      after today = not yet posted" — and this function simply did not follow
 *      it. Filtering strictly after `today` is correct whichever way the bill
 *      went: unposted it is counted once, as overdue; posted it is PAID and
 *      belongs in neither.
 *
 *   2. **The horizon end was inclusive.** `addCalendarMonths(today, 6)` from
 *      the 1st is the 1st six months later, and projecting through it inclusive
 *      catches a SEVENTH first-of-month. The horizon is now half-open, so
 *      `months` calendar months means exactly that many payments.
 *
 * ⚠️ Neither could fire in the test fixture, and that is the lesson worth
 * keeping: `TODAY` there is the **24th** while every bill is anchored on the
 * 1st or 2nd, so no bill can ever coincide with today and no anchor can ever
 * land on the horizon's last day. Twenty-three green tests, both boundaries
 * unreachable. A fixture that cannot express a condition cannot test it.
 */
export function committedBook(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = COMMITTED_HORIZON_MONTHS,
): CommittedOutflows {
  /*
   * ⛔ THE FORWARD WINDOW OPENS ON `today` AND SPANS EXACTLY `months` CALENDAR
   * MONTHS, AND ARREARS ARE NOT INSIDE IT. This was the fourth phrasing.
   *
   * 🔴 The overdue leg opened at `monthStart` while the horizon was anchored on
   * `today`, so the numerator spanned `[monthStart, today + N months)` — N
   * months PLUS however far into the month it happened to be — against a
   * divisor of N. An overdue monthly bill contributed N+1 payments to an
   * N-month average. Measured on the real ledger, which holds no September rows
   * at all, so nothing changed between these days but the day of the question:
   *
   *     2026-09-01   $3,542.21 a month   (rent: 12 payments, $2,109.00/mo)
   *     2026-09-02   $3,733.14 a month   (rent: 13 payments, $2,284.75/mo)
   *     2026-09-23   $3,809.38 a month
   *     2026-10-01   $3,512.08 a month   ← and it resets
   *
   * A $267.17 sawtooth on the runway card's headline every month, and a rent
   * line publishing $2,284.75 as the monthly burden of a $2,109.00 bill. A
   * monthly series cannot cost more per month than its own bill.
   *
   * ⚠️ ANCHORING THE WINDOW ON THE MONTH START INSTEAD IS THE SAME DEFECT
   * MIRRORED, and it was measured before it was rejected. `[monthStart,
   * monthStart + N)` is a whole number of months, but a bill already paid this
   * month has no occurrence left in it, so on 2026-08-25 the same rent reads
   * ELEVEN payments and $1,933.25 a month. Less than the bill is as false as
   * more than it. Only a window that opens on `today` holds exactly N
   * occurrences of a monthly series whatever day you ask on.
   *
   * That forces the other half: `[today, today + N)` cannot contain a payment
   * that came due before today, so ARREARS ARE NOT IN THE TOTAL. They are
   * counted, reported and left out — the same treatment this module already
   * gives an inflow handed to an outflow roll-up, and for the same reason: a
   * figure that mixes a one-off debt into a monthly rate is arithmetic that
   * defends itself around a number that is false.
   *
   * ⚠️ `carCard` does NOT share any of this. It has no overdue leg, so its
   * window already opened on `today` and already spanned its own denominator;
   * swept day by day across September on the real ledger its all-in figure is
   * constant at $1,325.60. Three surfaces, one rule, and still not one fix.
   */
  const to = addCalendarMonths(today, months);
  // half-open: the horizon's last day is the day BEFORE `to`, so a monthly bill
  // anchored on today's day-of-month is projected `months` times, not months+1
  const horizonEnd = addDays(to, -1);
  const moneyOut = moneyOutSeriesIds(db);

  const occurrences = // +1: `windowDays` counts days and today is the first — see its docstring
    upcomingOccurrences(db, today, diffDays(today, horizonEnd) + 1)
    .filter((o) => moneyOut.has(o.seriesId))
    .map(toCommitted);

  /*
   * Strictly BEFORE today. The forward window owns `today`, so the two abut
   * exactly: no day belongs to both, no day belongs to neither. A bill due
   * today and unposted is not late — it is due — and it is counted once, in
   * the forward leg.
   *
   * ⚠️ `/budgets` splits the same instant the other way round: `budgetOverdue`
   * closes on `today` inclusive and `budgetTail` opens at `today + 1`. That is
   * not a disagreement worth reconciling, because budgets ADDS the two
   * (`expectedTailCents = tail + overdue`) and so cannot see the difference.
   * Here the two are published separately, which is what makes the day matter.
   */
  const monthStart = periodBounds(today, "monthly").start;
  const late = overdueForSeries(db, moneyOut, monthStart, addDays(today, -1));
  const lateRows = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();
  const staleById = new Map(lateRows.map((s) => [s.id, seriesStaleness(s, today)]));

  const overdue: CommittedOccurrence[] = late.series.map((s) => ({
    seriesId: s.id,
    name: s.name,
    date: s.nextDate,
    // `BudgetTailSeries.amountCents` is a positive money-out magnitude; this
    // module's occurrences are net-worth signed, so it flips back to negative.
    amountCents: -s.amountCents,
    lastMatchedOn: staleById.get(s.id)?.lastMatchedOn ?? null,
    isStale: staleById.get(s.id)?.isStale ?? false,
  }));

  return committedOutflows({ from: today, to, months, occurrences, overdue });
}

export interface RunwayCard {
  runway: Runway;
  /** the committed subset of the spend the runway burns */
  committed: CommittedOutflows;
  /** what the spend term is, and over which months */
  spend: SpendBaseline;
  /** how the income term was chosen — `incomeBasis`'s own explanation */
  incomeBasisExplanation: string;
  today: string;
}

export function runwayCard(db: AppDatabase, today: string = todayIso()): RunwayCard {
  let liquidCents = 0;
  let investableCents = 0;
  let cardDebtCents = 0;
  for (const a of listAccounts(db)) {
    const cents = a.balance?.balanceCents ?? 0;
    if (a.type === "checking" || a.type === "savings") liquidCents += cents;
    else if (a.type === "investment") investableCents += cents;
    // a credit balance is stored negative; the runway wants a positive debt
    else if (a.type === "credit") cardDebtCents -= cents;
  }

  const month = periodBounds(today, "monthly");
  const income = incomeExpectation(db, month.start, month.end, today);
  const spend = spendBaseline(db, today);

  return {
    runway: runway({
      liquidCents,
      cardDebtCents,
      investableCents,
      monthlyIncomeCents: income.basis.cents,
      monthlySpendCents: spend.monthlyCents,
    }),
    committed: committedBook(db, today),
    spend,
    incomeBasisExplanation: income.basis.explanation,
    today,
  };
}

export interface CarCard {
  cost: CarCost;
  /** the car's own committed lines, largest first */
  book: CommittedOutflows;
  /** the spend baseline the share is measured against, car spend removed */
  baseline: SpendBaseline;
  today: string;
}

/**
 * What the car costs, all in.
 *
 * Returns null when no Car category exists — a fresh ledger has no car, and a
 * card that renders zeroes is worse than one that does not render.
 */
export function carCard(db: AppDatabase, today: string = todayIso()): CarCard | null {
  const idx = loadCategoryIndex(db);
  const car = [...idx.byId.values()].find((c) => c.parentId === null && c.name === "Car");
  if (!car) return null;

  const carSeries = recurringSeriesIdsForCategory(db, car.id);
  const months = COMMITTED_HORIZON_MONTHS;
  const to = addCalendarMonths(today, months);
  /*
   * ⛔ Half-open, the same as `committedBook` — and this was the SECOND phrasing
   * of one boundary, left behind when the first was fixed.
   *
   * 🔴 Measured on the real ledger: on 2026-09-15, the lease's own anchor day,
   * the twelve-month horizon `[2026-09-15, 2027-09-15]` caught THIRTEEN lease
   * payments and the card published **$10,481.48** where the days either side
   * both say $9,786.44 — a $695.04 spike, exactly one payment, on one day per
   * month per series.
   *
   * ⚠️ Only the horizon half applies here. `committedBook` ALSO has to skip an
   * occurrence dated `today`, because its overdue leg already owns that day;
   * this function has no overdue leg, so a bill due today belongs in its book
   * and skipping it would silently lose a payment.
   */
  const horizonEnd = addDays(to, -1);

  const occurrences = // +1: `windowDays` counts days and today is the first — see its docstring
    upcomingOccurrences(db, today, diffDays(today, horizonEnd) + 1)
    .filter((o) => carSeries.has(o.seriesId))
    .map(toCommitted);
  const book = committedOutflows({ from: today, to, months, occurrences, overdue: [] });

  /*
   * The recurring monthly bill, NOT `book.totalCents / months`. Insurance stops
   * five payments into the twelve-month horizon, so the average ($710.51) and
   * the bill he actually pays in September ($921.38) are different true numbers.
   * Taking the first occurrence of each series is what "what does it cost a
   * month" means.
   */
  /*
   * ⚠️ Taking the FIRST occurrence per series is intent, not arithmetic: a
   * mutation that took the last survived, because `projectOccurrences` copies
   * one `nextExpectedAmountCents` onto every occurrence it emits, so a series'
   * occurrences are all the same size and first and last cannot differ. An
   * equivalent mutant, recorded rather than papered over with a test that would
   * only assert the fixture back to itself. If per-occurrence amounts ever
   * become real, "the next bill" is the answer this wants.
   */
  const firstByCadence = new Map<string, number>();
  for (const o of occurrences) {
    if (!firstByCadence.has(o.seriesId)) firstByCadence.set(o.seriesId, -o.amountCents);
  }
  const committedMonthlyCents = [...firstByCadence.values()].reduce((s, c) => s + c, 0);

  // money already handed over: every posted row in the Car subtree
  const subtree = new Set(idx.subtreeIds(car.id));
  const upfrontCents = monthlySpending(db, { months: 24, refDate: today })
    .filter((c) => c.categoryId !== null && subtree.has(c.categoryId))
    .reduce((s, c) => s + c.spentCents, 0);

  /*
   * The share's denominator must not already contain the car, or the car would
   * be counted twice in its own percentage. Measured 2026-08-24 the six complete
   * baseline months (Feb–Jul) predate every car row, so this subtracts zero —
   * but it will stop being zero in March, and a figure that silently becomes
   * wrong later is the kind this codebase keeps finding.
   */
  const baseline = spendBaseline(db, today);
  const baselineCarCents = monthlySpending(db, { months: SPEND_BASELINE_MONTHS + 1, refDate: today })
    .filter((c) => c.month !== monthKey(today))
    .filter((c) => c.month >= baseline.fromMonth)
    .filter((c) => c.categoryId !== null && subtree.has(c.categoryId))
    .reduce((s, c) => s + c.spentCents, 0);
  const baselineMonthlySpendCents =
    baseline.monthlyCents - Math.round(baselineCarCents / SPEND_BASELINE_MONTHS);

  /*
   * The first date a car commitment runs out — the six-month insurance policy,
   * not the lease. Past it the monthly figure above stops being what he pays,
   * and a renewal is not in the ledger to replace it.
   */
  const ends = db
    .select({ id: recurringSeries.id, endsOn: recurringSeries.userEndsOn })
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all()
    .filter((r) => carSeries.has(r.id) && r.endsOn !== null)
    .map((r) => r.endsOn as string)
    .sort();

  return {
    cost: carCost({
      months,
      committedCents: book.totalCents,
      committedMonthlyCents,
      upfrontCents,
      upfrontAmortisedOverMonths: CAR_LEASE_TERM_MONTHS,
      baselineMonthlySpendCents,
      evidencedThrough: ends[0] ?? null,
    }),
    book,
    baseline: { ...baseline, monthlyCents: baselineMonthlySpendCents },
    today,
  };
}
