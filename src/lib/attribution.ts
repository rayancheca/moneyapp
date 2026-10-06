/**
 * Net worth moved from X to Y. WHY?
 *
 * The bridge between two net-worth readings, decomposed into bands that sum
 * back to the movement — with the part that does NOT sum as a first-class
 * output rather than a rounding note.
 *
 * ## The identity, and why it is provable rather than hopeful
 *
 * Measured on the live ledger before any of this was written, on five windows
 * from one month to four years:
 *
 *     Δ net worth = transactions on REPLAYING accounts
 *                 + market gain
 *                 + portfolio net flow
 *                 + Δ money in transit
 *                 + unexplained
 *
 * and `unexplained` came back **exactly $0.00** on every window that did not
 * span an account opening or a manual anchor. That is not an accident of one
 * ledger: the cash and credit accounts are replayed from their transactions, so
 * their balance change *is* their transaction sum, and the holdings-valued
 * accounts are quantity × close, so their change is exactly gain plus flow.
 *
 * ⚠️ **Transactions on holdings-valued accounts must never enter this sum.**
 * An investment account's daily balance is rebuilt from `holding_events` and
 * cached closes, not from transaction replay, so its rows moved no balance and
 * counting them double-counts the market term. The measured cost of getting this
 * wrong on this ledger is $35,938.24 over four years. The divider is "is the
 * account holdings-derived", NOT `investmentSideAccountIds()`, which includes
 * the settlement-cash sibling and *is* replayed.
 *
 * ## Why `unexplained` is a residual and never a plug
 *
 * It would be trivial to make this always close: compute every band, then set
 * the last one to whatever is left. That number would be meaningless, and the
 * one output the bridge exists to produce would be the one output nobody could
 * trust. So the residual is subtraction and nothing else, and the *explanations*
 * for it (`restatements`) are a separate input that is CHECKED against it rather
 * than folded into it. A restatement covering part of the hole reports the
 * remainder; one covering more than the hole reports a negative remainder rather
 * than clamping, because two explanations for the same money is itself the bug.
 *
 * Pure: no database, no clock. The service assembles the measurements.
 */

/**
 * Why an account's balance moved with no transaction behind it.
 *
 * Both values are real on this ledger: `anchor` is the $5,000.00 manual anchor
 * on Cash on Hand dated 2026-08-03 (the owner's untracked cash float — see
 * MEMORY, it is deliberate and must not be "fixed"), and `opening` is Robinhood
 * Brokerage entering coverage at $20.19 on 2024-07-10.
 */
export type RestatementReason = "anchor" | "opening";

export interface Restatement {
  accountName: string;
  /** signed, net-worth-directed */
  cents: number;
  reason: RestatementReason;
}

export interface AttributionInput {
  /** net worth at the window's opening edge */
  openingCents: number;
  /** net worth at the window's closing edge */
  closingCents: number;
  /** income-kind rows, money in, ≥ 0 — HIS: the population /spending calls Income (`isIncome`) */
  earnedCents: number;
  /**
   * income-kind rows on the agent's cash account (`outsidePortfolioCashAccountIds`), either sign, net-worth-signed —
   * what the agent's account was paid, net of what was clawed back from it (`isAgentsIncomeCategoryRow`). Below zero
   * in a window whose clawbacks come to more.
   *
   * ⚖️ Owner decision 2026-09-28: not his income, so it is not in `earnedCents` — and still in net worth, so it is
   * not dropped either. A bridge that left it out would report the agent's dividend as "Unexplained". ⚖️ Owner
   * decision 2026-10-06 (§6A 43): the category decides, so a clawback filed in an income category lowers it rather
   * than sitting in `movedCents` — where his own clawback still sits.
   */
  agentIncomeCents: number;
  /**
   * expense-kind rows on the agent's cash account, either sign, net-worth-signed — what the agent's account paid, net
   * of what was refunded to it (`isAgentsCostCategoryRow`).
   *
   * ⚖️ Owner decision 2026-10-02 (§6A 34): not his spending, so it is in neither `spentCents` nor `refundsCents` — and
   * net worth paid it, so it is not dropped either. A bridge that left it out would report the agent's fee as
   * "Unexplained".
   */
  agentCostsCents: number;
  /** expense-kind debits, HIS — the population /spending calls Spent (`spendingBucket`) — net-worth-signed, ≤ 0 */
  spentCents: number;
  /** credits inside expense categories, his — money back, not money earned, ≥ 0 */
  refundsCents: number;
  /**
   * transfer-kind and investment-kind rows on replaying accounts, signed.
   *
   * ⚠️ NOT a neutral bucket that can be dropped. A transfer nets to zero only
   * when BOTH legs sit inside the ledger; measured here, 1,244 transfer rows
   * carry no counter-leg at all and come to +$86,941.15 all-time — money really
   * crossing the boundary of what is tracked, which `periodTotals` excludes from
   * both earned and spent by design.
   */
  movedCents: number;
  /** holdings gain: Δ NAV less flow, from the portfolio return engine */
  marketCents: number;
  /** money moving into or out of the holdings themselves */
  portfolioFlowCents: number;
  /** in-transit stock at the close less at the open — a flow, not a stock */
  inTransitDeltaCents: number;
  /** what is known about balance movement no transaction explains */
  restatements: readonly Restatement[];
}

export type AttributionBandKey =
  | "earned"
  | "agentIncome"
  | "agentCosts"
  | "refunds"
  | "spent"
  | "moved"
  | "market"
  | "portfolioFlow"
  | "inTransit"
  | "unexplained";

/**
 * The order the bands are read in, and therefore the order a running total
 * accumulates them.
 *
 * Declared as a constant rather than assembled from an object's keys: a
 * waterfall's order IS its arithmetic, and leaving it to iteration order makes
 * the chart's meaning depend on a detail no test would notice changing. Money in
 * first, money out next, then the parts that are not cash at all, then whatever
 * is left over — which reads last because it is defined as what the others
 * could not account for.
 */
export const ATTRIBUTION_BAND_ORDER = [
  "earned",
  "agentIncome",
  "agentCosts",
  "refunds",
  "spent",
  "moved",
  "market",
  "portfolioFlow",
  "inTransit",
  "unexplained",
] as const satisfies readonly AttributionBandKey[];

/**
 * What each band is called on screen, and what it means.
 *
 * Here rather than in the component because the chart and its table render the
 * same words, and a second copy is how a legend ends up disagreeing with the
 * row beneath it. `jargon.ts` holds copy for terms a page prints once; these are
 * printed once per band per lens, so they live with the data that selects them.
 */
export const ATTRIBUTION_BAND_LABEL: Record<AttributionBandKey, string> = {
  // S22: every positive income-kind row HE received, the population /spending calls
  // Income — /summary's "Earned" is narrower (owner decision 2026-09-14). The key stays.
  earned: "Income",
  // 2026-09-28: the agent's income is not his, so it is not "Income" — named, not hidden
  agentIncome: "Agent's income",
  // 2026-10-02: nor are its costs his spending — named beside it, not hidden in "Spent"
  agentCosts: "Agent's costs",
  refunds: "Refunds",
  spent: "Spent",
  moved: "Moved",
  market: "Market",
  portfolioFlow: "Into holdings",
  inTransit: "In transit",
  unexplained: "Unexplained",
};

export const ATTRIBUTION_BAND_MEANING: Record<AttributionBandKey, string> = {
  earned: "Money arriving in an income category. Only money in — a credit that claws back earlier pay is not negative income. What the agent's account is paid is not yours, and has its own line.",
  agentIncome: "Money arriving in an income category on the agent's own cash account — its dividends and interest, less any clawed back from it. Net worth holds it, so it is counted here; it is not your income, so the Income line leaves it out.",
  agentCosts: "Money leaving in a spending category from the agent's own cash account — its fees, less any refunded to it. Net worth pays it, so it is counted here; it is not your spending, so the Spent and Refunds lines leave it out.",
  refunds: "Credits inside spending categories. Money coming back, which is not the same as income. What is refunded to the agent's account is not yours, and sits on its own line.",
  spent: "Debits in spending categories, before any refund is netted against them. What the agent's account pays is not yours, and has its own line.",
  moved: "Transfers and investment rows on accounts that replay. It nets to nothing when both legs are on the ledger, so whatever is left is money crossing the boundary of what is tracked.",
  market: "What holdings gained or lost on price alone, with every buy and sell taken out first.",
  portfolioFlow: "Money moving into or out of the holdings themselves. Its other leg is a transfer out of cash, so the two cancel.",
  inTransit: "Money that had left one account and not yet arrived in another, at the close less at the open.",
  unexplained: "Movement no band accounts for. Zero on a reconciled window; when it is not, what is known about it is named beside it.",
};

export type BandDirection = "up" | "down" | "flat";

export interface AttributionBand {
  key: AttributionBandKey;
  /** signed, net-worth-directed */
  cents: number;
  direction: BandDirection;
  /**
   * Exactly zero. Kept and marked rather than dropped: two windows whose band
   * lists differ in length cannot be compared, and a missing band is
   * indistinguishable from an empty one.
   */
  isZero: boolean;
  /** this band's share of GROSS movement, signed; 0 when nothing moved */
  sharePct: number;
}

export interface Attribution {
  /** closing − opening */
  deltaCents: number;
  bands: AttributionBand[];
  /** Σ|band|, the denominator every share is measured against */
  grossCents: number;
  /** the residual: the delta less every named band. Zero on a closed window. */
  unexplainedCents: number;
  /** true when the residual is exactly zero */
  closes: boolean;
  /** Σ restatements — how much of the residual has a name */
  attributedCents: number;
  /**
   * `unexplainedCents − attributedCents`. Positive is a hole nobody has
   * accounted for; NEGATIVE means the explanations overlap and is a defect in
   * the attribution rather than in the ledger. Never clamped.
   */
  unattributedCents: number;
  restatements: readonly Restatement[];
}

function directionOf(cents: number): BandDirection {
  if (cents > 0) return "up";
  if (cents < 0) return "down";
  return "flat";
}

export function attribute(input: AttributionInput): Attribution {
  const deltaCents = input.closingCents - input.openingCents;

  const named: Record<Exclude<AttributionBandKey, "unexplained">, number> = {
    earned: input.earnedCents,
    agentIncome: input.agentIncomeCents,
    agentCosts: input.agentCostsCents,
    refunds: input.refundsCents,
    spent: input.spentCents,
    moved: input.movedCents,
    market: input.marketCents,
    portfolioFlow: input.portfolioFlowCents,
    inTransit: input.inTransitDeltaCents,
  };

  const namedTotal = Object.values(named).reduce((sum, c) => sum + c, 0);
  // Subtraction, and only subtraction — see the module docstring on why this
  // must never be assembled from the explanations that describe it.
  const unexplainedCents = deltaCents - namedTotal;

  const cents = (k: AttributionBandKey): number =>
    k === "unexplained" ? unexplainedCents : named[k];

  const grossCents = ATTRIBUTION_BAND_ORDER.reduce((sum, k) => sum + Math.abs(cents(k)), 0);

  const bands = ATTRIBUTION_BAND_ORDER.map((key) => {
    const c = cents(key);
    return {
      key,
      cents: c,
      direction: directionOf(c),
      isZero: c === 0,
      // a window where nothing moved has no denominator, and every share of
      // nothing is nothing — stated rather than divided
      sharePct: grossCents === 0 ? 0 : (c / grossCents) * 100,
    };
  });

  const attributedCents = input.restatements.reduce((sum, r) => sum + r.cents, 0);

  return {
    deltaCents,
    bands,
    grossCents,
    unexplainedCents,
    closes: unexplainedCents === 0,
    attributedCents,
    unattributedCents: unexplainedCents - attributedCents,
    restatements: input.restatements,
  };
}
