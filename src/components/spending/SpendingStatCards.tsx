import { StatCard } from "@/components/ui/StatCard";
import { Money } from "@/components/ui/Money";
import { spendingStatCards } from "@/lib/spending-stat-cards";
import type { DateRange } from "@/services/analytics";
import type { PeriodTotals } from "@/services/spending";

/**
 * The tappable summary cards (ux-overhaul-plan §5.1). Income/Spent/Refunds each
 * drill to their EXACT kind-scoped ledger (the filter tokens reconcile to these
 * very numbers); Net and Savings-rate drill to the whole period. Every card is a
 * link — nothing is view-only. Refunds appears only in periods with expense-
 * category credits, so Net reads as Income + Refunds − Spent right on the row.
 * The card set + aria live in the pure `spendingStatCards` helper.
 */
export function SpendingStatCards({ totals, range }: { totals: PeriodTotals; range: DateRange }) {
  const cards = spendingStatCards(totals, range);
  const cols = cards.length >= 5 ? "lg:grid-cols-5" : "lg:grid-cols-4";
  return (
    <div className={`grid grid-cols-2 gap-3 ${cols}`}>
      {cards.map((card) => (
        <StatCard
          key={card.key}
          label={card.label}
          value={
            card.text !== undefined ? (
              card.muted ? (
                <span className="text-ink-faint">{card.text}</span>
              ) : (
                card.text
              )
            ) : (
              <Money cents={card.cents ?? 0} flow={card.flow} />
            )
          }
          delta={card.delta}
          href={card.href}
          ariaLabel={card.ariaLabel}
          className={card.mobileFull ? "col-span-2 lg:col-span-1" : undefined}
        />
      ))}
    </div>
  );
}
