import type { Cadence } from "@/db/schema/recurring";
import { addDays, compareDates, diffDays } from "./dates";
import { signedStepsToReach, stepFrom, stepPlan } from "./recurring-step";

/**
 * SETTLE BACKWARDS — which paydays a deposit has paid down.
 *
 * ⚖️ THE OWNER'S DECISION, asked as a concrete either/or and answered
 * 2026-09-28. He was shown:
 *
 *   (A) settle backwards — "a deposit attributed to a pay series pays down the
 *       OLDEST unmet paydays up to its amount, so the Sep 24 deposit retires
 *       Aug 27, Sep 3, Sep 10, Sep 17 and Sep 24";
 *   (B) one deposit, one payday — today's rule.
 *
 * He chose (A) and rejected (B).
 *
 * 🔴 WHAT (B) COST, measured on his ledger 2026-09-28. Five weeks of pay had
 * landed and been linked by him — 2026-09-23 +$4,567.68, exactly 4 × $1,141.92,
 * and 2026-09-24 +$1,141.92 — and every surface still said the weeks before Sep
 * 24 went unpaid: /budgets "3 paydays worth $3,425.76 already passed this month",
 * the recurring calendar drawing Sep 3, Sep 10, Sep 17 and all four August
 * paydays "unsettled (unbanked)". Under (B) a lump could never catch up, so
 * August's four marks were red forever however much he was later paid.
 *
 * ⛔ ONE HOME, and that is the whole point of the module. Before this, "has this
 * payday been met?" was spelled three times — in `arrears`, in the recurring
 * calendar, and inside `incomeExpectation`'s forward leg — and the three had
 * already drifted: a lump that posts BEFORE the payday it covers was counted
 * both as banked and as still expected, because the budget leg only dropped an
 * occurrence dated exactly today with a deposit dated exactly today. A rule with
 * three spellings drifts; this repo has paid for that lesson repeatedly.
 *
 * ## The rule, in full
 *
 * Deposits are taken oldest first. Each settles the series' occurrences
 * NEWEST-first among those it can REACH — dated at or before its own date plus
 * the series' tolerance — and not already settled by another deposit:
 *
 *   · the first one is settled outright when it lies within the series'
 *     tolerance of the deposit's date. That is today's date-match rule kept
 *     exactly as it was, and it is what makes a SHORT pay still count: a
 *     $1,100.00 deposit against a $1,141.92 week answered that week, and whether a
 *     payday was answered is a different question from whether it was answered in
 *     full (`classifyPostedAmount` already draws that distinction as
 *     `paid_different`). (His June deposit of $1,047.00 was once the example; it
 *     was a cash week priced at $1,047.00 all along — §6A 55);
 *   · every further one — and any one outside that tolerance window — is settled
 *     only while the money left over covers its FULL amount. Claiming a payday
 *     was paid with money that was not there is the fabricated plug this ledger
 *     refuses everywhere else.
 *
 * Money left over at the end stays UNALLOCATED. It never pre-pays a payday the
 * deposit could not reach: an occurrence past the tolerance window has not
 * happened, the forward leg of `incomeExpectation` owns it, and settling it
 * early would delete a payday from the month's expectation on the strength of
 * money that answers a different week.
 *
 * ⛔ THE MONEY POOLS ACROSS DEPOSITS, and the split must not change the answer.
 * His decision is stated in AGGREGATE — "a deposit attributed to a pay series
 * pays down the oldest unmet paydays up to its amount". Each deposit's leftover
 * used to be dropped on the floor, so the same $4,567.68 retired four paydays
 * as one lump and only three split in two ($1,700.00 + $2,867.68, or $2,000.00
 * on the 22nd and $2,567.68 on the 24th): the first deposit's remainder never
 * reached Sep 3, and /budgets printed "1 payday worth $1,141.92 already passed
 * this month with no deposit against them" for a month carrying $4,567.68
 * attributed to that very series. How his payer happens to split a transfer is
 * not a fact about which weeks he was paid for.
 *
 * ⚖️ Only the MONEY pools. The anchor clause stays per-deposit: it is the link's
 * statement about the one payday that deposit landed on, not a purse.
 *
 * ⚖️ AND IT POOLS ONLY AS FAR AS ITS OWN DEPOSIT REACHED (owner decision 2026-10-08, §6A 55b). Every sum of carried
 * money keeps the reach of the deposit it came from — that deposit's date plus the tolerance — and pays no payday
 * after it, whichever later deposit's walk finds the payday. The rule above, "it never pre-pays a payday the deposit
 * could not reach", held for a deposit's own walk and not for its change. 🔴 On his ledger June's $1,047.00 and
 * $400.00 rode forward through the summer and paid Aug 27 when the Sep 23 lump walked back to it: the calendar read
 * "Jun 4 … paid (toward the payday of Aug 27, 2026)", eleven weeks before that payday happened.
 *
 * ⚖️ AND ONLY INSIDE ITS RATE ERA (owner decision 2026-10-08, §6A 55a). A series whose rate has a dated history
 * (`periodOf`, `ratePeriodOf`) prices each payday at its own time's rate, and money pays only the paydays of its
 * own era: payroll money pays payroll weeks. A deposit belongs to the era of the payday it ANCHORS to — the nearest
 * within the tolerance — else of its own date, because his payroll lands the Wednesday before the Thursday it pays
 * and must not change eras at a raise. Its walk stops at the first payday of an earlier era, and carried money keeps
 * its era. 🔴 With his history set, the payroll week of Sep 24 walked back past Aug 27 and paid the CASH week of
 * Aug 20 at $1,047.00, leaving $94.92 of a payroll week to read as change against a week it never answered.
 *
 * ⚠️ ONE CONSEQUENCE WORTH STATING. Where a series' tolerance is wide enough to
 * reach two of its own occurrences, one deposit used to meet both. It no longer
 * does — the second needs its own money. That is (A) rather than a regression:
 * one week's pay settling two weeks is the double-settle the decision exists to
 * prevent. No series on the owner's ledger is in that shape (his pay is weekly
 * with three days of tolerance).
 *
 * ⛔ ATTRIBUTED DEPOSITS ONLY, and the caller is responsible for that. "+$468.20
 * Instant Pmt From It America LLC — this was them paying them back for claude
 * subscription" (his words, 2026-09-28): same payer, same account, four days
 * after a payday, and it is a reimbursement filed under Refunds &
 * Reimbursements with no series on it. Any rule wide enough to catch it would
 * also sweep in his father's money, which is the mistake the 2026-07-21 ATM
 * pair was rescued from.
 */

/** One projected payday: the ledger's own drawing of what was due, and when. */
export interface PaydayOccurrence {
  date: string;
  /** what one payday is worth, positive money-in cents */
  amountCents: number;
}

/**
 * Whether a row dated `postedOn` has ARRIVED by `today`. Nothing dated after
 * today has, whatever the row says — the same refusal `cashEarnings` makes when
 * it clamps its window to today.
 *
 * ⛔ ONE BOUNDARY, for settlement and for every surface that draws a deposit
 * beside settlement's answer. A row settlement did not read cannot be drawn as
 * paying a payday that settlement says is still owed: the recurring calendar
 * drew a deposit dated Oct 2, read on Oct 1, as settled beside the Oct 1 payday
 * settlement left unpaid — one week counted in Settled and again in Expected.
 */
export function hasArrived(postedOn: string, today: string): boolean {
  return compareDates(postedOn, today) <= 0;
}

/** One deposit the owner (or detection) attributed to the pay series. */
export interface AttributedDeposit {
  postedOn: string;
  /** positive money-in cents */
  amountCents: number;
}

/** The schedule a pay series walks: its effective cadence, measured gap, proven day and anchor (`EffectiveSeries`). */
export interface PaydayRhythm {
  cadence: Cadence;
  intervalDaysAvg: number | null;
  anchorDay: number | null;
  /** the schedule's anchor — the date its rhythm is stepped from; null when it has none */
  nextExpectedOn: string | null;
}

/**
 * ⚖️ THE FIRST PAYDAY — where every reader of a pay series' paydays opens (§6A 55, step B): the anchor's rhythm walked
 * BACK to the first date on or after the first deposit less the tolerance. The settlement walks from it, the recurring
 * calendar and /budgets draw from it, and Earned vs banked counts from it (`startedOn`).
 *
 * 🔴 TWO PAYDAY UNIVERSES. Earned vs banked counted from the first DEPOSIT; the settlement, the calendar and /budgets
 * from the stored ANCHOR — `stepsToReach` never walks back. On his ledger (2026-10-08) the card earned June's cash
 * weeks from Jun 4, while the calendar drew no payday before detection's Jul 23 and Jun 4's $1,047.00 read "toward no
 * payday"; on the e2e fixture, whose Paycheck deposits fall on the other Fridays of its biweekly anchor, the card
 * counted one Friday and the calendar the next.
 *
 * Why the first deposit less the TOLERANCE: a deposit answers a payday within the tolerance before it (settlement's
 * anchor clause), so the first payday it can have been for is the first one in that reach. And only BACK — an anchor
 * already before the first deposit is itself the first payday, as the settlement has always drawn it.
 *
 * The evidence is settlement's: money IN that has ARRIVED (`hasArrived`). Null when there is none — a series nobody
 * has been paid by has no paydays to grade. With no anchor there is no rhythm to walk, and the first deposit's own day
 * opens it (no projection draws a payday without an anchor).
 */
export function firstPaydayOn(
  schedule: PaydayRhythm,
  toleranceDays: number,
  deposits: readonly AttributedDeposit[],
  today: string,
): string | null {
  const firstDepositOn = deposits
    .filter((d) => d.amountCents > 0 && hasArrived(d.postedOn, today))
    .reduce<string | null>(
      (first, d) => (first === null || compareDates(d.postedOn, first) < 0 ? d.postedOn : first),
      null,
    );
  if (firstDepositOn === null) return null;
  const anchor = schedule.nextExpectedOn;
  if (anchor === null) return firstDepositOn;
  const plan = stepPlan(schedule.cadence, schedule.intervalDaysAvg, schedule.anchorDay);
  const steps = signedStepsToReach(anchor, plan, addDays(firstDepositOn, -toleranceDays));
  return stepFrom(anchor, plan, Math.min(0, steps));
}

/**
 * ⚖️ WHERE THE WALK BACK ENDS — the first day it does not draw (`ProjectableSeries.walkBackBefore`): the later of today
 * and the day after the last arrived deposit's REACH, its date plus the tolerance — settlement's own bound on the
 * paydays a deposit can pay (§6A 55b). The walk back from the anchor draws the past, and the paydays money has
 * already reached; from there on the schedule is its anchor's, as every forward reader projects it.
 *
 * 🔴 Bounded at today alone, the day his pay was imported on payday lost that payday. Detection dates the next payday
 * one step after the last deposit, so on Thu Sep 24 with that day's deposit in, the anchor was Oct 1 and Sep 24 lay on
 * the walk back: no past reader drew it and no forward reader does (they open on the anchor). /budgets scheduled three
 * of September's four Thursdays, the Sep 23 lump paid Aug 27 instead, and Sep 24's own deposit read "toward no
 * payday" — and the next day, Sep 24 in the past, it all came back: one deposit's payday changed overnight with
 * nothing imported. ⛔ Not `>` today either: an anchor he dates ahead (Oct 22, set on Oct 8) with no money near it
 * must still leave Oct 8 off every past reader, since no forward reader draws it.
 *
 * A payday drawn this way is one a deposit settles — the newest it reaches, inside its tolerance (the anchor clause) —
 * so it leaves /budgets' schedule through the posted leg, never into no leg. The evidence is settlement's: money IN
 * that has ARRIVED (`hasArrived`).
 */
export function walkBackBound(deposits: readonly AttributedDeposit[], toleranceDays: number, today: string): string {
  const reachedThrough = deposits
    .filter((d) => d.amountCents > 0 && hasArrived(d.postedOn, today))
    .map((d) => addDays(d.postedOn, toleranceDays))
    .reduce((latest, day) => (compareDates(day, latest) > 0 ? day : latest), addDays(today, -1));
  return addDays(reachedThrough, 1);
}

export interface PaydaySettlementInput {
  /** every occurrence the ledger draws for the series, in any order */
  occurrences: readonly PaydayOccurrence[];
  /** the deposits carrying this series' id, in any order */
  deposits: readonly AttributedDeposit[];
  /** the series' own arbiter for "did it land near enough?" */
  toleranceDays: number;
  /**
   * Which rate era a day belongs to — `ratePeriodOf` over the series' dated history; money pays only the paydays of
   * its own era (§6A 55a). It never decreases as the day moves forward. Omitted: one era, as for every series whose
   * rate has never changed.
   */
  periodOf?: (day: string) => number;
}

export interface PaydaySettlement {
  /**
   * Each payday the deposits have paid down → the date of the deposit that paid
   * it.
   *
   * ⛔ WHICH DEPOSIT, and not merely THAT one exists. Every reader of this
   * answer also publishes a figure covering a WINDOW — `incomeExpectation`'s
   * `postedCents` is `[start, today]`, the recurring calendar's Settled total is
   * the month it draws — and a settlement's deposit can lie outside it: a
   * deposit on Sep 30 settles Oct 1, a lump on Sep 23 settles Aug 27. Told only
   * "met", a reader drops the payday from its expectation while the money sits
   * in a different period's total, and the payday is named by no figure at all.
   * Measured on 2026-10-01 with one deposit of $1,141.92 on 2026-09-30:
   * /budgets read posted $0.00 + expected $4,567.68 + passed-unpaid $0.00
   * against five paydays scheduled at $5,709.60. That is the hole this map
   * exists to let each reader close in its own terms.
   */
  settledBy: ReadonlyMap<string, string>;
  /**
   * WHERE THE MONEY WENT: every sum the walk spent, as (payday, deposit, cents),
   * in the order it spent them.
   *
   * 🔴 `settledBy` carries a date and no money, and a reader publishing a figure
   * over a window needs the money. /budgets' fourth figure added each payday's
   * SCHEDULED amount wherever its settling deposit fell outside the month, so a
   * short deposit was reported at a week it never carried — "$1,141.92 … paid
   * early, by the deposit of Wed, Sep 30" of a row holding $1,100.00 — and change
   * pooled from one month into a payday another month's deposit retired put the
   * whole payday on one side of the month line when its money sat on both.
   *
   * Each deposit's own money is spent first, then change carried over from
   * earlier deposits that can still pay that payday — its era, its reach — newest
   * first (see `take`). So `settledBy` names the deposit
   * whose WALK retired a payday and this names whose MONEY paid it; the two part
   * only when carried-over change is spent.
   *
   * ⛔ Every cent of every deposit is in exactly one portion or in
   * `unallocatedCents`; exactly the settled paydays hold money; none holds more
   * than it is worth, and a short anchor holds the money its deposit had.
   */
  portions: readonly SettlementPortion[];
  /**
   * Deposit money that retired no payday, after the whole walk.
   *
   * Not "per deposit": leftovers pool forward (see the header), so this is what
   * is left when every deposit's money has been spent.
   */
  unallocatedCents: number;
}

/** One sum of one deposit's money, spent on one payday. */
export interface SettlementPortion {
  /** the payday the money went to */
  paydayOn: string;
  /** the `posted_on` of the deposit it came from */
  depositOn: string;
  /** positive money-in cents */
  cents: number;
}

/** Which side of a reader's window a date falls on, asked of a payday and of a deposit. */
export interface SettlementWindow {
  paydayInside: (date: string) => boolean;
  depositInside: (date: string) => boolean;
}

/** A settlement's money that crossed a reader's window, in both directions. */
export interface PortionsAcross {
  /** sums from deposits OUTSIDE the window that paid paydays inside it */
  paidByAnotherWindow: SettlementPortion[];
  /** sums from deposits INSIDE the window that paid paydays outside it */
  paidForAnotherWindow: SettlementPortion[];
}

/**
 * Sorts a settlement's money by the window a reader publishes figures over.
 *
 * ⛔ ONE SPELLING, because two surfaces print totals beside each other that
 * have to agree: /budgets' fourth figure and its mirror, and the recurring
 * calendar's Settled figure. A sum whose payday and deposit are on the same
 * side of the window crossed nothing — its money is in the window's own
 * posted rows, or in none of them — and is in neither list.
 */
export function portionsAcross(portions: readonly SettlementPortion[], window: SettlementWindow): PortionsAcross {
  const paidByAnotherWindow: SettlementPortion[] = [];
  const paidForAnotherWindow: SettlementPortion[] = [];
  for (const p of portions) {
    const paydayInside = window.paydayInside(p.paydayOn);
    const depositInside = window.depositInside(p.depositOn);
    if (paydayInside && !depositInside) paidByAnotherWindow.push(p);
    else if (!paydayInside && depositInside) paidForAnotherWindow.push(p);
  }
  return { paidByAnotherWindow, paidForAnotherWindow };
}

/** The answer when there is nothing to settle — one spelling, for the service's early exits too. */
export const noSettlement = (): PaydaySettlement => ({
  settledBy: new Map(),
  portions: [],
  unallocatedCents: 0,
});

/** Money not yet spent, still carrying the deposit it came from — and what that deposit could pay. */
interface Held {
  depositOn: string;
  cents: number;
  /** the rate era of the payday its deposit anchored to (§6A 55a) */
  era: number;
  /** the last payday it can pay: its deposit's date plus the tolerance (§6A 55b) */
  reachesThrough: string;
}

const heldCents = (held: readonly Held[]): number => held.reduce((sum, h) => sum + h.cents, 0);

/** Whether a sum of held money can pay the payday `paydayOn` of era `paydayEra`: its own era, and inside its reach. */
const canPay =
  (paydayOn: string, paydayEra: number) =>
  (h: Held): boolean =>
    h.era === paydayEra && compareDates(paydayOn, h.reachesThrough) <= 0;

/**
 * Takes `cents` out of the held money `eligible` says may pay, the NEWEST money
 * first, and says whose money it took and what is left.
 *
 * ⚖️ Newest first, so a deposit's own money answers its walk before change
 * carried over from earlier deposits does. The anchor is that deposit's own
 * statement about the payday it landed on ("the link's statement … not a
 * purse", in the header), so its money is what pays that payday; the change
 * only tops up what the deposit's own money cannot pay, and so goes to the
 * older paydays behind it. Oldest-first would record a week's own deposit as
 * change left over and an earlier deposit's leftover as that week's pay — and
 * /budgets would move money across the month line.
 *
 * ⛔ ELIGIBLE money only (`canPay`): a sum outside its era or past its reach is
 * passed over and stays held, whatever the walk asking for it (§6A 55a, 55b).
 * The walk already asks for no more than the eligible money, and with eras that
 * never run backwards the newer money is always the eligible kind — so this is
 * the same rule held where the money is taken, not a second one.
 */
function take(
  held: readonly Held[],
  cents: number,
  eligible: (h: Held) => boolean,
): { taken: Held[]; left: Held[] } {
  const taken: Held[] = [];
  const left = [...held];
  let owed = cents;
  for (let i = left.length - 1; i >= 0 && owed > 0; i -= 1) {
    const h = left[i]!;
    if (!eligible(h)) continue;
    const part = Math.min(owed, h.cents);
    taken.push({ ...h, cents: part });
    owed -= part;
    if (part === h.cents) left.splice(i, 1);
    else left[i] = { ...h, cents: h.cents - part };
  }
  return { taken, left };
}

/**
 * The era a deposit's money belongs to: that of the payday it ANCHORS to — the nearest within the tolerance, the
 * newer on a tie — else of its own date. ⚖️ His payroll lands the Wednesday before the Thursday it pays, so a
 * deposit dated in one era can be the pay of the first payday of the next; read by its own date, Wed Aug 26's pay
 * would be a cash week's (§6A 55a).
 */
function depositEra(
  postedOn: string,
  byDateDesc: readonly PaydayOccurrence[],
  toleranceDays: number,
  periodOf: (day: string) => number,
): number {
  let anchor: string | null = null;
  let gap = Infinity;
  for (const o of byDateDesc) {
    const g = Math.abs(diffDays(postedOn, o.date));
    if (g <= toleranceDays && g < gap) {
      anchor = o.date;
      gap = g;
    }
  }
  return periodOf(anchor ?? postedOn);
}

const ONE_ERA = (): number => 0;

/**
 * Which of a series' paydays its deposits have retired.
 *
 * Pure, and deliberately in `lib`: the same three surfaces that must agree read
 * it, and a rule that takes a database cannot be tested at the boundaries that
 * matter (a lump plus a weekly deposit, a rate change mid-run, a partial).
 */
export function settlePaydaysBackwards({
  occurrences,
  deposits,
  toleranceDays,
  periodOf = ONE_ERA,
}: PaydaySettlementInput): PaydaySettlement {
  if (occurrences.length === 0 || deposits.length === 0) return noSettlement();

  // newest first: a deposit answers the most recent payday it can reach, and
  // only then the ones behind it
  const byDateDesc = [...occurrences].sort((a, b) => compareDates(b.date, a.date));
  const settledBy = new Map<string, string>();
  const portions: SettlementPortion[] = [];
  /*
   * What the deposits walked so far have not spent. It rides FORWARD into the
   * next deposit rather than being written off, which is what makes one lump
   * and two transfers of the same total retire the same weeks — and it keeps
   * the deposit each sum came from, so a payday it pays is paid by that money,
   * and only a payday that money could pay (its era, its reach).
   */
  let carried: readonly Held[] = [];

  // oldest first, so the queue drains in the order the money actually arrived
  for (const d of [...deposits].sort((a, b) => compareDates(a.postedOn, b.postedOn))) {
    const era = depositEra(d.postedOn, byDateDesc, toleranceDays, periodOf);
    let held: readonly Held[] = [
      ...carried,
      { depositOn: d.postedOn, cents: d.amountCents, era, reachesThrough: addDays(d.postedOn, toleranceDays) },
    ];
    const pay = (paydayOn: string, cents: number, eligible: (h: Held) => boolean): void => {
      const { taken, left } = take(held, cents, eligible);
      for (const t of taken) portions.push({ paydayOn, depositOn: t.depositOn, cents: t.cents });
      held = left;
    };
    let isAnchor = true;
    for (const o of byDateDesc) {
      if (heldCents(held) <= 0) break;
      if (settledBy.has(o.date)) continue;
      // out of reach ahead: a deposit cannot pay a payday that had not happened
      // yet — `diffDays(a, b)` is b − a, so this is (occurrence − deposit)
      if (diffDays(d.postedOn, o.date) > toleranceDays) continue;
      // ⚖️ §6A 55a: a later era's payday is not this money's to pay, and the
      // first payday of an earlier era ends the walk (eras never run backwards)
      const paydayEra = periodOf(o.date);
      if (paydayEra > era) continue;
      if (paydayEra < era) break;
      const eligible = canPay(o.date, paydayEra);
      const remaining = heldCents(held.filter(eligible));

      const withinTolerance = Math.abs(diffDays(d.postedOn, o.date)) <= toleranceDays;
      if (isAnchor && withinTolerance) {
        // the link itself says this deposit answers this payday, whatever it
        // paid — and what it paid is the money there was (a $1,100.00 deposit
        // against a $1,141.92 week), so a short payday leaves nothing behind.
        // Never nothing: the deposit's own money is untouched and can pay it.
        settledBy.set(o.date, d.postedOn);
        pay(o.date, Math.min(remaining, o.amountCents), eligible);
        isAnchor = false;
        continue;
      }
      isAnchor = false;
      if (remaining < o.amountCents) break; // the money stops here, and so does the walk
      settledBy.set(o.date, d.postedOn);
      pay(o.date, o.amountCents, eligible);
    }
    carried = held;
  }

  return { settledBy, portions, unallocatedCents: heldCents(carried) };
}
