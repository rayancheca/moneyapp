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
 * The card row makes Net self-explaining: Earned + Refunds − Spent = Net, all
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

/** aria-friendly "N dollars" (matches the existing StatCard phrasing) */
function dollars(cents: number): string {
  return `${cents / 100} dollars`;
}

export function spendingStatCards(totals: PeriodTotals, range: DateRange): SpendingStatCardSpec[] {
  const { earnedCents, spentCents, refundsCents, netCents, savingsRatePct } = totals;
  const showRefunds = refundsCents > 0;
  const cards: SpendingStatCardSpec[] = [];

  cards.push({
    key: "earned",
    label: "Earned",
    cents: earnedCents,
    href: ledgerHref({ category: "income", from: range.from, to: range.to }),
    ariaLabel: `Earned this period. ${dollars(earnedCents)}. View income transactions.`,
  });

  cards.push({
    key: "spent",
    label: "Spent",
    cents: spentCents,
    href: ledgerHref({ category: "spending", from: range.from, to: range.to, flow: "out" }),
    ariaLabel: `Spent this period, gross. ${dollars(spentCents)}. View spending transactions.`,
  });

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
    cents: netCents,
    flow: true,
    // with Refunds on screen the arithmetic is visible; name it for clarity
    delta: showRefunds ? "earned + refunds − spent" : undefined,
    href: ledgerHref({ from: range.from, to: range.to }),
    ariaLabel: `Net this period. ${netCents < 0 ? "negative " : ""}${dollars(Math.abs(netCents))}. View all transactions.`,
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
   * here was wrong, only unreadable. "Earned" is the word the sibling card two
   * along already uses for the same figure.
   */
  cards.push({
    key: "savings",
    label: "Savings rate",
    text: savingsRatePct === null ? "—" : `${savingsRatePct}%`,
    muted: savingsRatePct === null,
    delta:
      savingsRatePct === null
        ? "no income yet"
        : `${netCents >= 0 ? "kept" : "overspent"} · of ${formatCents(earnedCents)} earned`,
    href: ledgerHref({ from: range.from, to: range.to }),
    ariaLabel:
      savingsRatePct === null
        ? "Savings rate unavailable without income."
        : `Savings rate ${savingsRatePct} percent, of ${dollars(earnedCents)} earned.`,
  });

  return cards;
}
