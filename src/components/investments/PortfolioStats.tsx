import { Money } from "@/components/ui/Money";
import { closesDayChange } from "@/lib/day-change-label";
import { formatDayShort, formatMonthYear } from "@/lib/format-date";
import type { PortfolioDayChange, PortfolioOverview } from "@/services/portfolio";

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

export function PortfolioStats({
  overview,
  dayChange,
  today,
}: {
  overview: PortfolioOverview;
  /** the move INTO the newest close — `portfolioDayChange`, never the series' carried last day */
  dayChange: PortfolioDayChange;
  today: string;
}) {
  /*
   * "Today" is a claim about WHEN, and this stat is never measured over today
   * unless the prices happen to be current. It is always the flow-adjusted move
   * between two covered days — days that both sit in the past
   * whenever prices have not been refreshed, which is this page's normal
   * resting state. On the real ledger `asOf` trails today by a week, so the
   * word asserted that a move measured between Aug 5 and Aug 6 happened today,
   * while the price-age note directly above said the closes were seven days
   * old. Two elements on one screen contradicting each other.
   *
   * So the word is spent only when it is true, and when it is not, the dates
   * that WERE measured are named instead of estimated over.
   *
   * 🔴 …and then it measured into a day NO close was printed on. The series is
   * carried to today, so on Tue 2026-09-15 this read "Today $0.00 +0.00%" —
   * Tuesday against Monday, at Monday's closes — over ten holdings that had
   * moved +$1,904.99 into those closes. The figure is now the move INTO the
   * newest close, named by the closes it is made of: the rule the movers strip
   * and the holdings subtotal on this page already use.
   */
  const { label, interval } = closesDayChange(dayChange.closes, today, formatDayShort).heading;
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
      <div>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">
          {label}
        </dt>
        {/* the interval note lives inside the dd, so each dl > div holds exactly
            a dt/dd pair (axe definition-list) — same idiom as Total return */}
        <dd className="mt-1">
          <span className="flex items-baseline gap-1.5">
            {/* Nothing to measure against — one covered day, or none at all. The
                em dash is the same treatment the two P/L stats below use for
                "not computable", rather than a $0.00 that would read as a
                portfolio which sat still. */}
            {dayChange.cents === null ? (
              <span className="text-sm text-ink-faint">—</span>
            ) : (
              <>
                <Money cents={dayChange.cents} flow className="text-sm font-medium" />
                <span className={`figures text-xs ${toneClass(dayChange.cents)}`}>
                  {pctText(dayChange.pct)}
                </span>
                {!dayChange.exact && (
                  <span className="text-[11px] text-ink-faint" title="A crypto trade this day — market P/L not separable to the cent">
                    ≈
                  </span>
                )}
              </>
            )}
          </span>
          {interval && (
            <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">{interval}</span>
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
          {/**
           * 🔴 "in total" is load-bearing. These two percentages are stacked one
           * above the other and they are NOT the same kind of number: TWR is
           * CUMULATIVE across the whole span, XIRR is a rate PER YEAR. Measured
           * 2026-08-27 over a 2.13-year book they read 30.42% and 28.56%, so
           * bare they invite the conclusion that the first beat the second —
           * when annualized the first is 13.30%/yr, less than half of it.
           * Neither label said so until now.
           */}
          {overview.twrAnchor && (
            <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
              time-weighted · in total since {formatMonthYear(overview.twrAnchor)}
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
                money-weighted · a year, your dollars
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
