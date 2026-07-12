import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatDayLong } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { formatQuantityE8 } from "@/services/holdings";
import type { HoldingEventRow } from "@/services/holding-detail";

/**
 * Events history (ux-overhaul-plan §6.4): the most recent dated buys/sells from
 * the rebuilt timeline, each equity row linking to its source ledger
 * transactions. A heavily DCA'd holding has hundreds of trades, so the list is
 * capped with a "view all" ledger link. Crypto rows do not link — those trades
 * live only in monthly statements.
 */
export function HoldingEventsList({
  events,
  eventsTotal,
  allTradesHref,
}: {
  events: HoldingEventRow[];
  eventsTotal: number;
  allTradesHref: string | null;
}) {
  if (events.length === 0) {
    return (
      <SurfaceCard>
        <h2 className="mb-2 text-sm font-medium">Trade history</h2>
        <p className="text-sm text-ink-muted">No recorded trades for this holding yet.</p>
      </SurfaceCard>
    );
  }

  const hidden = eventsTotal - events.length;
  return (
    <SurfaceCard>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Trade history</h2>
        <span className="text-[11px] text-ink-faint">
          {hidden > 0 ? `${events.length} most recent of ${eventsTotal}` : `${eventsTotal} trades`}
        </span>
      </div>
      <ul className="divide-y divide-line">
        {events.map((e, i) => {
          const body = (
            <div className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2.5">
                <Badge tone={e.kind === "buy" ? "positive" : "negative"}>{e.kind === "buy" ? "Buy" : "Sell"}</Badge>
                <div className="min-w-0">
                  <span className="figures text-sm">{formatQuantityE8(Math.abs(e.quantityE8))} sh</span>
                  <div className="text-[11px] text-ink-faint">{formatDayLong(e.day)}</div>
                </div>
              </div>
              {e.costCents !== null ? (
                <span className="figures shrink-0 text-sm text-ink-muted">{formatCents(e.costCents)}</span>
              ) : null}
            </div>
          );
          return (
            <li key={`${e.day}-${i}`}>
              {e.ledgerHref ? (
                <Link
                  href={e.ledgerHref}
                  className="block rounded-md px-1 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                >
                  {body}
                </Link>
              ) : (
                <div className="px-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && allTradesHref && (
        <Link
          href={allTradesHref}
          className="mt-3 inline-block text-xs font-medium text-accent underline decoration-line underline-offset-4 transition-colors duration-(--duration-fast) hover:decoration-accent"
        >
          View all {eventsTotal} trades in the ledger →
        </Link>
      )}
      {hidden > 0 && !allTradesHref && (
        <p className="mt-3 text-xs text-ink-faint">
          {hidden} earlier trades not shown — crypto trades live in monthly statements.
        </p>
      )}
    </SurfaceCard>
  );
}
