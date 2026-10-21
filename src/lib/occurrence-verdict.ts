import type { SeriesKind } from "@/db/schema/recurring";
import { addDays, compareDates } from "./dates";

/**
 * What the calendar is allowed to SAY about one expected occurrence.
 *
 * ## The bug this exists to make unrepresentable
 *
 * The recurring calendar used to have four day-states, and the one it reached
 * for whenever an expected charge had not posted was `missed` — red, ✕, "you
 * did not pay this". Measured on the real ledger on 2026-08-25, that painted
 * **six** red marks across August:
 *
 * | day | series | actually? |
 * |---|---|---|
 * | 08-06 | Cash job (weekly pay) | he was paid in cash; it is in his safe |
 * | 08-10 | Breezeline | Venture X is imported through 08-14 — really absent |
 * | 08-10 | FPL | Chase Checking imported through 08-12 — really absent |
 * | 08-13 | Cash job (weekly pay) | Chase Checking stops at 08-12 — unknown |
 * | 08-15 | Rocket Money | Chase Checking stops at 08-12 — unknown |
 * | 08-20 | Cash job (weekly pay) | unknown |
 *
 * Two of the six were real. The other four were the calendar reporting a
 * failure it had no evidence for — August's statements simply have not been
 * uploaded yet, which in this ledger is the normal monthly rhythm and not a
 * defect. Absence of evidence was being rendered as evidence of absence, in the
 * loudest colour on the page.
 *
 * ⚠️ And the opposite error is just as real: pass 45 found $2,285.70 of overdue
 * rent sitting behind a budget that read green. A genuinely missed bill on a day
 * the ledger HAS been shown must still read as missed. So this module does not
 * soften `missed` — it narrows it to the days that can support the claim.
 *
 * Pure: no DB, no React, no `Date`, no `Math.random`.
 */

/** A past occurrence that never posted, and why we cannot call it missed. */
export type UnsettledReason =
  /** money OUT: the ledger has not been shown this day, and its grace, for the account(s) this bills on */
  | "not_imported"
  /**
   * money IN: a payday after the last day every account its pay lands in has been checked through, or with one of
   * them never checked (`paydayIsRead`) — nobody has looked for its deposit. ⚖️ Its own reason, in the pay sentences'
   * words (`notLookedForDeposits`), never a bill's: 🔴 it shared `not_imported` and read "no statement has covered it
   * yet" beside pay landing in an archived account or a cash wallet, which no statement will ever cover.
   */
  | "not_looked_for"
  /**
   * money OUT, on accounts read through today (`DueDayReading.readsToToday`) — archived, a cash wallet, or checked to
   * the day: no statement keeps it unread, only the days a payment has to post, still to come. ⚖️ Not a new verdict: the
   * same quiet "?" as `not_imported`, in the words of what it waits for.
   */
  | "in_grace"
  /** money IN, on a day the ledger HAS looked: its absence from the ledger is never proof it did not happen */
  | "unbanked"
  /** too few postings to know when this is due — the date itself is a guess */
  | "schedule_unproven";

export type OccurrenceState =
  /** posted, within the series' own noise band of the expected amount */
  | "paid"
  /** posted, but the amount moved enough to be worth seeing */
  | "paid_different"
  /** expected before today, did not post, and the day IS covered */
  | "missed"
  /** expected before today, did not post, and the ledger cannot yet say */
  | "unsettled"
  /** expected on or after today */
  | "upcoming";

/**
 * How firmly the app is entitled to assert a FUTURE occurrence.
 *
 * The owner asked for this by name — *"how it shows future confirmed charges vs
 * future unconfirmed"*. Today every future mark is one state, `upcoming`, and a
 * lease he typed in himself draws identically to a weekly smoothie the detector
 * noticed twice. Those are not the same claim.
 */
export type ForecastConfidence =
  /** the owner told the app: a user-set amount or a user-set date */
  | "scheduled"
  /** confirmed by the owner, but the figures come from posted history */
  | "expected"
  /** the app inferred the series itself and nobody has agreed to it */
  | "predicted";

/**
 * Can this occurrence's ABSENCE from the ledger be read as evidence?
 *
 * Money out: yes. A card charge either appears on the statement covering its day
 * or it does not, so once that day is imported, silence is an answer.
 *
 * Money in: no — and this is not a nicety, it is this ledger's central fact. The
 * owner is paid weekly in cash from a job whose deposits are irregular by
 * nature; pass 60 measured $12,552 implied against $1,447 banked, with eleven
 * paydays silent. Cash he has been handed and not yet deposited never touches
 * the ledger at all, so a bank statement can no more disprove a payday than it
 * can disprove the weather. Marking those eleven days red would be the app
 * telling him he was not paid, eleven times.
 *
 * ⚠️ Shares its root with `lapsedSeriesShouldStopForecasting`, which splits the
 * same way for the same reason, but answers a different question — that one asks
 * whether to keep FORECASTING a series that has gone quiet, this one asks
 * whether a specific silent day is an accusation. They are deliberately separate
 * functions: pass 54's lesson is that two answers which must stay consistent
 * should not be derived twice, and these two are not required to agree — they
 * are required to share a premise, which the prose above carries.
 */
export function absenceIsEvidence(kind: SeriesKind): boolean {
  return kind !== "income";
}

export interface SettledVerdict {
  state: Extract<OccurrenceState, "missed" | "unsettled">;
  /** null exactly when `state` is "missed" */
  reason: UnsettledReason | null;
}

/**
 * Whether a series' expected DATE is established well enough to hold a biller
 * to it — supplied by the caller, which decides it from the series' posting
 * count (see `scheduleIsProven` in `recurring-calendar`).
 *
 * A boolean rather than the count, so the threshold has exactly one definition
 * in the codebase and this module never has to import from a service.
 *
 * ## Why this gate exists
 *
 * Both of the two `missed` marks that survived the coverage narrowing on the
 * real ledger were still wrong, and neither was a coverage problem:
 *
 * | series | postings | app expected | actually charged |
 * |---|---|---|---|
 * | FPL (electricity) | 1 | 2026-08-10, $14.21 | 2026-07-28, $56.22 |
 * | Breezeline (internet) | 2 | 2026-08-10, $50.00 | 2026-08-10, $50.00 |
 *
 * FPL's due date was extrapolated from a SINGLE observation and was wrong by
 * thirteen days; the calendar then reported the biller as delinquent on a date
 * the app had invented. Breezeline's charge landed exactly where predicted and
 * is sitting in the ledger untagged, because detection will not tag a
 * description group holding fewer than `MIN_OCCURRENCES` rows — so a confirmed
 * series with a hand-linked history cannot absorb its own new charges. With the
 * gate, August 2026 draws ZERO missed marks, which is the measured truth: all
 * six of the original red ✕ were false.
 *
 * One observation is not a cadence. `MIN_OCCURRENCES` is already this codebase's
 * line between a statistic and an anecdote, and `classifyPostedAmount` was
 * taught the same lesson about amounts in this pass.
 *
 * ## Why a series with NO postings is trusted, and one with two is not
 *
 * The rule is about where the date CAME FROM, and the posting count is the only
 * proxy the schema offers — `next_expected_on` looks identical whether a human
 * typed it or detection extrapolated it.
 *
 *  - **No postings at all**: nothing could have been extrapolated, so the date
 *    is a human's statement. The owner's car lease (registered by hand for the
 *    15th, never charged) is among the most certain dates in the ledger and
 *    must stay missable.
 *  - **One or two postings**: the date IS detection's estimate, drawn from too
 *    few points to be one. This is the population that produced both false
 *    accusations above.
 *
 *    ⚠️ …or a date TYPED by hand that has since had a charge linked to it by
 *    hand — the count cannot see who wrote the date. 🔴 This bullet used to name
 *    Car insurance under "never charged … must stay missable"; linking its first
 *    charge (PROGRESSIVE INS -$357.58, 2026-08-12, linked 2026-09-03) moved it
 *    here, and on 2026-09-14 this band was the only thing keeping its Sep 11
 *    from a false red ✕. Its one posting is on Venture X, imported through
 *    09-13, while the payments after the first were registered to bill on Wells
 *    Fargo, imported through 08-25 — and no billing account is recorded, so the
 *    coverage check vouched for a day the paying account had not been shown.
 *    ⛔ Do not widen this gate to trust a typed date (`userNextExpectedOn`, or
 *    the "scheduled" confidence) while the account it bills on is not in the
 *    data: measured, that turns Sep 11 into "missed". The reason word is "too
 *    few charges to grade yet" (`unsettledReasonWord`) — what was counted.
 *
 *    ⚠️ Linking at import reaches this band with no hand at all: a registered
 *    commitment's first charge, linked by `linkFirstPostings`, moves it from
 *    zero postings to one, so its next missed payment reads "too few charges
 *    to grade yet" until `MIN_OCCURRENCES` charges have linked — while
 *    `overdueForSeries`, which has no posting-count gate, counts it owed.
 *    ⛔ OWNER DECISION G2 (a), 2026-09-14: keep the count. He was shown (b),
 *    trusting a typed date at any posting count, and that it turns a
 *    typed-date bill red, and chose (a).
 *  - **`MIN_OCCURRENCES` or more**: a measured cadence. Hold the biller to it —
 *    pass 45's $2,285.70 of overdue rent (three postings) still reads missed.
 *
 * A detected series always has at least `MIN_OCCURRENCES` rows by construction,
 * so the middle band is reachable only by hand-created series, which is exactly
 * where both defects were found.
 */
export type ScheduleProven = boolean;

/**
 * How far the ledger has read the days a series' bill can be PAID on: the last day it has been shown for every account
 * the series posts to now, and the grace a payment has to post after its due day.
 */
export interface DueDayReading {
  /**
   * The last day the ledger has been shown for the account(s) this series posts to now — ⚖️ the day its "running late"
   * chip measures to (`silenceMeasuredThroughBySeries`, his decision 62, 2026-10-12): the accounts its last two payments
   * posted to and the one it names (his decision 66), each to its checked balance, the earliest — `null` when nothing is
   * known at all, the most cautious input. ⚖️ An account no statement will ever come for (archived, or a cash wallet)
   * counts as shown through today (`silenceReadThrough`, 2026-10-08): nothing more is coming.
   */
  observedThrough: string | null;
  /**
   * The days after its due day a covering payment may still post on — the bill's `toleranceDays`, the window
   * `paymentFor` pays an occurrence ON TIME within (one past it pays it late, once it has come); for a bill paid
   * inside another's payment, the widest of its own and its carrier's (`dueDayGraces`, the two by name in
   * `CarriedGrace`) — and a carrier's its own alone, never widened by what it carries.
   */
  graceDays: number;
  /**
   * Whether `observedThrough` reaches TODAY — every account it may land in checked to the day, or one no statement will
   * come for (archived, a cash wallet). A due day unread then waits for no statement: only for the days a payment has to
   * post, still to come — today among them, read once it is over (`lastDueDayRead`) — the words `in_grace` and
   * `ArrearsReading.inGraceCents` say it in.
   */
  readsToToday: boolean;
}

/**
 * ⚖️ The two windows a bill billed inside another's payment (§6A 59) is paid within: a posting of its own within its
 * own `toleranceDays` of a due day, and a payment of its carrier's within the CARRIER's — each payment by its own
 * series' tolerance (`paymentFor`). Its grace is the wider (`DueDayReading.graceDays`); what its page says the imports
 * hold no posting within names each (`alreadyDueWords`). 🔴 It named the wider alone (review of 44eb3e7): with the
 * rent's 5 and the utilities' own 3, their page read "hold no posting within 5 days of it" beside a posting of their
 * own four days off the day, which paid them nothing.
 */
export interface CarriedGrace {
  readonly ownDays: number;
  /** the carrier's own name — "Flamingo South Beach (rent)", said "the rent" (`carrierWord`) */
  readonly carrierName: string;
  readonly carrierDays: number;
}

/**
 * The last DUE day the ledger has read for a series: the last day its accounts are read through, less its grace — null
 * when nothing is read. A due day on or before it is read (`dueDayIsRead`); one after it may still be paid by a posting
 * no checked statement has reached.
 *
 * ⛔ TODAY IS NEVER READ: a charge can still post on it — the "running late" chip measures to the day after the checked
 * day, never past today (`seriesStaleness`) — so accounts read through today (`readsToToday`) are read through the day
 * before. 🔴 Read through today itself (review of 384917c), an archived card at Oct 4 drew Oct 1's ✕ and every surface
 * said "not posted" on the last of its 3 days — while a payment posting that day still paid it on time.
 */
export function lastDueDayRead(reading: DueDayReading): string | null {
  if (reading.observedThrough === null) return null;
  const lastDayOver = reading.readsToToday ? addDays(reading.observedThrough, -1) : reading.observedThrough;
  return addDays(lastDayOver, -reading.graceDays);
}

/**
 * ⚖️ WHETHER A DUE DAY HAS BEEN READ — his decision 60 (2026-10-08): once every account the series posts to now (its
 * last two payments' accounts, his decision 62, and the one it names, 66 — its carrier's too, for one billed inside
 * another's payment) is read through the due day PLUS its grace, the days a payment may still post on, the last of them
 * over (`lastDueDayRead`) — read as its "running late" chip reads them, to each account's checked balance
 * (`dueDayReadings`). Until then a payment may be sitting where no statement has reached, so nothing may say "not
 * posted" of it — ⚖️ "no statement has covered it yet" (his decision 65, 2026-10-12: the words name what it waits for),
 * quiet.
 *
 * ⛔ THE ONE PREDICATE for every claim that a bill did not post: the calendar's red ✕ (`settledVerdict`), and the read
 * half of the arrears (`arrearsReadCents`) that the bill's page, the runway, /budgets, the End dialog, the forecast's
 * arrears line, /recurring's Next column and the category page all say their arrears through.
 *
 * 🔴 "Read" meant the due day ITSELF (`occurrenceDate <= observedThrough`), so it vouched for days after it no import
 * had reached: the e2e fixture's Meal Kit, due Jul 5 on a card imported through Jul 5, drew a red ✕ "missed", "Already
 * due, and not posted" and "$125.00 never posted" — while a payment on Jul 6, 7 or 8 would still have paid it.
 */
export function dueDayIsRead(dueOn: string, reading: DueDayReading): boolean {
  const last = lastDueDayRead(reading);
  return last !== null && compareDates(dueOn, last) <= 0;
}

/**
 * WHETHER THE LEDGER HAS LOOKED FOR A PAYDAY'S DEPOSIT: `checkedThrough` is the last day every account the pay lands
 * in NOW has been checked through (`checkedThroughBySeries`, the day every pay sentence names — `LAST_CHECKED_DAY`), or
 * null when one of them has no checked record. A payday ON that day was looked for: a deposit dated on it is in the
 * records. No grace in the split — the pay's sentences give none; only "never reached a bank" waits out a payday's
 * days to land (`paydayLandingIsRead`).
 *
 * ⛔ THE ONE PREDICATE for whether a passed payday was looked for: the calendar's "not banked yet" against "the ledger
 * has not looked for its deposit" (`settledVerdict`, `not_looked_for`), and the checked half of the passed paydays
 * (`unbankedIncomeForSeries`) that the forecast's note, the pay series' own page, /budgets and the dashboard say "the
 * ledger has not looked for their deposits" through.
 *
 * ⛔ Never the bills' reading (`dueDayReadings`), though both read where a series lands NOW (`landingAccountsBySeries`):
 * that one waits a grace the pay's sentences do not give, and reads an account no statement is coming for (archived, a
 * cash wallet) through TODAY (`silenceReadThrough`) — where this reads each to its checked record, an archived one's
 * stopping where its statements did, a deposit after it unseen (`checkedThroughBySeries`). 🔴 When the bills' reading
 * took every account a series EVER posted to (before his decision 62, 2026-10-12), it gave the pay Chase Checking's Aug
 * 12 (his ledger copy 2026-10-12) — the pay lands in Wells Fargo, checked through Sep 24 — and Aug 13 and Aug 20 would
 * have read unlooked-for beside a dashboard that counts them checked.
 */
export function paydayIsRead(paydayOn: string, checkedThrough: string | null): boolean {
  return checkedThrough !== null && compareDates(paydayOn, checkedThrough) <= 0;
}

/**
 * WHETHER THE LEDGER HAS CHECKED A PAYDAY THROUGH ITS DAYS TO LAND — its series' own `toleranceDays` after it, the
 * reach the settlement's anchor clause gives a deposit: no deposit can still answer it on a day the ledger has not
 * read.
 *
 * ⛔ THE ONE PREDICATE behind "never reached a bank" against "not banked yet", for a payday no deposit settled: the
 * forecast's note and the pay series' own page (`pastGraceOccurrenceCount`), the dashboard's Earned vs banked and
 * /spending's shortfall note (`paydaysNotBankedYet`). 🔴 Review of 878c3d5: it reached the first two alone — Thu Sep 3
 * checked through Sat Sep 5 read "Pay not banked yet" on the forecast, and "$1,000.00 of it never reached a bank" on
 * the dashboard and "none of it reached a bank" on /spending, while a deposit on Sun Sep 6 would still have paid it.
 */
export function paydayLandingIsRead(paydayOn: string, toleranceDays: number, checkedThrough: string | null): boolean {
  return paydayIsRead(addDays(paydayOn, toleranceDays), checkedThrough);
}

/** How far the ledger has read the days one series' past occurrences are graded on — each direction by its own rule. */
export interface OccurrenceReading {
  /** money OUT: its accounts' silence frontier and its grace (`dueDayReadings`) — what `dueDayIsRead` grades */
  dueDay: DueDayReading;
  /** money IN: the last day every account its pay lands in now is checked through (`checkedThroughBySeries`) */
  paydaysCheckedThrough: string | null;
}

/**
 * The verdict on a PAST expected occurrence that did not post.
 *
 * `reading.dueDay` is how far the ledger has read the days this bill can be paid on — its accounts' frontier and its
 * grace (`DueDayReading`): ⚖️ the day is graded only once its accounts are checked through both (`dueDayIsRead`, his
 * decisions 60 and 65). `scheduleIsProven` says whether the expected DATE is worth holding a biller to; see
 * `ScheduleProven`.
 *
 * Money in is never `missed` (`absenceIsEvidence`), but it asks the same question first: whether anyone has LOOKED
 * (`paydayIsRead` over `reading.paydaysCheckedThrough`). 🔴 It answered "unbanked" of every passed payday before
 * asking. Measured on his ledger copy 2026-10-12: the calendar drew Oct 1 and Oct 8 "not yet known (not banked yet)"
 * while the dashboard, the forecast and /budgets said they "fall after Sep 24, the last day every account that pay
 * lands in has been checked through — so the ledger has not looked for their deposits". ⚖️ The calendar says it in
 * those words (`not_looked_for`), never a bill's "no statement has covered it yet".
 *
 * The state and its reason are returned from ONE call on purpose. `budgetVerdict`
 * established the rule after a headline and its own definition drifted apart on
 * screen; `runway`, `carCost` and `merchantProfile` all follow it. A caller that
 * could compute "missed" here and fetch the explaining sentence from somewhere
 * else is a caller that can eventually print the wrong pair.
 */
export function settledVerdict(
  kind: SeriesKind,
  occurrenceDate: string,
  reading: OccurrenceReading,
  scheduleIsProven: ScheduleProven,
): SettledVerdict {
  // Coverage first: where nobody has looked — a payday after its pay's checked day, a bill's day or the grace after it
  // not imported — nothing at all can be said, which is a stronger and more actionable answer than "not banked yet"
  // or "we are unsure when this is due".
  if (!absenceIsEvidence(kind)) {
    const looked = paydayIsRead(occurrenceDate, reading.paydaysCheckedThrough);
    return { state: "unsettled", reason: looked ? "unbanked" : "not_looked_for" };
  }
  if (!dueDayIsRead(occurrenceDate, reading.dueDay)) {
    return { state: "unsettled", reason: reading.dueDay.readsToToday ? "in_grace" : "not_imported" };
  }
  if (!scheduleIsProven) return { state: "unsettled", reason: "schedule_unproven" };
  return { state: "missed", reason: null };
}

/** The fields `forecastConfidence` reads — a subset of a `recurring_series` row. */
export interface ConfidenceInput {
  status: "detected" | "confirmed" | "dismissed" | "ended";
  userAmountCents: number | null;
  userNextExpectedOn: string | null;
  userEndsOn: string | null;
}

/**
 * How firmly a future occurrence may be asserted.
 *
 * The ladder is evidence, not enthusiasm. `scheduled` requires the owner to have
 * typed something — an amount, a start date, an end date — which is the only
 * input in this system that does not come from pattern-matching a bank export.
 * His car lease ($559.89 from 2026-09-11) has no postings at all and is still
 * the most certain number on the page; the detector's four-visit read on a
 * smoothie bar is the least. Rank by who said it, not by how much history it has.
 */
export function forecastConfidence(s: ConfidenceInput): ForecastConfidence {
  if (s.status !== "confirmed") return "predicted";
  const ownerTyped =
    s.userAmountCents !== null || s.userNextExpectedOn !== null || s.userEndsOn !== null;
  return ownerTyped ? "scheduled" : "expected";
}

/**
 * How much ATTENTION each state deserves — lowest number wins.
 *
 * One order, exported, because two consumers were computing it separately and
 * had already drifted: the service sorted a day's entries `missed,
 * paid_different, paid, upcoming` while `dayWeight` picked the cell's summary
 * colour with `missed, paid_different, upcoming, paid`. On any day holding both
 * a posted charge and a future one, the sheet listed them in one order and the
 * cell was tinted by the other. Neither was wrong on its own; together they were
 * inconsistent, which is the shape of bug pass 50 made unrepresentable for the
 * budget verdict.
 *
 * The ranking is by how much the reader has to DO about it: a charge that
 * definitely failed, then one that definitely changed, then one nobody can grade
 * yet, then one that has not happened, then one that went exactly as expected.
 */
export const STATE_ATTENTION_ORDER: Record<OccurrenceState, number> = {
  missed: 0,
  paid_different: 1,
  unsettled: 2,
  upcoming: 3,
  paid: 4,
};

/** The state a DAY takes when it holds several — the most attention-worthy. */
export function mostUrgentState(states: readonly OccurrenceState[]): OccurrenceState {
  return states.reduce<OccurrenceState>(
    (worst, s) => (STATE_ATTENTION_ORDER[s] < STATE_ATTENTION_ORDER[worst] ? s : worst),
    "paid",
  );
}
