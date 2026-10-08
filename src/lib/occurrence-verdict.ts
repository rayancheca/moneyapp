import type { SeriesKind } from "@/db/schema/recurring";
import { compareDates } from "./dates";

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
  /** the ledger has not been shown this day for the account(s) this bills on */
  | "not_imported"
  /** money IN: its absence from the ledger is never proof it did not happen */
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
 * The verdict on a PAST expected occurrence that did not post.
 *
 * `observedThrough` is the last day the ledger has actually been shown for the
 * account(s) this series bills on — `null` when nothing is known at all, which
 * is the most cautious input and yields the most cautious answer. ⚖️ An account
 * no statement will ever come for (archived, or a cash wallet) counts as shown
 * through today (`silenceObservedThrough`, 2026-10-08): nothing more is coming.
 * `scheduleIsProven` says whether the expected DATE is worth holding a biller
 * to; see `ScheduleProven`.
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
  observedThrough: string | null,
  scheduleIsProven: ScheduleProven,
): SettledVerdict {
  if (!absenceIsEvidence(kind)) return { state: "unsettled", reason: "unbanked" };
  // Coverage first: where the day has not been imported, nothing at all can be
  // said, which is a stronger and more actionable answer than "we are unsure
  // when this is due".
  if (observedThrough === null) return { state: "unsettled", reason: "not_imported" };
  if (compareDates(occurrenceDate, observedThrough) > 0) {
    return { state: "unsettled", reason: "not_imported" };
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
