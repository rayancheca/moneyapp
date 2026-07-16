import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Money } from "@/components/ui/Money";
import { formatDayLong } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import type { RealizedPnl, RealizedSale } from "@/lib/realized-pnl";
import { formatQuantityE8 } from "@/services/holdings";

/**
 * The sell drill-down (Robinhood-parity item 2): every realized sale for this
 * holding — day, quantity, proceeds, average-cost basis, and the gain each sell
 * locked in. HONESTY: the walk values trades at daily closes (execution prices
 * are not recorded), the header says so, ≈ marks a sale whose basis was partial
 * (an unpriced earlier trade), and a clamped over-sell names the import gap.
 * Rendered only when the holding has at least one sell.
 */

/** A heavily traded holding can have many sells — show the recent ones. */
const SALES_SHOWN = 40;

export function RealizedSalesList({
  sales,
  totals,
}: {
  /** ascending by day; this component shows the newest first */
  sales: RealizedSale[];
  totals: RealizedPnl;
}) {
  const shown = sales.slice().reverse().slice(0, SALES_SHOWN);
  const hidden = sales.length - shown.length;
  return (
    <SurfaceCard>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Realized P/L</h2>
        <span className="figures text-sm">
          <Money cents={totals.realizedCents} flow />
          <span className="ml-2 text-[11px] font-normal text-ink-faint">
            {totals.exact ? "" : "≈ "}
            {totals.sellCount} sell{totals.sellCount === 1 ? "" : "s"} · at daily closes
          </span>
        </span>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((s, i) => (
          <li key={`${s.day}-${i}`} className="px-1">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <span className="figures text-sm">Sold {formatQuantityE8(s.qtyE8)} sh</span>
                <div className="text-[11px] text-ink-faint">
                  {formatDayLong(s.day)}
                  {s.clamped && (
                    <span title="The sell exceeded the recorded holdings (an import gap) and was clamped">
                      {" "}
                      · clamped
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <span className="figures text-sm">
                  {!s.exact && <span title="An earlier trade had no cached close — the basis is partial">≈ </span>}
                  <Money cents={s.gainCents} flow />
                </span>
                <div className="figures text-[11px] text-ink-faint">
                  {formatCents(s.proceedsCents)} − {formatCents(s.basisCents)} basis
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-3 text-xs text-ink-faint">{hidden} earlier sells not shown.</p>
      )}
    </SurfaceCard>
  );
}
