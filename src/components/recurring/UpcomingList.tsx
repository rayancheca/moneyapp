import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { seriesIsIncomeOrSpending } from "@/lib/series-kind";
import type { SeriesOccurrence } from "@/services/recurring";
import { KIND_LABEL, shortDate, staleOccurrenceEntries } from "./labels";
import { StaleFooter, StaleMark } from "./StalenessNote";

interface UpcomingListProps {
  occurrences: SeriesOccurrence[];
}

/**
 * Projected occurrences for the next 30 days, date-sorted, with a total.
 *
 * Every detected|confirmed series is here, stale evidence included — see
 * services/recurring.ts::upcomingOccurrences for why filtering would be the
 * dishonest option. Each late row is marked, and a collapsed footer names
 * what is late and why. The one series left out is not his: an income series
 * on the agent's cash (owner decision 2026-09-28), which no Income of his and
 * no 30-day net counts.
 *
 * ⚖️ A transfer series is LISTED and left out of the net: money moving between
 * his own accounts is never income or spending (`seriesIsIncomeOrSpending`), the
 * rule the forecast card above this tab and the dashboard's Upcoming apply.
 * 🔴 Summed, a one-legged one — the card autopay out of checking, its card's
 * statements never imported — moved this net by its whole amount. When what is
 * left out does not cancel, a line names it, so the rows still add up to the net.
 */
export function UpcomingList({ occurrences }: UpcomingListProps) {
  const totalCents = occurrences
    .filter((o) => seriesIsIncomeOrSpending(o.kind))
    .reduce((sum, o) => sum + o.amountCents, 0);
  const transfersCents = occurrences
    .filter((o) => !seriesIsIncomeOrSpending(o.kind))
    .reduce((sum, o) => sum + o.amountCents, 0);
  const stale = staleOccurrenceEntries(occurrences);

  return (
    <SurfaceCard className="p-0">
      <h2 className="border-b border-line px-5 pb-3 pt-5 text-sm font-medium">Upcoming 30 days</h2>
      {occurrences.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">
          Nothing projected — confirm or detect series to see expected bills here.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {occurrences.map((o) => (
              <li
                key={`${o.seriesId}-${o.date}`}
                className="flex items-baseline justify-between gap-3 px-5 py-2.5"
              >
                <div className="min-w-0">
                  <span className="figures mr-2 text-xs text-ink-faint">{shortDate(o.date)}</span>
                  <span className="truncate text-sm">{o.name}</span>
                  <span className="ml-2 text-[11px] text-ink-faint">{KIND_LABEL[o.kind]}</span>
                  {/* a stale series keeps its row; the age of the evidence sits
                      with the rest of what we know about it, never replaces it */}
                  <StaleMark staleness={o.staleness} className="ml-2" />
                </div>
                <Money cents={o.amountCents} flow className="text-sm" />
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between border-t border-line-strong px-5 py-3">
            <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">
              30-day net
            </span>
            <Money cents={totalCents} flow className="text-sm font-medium" />
          </div>
          {transfersCents !== 0 ? (
            <p className="px-5 pb-3 text-[11px] text-ink-faint">
              The net leaves out the <Money cents={transfersCents} flow /> of transfers above: money moving
              between your own accounts is never income or spending.
            </p>
          ) : null}
          <StaleFooter window="In the next 30 days" entries={stale} className="m-3" />
        </>
      )}
    </SurfaceCard>
  );
}
