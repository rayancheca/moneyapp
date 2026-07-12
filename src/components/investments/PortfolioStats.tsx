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
    <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-3">
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
        </dd>
      </div>

      <div>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">Cost-basis P/L</dt>
        <dd className="mt-1 flex items-baseline gap-1.5">
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
        </dd>
      </div>
    </dl>
  );
}
