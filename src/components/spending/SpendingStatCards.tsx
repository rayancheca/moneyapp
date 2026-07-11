import { StatCard } from "@/components/ui/StatCard";
import { Money } from "@/components/ui/Money";
import { ledgerHref, type DateRange } from "@/services/analytics";
import type { PeriodTotals } from "@/services/spending";

/**
 * The four tappable summary cards (ux-overhaul-plan §5.1). Earned and Spent
 * drill to their EXACT kind-scoped ledger (the `income` / `spending` filter
 * tokens reconcile to these very numbers); Net and Savings-rate drill to the
 * whole period. Every card is a link — nothing is view-only.
 */
export function SpendingStatCards({ totals, range }: { totals: PeriodTotals; range: DateRange }) {
  const { earnedCents, spentCents, netCents, savingsRatePct } = totals;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Earned"
        value={<Money cents={earnedCents} />}
        href={ledgerHref({ category: "income", from: range.from, to: range.to })}
        ariaLabel={`Earned this period. ${earnedCents / 100} dollars. View income transactions.`}
      />
      <StatCard
        label="Spent"
        value={<Money cents={spentCents} />}
        href={ledgerHref({ category: "spending", from: range.from, to: range.to })}
        ariaLabel={`Spent this period. ${spentCents / 100} dollars. View spending transactions.`}
      />
      <StatCard
        label="Net"
        value={<Money cents={netCents} flow />}
        href={ledgerHref({ from: range.from, to: range.to })}
        ariaLabel={`Net this period. ${netCents < 0 ? "negative " : ""}${Math.abs(netCents) / 100} dollars. View all transactions.`}
      />
      <StatCard
        label="Savings rate"
        value={savingsRatePct === null ? <span className="text-ink-faint">—</span> : `${savingsRatePct}%`}
        delta={savingsRatePct === null ? "no income yet" : netCents >= 0 ? "kept" : "overspent"}
        href={ledgerHref({ from: range.from, to: range.to })}
        ariaLabel={
          savingsRatePct === null
            ? "Savings rate unavailable without income."
            : `Savings rate ${savingsRatePct} percent.`
        }
      />
    </div>
  );
}
