import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries, type Cadence } from "@/db/schema/recurring";
import { carCost, carEvidenceCaption, type CarCost } from "@/lib/car-cost";
import {
  committedOutflows,
  heaviestMonth,
  heaviestMonthEnding,
  monthHorizon,
  withinMonthHorizon,
  type CommittedOccurrence,
  type CommittedOutflows,
} from "@/lib/committed";
import {
  addCalendarMonths,
  addDays,
  compareDates,
  diffDays,
  monthKey,
  periodBounds,
  todayIso,
} from "@/lib/dates";
import { resolvePeriod, withPeriod } from "@/lib/period";
import { runway, type Runway } from "@/lib/runway";
import { cashPosition, outsidePortfolioCashAccountIds } from "./accounts";
import {
  isAgentsSeries,
  loadCategoryIndex,
  monthlySpending,
  recurringSeriesIdsForCategory,
  type AnalyticsTxn,
} from "./analytics";
import { arrearsThisMonth, overdueForSeries } from "./arrears";
import { withBillingCarriers } from "./billing-carriers";
import { incomeExpectation, type BudgetTail } from "./budgets";
import { CAR_LEASE_TERM_MONTHS, isUpfrontCarRow, readUpfrontCarRule, upfrontCarRule } from "./car-upfront";
import { frontierForSeries, ledgerOpens, seriesAccountIds, silenceObservedThrough } from "./observation-frontier";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { seriesStaleness, upcomingOccurrences } from "./recurring";
import { seriesIdsNotDrawnAsRecurring } from "./recurring-link";

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


export interface SpendBaseline {
  /** mean monthly spend across the complete months in the window, the car's up-front money left out */
  monthlyCents: number;
  /**
   * The car's up-front money inside the window (`isUpfrontCarRow`), left OUT of `monthlyCents` — owner decision
   * 2026-10-07 (§6A 51): the car card spreads it over the lease, so averaged in it is counted twice, as a month's
   * spending. A caption that calls `monthlyCents` an average names it (`baselineCaption`); 0 when there is none.
   */
  upfrontCarCents: number;
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
export interface BaselineWindow {
  /** complete months the window actually spans — never more than asked for */
  months: number;
  /** 'YYYY-MM' keys, oldest first; empty when the ledger holds no whole month */
  keys: string[];
  /** first day of the first month, for a range query */
  from: string;
  /** last day of the last month */
  to: string;
  fromMonth: string;
  toMonth: string;
}

/**
 * The trailing window EVERY card shares: the last `months` COMPLETE calendar
 * months, floored at the first month the ledger covers in full.
 *
 * ⛔ ONE WINDOW, ONE PLACE. Five services import `SPEND_BASELINE_MONTHS`
 * precisely so they cannot quote different windows for one ledger — and a
 * constant is not enough on its own, because the floor is data-dependent. When
 * `spendBaseline` learned to shrink and the cards did not, a young ledger could
 * put "3 complete months" and "6 complete months" in two captions on one
 * dashboard.
 *
 * 🔴 The floor exists because a month BEFORE the ledger began is not a
 * measurement at all: at today = 2022-11-01 on the owner's ledger (which opens
 * 2022-08-25), $1,961.04 of spending sat in three of six month keys and
 * published $326.84 a month — half the $653.68 those three come to, and the
 * runway divides net cash by that rate.
 *
 * ⛔ And the ledger's OPENING MONTH is only a month if the ledger opened on its
 * FIRST day. A seven-day stub averaged in as a whole month is the same defect
 * one step smaller: at 2022-10-01 it published $519.61 over "2 complete months"
 * where the one month covered in full spent $992.78.
 *
 * ⚠️ A month with no spending INSIDE the window is still a real zero — that is
 * why this counts whole months rather than months-that-had-rows. Only months
 * the ledger cannot speak for are dropped.
 */
export function baselineWindow(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = SPEND_BASELINE_MONTHS,
): BaselineWindow {
  const currentMonth = monthKey(today);
  // the window runs from `currentMonth − months` to `currentMonth − 1`, so the
  // incomplete current month is never in it
  const asked: string[] = [];
  for (let i = months; i >= 1; i--) asked.push(monthKey(addCalendarMonths(`${currentMonth}-01`, -i)));

  const opens = ledgerOpens(db);
  const firstWholeMonth =
    opens === null
      ? null
      : periodBounds(opens, "monthly").start === opens
        ? monthKey(opens)
        : monthKey(addCalendarMonths(`${monthKey(opens)}-01`, 1));
  const keys = firstWholeMonth === null ? [] : asked.filter((k) => k >= firstWholeMonth);

  const fromMonth = keys[0] ?? currentMonth;
  const toMonth = keys[keys.length - 1] ?? currentMonth;
  return {
    months: keys.length,
    keys,
    from: `${fromMonth}-01`,
    to: periodBounds(`${toMonth}-01`, "monthly").end,
    fromMonth,
    toMonth,
  };
}

/**
 * Mean spend over the last complete calendar months.
 *
 * The window is `baselineWindow`'s — shared with every card that quotes one, so
 * two captions on one dashboard cannot name different months.
 */
export function spendBaseline(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = SPEND_BASELINE_MONTHS,
): SpendBaseline {
  /*
   * ⚖️ Owner decision 2026-10-07 (§6A 51): the car's up-front money is not a month's spending. 🔴 Averaged in, his
   * $6,100 down payment and deposit (August) read as $1,016.67 a month of "What you spend a month" over Apr–Sep —
   * $9,259.32 where the rest comes to $8,242.65 — and shortened the runway, beside a car card that already spreads the
   * same money over the lease. One predicate, the card's own: `isUpfrontCarRow`.
   */
  const upfront = readUpfrontCarRule(db);
  const sumByMonth = (keep: (t: AnalyticsTxn) => boolean): Map<string, number> => {
    const byMonth = new Map<string, number>();
    for (const c of monthlySpending(db, { months: months + 1, refDate: today, filter: keep })) {
      byMonth.set(c.month, (byMonth.get(c.month) ?? 0) + c.spentCents);
    }
    return byMonth;
  };
  const spent = sumByMonth((t) => !isUpfrontCarRow(upfront, t));
  const handedOver = upfront === null ? new Map<string, number>() : sumByMonth((t) => isUpfrontCarRow(upfront, t));

  const w = baselineWindow(db, today, months);
  const inWindow = (byMonth: ReadonlyMap<string, number>): number =>
    w.keys.reduce((sum, k) => sum + (byMonth.get(k) ?? 0), 0);
  const totalCents = inWindow(spent);
  return {
    // no complete month inside the ledger means no measured rate; the total is
    // necessarily zero there, so this divides by one rather than by nothing
    monthlyCents: Math.round(totalCents / Math.max(1, w.months)),
    upfrontCarCents: inWindow(handedOver),
    months: w.months,
    fromMonth: w.fromMonth,
    toMonth: w.toMonth,
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

/**
 * Every live series that represents a payment HE owes — none on the agent's cash, which pays its own (`isAgentsSeries`,
 * owner decision 2026-10-02): its forward occurrences already leave through `upcomingOccurrences`, and this is the set
 * its overdue leg reads.
 */
function moneyOutSeriesIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ id: recurringSeries.id, kind: recurringSeries.kind, accountId: recurringSeries.accountId })
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();
  const kinds = new Set<string>(COMMITTED_KINDS);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  return new Set(rows.filter((r) => kinds.has(r.kind) && !isAgentsSeries(agentsCash, r)).map((r) => r.id));
}

/** Every live series' own end day, by id — `userEndsOn`, the only one there is. */
function endsOnBySeries(db: AppDatabase): Map<string, string | null> {
  return new Map(
    db
      .select({ id: recurringSeries.id, endsOn: recurringSeries.userEndsOn })
      .from(recurringSeries)
      .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
      .all()
      .map((r) => [r.id, r.endsOn ?? null] as const),
  );
}

/**
 * ⚠️ `endsOn` is `userEndsOn` and nothing else, because that is the only end day
 * the ledger holds — `projectOccurrences` clamps its own walk on exactly this
 * column (`recurring.ts`), so a line that says it stops inside the horizon and
 * the occurrences that stop there are reading one fact, not two that agree.
 */
function toCommitted(
  o: {
    seriesId: string;
    name: string;
    date: string;
    amountCents: number;
    cadence: Cadence;
    staleness?: { lastMatchedOn: string | null; isStale: boolean };
  },
  endsOn: string | null,
): CommittedOccurrence {
  return {
    seriesId: o.seriesId,
    name: o.name,
    date: o.date,
    amountCents: o.amountCents,
    lastMatchedOn: o.staleness?.lastMatchedOn ?? null,
    isStale: o.staleness?.isStale ?? false,
    cadence: o.cadence,
    endsOn,
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
  /*
   * ⛔ THE WINDOW IS A `MonthHorizon`, NOT A PAIR OF DATES — see its docstring
   * in `lib/committed`. A half-open `[today, addCalendarMonths(today, months))`
   * is a day SHORT of `months` whole months whenever the end month is too short
   * to hold today's day-of-month, and a bill anchored just below it loses its
   * last payment while the rate still divides by `months`. Measured over every
   * (anchor day, asking day) pair in a 62-day span: six pairs were five
   * payments over a six-month divisor. Occurrences are therefore projected
   * through the whole end month and admitted by MONTH SLOT.
   */
  const horizon = monthHorizon(today, months);
  const to = horizon.nominalEnd;
  const moneyOut = moneyOutSeriesIds(db);
  const endsById = endsOnBySeries(db);

  const occurrences = // +1: `windowDays` counts days and today is the first — see its docstring
    upcomingOccurrences(db, today, diffDays(today, horizon.projectThrough) + 1)
    .filter((o) => moneyOut.has(o.seriesId))
    .filter((o) => withinMonthHorizon(horizon, o.date, o.anchorDayOfMonth))
    .map((o) => toCommitted(o, endsById.get(o.seriesId) ?? null));

  /*
   * Strictly BEFORE today. The forward window owns `today`, so the two abut
   * exactly: no day belongs to both, no day belongs to neither. A bill due
   * today and unposted is not late — it is due — and it is counted once, in
   * the forward leg.
   *
   * 🔴 `/budgets` SPLITS THE SAME INSTANT THE OTHER WAY ROUND, and the first
   * version of this comment was wrong about why that is tolerable. It said
   * budgets "cannot see the difference" because it ADDS the two
   * (`expectedTailCents = tail + overdue`). Its ARITHMETIC cannot; its PROSE
   * can: `budgetSectionNotes` prints "One bill totalling $X came due this
   * period and no import has covered it yet" straight off `overdueCents`. So
   * on the 1st of every month — reproduced on 2026-09-01 and 2026-10-01 — the
   * dashboard reports no arrears while /budgets says $2,291.21 came due, over
   * the same rent, from the same ledger, on the same day.
   *
   * ⛔ AND BOTH ARE RIGHT, for a reason that is not about the calendar. The
   * difference is that `budgetTail` does NOT check postings and
   * `overdueForSeries` does: it drops an occurrence a linked charge already
   * covers. A bill due today may already have posted, in which case
   * `spentCents` holds it — so on `/budgets` it must sit in the leg that can
   * see that, or it is counted twice.
   *
   * This leg has no such hazard. It is a RATE over N whole months, not a list
   * of what is still to pay, so a posted bill still belongs in it and today can
   * safely open the forward window. Moving either edge to match the other would
   * lose a bill on `/budgets` (no leg would own today) or break the rate here.
   *
   * What WAS wrong was the wording: `/budgets` said a bill due today "came due
   * this period", past tense, on the morning it fell due. It now says "due by
   * today", which is true whether it is late or due, and no longer reads as a
   * contradiction of a card that reports no arrears on the same day.
   */
  const late = arrearsThisMonth(db, moneyOut, today);
  const readById = arrearsReadCents(db, late, today);
  // each with the carrier it is billed with — a late line is evidenced by its carrier's postings too (§6A 59)
  const lateRows = withBillingCarriers(
    db,
    db.select().from(recurringSeries).where(inArray(recurringSeries.status, ["detected", "confirmed"])).all(),
  );
  // late only on days the ledger has checked — the forward leg's occurrences carry the same reading
  const checkedThrough = silenceMeasuredThroughBySeries(db, today);
  const staleById = new Map(lateRows.map((s) => [s.id, seriesStaleness(s, today, checkedThrough(s.id))]));

  const overdue: CommittedOccurrence[] = late.series.map((s) => ({
    seriesId: s.id,
    name: s.name,
    date: s.nextDate,
    // `BudgetTailSeries.amountCents` is a positive money-out magnitude; this
    // module's occurrences are net-worth signed, so it flips back to negative.
    amountCents: -s.amountCents,
    lastMatchedOn: staleById.get(s.id)?.lastMatchedOn ?? null,
    isStale: staleById.get(s.id)?.isStale ?? false,
    // `BudgetTailSeries.cadence` is the occurrence's own, from the same
    // projection walk the forward leg reads
    cadence: s.cadence as Cadence,
    endsOn: endsById.get(s.id) ?? null,
    unreadCents: s.amountCents - (readById.get(s.id) ?? 0),
  }));

  return committedOutflows({ from: today, to, months, occurrences, overdue });
}

/**
 * Of each late series' arrears, the money that fell due on days the ledger has
 * read for the accounts the series bills on — the part the runway card may
 * call "never posted" (`arrearsSentence`).
 *
 * 🔴 It said "never posted" of all $2,296.20 on 2026-10-07 while October was
 * imported for none of those accounts. ⛔ NO NEW RULE: "has the ledger read this
 * bill's day" is the recurring calendar's — `frontierForSeries` over
 * `silenceObservedThrough` and `seriesAccountIds`, the input `settledVerdict`
 * grades `missed` against `not_imported` with — and "is this payment late" is
 * still `overdueForSeries`, asked again only up to that day. A series with no
 * account the ledger knows reads nothing: the calendar's `null`, and the
 * cautious answer.
 *
 * ⛔ NOT pay's "where it lands now" (`landingAccountsBySeries`, 2026-10-07). "Never posted" is a NEGATIVE claim, so
 * every account a bill has paid from must be read past its day — the calendar's rule, which grades `missed` against
 * `not_imported` with the same accounts (`seriesAccountIds`: the named account AND the history; Netflix names Sapphire
 * and has billed Discover). Fewer accounts here would let the card say "never posted" of a day /recurring calls not
 * imported. Measured on a copy of his ledger 2026-10-08: rent names no account, so pay's rule reads the same three
 * (Venture X, Chase Checking, Wells Fargo) to the same Aug 12; it posts from Wells Fargo now, read only through
 * Sep 24, so its Oct 1 payment is unread under either rule and "no import has covered it yet" is true.
 *
 * ⚖️ …and an account no statement will come for — archived, or a cash wallet — is read through today, the calendar's
 * frontier for the same reason (`silenceObservedThrough`): its bills' silence is measured there (2026-10-08). 🔴 Read
 * to an archived card's last import (review of e00e6b8), Venture X's Breezeline was "running late" on /recurring and
 * its Nov 8 still "no import has covered it yet" here, at 2026-11-20 — an import /imports never asks for.
 */
function arrearsReadCents(db: AppDatabase, late: BudgetTail, today: string): ReadonlyMap<string, number> {
  const read = new Map<string, number>();
  if (late.series.length === 0) return read;
  // `arrearsThisMonth`'s window, walked again below only as far as each series has been read
  const monthStart = periodBounds(today, "monthly").start;
  const yesterday = addDays(today, -1);

  const frontier = silenceObservedThrough(db, today);
  const accountsBySeries = seriesAccountIds(db);
  // series read only part-way through the arrears window, grouped by the day they are read to
  const partly = new Map<string, Set<string>>();
  for (const s of late.series) {
    const through = frontierForSeries(frontier, accountsBySeries.get(s.id));
    if (through === null || compareDates(through, s.nextDate) < 0) continue;
    if (compareDates(through, yesterday) >= 0) {
      read.set(s.id, s.amountCents);
      continue;
    }
    partly.set(through, new Set([...(partly.get(through) ?? []), s.id]));
  }
  const lateById = new Map(late.series.map((s) => [s.id, s.amountCents] as const));
  for (const [through, ids] of partly) {
    for (const s of overdueForSeries(db, ids, monthStart, through, today).series) {
      read.set(s.id, Math.min(s.amountCents, lateById.get(s.id) ?? 0));
    }
  }
  return read;
}

export interface RunwayCard {
  runway: Runway;
  /** the committed subset of the spend the runway burns */
  committed: CommittedOutflows;
  /** what the spend term is, and over which months */
  spend: SpendBaseline;
  /**
   * `/spending` over the months `spend` averaged — the card's header link and
   * the "What you spend a month" row.
   *
   * 🔴 Both were a bare `/spending`, which `resolvePeriod` resolves to the
   * RUNNING month, the one month `spendBaseline` leaves out. Measured on the
   * owner's ledger 2026-09-15: the spend term averaged Mar 2026 to Aug 2026, and
   * both links opened September 2026, where the page refuses any comparison
   * ("There is no comparison for September 2026 yet: …").
   */
  spendingHref: string;
  /** how the income term was chosen — `incomeBasis`'s own explanation */
  incomeBasisExplanation: string;
  today: string;
}

export function runwayCard(db: AppDatabase, today: string = todayIso()): RunwayCard {
  /*
   * 🔴 ARCHIVED ACCOUNTS WERE STILL SPENDING. `/accounts/<x>` promises by name
   * that "Archiving takes {name} out of net worth, the assets and owed totals,
   * and every analytic" — and `latestBridgedNetWorthCents`, `coverage`,
   * `cards-owed`, `account-insights`, `cash-wallets` and both of `forecast`'s
   * EOM-cash walks all filter for it. `attribution`'s docstring records the
   * same omission being caught in review once. This card walked `listAccounts`
   * unfiltered, so an archived balance kept funding "Cash you can spend today",
   * the runway measured from it, and what selling investments would add.
   *
   * ⚠️ Latent on the real ledger, which has archived nothing: the promise goes
   * false the day the button is used, not before.
   *
   * ⚖️ AND BROKERAGE CASH WAS SPENDING. Every checking and savings account read
   * as "Cash you can spend today", so Robinhood Cash ($0.90) and Robinhood
   * Agentic ($26.64) — typed `checking` so balance replay can run them — funded
   * the headline. The owner's decision of 2026-09-15 moves them into what
   * selling investments would add. `cashPosition` holds that rule and the active
   * filter above, and the forecast's month-end cash reads the same one.
   */
  const cash = cashPosition(db);

  const month = periodBounds(today, "monthly");
  const income = incomeExpectation(db, month.start, month.end, today);
  const spend = spendBaseline(db, today);

  return {
    runway: runway({
      liquidCents: cash.spendableCents,
      cardDebtCents: cash.cardDebtCents,
      cardCreditCents: cash.cardCreditCents,
      investableCents: cash.investableCents,
      monthlyIncomeCents: income.basis.cents,
      // ⛔ The figure and the WORD for how it was chosen travel together. Sending
      // the cents alone let the card's body text contradict the tooltip mounted
      // on the same row the first time a lump switched the basis to "banked".
      incomeBasisKind: income.basis.kind,
      monthlySpendCents: spend.monthlyCents,
      // …and what the spend term left out, so a withheld verdict cannot say nothing was spent (§6A 51)
      upfrontCarCents: spend.upfrontCarCents,
    }),
    committed: committedBook(db, today),
    spend,
    // the months `spend` averaged, as `baselineWindow` bounds them — see the field
    spendingHref: withPeriod(
      "/spending",
      resolvePeriod(
        { period: null, from: `${spend.fromMonth}-01`, to: periodBounds(`${spend.toMonth}-01`, "monthly").end },
        today,
      ),
    ),
    incomeBasisExplanation: income.basis.explanation,
    today,
  };
}

export interface CarCard {
  cost: CarCost;
  /** the car's own committed lines, largest first */
  book: CommittedOutflows;
  /** when the monthly figure stops being true, naming the line — `carEvidenceCaption`; null when nothing billed in it ends */
  evidenceCaption: string | null;
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
  // the car, and which of its rows are money handed over up front — `car-upfront.ts`, the rule the pace reads too
  const upfront = upfrontCarRule(idx, outsidePortfolioCashAccountIds(db), seriesIdsNotDrawnAsRecurring(db));
  if (!upfront) return null;

  const carSeries = recurringSeriesIdsForCategory(db, upfront.carId);
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
  // ⛔ THE SAME `MonthHorizon`, and not a second phrasing of it. This card has
  // its own copy of the window and had its own copy of the clamp bug with it —
  // a twelve-month horizon opened on the 29th, 30th or 31st ran a day short of
  // twelve whole months for every car bill anchored below that day.
  const horizon = monthHorizon(today, months);
  const carEndsById = endsOnBySeries(db);

  const occurrences = // +1: `windowDays` counts days and today is the first — see its docstring
    upcomingOccurrences(db, today, diffDays(today, horizon.projectThrough) + 1)
    .filter((o) => carSeries.has(o.seriesId))
    .filter((o) => withinMonthHorizon(horizon, o.date, o.anchorDayOfMonth))
    .map((o) => toCommitted(o, carEndsById.get(o.seriesId) ?? null));
  const book = committedOutflows({ from: today, to, months, occurrences, overdue: [] });

  /*
   * The recurring monthly bill, NOT `book.totalCents / months`. Insurance stops
   * inside the twelve-month horizon, so the average and the bill he actually
   * pays in a month both are billed are different true numbers.
   *
   * 🔴 AND NOT THE FIRST OCCURRENCE OF EVERY SERIES, which is what this summed
   * until 2026-09-15. The owner's decision of 2026-09-14 registered the $72.74
   * still owed on Nov 11 as its own one-payment series, and the card published
   * "Lease and insurance, a month while both are billed $1,125.36" — $695.04 +
   * $357.58 + $72.74, the premium's remainder priced as a second monthly
   * premium. No month bills that: November is $767.78, December and January
   * $1,052.62. `heaviestMonth` reads the months instead, and says why
   * dropping every line "billed once" is the same defect three months on — and
   * what reading the months still cannot tell.
   */
  const heaviest = heaviestMonth(occurrences);
  const committedMonthlyCents = heaviest.cents;

  // money already handed over: every posted row in the Car subtree, dated
  // before the lease starts, that no commitment accounts for
  /*
   * ⛔ NOT every posted Car row. A row attributed to a recurring series is a
   * payment the "Lease and insurance" line above already prices — and this
   * bucket used to take it too. Measured on the owner's ledger on 2026-09-03:
   * the first insurance charge ($357.58, Progressive, 2026-08-12) sat inside
   * "Paid up front, spread over the lease", and on 2026-09-15 the first lease
   * payment would have joined it — $695.04 counted as the monthly lease AND as
   * an up-front cost amortised over 24 months, one more payment every month
   * for the life of the lease. The series link is the fact that separates
   * "handed over up front" from "the bill, paid".
   *
   * ⛔ …read through the series' STATUS, not the link alone. A row tagged to a
   * series the owner DISMISSED is not a bill he pays — he said so — and no
   * commitment line prices it, so it is money handed over like any unlinked
   * Car row (`seriesDrawsAsRecurring`). An ENDED series' payment was a bill.
   *
   * ⚖️ ONE PREDICATE (`isUpfrontCarRow`), and every spending rate asks it too: the owner's decisions of 2026-10-07
   * leave this money out of every pace and baseline (§6A 48, §6A 51), so it is not projected again as monthly
   * spending — and bound it to the days BEFORE the lease starts (§6A 52): a repair after it is ordinary spending,
   * never spread over the lease.
   */
  const subtree = upfront.subtree;
  const upfrontCents = monthlySpending(db, {
    months: 24,
    refDate: today,
    filter: (t) => isUpfrontCarRow(upfront, t),
  }).reduce((s, c) => s + c.spentCents, 0);

  /*
   * The share's denominator must not already contain the car, or the car would
   * be counted twice in its own percentage. Measured 2026-08-24 the six complete
   * baseline months (Feb–Jul) predate every car row, so this subtracts zero —
   * but it will stop being zero in March, and a figure that silently becomes
   * wrong later is the kind this codebase keeps finding.
   */
  const baseline = spendBaseline(db, today);
  /*
   * ⛔ …and the car spending it removes is the car spending the baseline HOLDS. The up-front money is already out of
   * it (§6A 51, `spendBaseline`), so taking it out here as well would subtract it twice and leave "before the car"
   * short of what he spends by the very amount the card spreads over the lease.
   */
  const baselineCarCents = monthlySpending(db, {
    months: SPEND_BASELINE_MONTHS + 1,
    refDate: today,
    filter: (t) => !isUpfrontCarRow(upfront, t),
  })
    .filter((c) => c.month !== monthKey(today))
    .filter((c) => c.month >= baseline.fromMonth)
    .filter((c) => c.categoryId !== null && subtree.has(c.categoryId))
    .reduce((s, c) => s + c.spentCents, 0);
  /*
   * ⛔ DIVIDED BY THE WINDOW'S OWN MONTHS, not the constant. `baseline.months`
   * shrinks to what the ledger can prove, and the numerator above already
   * follows it (`c.month >= baseline.fromMonth`); dividing the two by different
   * numbers leaves car spending inside a figure whose whole job is to have it
   * removed. Its own test measures the size of that: on a window the ledger
   * has shortened to three months, $600 of car spending was removed at $100 a
   * month instead of $200, leaving half of it inside the total — money then
   * counted a second time as the amortised up-front cost. Unchanged on the
   * owner's ledger, where the window is a full six months.
   */
  const baselineMonthlySpendCents =
    baseline.monthlyCents - Math.round(baselineCarCents / Math.max(1, baseline.months));

  /*
   * The date a car commitment runs out inside the horizon — past it the monthly
   * figure above stops being what he pays, and a renewal is not in the ledger.
   *
   * 🔴 It was the EARLIEST `userEndsOn` of any car series, printed under the
   * hard-coded word "Insurance". On 2026-09-15 that was the one-payment Nov 11
   * balance, beside a runway card naming the premium's Jan 11, 2027 — and a
   * lease ending in 2028 would have been printed as "Insurance" too.
   *
   * 🔴 AND THEN IT NAMED THE RUNWAY CARD'S LEAD (`endingLead`), the line that
   * lowers the RATE most — a different question. A review built a lease ending
   * Feb 15, 2027 beside a policy ending Nov 11, 2026 (2026-09-15): the card
   * dated the lease over a monthly figure holding the premium, which stops
   * three months sooner. `heaviestMonthEnding` names the line whose end stops
   * THIS figure. Computed once: `evidencedThrough` and the sentence share it.
   */
  const ending = heaviestMonthEnding(book, heaviest);

  return {
    cost: carCost({
      months,
      committedCents: book.totalCents,
      committedMonthlyCents,
      upfrontCents,
      upfrontAmortisedOverMonths: CAR_LEASE_TERM_MONTHS,
      baselineMonthlySpendCents,
      evidencedThrough: ending?.endsOn ?? null,
    }),
    book,
    evidenceCaption: carEvidenceCaption(ending, months),
    baseline: { ...baseline, monthlyCents: baselineMonthlySpendCents },
    today,
  };
}
