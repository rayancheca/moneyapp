import type { AppDatabase } from "@/db/client";
import { STALE_PERIODS, type CashEarningsBasis } from "@/lib/cash-earnings";
import { addCalendarMonths, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatDayShort, formatMonthYear } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import {
  LAST_CHECKED_DAY,
  NOT_CHECKED,
  sharedFrontier,
  unbankedIncomeFrontierClause,
  type UnbankedFrontier,
} from "@/lib/unbanked-income";
import { incomeExpectation } from "./budgets";
import {
  cashEarningsReadings,
  earliestVerified,
  landingAccountsBySeries,
  type CashEarningsReading,
} from "./cash-earnings";
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
 *   - paydays past that day, which no checked record covers yet — the ledger
 *     has not looked, and saying anything about them would be inventing news.
 *     (Past it, not "nothing imported": rows can be imported beyond a chain
 *     that has not closed — see `LAST_CHECKED_DAY`.)
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
  /**
   * Of a POSITIVE difference, the part that is pay for paydays after the day
   * every account it lands in is checked through — money the ledger has not
   * looked for, so it cannot be said to have "never reached a bank". Zero when
   * the difference is not positive. Part of `gapMagnitudeCents`, never added
   * to it.
   */
  unreadGapCents: number;
  /** the clause that follows the magnitude, e.g. "never reached a bank" */
  gapLabel: string;
}

/**
 * 🔴 "The difference — never reached a bank — $13,397.96", measured on the
 * owner's ledger 2026-10-07, of which $1,141.92 was the Oct 1 payday: after Sep
 * 24, the day Wells Fargo (where the payroll lands) is checked through. The
 * figure was right and the label was not. The unread part is the pay the
 * schedule implies past the frontier — the same as-of-the-frontier reading the
 * verdict's `checkedSilentPeriods` and /spending's `checkedPeriodsCovered`
 * take — capped at the difference, and named in the forecast's words
 * (`LAST_CHECKED_DAY`, `NOT_CHECKED`, `sharedFrontier`).
 */
function gapOf(
  impliedCents: number,
  bankedCents: number,
  unreadImpliedCents: number,
  frontier: UnbankedFrontier,
): Gap {
  const gapCents = impliedCents - bankedCents;
  const unreadGapCents = gapCents > 0 ? Math.min(gapCents, Math.max(0, unreadImpliedCents)) : 0;
  return {
    gapCents,
    gapMagnitudeCents: gapCents === 0 ? 0 : Math.abs(gapCents),
    unreadGapCents,
    gapLabel: gapLabelFor(gapCents, unreadGapCents, frontier),
  };
}

function gapLabelFor(gapCents: number, unreadGapCents: number, frontier: UnbankedFrontier): string {
  if (gapCents < 0) return "more than this window implies you earned";
  if (gapCents === 0) return "exactly what this window implies you earned";
  if (unreadGapCents === 0) return "never reached a bank";

  const readCents = gapCents - unreadGapCents;
  if (frontier.kind === "unchecked") {
    return readCents === 0
      ? `${NOT_CHECKED}, so it cannot say whether any of it reached a bank.`
      : `${formatCents(readCents)} of it never reached a bank; for the other ${formatCents(unreadGapCents)}, ${NOT_CHECKED}.`;
  }
  const after =
    frontier.kind === "day"
      ? `after ${formatDayShort(frontier.through)}, ${LAST_CHECKED_DAY}`
      : "after the last day the accounts their pay lands in have been checked through, which differs by schedule";
  return readCents === 0
    ? `all of it is for paydays ${after} — so the ledger has not looked for it.`
    : `${formatCents(readCents)} of it never reached a bank; the other ${formatCents(unreadGapCents)} is for paydays ${after} — so the ledger has not looked for it.`;
}

export interface IncomePayLine extends Gap {
  seriesId: string;
  name: string;
  /** what the confirmed schedule implies was earned inside the window */
  impliedCents: number;
  /** how many of the series' own paydays the window actually contains */
  paydays: number;
  /**
   * That count with the span it actually covers — "13 paydays, Jun 4 – Aug 27".
   * The count is bounded by the SERIES' life, not by the window, so a line that
   * named the window over it said something false about both.
   */
  paydaysLabel: string;
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
 * 🔴 The row read "13 paydays in this window" while the summary one line above
 * read "Measured from Mar 2026 to today". Thirteen WEEKLY paydays cannot span
 * twenty-six weeks, and a reader who does the arithmetic finds the card wrong
 * about itself. Both halves were true — `cashEarnings` bounds a series by its
 * own life, so the count starts at the job's first payday, not the window's
 * first day — and the pair was not.
 *
 * The window is already named by `summaryFor` as a trailing clause. The row
 * names its OWN span instead, which is the only one it measured, and a reader
 * can now check it: Jun 4 to Aug 27 is twelve weeks, and thirteen Thursdays.
 */
function paydaysLabelFor(paydays: number, firstOn: string | null, lastOn: string | null): string {
  if (paydays === 0 || firstOn === null || lastOn === null) return "no paydays in this window";
  const span =
    firstOn === lastOn ? formatDayShort(firstOn) : `${formatDayShort(firstOn)} – ${formatDayShort(lastOn)}`;
  return `${paydays} ${paydayWord(paydays)}, ${span}`;
}

/**
 * The verdict: is pay arriving, did the ledger look and find nothing, or has it
 * not looked yet?
 *
 * `STALE_PERIODS` is imported rather than re-chosen. It is already the bar
 * `cashEarnings` uses to call a series stale — three periods — and a second
 * threshold for the same idea is a defect whichever number it holds.
 *
 * 🔴 A LIVE SCHEDULE'S SILENCE WAS NEVER ASKED WHETHER ANYONE LOOKED. Measured
 * on the owner's ledger 2026-10-07: "1 payday has passed since Sep 24 with no
 * deposit — you bank in lumps, so fewer than 3 quiet periods is the ordinary
 * rhythm…", of the Oct 1 payday, after Sep 24, the day Wells Fargo (where the
 * payroll lands) is checked through. /recurring said of the same payday "so the
 * ledger has not looked for its deposit", and "you bank in lumps" was a fact of
 * the cash job, not of weekly ACH payroll. Unread paydays are now named by
 * `unbankedIncomeFrontierClause`, the forecast's own sentence; a silence the
 * ledger HAS read is measured against the stale bar, and nothing more is said
 * about how he banks.
 */
function verdictFor(line: Omit<IncomePayLine, "verdict">): string {
  const { lastBankedOn, silentPeriods, checkedSilentPeriods, checkedThrough, unreadDays } = line;

  if (lastBankedOn === null) {
    return "No deposit has been attributed to this schedule on or before today, so there is nothing to date the silence from.";
  }

  const passed = `${silentPeriods} ${paydayWord(silentPeriods)} ${silentPeriods === 1 ? "has" : "have"} passed`;
  const since = `${passed} since ${formatDayShort(lastBankedOn)} with no deposit`;

  if (line.basis === "series-live") {
    if (silentPeriods === 0) {
      return `Pay is arriving: the last deposit landed on ${formatDayShort(lastBankedOn)}.`;
    }
    const unread = unbankedIncomeFrontierClause(
      {
        occurrenceCount: silentPeriods,
        checkedOccurrenceCount: checkedSilentPeriods,
        frontier: checkedThrough === null ? { kind: "unchecked" } : { kind: "day", through: checkedThrough },
      },
      formatDayShort,
    );
    if (unread !== null) {
      // "with no deposit" is the clause's to say, and only of the days it checked
      return `${passed} since the last deposit on ${formatDayShort(lastBankedOn)}. ${unread}`;
    }
    return `${since} — a schedule is called stale only after ${STALE_PERIODS} quiet periods, so this is not a warning yet.`;
  }

  if (checkedThrough === null) {
    return `${since}, and no day of that silence rests on a checked record — the ledger cannot say whether the pay arrived.`;
  }

  if (checkedSilentPeriods >= STALE_PERIODS) {
    return `${since}. ${checkedSilentPeriods} of them fall on days the records already cover, through ${formatDayShort(checkedThrough)} — so the pay did not reach a bank. Whether it was earned is a different question, and this card cannot answer it.`;
  }

  const unlooked = silentPeriods - checkedSilentPeriods;
  return `${since}, but only ${checkedSilentPeriods} of them fall on days the records cover. The other ${unlooked} sit inside the ${unreadDays ?? 0} days past ${formatDayShort(checkedThrough)}, ${LAST_CHECKED_DAY}, so the ledger has not looked.`;
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
  const readingAsOf = (day: string, seriesId: string): CashEarningsReading | undefined => {
    let rows = asOfCache.get(day);
    if (rows === undefined) {
      // `day` is the verified frontier: every deposit on it is in the records,
      // so a payday dated on it is checked — see `todayIsComplete`
      rows = cashEarningsReadings(db, { from: windowFrom, to: day, today: day, todayIsComplete: true });
      asOfCache.set(day, rows);
    }
    return rows.find((r) => r.seriesId === seriesId);
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

    const asChecked = checkedThrough === null ? undefined : readingAsOf(checkedThrough, r.seriesId);
    // what the schedule implies past the frontier: every payday when nothing is checked
    const unreadImpliedCents = r.impliedCents - (asChecked?.impliedCents ?? 0);

    const base = {
      seriesId: r.seriesId,
      name: r.seriesName,
      impliedCents: r.impliedCents,
      paydays: r.periodsCovered,
      paydaysLabel: paydaysLabelFor(r.periodsCovered, r.firstPeriodOn, r.lastPeriodOn),
      bankedCents: r.bankedCents,
      basis: r.basis,
      lastBankedOn: r.lastBankedOn,
      silentPeriods: r.periodsSinceBanked,
      checkedSilentPeriods: asChecked?.periodsSinceBanked ?? 0,
      checkedThrough,
      unreadDays: checkedThrough === null ? null : diffDays(checkedThrough, today),
      ...gapOf(
        r.impliedCents,
        r.bankedCents,
        unreadImpliedCents,
        checkedThrough === null ? { kind: "unchecked" } : { kind: "day", through: checkedThrough },
      ),
    };
    return { ...base, verdict: verdictFor(base) };
  });

  const impliedCents = pay.reduce((s, l) => s + l.impliedCents, 0);
  const bankedCents = pay.reduce((s, l) => s + l.bankedCents, 0);
  // the lines' own unread parts, against the one day they share when they share one
  const unread = pay.filter((l) => l.unreadGapCents > 0);
  const totals = {
    impliedCents,
    bankedCents,
    ...gapOf(
      impliedCents,
      bankedCents,
      unread.reduce((s, l) => s + l.unreadGapCents, 0),
      sharedFrontier(unread.map((l) => l.checkedThrough)),
    ),
  };
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
