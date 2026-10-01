import { compareDates, diffDays } from "./dates";

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
 *     exactly as it was, and it is what makes a SHORT pay still count: his June
 *     deposit was $1,047.00 against a $1,141.92 week, and whether a payday was
 *     answered is a different question from whether it was answered in full
 *     (`classifyPostedAmount` already draws that distinction as `paid_different`);
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

export interface PaydaySettlementInput {
  /** every occurrence the ledger draws for the series, in any order */
  occurrences: readonly PaydayOccurrence[];
  /** the deposits carrying this series' id, in any order */
  deposits: readonly AttributedDeposit[];
  /** the series' own arbiter for "did it land near enough?" */
  toleranceDays: number;
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
   * earlier deposits, newest first (see `take`). So `settledBy` names the deposit
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

/** Money not yet spent, still carrying the deposit it came from. */
interface Held {
  depositOn: string;
  cents: number;
}

const heldCents = (held: readonly Held[]): number => held.reduce((sum, h) => sum + h.cents, 0);

/**
 * Takes `cents` out of what is held, the NEWEST money first, and says whose
 * money it took and what is left.
 *
 * ⚖️ Newest first, so a deposit's own money answers its walk before change
 * carried over from earlier deposits does. The anchor is that deposit's own
 * statement about the payday it landed on ("the link's statement … not a
 * purse", in the header), so its money is what pays that payday; the change
 * only tops up what the deposit's own money cannot reach, and so goes to the
 * older paydays behind it. Oldest-first would record Oct 1's own weekly deposit
 * as change left over and September's leftover as Oct 1's pay — and /budgets
 * would move that week across the month line.
 */
function take(held: readonly Held[], cents: number): { taken: Held[]; left: Held[] } {
  const taken: Held[] = [];
  const left = [...held];
  let owed = cents;
  while (owed > 0 && left.length > 0) {
    const newest = left[left.length - 1]!;
    const part = Math.min(owed, newest.cents);
    taken.push({ depositOn: newest.depositOn, cents: part });
    owed -= part;
    if (part === newest.cents) left.pop();
    else left[left.length - 1] = { depositOn: newest.depositOn, cents: newest.cents - part };
  }
  return { taken, left };
}

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
   * the deposit each sum came from, so a payday it pays is paid by that money.
   */
  let carried: readonly Held[] = [];

  // oldest first, so the queue drains in the order the money actually arrived
  for (const d of [...deposits].sort((a, b) => compareDates(a.postedOn, b.postedOn))) {
    let held: readonly Held[] = [...carried, { depositOn: d.postedOn, cents: d.amountCents }];
    const pay = (paydayOn: string, cents: number): void => {
      const { taken, left } = take(held, cents);
      for (const t of taken) portions.push({ paydayOn, depositOn: t.depositOn, cents: t.cents });
      held = left;
    };
    let isAnchor = true;
    for (const o of byDateDesc) {
      const remaining = heldCents(held);
      if (remaining <= 0) break;
      if (settledBy.has(o.date)) continue;
      // out of reach ahead: a deposit cannot pay a payday that had not happened
      // yet — `diffDays(a, b)` is b − a, so this is (occurrence − deposit)
      if (diffDays(d.postedOn, o.date) > toleranceDays) continue;

      const withinTolerance = Math.abs(diffDays(d.postedOn, o.date)) <= toleranceDays;
      if (isAnchor && withinTolerance) {
        // the link itself says this deposit answers this payday, whatever it
        // paid — and what it paid is the money there was (his June week was
        // $1,047.00 against $1,141.92), so a short payday leaves nothing behind
        settledBy.set(o.date, d.postedOn);
        pay(o.date, Math.min(remaining, o.amountCents));
        isAnchor = false;
        continue;
      }
      isAnchor = false;
      if (remaining < o.amountCents) break; // the money stops here, and so does the walk
      settledBy.set(o.date, d.postedOn);
      pay(o.date, o.amountCents);
    }
    carried = held;
  }

  return { settledBy, portions, unallocatedCents: heldCents(carried) };
}
