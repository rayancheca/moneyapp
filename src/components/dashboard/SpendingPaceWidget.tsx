import Link from "next/link";
import type { SpendingPace } from "@/services/dashboard";
import { formatCents } from "@/lib/money";
import { paceGeometry, PACE_VH, PACE_VW } from "@/lib/pace-geometry";

/**
 * The spending-pace teaser (ux-overhaul-plan §7.1 [CP]): a filled staircase of
 * cumulative spend so far and a dotted projection to where the month's current
 * pace lands, plus "Free to spend ≈ $X" — the discretionary headroom left after
 * income and the fixed bills still due. A calm read that hands off to /spending.
 *
 * All of the geometry lives in @/lib/pace-geometry, where the 100%-branch gate
 * can reach the days of the month a pinned e2e clock never renders. This file
 * owns colour, weight and order only.
 */

export function SpendingPaceWidget({ pace }: { pace: SpendingPace }) {
  const geo = paceGeometry({
    actualCents: pace.points.map((p) => p.actualCents),
    projectedCents: pace.projectedCents,
  });
  const free = pace.freeToSpendCents;

  return (
    <section aria-labelledby="pace-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pace-heading" className="text-sm font-medium">
          Spending pace <span className="text-ink-faint">· {pace.monthLabel}</span>
        </h2>
        <Link
          href={pace.href}
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Details →
        </Link>
      </div>

      <Link
        href={pace.href}
        className="group block rounded-(--radius-card) border border-line bg-surface-raised p-4 transition-colors duration-(--duration-fast) hover:border-line-strong"
      >
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">Free to spend</div>
            <div
              className={`figures mt-0.5 text-2xl font-semibold tracking-tight ${
                free < 0 ? "text-negative" : "text-ink"
              }`}
            >
              {/* always approximate (a projection): a negative value = over pace */}
              ≈ {free < 0 ? "−" : ""}
              {formatCents(Math.abs(free))}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted">
              {formatCents(pace.actualToDateCents)} spent · {formatCents(pace.projectedCents)} projected
            </div>
          </div>
          {geo && (
            <svg
              viewBox={`0 0 ${PACE_VW} ${PACE_VH}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="h-14 w-32 shrink-0 text-accent"
            >
              {/* The estimate, deliberately a whisper. It is a straight line
                  because it IS a straight-line extrapolation, and curving it to
                  look livelier would draw a shape nobody measured — so it is
                  quietened instead of restyled. --line-strong rather than
                  --ink-faint: fainter in BOTH themes (light 0.82 vs 0.52; dark
                  0.40 vs 0.64 against a dark ground). Safe to fade because the
                  svg is aria-hidden and every figure it draws is printed as text
                  beside it, so it is decorative, not informational. */}
              {geo.projection && (
                <path
                  d={geo.projection}
                  fill="none"
                  stroke="var(--line-strong)"
                  strokeWidth={1.25}
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <path d={geo.area} fill="currentColor" opacity={0.12} stroke="none" />
              <path
                d={geo.solid}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* Where the measured part stops and the estimate takes over.
                  A zero-length round-capped stroke, not a <circle>: the viewBox
                  is drawn with preserveAspectRatio="none", which squeezes x to
                  ~0.53 and would hatch any real circle into an egg. Stroke
                  geometry is exempt via non-scaling-stroke. */}
              <path
                d={`M ${geo.todayX.toFixed(1)} ${geo.todayY.toFixed(1)} L ${geo.todayX.toFixed(1)} ${geo.todayY.toFixed(1)}`}
                stroke="currentColor"
                strokeWidth={4}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </div>
      </Link>
    </section>
  );
}
