import Link from "next/link";
import type { SpendingPace } from "@/services/dashboard";
import { formatCents } from "@/lib/money";

/**
 * The spending-pace teaser (ux-overhaul-plan §7.1 [CP]): a solid line of
 * cumulative spend so far and a dotted projection to where the month's current
 * pace lands, plus "Free to spend ≈ $X" — the discretionary headroom left after
 * income and the fixed bills still due. A calm read that hands off to /spending.
 */

const VW = 240;
const VH = 56;

interface PaceGeometry {
  solid: string;
  projection: string | null;
}

function buildGeometry(pace: SpendingPace): PaceGeometry | null {
  const n = pace.points.length;
  if (n < 2) return null;
  const actual = pace.points.map((p) => p.actualCents);
  let lastActualIdx = -1;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== null) lastActualIdx = i;
  if (lastActualIdx < 0) return null;

  const max = Math.max(
    pace.projectedCents,
    ...actual.filter((v): v is number => v !== null),
    1,
  );
  const x = (i: number) => (i / (n - 1)) * VW;
  const y = (v: number) => VH - 4 - (v / max) * (VH - 8);

  const solid = actual
    .slice(0, lastActualIdx + 1)
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v!).toFixed(1)}`)
    .join(" ");

  // straight dotted projection from the last actual point to the month-end pace
  const startV = actual[lastActualIdx]!;
  const projection =
    lastActualIdx < n - 1
      ? `M ${x(lastActualIdx).toFixed(1)} ${y(startV).toFixed(1)} L ${x(n - 1).toFixed(1)} ${y(pace.projectedCents).toFixed(1)}`
      : null;

  return { solid, projection };
}

export function SpendingPaceWidget({ pace }: { pace: SpendingPace }) {
  const geo = buildGeometry(pace);
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
              viewBox={`0 0 ${VW} ${VH}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="h-14 w-32 shrink-0 text-accent"
            >
              {geo.projection && (
                <path
                  d={geo.projection}
                  fill="none"
                  stroke="var(--ink-faint)"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <path
                d={geo.solid}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </div>
      </Link>
    </section>
  );
}
