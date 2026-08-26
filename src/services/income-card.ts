import { and, eq, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { STALE_PERIODS, type CashEarningsBasis } from "@/lib/cash-earnings";
import { addCalendarMonths, compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatDayShort, formatMonthYear } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { incomeExpectation } from "./budgets";
import { cashEarningsReadings, type CashEarningsReading } from "./cash-earnings";
import { SPEND_BASELINE_MONTHS } from "./committed";
import { accountCoverage } from "./coverage";

/**
 * Am I actually being paid, and how much of it ever reaches a bank?
 *
 * ## ⛔ This module reconciles NOTHING. `cashEarningsReadings` already did.
 *
 * Implied, banked, the difference between them, the pay periods of silence and
 * the word for what state the schedule is in all arrive from
 * `services/cash-earnings`, whose own docstring carries the two decisions that
 * make them trustworthy — that a series' life is read from its linked rows
 * rather than from the stale `last_matched_on` cache, and that ONLY deposits
 * carrying `recurring_series_id` count as banked, because the $6,900 ATM pair
 * of 2026-07-21 is his mother's money and any heuristic wide enough to catch a
 * payday sweeps it in. Re-deriving either here would give the app two answers
 * to one question and the second would be the untested one.
 *
 * What this module adds is the one thing that reading cannot answer on its own.
 *
 * ## The trap: a silence is not a collapse
 *
 * Measured 2026-08-26, income by month reads $17,561.44 in January falling to
 * $52.95 in July with August empty. A card built on that shape would announce a
 * 99.7% collapse in earnings, and it would be a false alarm of exactly the kind
 * this codebase exists to prevent: he is paid in CASH by a job whose deposits
 * are irregular, statements arrive monthly and land late, and July's $52.95 is
 * dividends and interest rather than the absence of a wage.
 *
 * So the card must separate "you earned nothing" from "the ledger has not seen
 * it", and the separation is MEASURABLE rather than rhetorical. `accountCoverage`
 * publishes, per account, the last day whose balance rests on a closed
 * arithmetic chain. Take the accounts this series' attributed pay has actually
 * landed in, take the earliest of their `verifiedThrough` dates, and ask
 * `cashEarnings` for a second reading AS OF that day — its `today` parameter is
 * exactly "the day the reading is taken". The difference between the two
 * readings splits the silence in two:
 *
 *   - paydays that fell on days the records already cover — the ledger LOOKED
 *     and no deposit was there;
 *   - paydays inside the stretch nothing has imported yet — the ledger has not
 *     looked, and saying anything about them would be inventing news.
 *
 * On the real ledger 2026-08-26 that comes to 9 checked against 2 unread, so
 * the silence is real and not a statement lag. The verdict sentence says which,
 * every time, and it is written here rather than in the component for the same
 * reason `budgetVerdict` writes its own headline: a reading and the meaning of
 * the reading that leave a service together cannot drift apart.
 *
 * ⚠️ KNOWN AND DELIBERATELY CONSERVATIVE: `verifiedThrough` stops at the last
 * `anchored`/`derived` day, and `carried` days are neither trusted nor counted
 * as broken by `accountCoverage` — so a trailing run of them reads here as "not
 * looked at". Measured 2026-08-26, Chase Checking is `anchored` on 2026-08-12
 * and `carried` on 08-13 and 08-14, which means no transaction happened on
 * those two days and the 08-13 payday provably did not arrive. This card counts
 * them as unread anyway. That errs toward saying the ledger has NOT looked,
 * which is the only safe direction for a card whose job is to refuse false
 * alarms; the verdict is unchanged either way (9 checked and 10 checked both
 * clear `STALE_PERIODS`). Fixing it properly means `accountCoverage` publishing
 * a carried-inclusive through-date, and inventing a second one here would be
 * exactly the duplicate definition this module refuses everywhere else.
 *
 * ## The window ends TODAY, and that is the one deviation from the spend cards
 *
 * `SPEND_BASELINE_MONTHS` is imported rather than re-picked — the runway and
 * eating-out cards publish "6 complete months" on the same screen and a second
 * window for the same ledger is a contradiction the reader has to resolve. But
 * those cards stop at the last COMPLETE month, because a partial month
 * understates a rate. This one runs to `today`, because the current month's
 * silence is the very thing the card exists to explain and stopping a month
 * short would hide it. Nothing is overstated by doing so: `cashEarnings` clamps
 * its own end to `today` and never counts a payday that has not happened.
 *
 * ## The headline is `incomeBasis`', not a rate of this module's own
 *
 * `/budgets` sizes its whole header from `incomeBasis`, and a second monthly
 * income rate on the dashboard would let the two contradict each other. So the
 * figure is `incomeExpectation(...).basis.cents` unchanged.
 *
 * ⚠️ Its `explanation` is deliberately NOT re-published. `RunwayCard` already
 * mounts that exact string in a tooltip on this same page, and a tooltip body
 * is live DOM text even while closed — a second copy would double a phrase that
 * exact-count locators read.
 *
 * ⚠️ Not `projectOngoingIncome` (`lib/income-forecast`), which looks FORWARD
 * from trailing history to estimate what next month brings. This looks BACKWARD
 * at a confirmed schedule against a window that has already happened. Merging
 * them would be a category error.
 */

/** What a gap means, chosen by the same branch that measures it. */
interface Gap {
  /** implied − banked. POSITIVE means pay never reached a bank. */
  gapCents: number;
  /**
   * The same difference as a magnitude, so the component never flips a sign.
   *
   * ⛔ The explicit zero branch is not decoration. `-0` formats as "-$0.00" and
   * a total of exactly zero is the common case on a schedule that is being
   * banked on time; it shipped to this dashboard once already and only looking
   * at the page caught it, because every sum stayed correct (`-0 + 0 === 0`).
   */
  gapMagnitudeCents: number;
  /** the clause that follows the magnitude, e.g. "never reached a bank" */
  gapLabel: string;
}

function gapOf(impliedCents: number, bankedCents: number): Gap {
  const gapCents = impliedCents - bankedCents;
  return {
    gapCents,
    gapMagnitudeCents: gapCents === 0 ? 0 : Math.abs(gapCents),
    gapLabel:
      gapCents > 0
        ? "never reached a bank"
        : gapCents < 0
          ? "more than this window implies you earned"
          : "exactly what this window implies you earned",
  };
}

export interface IncomePayLine extends Gap {
  seriesId: string;
  name: string;
  /** what the confirmed schedule implies was earned inside the window */
  impliedCents: number;
  /** how many of the series' own paydays the window actually contains */
  paydays: number;
  /** what reached a bank inside the window, attributed deposits only */
  bankedCents: number;
  /** `cashEarnings`' own word for which world these numbers live in */
  basis: CashEarningsBasis;
  lastBankedOn: string | null;
  /** pay periods since the last attributed deposit, counted to today */
  silentPeriods: number;
  /** of those, the ones that fell on days the records already cover */
  checkedSilentPeriods: number;
  /** earliest day the accounts this pay lands in stop being checked */
  checkedThrough: string | null;
  /** days between `checkedThrough` and today — the stretch nobody has imported */
  unreadDays: number | null;
  /** the whole verdict for this series, written here and never re-worded */
  verdict: string;
}

export interface IncomeCard {
  /** the monthly figure `/budgets` grades against — `incomeBasis`', unchanged */
  monthlyRateCents: number;
  /** the sentence under the headline: how much of the implied pay was banked */
  summary: string;
  pay: IncomePayLine[];
  totals: Gap & { impliedCents: number; bankedCents: number };
  /**
   * Banked ÷ implied as a whole percentage, occasionally above 100.
   *
   * ⛔ Null when nothing was implied. `x / 0` is `Infinity`, which renders as
   * "Infinity% of your pay"; a window containing no payday has no share to
   * publish, and `summary` says something else entirely in that branch.
   *
   * Rounded HERE, once, and `summary` is written from this same number — the
   * sentence and any figure a caller reads cannot disagree about whether 11.5%
   * is 11 or 12.
   */
  bankedSharePct: number | null;
  /** income the ledger has actually recorded in the current calendar month */
  postedThisMonthCents: number;
  /** "Aug 2026" — the month that figure describes */
  postedMonth: string;
  /** why an empty month is not the same as an unpaid one */
  postedNote: string;
  /** what a difference is NOT — the standing caveat, never omitted */
  caveat: string;
  /**
   * First day of the reconciliation window. It ends on `today` — see the header
   * note; that is the one place this card parts company with the spend cards,
   * and publishing a `windowTo` equal to `today` would be a second name for one
   * date rather than a second fact.
   */
  windowFrom: string;
  today: string;
}

/**
 * What a positive difference must never be read as saying.
 *
 * Three innocent explanations, straight out of `lib/cash-earnings`, and this
 * module cannot distinguish between them. Printing the gap without printing
 * this is how "you are owed $11,117.00" gets read off a subtraction.
 */
const CAVEAT =
  "A difference is not money the app has found. Cash pay can sit undeposited, be spent without ever touching a bank, or the arrangement can have quietly ended — nothing here can tell those three apart.";

const paydayWord = (n: number): string => (n === 1 ? "payday" : "paydays");

/**
 * The verdict: is pay arriving, did the ledger look and find nothing, or has it
 * not looked yet?
 *
 * `STALE_PERIODS` is imported rather than re-chosen. It is already the bar
 * `cashEarnings` uses to call a series stale — three periods, because he banks
 * in lumps and one quiet week is his ordinary rhythm — and a second threshold
 * for the same idea is a defect whichever number it holds.
 */
function verdictFor(line: Omit<IncomePayLine, "verdict">): string {
  const { lastBankedOn, silentPeriods, checkedSilentPeriods, checkedThrough, unreadDays } = line;

  if (lastBankedOn === null) {
    return "No deposit has been attributed to this schedule on or before today, so there is nothing to date the silence from.";
  }

  const since = `${silentPeriods} ${paydayWord(silentPeriods)} ${silentPeriods === 1 ? "has" : "have"} passed since ${formatDayShort(lastBankedOn)} with no deposit`;

  if (line.basis === "series-live") {
    if (silentPeriods === 0) {
      return `Pay is arriving: the last deposit landed on ${formatDayShort(lastBankedOn)}.`;
    }
    return `${since} — you bank in lumps, so fewer than ${STALE_PERIODS} quiet periods is the ordinary rhythm here rather than a warning.`;
  }

  if (checkedThrough === null) {
    return `${since}, and no day of that silence rests on a checked record — the ledger cannot say whether the pay arrived.`;
  }

  if (checkedSilentPeriods >= STALE_PERIODS) {
    return `${since}. ${checkedSilentPeriods} of them fall on days the records already cover, through ${formatDayShort(checkedThrough)} — so the pay did not reach a bank. Whether it was earned is a different question, and this card cannot answer it.`;
  }

  const unlooked = silentPeriods - checkedSilentPeriods;
  return `${since}, but only ${checkedSilentPeriods} of them fall on days the records cover. The other ${unlooked} sit inside the ${unreadDays ?? 0} days past ${formatDayShort(checkedThrough)} that nothing has imported yet, so the ledger has not looked.`;
}

/** The accounts each income series' attributed pay has actually landed in. */
function landingAccountsBySeries(db: AppDatabase): Map<string, Set<string>> {
  const rows = db
    .select({ seriesId: transactions.recurringSeriesId, accountId: transactions.accountId })
    .from(transactions)
    .where(and(isNotNull(transactions.recurringSeriesId), eq(transactions.status, "active")))
    .all();

  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.seriesId === null) continue;
    const set = out.get(r.seriesId) ?? new Set<string>();
    set.add(r.accountId);
    out.set(r.seriesId, set);
  }
  return out;
}

/**
 * The EARLIEST `verifiedThrough` across every account a series' pay has landed
 * in — the last day the ledger has checked every place a payday could arrive.
 *
 * A single account with nothing verified collapses the whole thing to null,
 * which is the honest answer rather than the convenient one: if one possible
 * landing place is unchecked, a deposit could be sitting in it unseen and the
 * card must not claim the ledger looked.
 */
function earliestVerified(
  accountIds: ReadonlySet<string>,
  verifiedThroughByAccount: ReadonlyMap<string, string | null>,
  today: string,
): string | null {
  if (accountIds.size === 0) return null;
  let earliest: string | null = null;
  for (const id of accountIds) {
    const through = verifiedThroughByAccount.get(id) ?? null;
    if (through === null) return null;
    if (earliest === null || compareDates(through, earliest) < 0) earliest = through;
  }
  // a record reaching past today still cannot have been read against today
  if (earliest !== null && compareDates(earliest, today) > 0) return today;
  return earliest;
}

export function incomeCard(db: AppDatabase, today: string = todayIso()): IncomeCard | null {
  const months = SPEND_BASELINE_MONTHS;
  const currentMonth = monthKey(today);
  const windowFrom = `${monthKey(addCalendarMonths(`${currentMonth}-01`, -months))}-01`;

  const readings = cashEarningsReadings(db, { from: windowFrom, to: today, today });
  // No confirmed income series with evidence behind it: there is no schedule to
  // reconcile against, and a card of zeroes is worse than no card.
  if (readings.length === 0) return null;

  const verifiedThroughByAccount = new Map(
    accountCoverage(db, today).map((c) => [c.accountId, c.verifiedThrough] as const),
  );
  const landings = landingAccountsBySeries(db);

  /*
   * One reading per distinct cut-off, memoised. Two series banking into the
   * same account share a call; two banking into differently-covered accounts do
   * not, because "the day the records stop" is a fact about the account the pay
   * lands in and not about the ledger as a whole.
   */
  const asOfCache = new Map<string, CashEarningsReading[]>();
  const silenceAsOf = (day: string, seriesId: string): number => {
    let rows = asOfCache.get(day);
    if (rows === undefined) {
      rows = cashEarningsReadings(db, { from: windowFrom, to: day, today: day });
      asOfCache.set(day, rows);
    }
    return rows.find((r) => r.seriesId === seriesId)?.periodsSinceBanked ?? 0;
  };

  const pay: IncomePayLine[] = readings.map((r) => {
    /*
     * The EARLIEST verifiedThrough across every account this pay has landed in.
     * A payday could have arrived in any of them, so the ledger has only checked
     * every possible landing place through the first date one of them stops. A
     * single unverified account collapses the whole thing to null, which is the
     * honest answer rather than a convenient one.
     */
    const checkedThrough = earliestVerified(
      landings.get(r.seriesId) ?? new Set<string>(),
      verifiedThroughByAccount,
      today,
    );

    const base = {
      seriesId: r.seriesId,
      name: r.seriesName,
      impliedCents: r.impliedCents,
      paydays: r.periodsCovered,
      bankedCents: r.bankedCents,
      basis: r.basis,
      lastBankedOn: r.lastBankedOn,
      silentPeriods: r.periodsSinceBanked,
      checkedSilentPeriods: checkedThrough === null ? 0 : silenceAsOf(checkedThrough, r.seriesId),
      checkedThrough,
      unreadDays: checkedThrough === null ? null : diffDays(checkedThrough, today),
      ...gapOf(r.impliedCents, r.bankedCents),
    };
    return { ...base, verdict: verdictFor(base) };
  });

  const impliedCents = pay.reduce((s, l) => s + l.impliedCents, 0);
  const bankedCents = pay.reduce((s, l) => s + l.bankedCents, 0);
  const totals = { impliedCents, bankedCents, ...gapOf(impliedCents, bankedCents) };
  const bankedSharePct = impliedCents <= 0 ? null : Math.round((bankedCents / impliedCents) * 100);

  const month = periodBounds(today, "monthly");
  const expectation = incomeExpectation(db, month.start, month.end, today);
  const postedThisMonthCents = expectation.postedCents;
  const postedMonth = formatMonthYear(today);

  return {
    monthlyRateCents: expectation.basis.cents,
    summary: summaryFor(bankedSharePct, totals.impliedCents, totals.bankedCents, windowFrom),
    pay,
    totals,
    bankedSharePct,
    postedThisMonthCents,
    postedMonth,
    postedNote:
      postedThisMonthCents === 0
        ? `No income at all has been recorded in ${postedMonth}. An empty month is what an unimported month looks like as well as what an unpaid one looks like — the lines above say which this is.`
        : `That is what has been imported so far, not what was earned in ${postedMonth}.`,
    caveat: CAVEAT,
    windowFrom,
    today,
  };
}

/**
 * The sentence under the headline.
 *
 * Written here rather than in the component because the branches share no
 * shape: an empty window, a zero, an exact match and an overshoot each need a
 * different sentence, and a component assembling them out of a nullable number
 * would be the second author of a verdict.
 *
 * ⚠️ The over-banked branches test CENTS, not the rounded percentage. Banking
 * 99.6% of the implied pay rounds to 100 and is still not "everything"; reading
 * the branch off the display figure is how a card says the opposite of what it
 * measured.
 */
function summaryFor(
  bankedSharePct: number | null,
  impliedCents: number,
  bankedCents: number,
  windowFrom: string,
): string {
  /*
   * ⚠️ The window is a TRAILING clause, not a mid-sentence one. "the $12,564.00
   * the schedule implies you have earned since Feb 2026" reads as a claim that
   * the arrangement existed in February, and on the real ledger it did not —
   * every one of those twelve paydays falls after 2026-06-04, because
   * `cashEarnings` bounds a series by its own life. Naming the window at the end
   * says the same true thing without inventing a job.
   */
  const measured = `Measured from ${formatMonthYear(windowFrom)} to today.`;
  if (bankedSharePct === null) {
    const deposits =
      bankedCents === 0
        ? "and no attributed deposit landed in it either"
        : `though ${formatCents(bankedCents)} of attributed deposits landed inside it`;
    return `No payday from a confirmed schedule falls inside this window, ${deposits}, so there is nothing to reconcile yet. ${measured}`;
  }
  if (bankedCents === 0) {
    return `Nothing has reached a bank, against ${formatCents(impliedCents)} the confirmed schedule implies you earned. ${measured}`;
  }
  if (bankedCents === impliedCents) {
    return `${formatCents(bankedCents)} has reached a bank — exactly what the confirmed schedule implies you earned. ${measured}`;
  }
  if (bankedCents > impliedCents) {
    return `${formatCents(bankedCents)} has reached a bank, ${formatCents(bankedCents - impliedCents)} more than the confirmed schedule implies you earned — pay banked in lumps outruns the window it is measured over. ${measured}`;
  }
  return `${formatCents(bankedCents)} of the ${formatCents(impliedCents)} the confirmed schedule implies you earned reached a bank — ${bankedSharePct}% of it. ${measured}`;
}
