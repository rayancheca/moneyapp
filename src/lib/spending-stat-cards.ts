import { nothingFoundSoFar } from "@/lib/budget-coverage";
import { formatCents } from "@/lib/money";
import { ledgerHref } from "@/lib/ledger-href";
import type { DateRange } from "@/services/analytics";
import type { PeriodTotals } from "@/services/spending";

/**
 * Pure descriptor for the /spending summary cards. Lives in lib (type-only
 * imports of PeriodTotals / DateRange are erased at build time, so no drizzle
 * leaks into the client bundle) so the card set — especially the conditional
 * Refunds card and every aria string — is unit-testable without rendering.
 *
 * The card row makes Net self-explaining: Income + Refunds − Spent = Net, all
 * on screen. Refunds only appears when there are refunds (positive amounts in
 * expense categories — statement credits, reimbursements). Its drill-down
 * (`category=spending, flow=in`) resolves to exactly the rows summed into
 * `refundsCents`, so the number reconciles to the list it opens — the same
 * "nothing view-only" contract every other card honors.
 */
export interface SpendingStatCardSpec {
  key: "earned" | "spent" | "refunds" | "net" | "savings";
  label: string;
  /** money-valued cards carry cents; `flow` shows +/- and semantic tone */
  cents?: number;
  flow?: boolean;
  /** non-money value (the savings-rate percent, or an em-dash) */
  text?: string;
  /** render `text` in the faint tone (the em-dash placeholder) */
  muted?: boolean;
  /** small sub-line under the value */
  delta?: string;
  href: string;
  ariaLabel: string;
  /** span both columns on the 2-col mobile grid so the card isn't a lonely orphan */
  mobileFull?: boolean;
}

/** a card whose figure is no measurement (decisions 64 + 72): the em dash, in the faint tone */
const DASH = { text: "—", muted: true } as const;

/** why Net and the savings rate wait, for a screen reader — Spent's own card says whose day it is */
const UNTIL_SPENDING_IS_FOUND = "until spending is found";

/** aria-friendly "N dollars" (matches the existing StatCard phrasing) */
function dollars(cents: number): string {
  return `${cents / 100} dollars`;
}

/**
 * ⚖️ Decisions 64 + 72: `spendingUnaccounted` is the window's `CashFlow.spendingUnaccounted` — "spending imported
 * through Aug 12" where it holds no spending row and not one of its elapsed days is read by the day every account he
 * spends from is imported through. Spent prints "—" with it, and so do Net and the savings rate, which are Spent's
 * arithmetic; what was found (Income, Refunds) keeps its figure, and every card keeps its link. 🔴 Review of 516d6fc,
 * his ledger copy 2026-10-13: `/spending?period=2026-09-23` read "Spent $0.00 · Net +$4,567.68 · Savings rate 100%"
 * over its own table row "$4,567.68 — —".
 */
export function spendingStatCards(
  totals: PeriodTotals,
  range: DateRange,
  spendingUnaccounted: string | null = null,
): SpendingStatCardSpec[] {
  const { earnedCents, spentCents, refundsCents, netCents, savingsRatePct } = totals;
  const showRefunds = refundsCents > 0;
  const cards: SpendingStatCardSpec[] = [];
  const notFound = spendingUnaccounted === null ? null : nothingFoundSoFar(spendingUnaccounted);

  /*
   * 🔴 S22 — "Earned" NAMED A POPULATION IT DID NOT HOLD. `earnedCents` is every
   * positive row in an income-kind category (`isIncome`) — off the agent's cash
   * account since 2026-09-28, his pay by the day since decision 75 (`hisIncomeRows`),
   * and `?category=income` opens the same set; /summary's "Earned" is
   * wages, tutoring and savings interest, and files financial aid and
   * reimbursements under "Money in that you did not earn". Measured on the real
   * ledger 2026-09-15: `/spending?period=2024` read "Earned $32,717.06" over a
   * year holding a $14,171.00 financial-aid refund.
   *
   * ⛔ Owner decision 2026-09-14: this population is "Income" on every surface
   * that prints it — this card, the savings and Net deltas, the heatmap, the
   * cash-flow chart/table/graph and the dashboard bridge — while /summary keeps
   * its narrow "Earned". Only words moved: the figure, the savings-rate base and
   * every href are unchanged. The `key` stays "earned" (never printed).
   */
  cards.push({
    key: "earned",
    label: "Income",
    cents: earnedCents,
    href: ledgerHref({ category: "income", from: range.from, to: range.to }),
    ariaLabel: `Income this period. ${dollars(earnedCents)}. View income transactions.`,
  });

  const spentHref = ledgerHref({ category: "spending", from: range.from, to: range.to, flow: "out" });
  cards.push(
    notFound === null
      ? {
          key: "spent",
          label: "Spent",
          cents: spentCents,
          href: spentHref,
          ariaLabel: `Spent this period, gross. ${dollars(spentCents)}. View spending transactions.`,
        }
      : {
          key: "spent",
          label: "Spent",
          ...DASH,
          delta: notFound,
          href: spentHref,
          ariaLabel: `Spent this period: ${notFound}. View spending transactions.`,
        },
  );

  if (showRefunds) {
    cards.push({
      key: "refunds",
      label: "Refunds",
      cents: refundsCents,
      flow: true,
      delta: "money back",
      href: ledgerHref({ category: "spending", from: range.from, to: range.to, flow: "in" }),
      ariaLabel: `Refunds this period. ${dollars(refundsCents)} back. View refund transactions.`,
      mobileFull: true,
    });
  }

  cards.push({
    key: "net",
    label: "Net",
    // ⚖️ no Spent, no Net: the figure is Spent's arithmetic (decisions 64 + 72)
    ...(notFound === null ? { cents: netCents, flow: true } : DASH),
    // with Refunds on screen the arithmetic is visible; name it for clarity
    delta: showRefunds ? "income + refunds − spent" : undefined,
    /*
     * 🔴 THE DRILL-DOWN CONTRACT, BROKEN ON THE ONE CARD THAT SUMS THE OTHER
     * THREE. This was an unscoped window, so `/spending?period=2026` printed
     * "Net -$31,733.19" over a link opening 2,682 rows summing to +$27,961.36 —
     * the whole ledger for the year, transfers, card payments and investment
     * flows included. Its Earned, Spent and Refunds siblings all opened exactly
     * the rows behind them. `cashflow` is their union, which is the population
     * this figure is over.
     */
    href: ledgerHref({ category: "cashflow", from: range.from, to: range.to }),
    ariaLabel:
      notFound === null
        ? `Net this period. ${netCents < 0 ? "negative " : ""}${dollars(Math.abs(netCents))}. View the income and spending behind it.`
        : `Net this period: no figure ${UNTIL_SPENDING_IS_FOUND}. View the income and spending behind it.`,
  });

  /*
   * ❓ OWNER DECISION, 2026-09-04: NAME THE DENOMINATOR, never suppress the
   * figure.
   *
   * `/spending?from=2026-07-01&to=2026-07-31` read
   *
   *     EARNED $52.95 · SPENT $10,353.96 · REFUNDS +$113.11 · NET -$10,187.90
   *     SAVINGS RATE  -19240.6%   overspent
   *
   * The rate is `net ÷ earned`, and July's recorded income is $52.95 of
   * dividends and interest — the cash job's $5,235.00 never reached a bank,
   * which the note under these cards says in full. The house style elsewhere is
   * to REFUSE a ratio its denominator cannot carry (`merchantProfile` will not
   * state a monthly rate under three visits), but refusing this one whenever
   * there is unbanked pay would refuse it on every recent window — and his
   * decision of 2026-08-21 is that both readings stand when the spending and
   * income surfaces disagree about the cash: "suppressing this one would tell a
   * working man he has no income."
   *
   * So the base is printed instead, always and not past a threshold: nothing
   * here was wrong, only unreadable. The base is named with the word the sibling
   * card uses for the same figure — "Income" since S22, when "Earned" turned out
   * to hold financial aid and reimbursements that /summary says were not earned.
   *
   * ⚖️ …and a rate over a Spent nobody has found is no figure (decisions 64 + 72): "—", the base still named.
   */
  const waits = notFound !== null && savingsRatePct !== null;
  cards.push({
    key: "savings",
    label: "Savings rate",
    text: savingsRatePct === null || waits ? "—" : `${savingsRatePct}%`,
    muted: savingsRatePct === null || waits,
    delta:
      savingsRatePct === null
        ? "no income yet"
        : waits
          ? `of ${formatCents(earnedCents)} income`
          : `${netCents >= 0 ? "kept" : "overspent"} · of ${formatCents(earnedCents)} income`,
    // the same population as Net — this rate is net ÷ income, and both terms
    // come from these rows
    href: ledgerHref({ category: "cashflow", from: range.from, to: range.to }),
    ariaLabel:
      savingsRatePct === null
        ? "Savings rate unavailable without income."
        : waits
          ? `Savings rate unavailable ${UNTIL_SPENDING_IS_FOUND}, of ${dollars(earnedCents)} of income.`
          : `Savings rate ${savingsRatePct} percent, of ${dollars(earnedCents)} of income.`,
  });

  return cards;
}
