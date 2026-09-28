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
  /** the dates of the occurrences the deposits have paid down */
  settledDates: ReadonlySet<string>;
  /** deposit money that retired no payday — never carried forward */
  unallocatedCents: number;
}

const EMPTY: PaydaySettlement = { settledDates: new Set(), unallocatedCents: 0 };

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
  if (occurrences.length === 0 || deposits.length === 0) return EMPTY;

  // newest first: a deposit answers the most recent payday it can reach, and
  // only then the ones behind it
  const byDateDesc = [...occurrences].sort((a, b) => compareDates(b.date, a.date));
  const settledDates = new Set<string>();
  let unallocatedCents = 0;

  // oldest first, so the queue drains in the order the money actually arrived
  for (const d of [...deposits].sort((a, b) => compareDates(a.postedOn, b.postedOn))) {
    let remaining = d.amountCents;
    let isAnchor = true;
    for (const o of byDateDesc) {
      if (remaining <= 0) break;
      if (settledDates.has(o.date)) continue;
      // out of reach ahead: a deposit cannot pay a payday that had not happened
      // yet — `diffDays(a, b)` is b − a, so this is (occurrence − deposit)
      if (diffDays(d.postedOn, o.date) > toleranceDays) continue;

      const withinTolerance = Math.abs(diffDays(d.postedOn, o.date)) <= toleranceDays;
      if (isAnchor && withinTolerance) {
        // the link itself says this deposit answers this payday, whatever it paid
        settledDates.add(o.date);
        remaining -= o.amountCents;
        isAnchor = false;
        continue;
      }
      isAnchor = false;
      if (remaining < o.amountCents) break; // the money stops here, and so does the walk
      settledDates.add(o.date);
      remaining -= o.amountCents;
    }
    if (remaining > 0) unallocatedCents += remaining;
  }

  return { settledDates, unallocatedCents };
}
