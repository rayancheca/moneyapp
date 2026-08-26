import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { carCost, type CarCost } from "@/lib/car-cost";
import { committedOutflows, type CommittedOccurrence, type CommittedOutflows } from "@/lib/committed";
import { addCalendarMonths, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
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
 */
export function committedBook(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = COMMITTED_HORIZON_MONTHS,
): CommittedOutflows {
  const to = addCalendarMonths(today, months);
  const moneyOut = moneyOutSeriesIds(db);

  const occurrences = upcomingOccurrences(db, today, diffDays(today, to))
    .filter((o) => moneyOut.has(o.seriesId))
    .map(toCommitted);

  const monthStart = periodBounds(today, "monthly").start;
  const late = overdueForSeries(db, moneyOut, monthStart, today);
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

  const occurrences = upcomingOccurrences(db, today, diffDays(today, to))
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
