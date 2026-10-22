import { StatCard } from "@/components/ui/StatCard";
import { Money } from "@/components/ui/Money";
import { VerdictChip } from "@/components/ui/VerdictChip";
import { spendingStatCards } from "@/lib/spending-stat-cards";
import type { DateRange } from "@/services/analytics";
import type { PartlyRead } from "@/services/provenance";
import type { PeriodTotals } from "@/services/spending";

/**
 * The tappable summary cards (ux-overhaul-plan §5.1). Income/Spent/Refunds each
 * drill to their EXACT kind-scoped ledger (the filter tokens reconcile to these
 * very numbers); Net and Savings-rate drill to the whole period. Every card is a
 * link — nothing is view-only. Refunds appears only in periods with expense-
 * category credits, so Net reads as Income + Refunds − Spent right on the row.
 * The card set + aria live in the pure `spendingStatCards` helper.
 */
export function SpendingStatCards({
  totals,
  range,
  spendingUnaccounted,
  incomeUnread,
  partlyRead,
}: {
  totals: PeriodTotals;
  range: DateRange;
  /** `CashFlow.spendingUnaccounted` — Spent, Net and the savings rate print "—" with it (decisions 64 + 72) */
  spendingUnaccounted: string | null;
  /** §6A 68: the dashboard's note under its Income dash, for this window — Income, Net and the rate print "—" with it */
  incomeUnread: string | null;
  /** decision 72: the period proof's days read only in part (`Provenance.partlyRead`) — the chip, and Spent's line */
  partlyRead: PartlyRead | null;
}) {
  const cards = spendingStatCards(totals, range, spendingUnaccounted, { incomeUnread, partlyRead });
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
          chip={card.partlyRead ? <VerdictChip verdict="partly_read" /> : undefined}
          className={card.mobileFull ? "col-span-2 lg:col-span-1" : undefined}
        />
      ))}
    </div>
  );
}
