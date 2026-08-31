import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { forecastSplit } from "@/lib/forecast-split";
import type { MonthForecast } from "@/services/forecast";
import { ForecastComposition } from "./ForecastComposition";
import { monthLabel, staleComponentEntries } from "./labels";
import { StaleFooter, StaleMark } from "./StalenessNote";

interface ForecastCardProps {
  forecast: MonthForecast;
}

/**
 * The end-of-month projection with its math fully inspectable: every
 * component that feeds the totals renders in the "Show the math" table,
 * and the components sum exactly to the displayed projections.
 *
 * A series whose evidence has gone stale is NOT dropped from the math — the
 * forecast keeps the number and marks how old the evidence behind it is
 * (services/forecast.ts::fixedComponents).
 */
export function ForecastCard({ forecast: f }: ForecastCardProps) {
  const stale = staleComponentEntries(f.components);
  /*
   * Derived from the SAME array the totals above were summed from, so the band
   * and the tiles cannot drift: `forecastSplit` partitions by sign first, which
   * is exactly how `services/forecast` derives `projectedIncomeCents` and
   * `projectedSpendCents`. See lib/forecast-split.ts for why that makes the
   * identity arithmetic rather than a coincidence worth re-checking here.
   */
  const split = forecastSplit(
    f.components.map((c) => ({ kind: c.kind, cents: c.cents, isStale: c.staleness?.isStale })),
  );

  return (
    <SurfaceCard>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Forecast · {monthLabel(f.monthStart)}</h2>
        <span className="text-xs text-ink-faint">
          {f.remainingDays} of {f.daysInMonth} days remaining
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-5">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
            Projected income
          </dt>
          <dd className="mt-1">
            <Money cents={f.projectedIncomeCents} flow className="text-lg font-medium" />
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
            Projected spending
          </dt>
          <dd className="mt-1">
            <Money cents={f.projectedSpendCents} flow className="text-lg font-medium" />
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
            Projected net
          </dt>
          <dd className="mt-1">
            <Money cents={f.projectedNetCents} flow className="text-lg font-medium" />
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
            EOM cash
          </dt>
          <dd className="mt-1">
            <Money cents={f.projectedEomCashCents} className="text-lg font-medium" />
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
            EOM net worth
          </dt>
          <dd className="mt-1">
            <Money cents={f.projectedEomNetWorthCents} className="text-lg font-medium" />
          </dd>
        </div>
      </dl>

      <ForecastComposition split={split} />

      <details className="group mt-6 rounded-md border border-line bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink">
          Show the math
          <span className="ml-2 text-ink-faint group-open:hidden">
            ({f.components.length} components)
          </span>
        </summary>
        {f.components.length === 0 ? (
          <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
            No components yet — detect recurring series or import spending history.
          </p>
        ) : (
          // four columns of prose ("How it was computed") have a min-content
          // floor of ~374px, so on a phone this table pushed the whole document
          // sideways — 270px at 320 and still 150px at 440, and it did it while
          // COLLAPSED, scrolling the page into empty space. Wide content scrolls
          // in its own container (the web rule, and what DataTable.tsx:176 does);
          // the wrapper is what keeps it off the document.
          <div className="overflow-x-auto">
            <table className="w-full border-t border-line text-xs">
              <caption className="sr-only">
                Every forecast component; the rows sum exactly to the projections above
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint">
                  <th scope="col" className="px-4 py-2">Component</th>
                  <th scope="col" className="px-3 py-2">Type</th>
                  <th scope="col" className="px-3 py-2">How it was computed</th>
                  <th scope="col" className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {f.components.map((c) => (
                  <tr key={`${c.kind}-${c.label}`} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-2 text-left font-medium">
                      {c.label}
                      <StaleMark staleness={c.staleness} className="ml-2" />
                    </th>
                    <td className="px-3 py-2 text-ink-muted">
                      {c.kind === "fixed" ? "Fixed (series)" : "Variable (trailing avg)"}
                    </td>
                    <td className="px-3 py-2 text-ink-faint">{c.detail}</td>
                    <td className="px-4 py-2 text-right">
                      <Money cents={c.cents} flow />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong">
                  <th scope="row" colSpan={3} className="px-4 py-2 text-left font-medium">
                    Projected net (components sum)
                  </th>
                  <td className="px-4 py-2 text-right">
                    <Money cents={f.projectedNetCents} flow className="font-medium" />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </details>

      <StaleFooter entries={stale} className="mt-3" />
    </SurfaceCard>
  );
}
