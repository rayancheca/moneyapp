import { Money } from "@/components/ui/Money";
import { formatMonthYear } from "@/lib/format-date";
import type { PortfolioOverview } from "@/services/portfolio";

/**
 * The stat row beneath the portfolio chart: today's flow-adjusted change, the
 * whole-portfolio time-weighted return (anchored + labeled), and cost-basis P/L.
 * TWR is the honest performance number (flow-insensitive); cost-basis P/L is
 * "how far up on what I paid" — both stated, never conflated.
 */

function pctText(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function toneClass(value: number | null): string {
  if (value === null || value === 0) return "text-ink";
  return value < 0 ? "text-negative" : "text-positive";
}

export function PortfolioStats({ overview }: { overview: PortfolioOverview }) {
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
      <div>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">
          Today{overview.dayChangeVsDay ? "" : ""}
        </dt>
        <dd className="mt-1 flex items-baseline gap-1.5">
          <Money cents={overview.dayChangeCents} flow className="text-sm font-medium" />
          <span className={`figures text-xs ${toneClass(overview.dayChangeCents)}`}>
            {pctText(overview.dayChangePct)}
          </span>
          {!overview.dayChangeExact && (
            <span className="text-[11px] text-ink-faint" title="A crypto trade this day — market P/L not separable to the cent">
              ≈
            </span>
          )}
        </dd>
      </div>

      <div>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">Total return</dt>
        {/* the anchor note lives inside the dd so each dl > div holds exactly a
            dt/dd pair (axe definition-list) */}
        <dd className="mt-1">
          <span className="flex items-baseline gap-1.5">
            <span className={`figures text-sm font-medium ${toneClass(overview.twrPct)}`}>
              {pctText(overview.twrPct)}
            </span>
            <Money cents={overview.twrGainCents} flow className="text-xs" />
          </span>
          {overview.twrAnchor && (
            <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
              time-weighted · since {formatMonthYear(overview.twrAnchor)}
            </span>
          )}
          {/* money-weighted (XIRR) companion — the growth rate of YOUR dollars,
              sensitive to when you added/removed money; shown alongside, never
              instead of, the flow-insensitive TWR above */}
          {overview.xirrPct !== null && (
            <span className="mt-1.5 block border-t border-line/60 pt-1.5">
              <span className="flex items-baseline gap-1.5">
                <span className={`figures text-sm font-medium ${toneClass(overview.xirrPct)}`}>
                  {pctText(overview.xirrPct)}
                </span>
                {!overview.xirrExact && (
                  <span
                    className="text-[11px] text-ink-faint"
                    title="A crypto flow feeds this — not separable to the cent"
                  >
                    ≈
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                money-weighted · your dollars
              </span>
            </span>
          )}
        </dd>
      </div>

      <div>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">Unrealized P/L</dt>
        <dd className="mt-1">
          <span className="flex items-baseline gap-1.5">
            {overview.costBasisPlCents !== null ? (
              <>
                <Money cents={overview.costBasisPlCents} flow className="text-sm font-medium" />
                <span className={`figures text-xs ${toneClass(overview.costBasisPlCents)}`}>
                  {pctText(overview.costBasisPlPct)}
                </span>
              </>
            ) : (
              <span className="text-sm text-ink-faint">—</span>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">open positions · avg cost</span>
        </dd>
      </div>

      <div>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">Realized P/L</dt>
        <dd className="mt-1">
          <span className="flex items-baseline gap-1.5">
            {overview.realizedPlCents !== null ? (
              <>
                <Money cents={overview.realizedPlCents} flow className="text-sm font-medium" />
                {!overview.realizedPlExact && (
                  <span
                    className="text-[11px] text-ink-faint"
                    title="Some trades had no cached price — estimated at daily closes"
                  >
                    ≈
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm text-ink-faint">—</span>
            )}
          </span>
          {overview.realizedPlCents !== null && (
            <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
              {overview.realizedSellCount} sell{overview.realizedSellCount === 1 ? "" : "s"} · at daily closes
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}
