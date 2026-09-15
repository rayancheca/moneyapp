import Link from "next/link";
import type { InvestmentsTeaser as InvestmentsTeaserData } from "@/services/dashboard";
import { Money } from "@/components/ui/Money";
import { Sparkline, type SparklineTone } from "@/components/ui/Sparkline";
import { formatCentsSigned } from "@/lib/money";

/**
 * The investments teaser (ux-overhaul-plan §7.1): portfolio value, today's
 * flow-adjusted move, a sparkline, and the single biggest mover — each drilling
 * into the Investments tab (the mover straight to its holding page). Reuses the
 * §6 portfolioOverview/topMovers so the numbers match the tab exactly.
 */

function toneOf(cents: number | null): SparklineTone {
  if (cents === null || cents === 0) return "neutral";
  return cents > 0 ? "positive" : "negative";
}

export function InvestmentsTeaser({ data }: { data: InvestmentsTeaserData }) {
  const dayTone =
    data.dayChangeCents === null
      ? "text-ink-muted"
      : data.dayChangeCents > 0
        ? "text-positive"
        : data.dayChangeCents < 0
          ? "text-negative"
          : "text-ink-muted";

  return (
    <section aria-labelledby="investments-teaser-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="investments-teaser-heading" className="text-sm font-medium">
          Investments
        </h2>
        <Link
          href={data.href}
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Portfolio →
        </Link>
      </div>

      <Link
        href={data.href}
        className="group block rounded-(--radius-card) border border-line bg-surface-raised p-4 transition-colors duration-(--duration-fast) hover:border-line-strong"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Money cents={data.valueCents} className="text-2xl font-semibold tracking-tight" />
            {/* No prior covered day means no change to report — an em dash, not
                a $0.00 that would read as a portfolio which sat still. And the
                period is NAMED rather than assumed: `dayChangeTerm` says "today"
                only when the newest close is today's, otherwise the two dates
                the move was measured between. */}
            <p className={`figures mt-0.5 text-xs ${dayTone}`}>
              {data.dayChangeCents === null ? (
                <span className="text-ink-faint">— no prior close to compare</span>
              ) : (
                <>
                  {!data.dayChangeExact && <span aria-hidden>≈ </span>}
                  {formatCentsSigned(data.dayChangeCents)}
                  {data.dayChangePct !== null && (
                    <span>
                      {" "}
                      ({data.dayChangePct >= 0 ? "+" : ""}
                      {data.dayChangePct.toFixed(2)}%)
                    </span>
                  )}
                  <span className="text-ink-faint"> {data.dayChangeTerm}</span>
                </>
              )}
            </p>
          </div>
          <Sparkline values={data.sparkline} tone={toneOf(data.dayChangeCents)} width={88} height={32} />
        </div>
      </Link>

      {data.topMover && (
        <Link
          href={data.topMover.href}
          className="flex items-center justify-between gap-3 rounded-(--radius-card) border border-line bg-surface-raised px-4 py-2.5 transition-colors duration-(--duration-fast) hover:border-line-strong"
        >
          <span className="text-xs text-ink-muted">
            Top mover <span className="figures font-medium text-ink">{data.topMover.symbol}</span>
          </span>
          <span
            className={`figures text-xs font-medium ${
              data.topMover.dayChangePct >= 0 ? "text-positive" : "text-negative"
            }`}
          >
            {data.topMover.dayChangePct >= 0 ? "+" : ""}
            {data.topMover.dayChangePct.toFixed(2)}%
            {/* the closes the move was measured between, when the headline's
                term above does not already name them — see TeaserMover */}
            {data.topMover.dayChangeTerm !== null && (
              <span className="font-normal text-ink-faint"> {data.topMover.dayChangeTerm}</span>
            )}
          </span>
        </Link>
      )}
    </section>
  );
}
