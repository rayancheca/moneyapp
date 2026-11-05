import {
  countedDepositWords,
  matchedOfWords,
  namedTogether,
  neverClauses,
  neverSplit,
  notCountedWords,
  silenceMatches,
  type NeverSplit,
  type UnattachedMatch,
} from "@/lib/unattached-match";
import type { AppDatabase } from "@/db/client";
import { payGap, STALE_PERIODS, unbankedSplit, type CashEarningsBasis } from "@/lib/cash-earnings";
import { addCalendarMonths, compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatDayLong, formatDayShortIn, formatMonthYear } from "@/lib/format-date";
import { monthIncomeLink, type IncomeLink } from "@/lib/income-basis";
import { formatCents } from "@/lib/money";
import { dayWindowLabel } from "@/lib/period";
import { paydaysNotBankedYet, wentBackOutPhrase, type WentBackOut } from "@/lib/pay-shortfall";
import {
  ACCOUNT_NOT_READ,
  ACCOUNT_READ,
  LAST_CHECKED_DAY,
  NOT_CHECKED,
  noIncomeDayCheckedNote,
  notLookedForDeposits,
  ON_DAYS_ALREADY_CHECKED,
  paidEarlyAside,
  payNotBankedYet,
  sharedFrontier,
  theOther,
  theOtherFall,
  unbankedIncomeFrontierClause,
  type UnbankedFrontier,
} from "@/lib/unbanked-income";
import { loadCategoryIndex } from "./analytics";
import { incomeExpectation } from "./budgets";
import { cashEarningsReadings, type CashEarningsReading } from "./cash-earnings";
import { SPEND_BASELINE_MONTHS } from "./committed";
import { paydaySettlement } from "./payday-settlement";

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
 * window LENGTH for the same ledger is a contradiction the reader has to
 * resolve. But those cards stop at the last month every account you spend from
 * is read through to its end (`baselineWindow`, his decision 71), because a
 * partial month understates a rate — on his ledger copy at 2026-10-13 the runway
 * read "Feb 2026 to Jul 2026" beside this card's "Measured from Apr 2026 to
 * today" (review of cbee36b). This one runs to `today`, because the current month's
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
  /** implied − banked. POSITIVE means pay that has not banked. */
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
   * looked for, so it cannot be said to have "never reached" one. Zero when
   * the difference is not positive. Part of `gapMagnitudeCents`, never added
   * to it.
   */
  unreadGapCents: number;
  /** how many paydays `unreadGapCents` is for — "a payday" of one in `gapLabel` (`forPaydays`) */
  unreadPaydays: number;
  /**
   * Of a POSITIVE difference, the part for checked paydays no deposit settled whose days to land are not all checked
   * yet (`paydaysNotBankedYet`, `unbankedSplit`) — "not banked yet", the forecast's words, never "never reached"
   * (`NEVER_REACHED`). Zero when the difference is not positive. Part of `gapMagnitudeCents`, never added to it.
   */
  notBankedYetCents: number;
  /** how many paydays `notBankedYetCents` is for, rows the one rule matched to them included */
  notBankedYetPaydays: number;
  /**
   * …and the rest of the checked part: what "never reached" says of — the difference less `unreadGapCents`
   * and `notBankedYetCents` (`unbankedSplit`). Zero when the difference is not positive. ⛔ The card's own figure, for
   * every reader that reports it (the rate-history write's guard): 🔴 re-derived as the difference less the unread part
   * alone, a payday inside its days to land was counted in it (review of c02a4b0).
   */
  neverCents: number;
  /**
   * Of `neverCents`, the part for paydays a row matches to the cent that sits unattached (`unattachedPaydays`) — still
   * in `neverCents` and in the difference (linking is his act or the import's), and named by the rows' day and amount
   * in `gapLabel`, never "never reached".
   */
  unattachedCents: number;
  /** the rows `unattachedCents` is — each matching a payday of the window to the cent, unattached — oldest first */
  unattached: readonly UnattachedMatch[];
  /**
   * …and the rows the one rule matched to the paydays `notBankedYetCents` is for — still inside their days to land —
   * named with `unattached` in `gapLabel`, never "not banked yet" (`namedTogether`); still in `notBankedYetCents`.
   */
  notBankedYetUnattached: readonly UnattachedMatch[];
  /**
   * the clause that follows the magnitude, e.g. "never reached an account the ledger reads" (`NEVER_REACHED`) — and
   * after it, the money that went back out on a day of its own, in /spending's words (`withMoneyOut`)
   */
  gapLabel: string;
}

/** What a gap's not-banked-yet part comes to, and how far the accounts its paydays' pay lands in were checked. */
interface InGrace {
  cents: number;
  /** how many paydays `cents` is for */
  paydays: number;
  frontier: UnbankedFrontier;
  /** the rows the one rule matched to its paydays, which the words name with the never part's (`namedTogether`) */
  unattached: readonly UnattachedMatch[];
}

/** What the schedule implies past the day its pay's accounts are checked through, and how many paydays that is. */
interface Unread {
  impliedCents: number;
  paydays: number;
  frontier: UnbankedFrontier;
}

/**
 * How the card spells a day: "Oct 26", and "Dec 31, 2026" outside today's year (`formatDayShortIn`) — the dashboard
 * tile's spelling of the same day, one card over (`SpendingPace.paydaysLeftOut`). 🔴 Review of 082a0ef5 (LOW): read Jan
 * 8, 2027, Wells Fargo checked through Dec 31, the tile said "It falls after Dec 31, 2026, the last day …" and this
 * card "It falls after Dec 31, the last day …" — and a bare "Dec 31" in January is a day eleven months away.
 *
 * ⛔ …every day, the rows the card names too — the verdict's frontier clause takes it for them (`formatRowDay`), as the
 * tile's line does — and a list of days says each year once (`formatDaysYearOnce`): "on Dec 17, Dec 24, and Dec 31,
 * 2026". 🔴 Review of 87a440d0 (MEDIUM): two rules for a row's day, the clause's against the newest row and this one
 * against today, met on one card in January.
 */
type DayWord = (iso: string) => string;

/** "a payday", "paydays" — what a part of the difference "is for", by `paydayWord`'s count */
const forPaydays = (n: number): string => (n === 1 ? "a payday" : "paydays");

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
  unread: Unread,
  inGrace: InGrace,
  wentBackOut: readonly WentBackOut[],
  unattached: readonly UnattachedMatch[],
  day: DayWord,
): Gap {
  // ⛔ the one subtraction, shared with /spending's shortfall note (`payGap`)
  const { gapCents, unreadGapCents, readGapCents } = payGap(impliedCents, bankedCents, unread.impliedCents);
  // ⛔ …and the one split of its read part (`unbankedSplit`): "never reached a bank" only past the days to land
  const { notBankedYetCents, neverCents } = unbankedSplit(readGapCents, inGrace.cents);
  // ⛔ …and of each, what rows sitting unattached match to the cent (`lib/unattached-match`): named, still counted —
  // the one split, /spending's shortfall note's too (`neverSplit`, `namedTogether`): every row named once, a row of a
  // payday still inside its days to land too, never "not banked yet"
  const never = neverSplit(neverCents, unattached);
  const notYet = neverSplit(notBankedYetCents, inGrace.unattached);
  const { said, notYetLeftCents } = namedTogether(never, notYet);
  const unreadPart = { cents: unreadGapCents, paydays: unread.paydays, frontier: unread.frontier };
  // the not-banked-yet money no row answers is its paydays' that no row answers: each row is one payday's, to the cent
  const notYetLeft = { ...inGrace, cents: notYetLeftCents, paydays: inGrace.paydays - notYet.matched.length };
  return {
    gapCents,
    gapMagnitudeCents: gapCents === 0 ? 0 : Math.abs(gapCents),
    unreadGapCents,
    unreadPaydays: unread.paydays,
    notBankedYetCents,
    notBankedYetPaydays: inGrace.paydays,
    neverCents,
    unattachedCents: never.matchedCents,
    unattached: never.matched,
    notBankedYetUnattached: notYet.matched,
    gapLabel: withMoneyOut(
      notYetLeftCents > 0
        ? inGraceGapLabel(said, notYetLeft, unreadPart, day)
        : gapLabelFor(gapCents, said, unreadPart, day),
      wentBackOut,
    ),
  };
}

/** The difference's never part as the card says it: "$X of it never reached …", or bare (`neverClauses`). */
const cardNeverClauses = (never: NeverSplit, bare: boolean, day: DayWord): string[] =>
  neverClauses(never, day, { ofIt: true, bare });

/** "after Sep 24, the last day every account that pay lands in has been checked through", or by schedule. */
function afterFrontier(frontier: Exclude<UnbankedFrontier, { kind: "unchecked" }>, day: DayWord): string {
  return frontier.kind === "day"
    ? `after ${day(frontier.through)}, ${LAST_CHECKED_DAY}`
    : "after the last day the accounts their pay lands in have been checked through, which differs by schedule";
}

/**
 * ⚖️ DEFAULT (A), BUILT, NOT ASKED (2026-10-21): money that went back out on a day of its own is named on the card as
 * /spending names it — "$1,141.92 went back out on Fri, Sep 25, 2026" (`wentBackOutPhrase`, the same days by the same
 * rule, `moneyOutOfWindow`) — AFTER the difference and its split, never as a part of it: the banked figure never held
 * that money, so the difference does not either, and the payday its deposit paid stays paid (decision 75), as the
 * calendar draws it. 🔴 The card never named it: on his ledger copy 2026-10-21 with a hypothetical $1,141.92 of pay
 * back out on Fri Sep 25 it read only "$11,117.00 of it never reached a bank; the other $3,425.76 is for paydays after
 * Sep 24 …", while /spending YTD (bde27f3) read "…$11,117.00 never reached a bank; $1,141.92 went back out on Fri, Sep
 * 25, 2026".
 */
function withMoneyOut(label: string, wentBackOut: readonly WentBackOut[]): string {
  if (wentBackOut.length === 0) return label;
  const back = wentBackOutPhrase(wentBackOut, formatDayLong);
  return label.endsWith(".") ? `${label.slice(0, -1)}; ${back}.` : `${label}; ${back}`;
}

/** A part of the difference: what it comes to, how many paydays it is for, and the day its accounts are checked to. */
interface GapPart {
  cents: number;
  paydays: number;
  frontier: UnbankedFrontier;
}

/*
 * ⛔ "A payday" of one (`forPaydays`). 🔴 His ledger copy 2026-10-30: "…; the other $1,141.92 is for paydays after Oct
 * 26, the last day every account that pay lands in has been checked through — so the ledger has not looked for it." of
 * Oct 29 alone, over the verdict's "1 payday has passed since the last deposit on Oct 22".
 */
function gapLabelFor(gapCents: number, never: NeverSplit, unread: GapPart, day: DayWord): string {
  if (gapCents < 0) return "more than this window implies you earned";
  if (gapCents === 0) return "exactly what this window implies you earned";
  if (unread.cents === 0) {
    const whole = cardNeverClauses(never, true, day);
    return whole.length === 1 && never.matchedCents === 0 ? whole[0]! : `${whole.join("; ")}.`;
  }

  const read = cardNeverClauses(never, false, day).join("; ");
  if (unread.frontier.kind === "unchecked") {
    return never.cents === 0
      ? `${NOT_CHECKED}, so it cannot say whether any of it reached a bank.`
      : `${read}; for the other ${formatCents(unread.cents)}, ${NOT_CHECKED}.`;
  }
  const isFor = `is for ${forPaydays(unread.paydays)} ${afterFrontier(unread.frontier, day)}`;
  return never.cents === 0
    ? `all of it ${isFor} — so the ledger has not looked for it.`
    : `${read}; the other ${formatCents(unread.cents)} ${isFor} — so the ledger has not looked for it.`;
}

/**
 * The difference with a part NOT BANKED YET: pay for checked paydays no deposit settled whose days to land run past the
 * checked day (`paydaysNotBankedYet`) — in the forecast's words, beside what never reached a bank and what the ledger
 * has not looked for, each its own part. ⚖️ "Never reached a bank" only of a payday checked through its days to land
 * (`paydayLandingIsRead`). 🔴 Review of 878c3d5: weekly pay through Aug 27, Chase read through Sat Sep 5, the forecast
 * called Thu Sep 3 "Pay not banked yet" while this card said "$1,000.00 of it never reached a bank" of it.
 */
function inGraceGapLabel(never: NeverSplit, notYet: GapPart, unread: GapPart, day: DayWord): string {
  const past =
    notYet.frontier.kind === "day"
      ? `${day(notYet.frontier.through)}, ${LAST_CHECKED_DAY}`
      : "the last day the accounts their pay lands in have been checked through, which differs by schedule";
  const parts = cardNeverClauses(never, false, day);
  // "$X" after a figure, "$X of it" opening the clause, and "all of it" when it is the whole difference
  const lead =
    parts.length > 0
      ? formatCents(notYet.cents)
      : unread.cents > 0
        ? `${formatCents(notYet.cents)} of it`
        : "all of it";
  const isFor = `is for ${forPaydays(notYet.paydays)} whose days to land run past ${past}`;
  parts.push(`${lead} ${isFor} — so it is not banked yet`);
  if (unread.cents > 0) {
    const other = `the other ${formatCents(unread.cents)}`;
    const sameDay =
      unread.frontier.kind === "day" &&
      notYet.frontier.kind === "day" &&
      unread.frontier.through === notYet.frontier.through;
    parts.push(
      unread.frontier.kind === "unchecked"
        ? `for ${other}, ${NOT_CHECKED}`
        : `${other} is for ${forPaydays(unread.paydays)} ` +
            `${sameDay ? "after that day" : afterFrontier(unread.frontier, day)} — so the ledger has not looked for it`,
    );
  }
  return `${parts.join("; ")}.`;
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
  /**
   * what reached a bank inside the window, attributed deposits only — its days that banked, less the money out on a
   * day of its own the rule nets (`moneyOutOfWindow`), the figure /spending reads of the same window
   */
  bankedCents: number;
  /** the money out on days of their own the rule names, each day whole, oldest first — named in `gapLabel` */
  wentBackOut: readonly WentBackOut[];
  /** `cashEarnings`' own word for which world these numbers live in */
  basis: CashEarningsBasis;
  lastBankedOn: string | null;
  /** pay periods since the last attributed deposit, counted to today — none a deposit paid (`periodsSinceBanked`) */
  silentPeriods: number;
  /** …and the paydays since it a deposit paid early, which that count leaves out (`silencePaidEarly`), oldest first */
  silencePaidEarly: readonly string[];
  /** of those, the ones that fell on days the records already cover */
  checkedSilentPeriods: number;
  /**
   * Of those, the paydays no deposit settled whose days to land run past `checkedThrough`
   * (`silentPaydaysNotBankedYet`), oldest first: "not banked yet", never counted among the pay that "did not reach"
   * one — the paydays /spending's note for a stale schedule names (`CashEarningsReading.checkedSilentNotBankedYet`).
   */
  checkedSilentNotBankedYet: readonly string[];
  /**
   * Of the silence's checked paydays — inside their days to land too — those a row matches to the cent that sits
   * unattached (`CashEarningsReading.unattachedPaydays`), oldest first — never "the pay did not reach …", never
   * "with no deposit" nor "not banked yet", and still counted in the silence.
   */
  silenceUnattached: readonly UnattachedMatch[];
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
  /**
   * The header link: where `monthlyRateCents` is checked, and the page it opens in a word — `monthIncomeLink`, the
   * runway's earn row's link. 🔴 It was a bare `/recurring` (Upcoming) over the same figure (review of 59de07f,
   * 2026-10-12): on his ledger copy that day the rate is levelled from It America LLC's weekly pay, whose page it
   * now opens.
   */
  incomeLink: IncomeLink;
  /** the sentence under the headline: how much of the implied pay was banked */
  summary: string;
  pay: IncomePayLine[];
  totals: Gap & { impliedCents: number; bankedCents: number };
  /**
   * What the subtotal of several pay lines is called (`reachedLabel`): "Reached a bank", and of nothing banked
   * "Reached an account the ledger reads" — the scope the headline over it says the same zero in.
   */
  bankedLabel: string;
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
  /**
   * ⚖️ §6A 68's second reader (2026-10-13): `incomeExpectation(...).noIncomeDayRead`, passed through — not one day of
   * the month checked where the pay lands and nothing posted, so `postedThisMonthCents` is no measurement and the row
   * prints "—", exactly where /budgets' header prints "— in so far". ⛔ Never re-derived from this card's own lines:
   * /budgets reads every live pay series, detected ones too, and a second rule would let the two pages disagree.
   */
  noIncomeDayRead: boolean;
  /** "Aug 2026" — the month that figure describes */
  postedMonth: string;
  /** why an empty month is not the same as an unpaid one — or, with no day of it checked, why nothing is shown */
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
 * Four innocent explanations, straight out of `lib/cash-earnings`, and this
 * module cannot distinguish between them. Printing the gap without printing
 * this is how "you are owed $11,117.00" gets read off a subtraction.
 */
/*
 * ⚖️ Default built, not asked (2026-10-21): "Pay", never "Cash pay" — since Aug 27, 2026 his pay is payroll by ACH
 * into Wells Fargo (decision 55), so the explanations are true of a payroll too: one landing in an account the ledger
 * does not read looks exactly like one never paid. 🔴 "Cash pay can sit undeposited, be spent without ever touching a
 * bank, or …" sat under his payroll's difference — the forecast had already stopped saying "Cash pay" (review of the
 * pay-words batch).
 */
const CAVEAT =
  "A difference is not money the app has found. Pay taken in cash can sit undeposited or be spent without ever " +
  `touching a bank, payroll can land in ${ACCOUNT_NOT_READ}, or the arrangement can have quietly ended — nothing ` +
  "here can tell those apart.";

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
 *
 * ⛔ Dated at both ends or neither: inside today's year in the card's day ("Jun 4 – Oct 29"), and where an end is
 * not, in the house range form (`dayWindowLabel`), each year said once. 🔴 Review of ffb1b2d3 (LOW): read Jan 8, 2027,
 * each end spelled against today read "19 paydays, Sep 3, 2026 – Jan 7" — his ledger copy that day, "28 paydays, Jul 2,
 * 2026 – Jan 7".
 */
function paydaysLabelFor(
  paydays: number,
  firstOn: string | null,
  lastOn: string | null,
  day: DayWord,
  today: string,
): string {
  if (paydays === 0 || firstOn === null || lastOn === null) return "no paydays in this window";
  const thisYear = [firstOn, lastOn].every((d) => d.slice(0, 4) === today.slice(0, 4));
  const span =
    firstOn === lastOn
      ? day(firstOn)
      : thisYear
        ? `${day(firstOn)} – ${day(lastOn)}`
        : dayWindowLabel(firstOn, lastOn);
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
function verdictFor(line: Omit<IncomePayLine, "verdict">, day: DayWord): string {
  const { lastBankedOn, silentPeriods, checkedSilentPeriods, checkedThrough } = line;

  // ⛔ "banked", decision 75's word: a payroll attributed and returned the same day banked nothing, and it WAS
  // attributed. 🔴 "No deposit has been attributed to this schedule" was said of one (review of the pay-chain batch).
  if (lastBankedOn === null) {
    return "Nothing attributed to this schedule has banked on or before today, so there is nothing to date the silence from.";
  }

  const passed = `${silentPeriods} ${paydayWord(silentPeriods)} ${silentPeriods === 1 ? "has" : "have"} passed`;
  /*
   * ⛔ The paydays the count leaves out are named after the deposit's day, as /spending's stale note names them
   * (`paidEarlyAside`) — on BOTH leads, so no form of the verdict prints the count without them. 🔴 Review of 337baa7:
   * "2 paydays have passed since the last deposit on Sep 30" with Oct 1, which Sep 30 paid early, 8 and 15 passed.
   * 🔴 Review of the pay-words batch (#25): named on that lead and, by d632de3, on the stale form at the bar, the "with
   * no deposit" lead still dropped them twice. On his ledger copy 2026-10-29 with Wed Sep 30 +$1,141.92 inserted, read
   * through Oct 17 on Oct 19: "2 paydays have passed since Sep 30 with no deposit — a schedule is called stale only
   * after 3 quiet periods, …"; with Wells Fargo unchecked on Oct 29: "3 paydays have passed since Sep 30 with no
   * deposit, and no day of that silence rests on a checked record — …", four Thursdays passed.
   */
  const aside = paidEarlyAside(line.silencePaidEarly, day);
  /*
   * ⛔ "With no deposit" only where no row matches one of them unattached (`silenceUnattached`, the one rule's): "with
   * no deposit attached to this schedule" then, and the rows named. 🔴 His ledger copy 2026-10-29 (before his filing):
   * "4 paydays have passed since Sep 24 with no deposit. 4 of them fall on days the records already cover, through Oct
   * 26 — so the pay did not reach a bank." beside four +$1,141.92 payroll rows on Wells Fargo, unattached. ⚖️ …and of
   * rows the import attached and filed nowhere, "attached to this schedule and filed as income" (`countedDepositWords`).
   */
  const matched = line.silenceUnattached;
  const noDeposit =
    matched.length === 0 ? "with no deposit" : `with no deposit ${countedDepositWords(matched, "this schedule")}`;
  const since = `${passed} since ${day(lastBankedOn)} ${noDeposit}${aside}`;
  /*
   * which of the silent paydays the ledger has looked for, in the forecast's words — null when it looked for them all.
   * ⛔ With the rows the one rule matched, as /budgets and the forecast pass them: never "with no deposit" of a checked
   * payday a row answers. 🔴 Found sweeping the rule's readers (2026-10-29): on a copy of his ledger with Oct 1, 8 and 15
   * filed, Oct 22's row unattached and today Nov 2, the verdict read "1 falls on a day already checked, with no deposit"
   * one line over the difference naming the row.
   *
   * ⛔ …and its rows in the card's day (`DayWord`), as the difference under it names them — never the clause's own
   * spelling, against the newest row. 🔴 Review of 87a440d0 (MEDIUM): read Jan 8, 2027, Dec 31's +$1,141.92 attached
   * to nothing and Wells Fargo checked through Jan 4, it said "…by a row of $1,141.92 on Dec 31 that is not attached to
   * it" after "since the last deposit on Dec 24, 2026", over the difference's "…on Dec 31, 2026…".
   */
  const unread = unbankedIncomeFrontierClause(
    {
      occurrenceCount: silentPeriods,
      checkedOccurrenceCount: checkedSilentPeriods,
      frontier: checkedThrough === null ? { kind: "unchecked" } : { kind: "day", through: checkedThrough },
      unattached: matched,
    },
    day,
    day,
  );
  // "with no deposit" is the clause's to say, and only of the days it checked
  const sinceLast = `${passed} since the last deposit on ${day(lastBankedOn)}${aside}`;
  const notAllLooked = unread === null ? null : `${sinceLast}. ${unread}`;

  if (line.basis === "series-live") {
    if (silentPeriods === 0) {
      return `Pay is arriving: the last deposit landed on ${day(lastBankedOn)}.`;
    }
    // ⛔ of the silent paydays, the ones the rows answer (`matchedOfWords`): "…with no deposit attached to this
    // schedule: it is matched to the cent by a row of …" was said of a silence two paydays long that one row answers
    // (found sweeping the rule's readers for the review of e6ad55a)
    const rows = matched.length === 0 ? "" : `: ${matchedOfWords(matched, silentPeriods, day)}`;
    return (
      notAllLooked ??
      `${since}${rows} — a schedule is called stale only after ${STALE_PERIODS} quiet periods, so this is not a warning yet.`
    );
  }

  if (checkedThrough === null) {
    return `${since}, and no day of that silence rests on a checked record — the ledger cannot say whether the pay arrived.`;
  }

  /*
   * ⚖️ Short of the bar on the days the ledger has read, a stale schedule's silence says what a live one's does — the
   * sentence /budgets' passed paydays and the forecast say of the same paydays (`unbankedIncomeFrontierClause`).
   * 🔴 It had its own: "3 paydays have passed since Sep 24 with no deposit, but only 0 of them fall on days the records
   * cover. The other 3 sit inside the 27 days past Sep 24, …" — his ledger copy 2026-10-21, Wells Fargo checked through
   * Sep 24, while /budgets said of the same Oct 1, 8 and 15 "They all fall after Thu, Sep 24, 2026, … — so the ledger
   * has not looked for their deposits"; and "with no deposit" of days nobody had read.
   */
  if (checkedSilentPeriods < STALE_PERIODS && notAllLooked !== null) return notAllLooked;

  /*
   * ⛔ At or over the bar, every payday of the silence is named, and "with no deposit" only of a silence the ledger
   * checked to its end: past the checked day it is a claim about days nobody has read (27ca437's V2), so the lead is
   * the one below the bar's — "since the last deposit on …", with the paydays its count leaves out (`paidEarlyAside`)
   * — and the paydays after the checked day close the breakdown, not looked for. 🔴 Review of 0c9bc8d (MEDIUM, there
   * before 337baa7): on his ledger copy 2026-10-21 with a Salary-filed −$1,141.92 on Fri Sep 25, Wells Fargo read
   * through Fri Oct 16 and today Oct 23, it read "4 paydays have passed since Sep 24 with no deposit. 2 of them, and
   * their days to land, fall on days the records already cover, through Oct 16 — so the pay did not reach a bank;
   * Oct 15's days to land run past Oct 16, … — so its pay is not banked yet." — Oct 22 never named, beside the label's
   * "the other $1,141.92 is for paydays after that day — so the ledger has not looked for it".
   */
  const unlooked = silentPeriods - checkedSilentPeriods;
  const lead = unlooked > 0 ? sinceLast : since;
  const notYet = line.checkedSilentNotBankedYet;
  const checked = staleChecked(checkedSilentPeriods, notYet, checkedThrough, unlooked, matched, day);
  return `${lead}. ${checked}. Whether it was earned is a different question, and this card cannot answer it.`;
}

/**
 * What a stale schedule's checked silence says: "did not reach an account the ledger reads" of the paydays checked
 * through their days to land, and "not banked yet" of those still inside them (`checkedSilentNotBankedYet`) — the
 * difference line's split (`unbankedSplit`), in the words /spending's note for a stale schedule says it in
 * (`payNotBankedYet`).
 *
 * ⚖️ "Did not reach" only of a payday checked through its days to land (`paydayLandingIsRead`). 🔴 Review of
 * 4b98f77: weekly pay through Aug 6, Chase read through Sat Sep 5, today Sep 15 — this said "4 of them fall on days the
 * records already cover, through Sep 5 — so the pay did not reach a bank" one line under "$3,000.00 of it never
 * reached a bank; $1,000.00 is for paydays whose days to land run past Sep 5 … — so it is not banked yet" of Thu Sep 3.
 * On his ledger copy 2026-10-21 with Wells Fargo checked through Fri Oct 16 and no October deposit, it would have said
 * "3 of them … did not reach a bank" of Oct 1, 8 and 15, beside "$1,141.92 is for paydays whose days to land run past
 * Oct 16 … — so it is not banked yet".
 *
 * ⛔ …and the silence's paydays after the checked day (`unlooked`) last, in the forecast's words — "the other one falls
 * after Oct 16 — so the ledger has not looked for its deposit" (`theOtherFall`, `notLookedForDeposits`), the checked day
 * named in full once — so the breakdown adds up to the count before it (review of 0c9bc8d).
 *
 * ⛔ …and its checked paydays in the forecast's words too, "fall on days already checked"
 * (`unbankedIncomeFrontierClause`) — the words the dashboard's tile says them in, one card over, and this card's own
 * verdict short of the bar. 🔴 Review of 082a0ef5 (LOW): on a copy of the trial import read Oct 30, the tile said "4
 * fall on days already checked, with no deposit; the other one falls after Oct 26, …" and this "4 of them fall on days
 * the records already cover, through Oct 26 — so the pay did not reach a bank; the other one falls after Oct 26, …" of
 * Oct 1, 8, 15 and 22. The checked day is named where the breakdown names it in full: after it, or where the days to
 * land run past it.
 *
 * ⚖️ …and of the accounts the ledger reads (`ACCOUNT_READ`), as the difference above it says the same paydays
 * (`NEVER_REACHED`) — default built, not asked (2026-10-30). 🔴 Review of 87a440d0 (MEDIUM): "so the pay did not reach
 * a bank" beside the card's own caveat, "payroll can land in an account the ledger does not read".
 */
function staleChecked(
  checked: number,
  notBankedYet: readonly string[],
  checkedThrough: string,
  unlooked: number,
  matched: readonly UnattachedMatch[],
  day: DayWord,
): string {
  const covered = ON_DAYS_ALREADY_CHECKED;
  /*
   * ⛔ …and "not banked yet" only of the paydays no row matches either: a row of a payday still inside its days to land
   * is named with the others, never "its pay is not banked yet" — and then the paydays it is named with are said to
   * fall on covered days, never with their days to land (review of 304c59a4, MEDIUM: Oct 22's row, read Oct 24).
   */
  const matchedInGrace = matched.filter((m) => notBankedYet.includes(m.date));
  const notYet = notBankedYet.filter((d) => !matchedInGrace.some((m) => m.date === d));
  // ⛔ "did not reach" only of the paydays no row matches unattached (`silenceUnattached`): those are named
  const pastCount = checked - notYet.length;
  const didNot =
    matched.length === 0
      ? `so the pay did not reach ${ACCOUNT_READ}`
      : matchedOfWords(matched, pastCount, day) +
        (matched.length >= pastCount
          ? ""
          : // "the other one" of one (`theOther`) — 🔴 "for the other 1" (review of ffb1b2d3, LOW)
            `, and for ${theOther(pastCount - matched.length)} the pay did not reach ${ACCOUNT_READ}`);
  const after = (dayNamed: boolean): string =>
    unlooked <= 0
      ? ""
      : `; ${theOtherFall(unlooked)} after ${day(checkedThrough)}` +
        `${dayNamed ? "" : `, ${LAST_CHECKED_DAY}`} — so ${notLookedForDeposits(unlooked)}`;
  if (notYet.length === 0) return `${checked} of them fall ${covered} — ${didNot}${after(false)}`;

  // `why` names the checked day in full
  const why = payNotBankedYet(notYet, checkedThrough, day, day);
  if (pastCount === 0) return `${checked} of them fall ${covered}, but ${why}${after(true)}`;
  const them =
    matchedInGrace.length > 0
      ? `${pastCount} of them ${pastCount === 1 ? "falls" : "fall"}`
      : pastCount === 1
        ? "1 of them, and its days to land, falls"
        : `${pastCount} of them, and their days to land, fall`;
  return `${them} ${covered} — ${didNot}; ${why}${after(true)}`;
}

/** The first day the card measures from: the spend baseline's months back from this month's 1st. */
function cardWindowFrom(today: string): string {
  return `${monthKey(addCalendarMonths(`${monthKey(today)}-01`, -SPEND_BASELINE_MONTHS))}-01`;
}

/**
 * The series Earned vs banked prints a pay line for — its own readings, one line each, so a page asking "is it on
 * the card?" reads the card. The End dialog on a pay series names the line ending it takes off (`seriesEndHeadline`).
 */
export function incomeCardSeriesIds(db: AppDatabase, today: string = todayIso()): ReadonlySet<string> {
  return new Set(cashEarningsReadings(db, { from: cardWindowFrom(today), to: today, today }).map((r) => r.seriesId));
}

export function incomeCard(db: AppDatabase, today: string = todayIso()): IncomeCard | null {
  const windowFrom = cardWindowFrom(today);
  // ⛔ every day the card names, in the tile's spelling (`DayWord`)
  const cardDay: DayWord = (iso) => formatDayShortIn(iso, today);

  // ⛔ with the frontier: the banked figure, and the money out it names, are the one rule's (`moneyOutOfWindow`)
  const readings = cashEarningsReadings(db, { from: windowFrom, to: today, today, withChecked: true });
  // No confirmed income series with evidence behind it: there is no schedule to
  // reconcile against, and a card of zeroes is worse than no card.
  if (readings.length === 0) return null;

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

  // ⚡ the category index the lines' settlements read their pay days by, loaded once for them all (`paydaySettlement`'s
  // `idx`) — when a line settles at all. 🔴 Loaded per line, each pay series re-read the categories table on every load
  // (review of the pay-words batch, #26).
  const idx = readings.some((r) => r.checkedThrough != null) ? loadCategoryIndex(db) : undefined;
  const pay: IncomePayLine[] = readings.map((r) => {
    /*
     * The EARLIEST verifiedThrough across every account this pay has landed in.
     * A payday could have arrived in any of them, so the ledger has only checked
     * every possible landing place through the first date one of them stops. A
     * single unverified account collapses the whole thing to null, which is the
     * honest answer rather than a convenient one.
     */
    const checkedThrough = r.checkedThrough ?? null;

    const asChecked = checkedThrough === null ? undefined : readingAsOf(checkedThrough, r.seriesId);
    const frontier: UnbankedFrontier =
      checkedThrough === null ? { kind: "unchecked" } : { kind: "day", through: checkedThrough };
    // what the schedule implies past the frontier, and over how many paydays: every one when nothing is checked
    const unread: Unread = {
      impliedCents: r.impliedCents - (asChecked?.impliedCents ?? 0),
      paydays: r.periodsCovered - (asChecked?.periodsCovered ?? 0),
      frontier,
    };
    // ⚖️ …and of the checked paydays, those no deposit settled still inside their days to land: not banked yet — over
    // the window for the difference, and over the silence for the verdict (the reading's `checkedSilentNotBankedYet`)
    const settlement = checkedThrough === null ? null : paydaySettlement(db, r.seriesId, today, idx);
    const inGrace =
      settlement === null || checkedThrough === null
        ? { paydays: [], cents: 0 }
        : paydaysNotBankedYet(settlement, {
            from: windowFrom,
            to: today,
            today,
            checkedThrough,
            toleranceDays: r.toleranceDays,
          });
    // the window's paydays the one rule matched unattached (`unattachedPaydays`) — those still inside their days to
    // land are the not-banked-yet part's, the rest the never part's (`namedTogether` names them all once)
    const windowMatched = (r.unattachedPaydays ?? []).filter((m) => compareDates(m.date, windowFrom) >= 0);
    const inGraceMatched = windowMatched.filter((m) => inGrace.paydays.includes(m.date));

    const base = {
      seriesId: r.seriesId,
      name: r.seriesName,
      impliedCents: r.impliedCents,
      paydays: r.periodsCovered,
      paydaysLabel: paydaysLabelFor(r.periodsCovered, r.firstPeriodOn, r.lastPeriodOn, cardDay, today),
      bankedCents: r.bankedCents,
      wentBackOut: r.wentBackOut ?? [],
      basis: r.basis,
      lastBankedOn: r.lastBankedOn,
      silentPeriods: r.periodsSinceBanked,
      silencePaidEarly: r.silencePaidEarly,
      /*
       * ⛔ The reading's own (`checkedSilence` over its as-of reading): the silence it counts, none a deposit paid. 🔴
       * Review of 27ca437: read off this card's as-of reading, which asks without the settlement, it counted Thu Oct 1
       * — paid early by Wed Sep 30's payroll — as "1 falls on a day already checked, with no deposit".
       */
      checkedSilentPeriods: r.checkedPeriodsSinceBanked ?? 0,
      // ⛔ the silence's — /spending's stale note's own reading (`silentPaydaysNotBankedYet`), never a second one
      checkedSilentNotBankedYet: r.checkedSilentNotBankedYet ?? [],
      // ⛔ …and of its paydays the one rule matched unattached — the silence opens after the last day that banked — by
      // the one reading /spending's note for a stale schedule names them by (`silenceMatches`)
      silenceUnattached: silenceMatches(r.unattachedPaydays ?? [], r.lastBankedOn),
      checkedThrough,
      unreadDays: checkedThrough === null ? null : diffDays(checkedThrough, today),
      ...gapOf(
        r.impliedCents,
        r.bankedCents,
        unread,
        { cents: inGrace.cents, paydays: inGrace.paydays.length, frontier, unattached: inGraceMatched },
        r.wentBackOut ?? [],
        windowMatched.filter((m) => !inGrace.paydays.includes(m.date)),
        cardDay,
      ),
    };
    return { ...base, verdict: verdictFor(base, cardDay) };
  });

  const impliedCents = pay.reduce((s, l) => s + l.impliedCents, 0);
  const bankedCents = pay.reduce((s, l) => s + l.bankedCents, 0);
  // the lines' own unread and not-banked-yet parts, each against the one day its lines share when they share one
  const unread = pay.filter((l) => l.unreadGapCents > 0);
  const inGrace = pay.filter((l) => l.notBankedYetCents > 0);
  const totals = {
    impliedCents,
    bankedCents,
    ...gapOf(
      impliedCents,
      bankedCents,
      {
        impliedCents: unread.reduce((s, l) => s + l.unreadGapCents, 0),
        paydays: unread.reduce((s, l) => s + l.unreadPaydays, 0),
        frontier: sharedFrontier(unread.map((l) => l.checkedThrough)),
      },
      {
        cents: inGrace.reduce((s, l) => s + l.notBankedYetCents, 0),
        paydays: inGrace.reduce((s, l) => s + l.notBankedYetPaydays, 0),
        frontier: sharedFrontier(inGrace.map((l) => l.checkedThrough)),
        unattached: pay.flatMap((l) => l.notBankedYetUnattached),
      },
      pay.flatMap((l) => l.wentBackOut),
      pay.flatMap((l) => l.unattached),
      cardDay,
    ),
  };
  const bankedSharePct = impliedCents <= 0 ? null : Math.round((bankedCents / impliedCents) * 100);

  const month = periodBounds(today, "monthly");
  const expectation = incomeExpectation(db, month.start, month.end, today);
  const postedThisMonthCents = expectation.postedCents;
  const postedMonth = formatMonthYear(today);
  // the rows the lines above name that landed this month — what an empty month's note says is there
  const thisMonthsRows = pay.flatMap((l) =>
    l.silenceUnattached.filter((m) => compareDates(m.row.postedOn, month.start) >= 0),
  );

  return {
    monthlyRateCents: expectation.basis.cents,
    incomeLink: monthIncomeLink(expectation, month.start, today),
    summary: summaryFor(bankedSharePct, totals.impliedCents, totals.bankedCents, windowFrom),
    pay,
    totals,
    bankedLabel: reachedLabel(totals.bankedCents),
    bankedSharePct,
    postedThisMonthCents,
    noIncomeDayRead: expectation.noIncomeDayRead,
    postedMonth,
    /*
     * 🔴 With no day of the month checked where the pay lands, "an empty month is what an unimported month looks like"
     * stood under a $0.00 nobody had looked for — his ledger copy 2026-10-12, Wells Fargo checked through Sep 24 —
     * while /budgets' header printed "— in so far" off the same reading. The note says why there is no figure.
     */
    /*
     * ⛔ …and an empty month whose paydays rows match unattached (`silenceUnattached`) is neither unimported nor
     * unpaid: the note says the rows are there. 🔴 His ledger copy 2026-10-29 (before his filing): "An empty month is
     * what an unimported month looks like as well as what an unpaid one looks like" under four payroll rows of October.
     * ⚖️ …and of rows attached and filed nowhere, why: "not filed as income" (`notCountedWords`).
     */
    postedNote: expectation.noIncomeDayRead
      ? noIncomeDayCheckedNote(postedMonth)
      : postedThisMonthCents === 0
        ? thisMonthsRows.length > 0
          ? `No income at all has been recorded in ${postedMonth}, though the rows the lines above name match its paydays to the cent — they are ${notCountedWords(thisMonthsRows, "the schedule")}, so none of them is counted.`
          : `No income at all has been recorded in ${postedMonth}. An empty month is what an unimported month looks like as well as what an unpaid one looks like — the lines above say which this is.`
        : `That is what has been imported so far, not what was earned in ${postedMonth}.`,
    caveat: CAVEAT,
    windowFrom,
    today,
  };
}

/**
 * ⚖️ What the subtotal under several pay lines is called: "Reached a bank" of money the ledger read in one, and of none
 * the absence in the headline's scope — `ACCOUNT_READ`, "Nothing has reached an account the ledger reads"
 * (`summaryFor`'s zero, the one test both read). ⚖️ default built, not asked (2026-11-05): Default A's own rule of
 * 2026-10-30, a deposit the ledger read "reached a bank" and only an absence is scoped to where the ledger looks.
 * 🔴 Review of ffb1b2d3 (LOW): two confirmed weekly schedules, nothing banked in the window, read Jan 20, 2027 — the
 * card said "Nothing has reached an account the ledger reads, against $34,800.00 …" over "Reached a bank $0.00 of
 * $34,800.00 implied". Latent on his ledger copy 2026-11-05: one pay line, so no subtotal.
 */
function reachedLabel(bankedCents: number): string {
  return nothingReached(bankedCents) ? `Reached ${ACCOUNT_READ}` : "Reached a bank";
}

/** Nothing banked: what the headline and the subtotal say in the accounts the ledger reads (`ACCOUNT_READ`). */
const nothingReached = (bankedCents: number): boolean => bankedCents === 0;

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
 *
 * ⚖️ "Nothing has reached `ACCOUNT_READ`": an absence, said of where the ledger looks, as the difference under it says
 * it (`NEVER_REACHED`) beside the caveat's account the ledger does not read — default built, not asked (2026-10-30,
 * review of 87a440d0). What did reach one "reached a bank": the ledger read it there.
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
  if (nothingReached(bankedCents)) {
    return `Nothing has reached ${ACCOUNT_READ}, against ${formatCents(impliedCents)} the confirmed schedule implies you earned. ${measured}`;
  }
  if (bankedCents === impliedCents) {
    return `${formatCents(bankedCents)} has reached a bank — exactly what the confirmed schedule implies you earned. ${measured}`;
  }
  if (bankedCents > impliedCents) {
    return `${formatCents(bankedCents)} has reached a bank, ${formatCents(bankedCents - impliedCents)} more than the confirmed schedule implies you earned — pay banked in lumps outruns the window it is measured over. ${measured}`;
  }
  return `${formatCents(bankedCents)} of the ${formatCents(impliedCents)} the confirmed schedule implies you earned reached a bank — ${bankedSharePct}% of it. ${measured}`;
}
