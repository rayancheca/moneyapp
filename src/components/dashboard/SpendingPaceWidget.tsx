import Link from "next/link";
import type { SpendingPace } from "@/services/dashboard";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { nothingFoundSoFar } from "@/lib/budget-coverage";
import { formatCents } from "@/lib/money";
import { notImportedTitle } from "@/lib/empty-period";
import { untilFound } from "@/lib/spending-stat-cards";
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
  // ⚖️ §6A 68: Free to spend waits for an Income nobody has looked for; what was spent was found, and stands under it
  const spendingShown = free !== null || pace.waitsForIncome;

  return (
    <section aria-labelledby="pace-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pace-heading" className="text-sm font-medium">
          Spending pace <span className="text-ink-faint">· {pace.monthLabel}</span>
          {/* ⚖️ decision 72 (2026-10-13): /spending's proof of the month, its chip and all — "partly read" over days not
              every account he spends from has read. On the heading, never inside the card's link: a button in an <a>
              is axe `nested-interactive`, the reason /spending mounts its own on a heading. No proof beside the dash
              (`CategoryHeadline`'s rule): the popover proves a rendered figure — and the service builds none there.
              Beside a Free to spend waiting for income it proves the spending figures still printed under it. */}
          {spendingShown && pace.provenance !== null && (
            <ProvenancePopover label="this month's spending" provenance={pace.provenance} />
          )}
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
            {/* ⛔ An em dash, not a $0.00. When not one elapsed day of the
                month is imported, "you have spent nothing, so $X is free" is a
                claim about a month nobody has looked at — and it is the figure
                the eye lands on. Measured on the real ledger at today =
                2026-09-20 this tile read "≈ $947.00 · $0.00 spent · $0.00
                projected" over twenty unimported days. /budgets already
                refuses to grade the same days; this is that refusal. */}
            {free === null ? (
              <div className="figures mt-0.5 text-2xl font-semibold tracking-tight text-ink-faint">—</div>
            ) : (
              <div
                className={`figures mt-0.5 text-2xl font-semibold tracking-tight ${
                  free < 0 ? "text-negative" : "text-ink"
                }`}
              >
                {/* always approximate (a projection): a negative value = over pace */}
                ≈ {free < 0 ? "−" : ""}
                {formatCents(Math.abs(free))}
              </div>
            )}
            {/* ⚖️ §6A 68: a figure waiting for income says so, in /spending's savings-rate words for the same wait
                (`untilFound`), and the spending figures follow. 🔴 His ledger copy 2026-10-21: "≈ −$2,839.14" beside
                the dashboard's own Income card reading "—". */}
            {pace.waitsForIncome && (
              <div className="mt-0.5 text-[11px] text-ink-muted">{untilFound(false, true)}</div>
            )}
            {/* With NOTHING measured the figures are not lower bounds worth
                printing — "at least $0.00" is true of every month there has
                ever been. The reason replaces them; with part of the window
                measured they stand, marked as the bounds they are. */}
            {!spendingShown ? (
              <div className="mt-0.5 text-[11px] text-ink-muted">
                {/* the empty state's heading for the same month — the category headline's under its dash, word for
                    word. 🔴 "October 2026 is not imported yet" here, "has not been imported yet" there (review of
                    b2c9db7). ⚖️ Decision 64: where some account has read days and no spending was found past the day
                    all of them are read through, /spending's Spent card's words for its own dash. The dashboard's
                    Flow says those words over a range NO account has read too — the clause of the empty state whose
                    heading this prints, not a second reading (`CashFlow.spendingUnaccounted`, 2026-10-29). */}
                {pace.spendingNotFound === null
                  ? notImportedTitle(pace.monthLabel)
                  : nothingFoundSoFar(pace.spendingNotFound)}
              </div>
            ) : (
              <>
                <div className="mt-0.5 text-[11px] text-ink-muted">
                  {pace.partlyRead && "at least "}
                  {formatCents(pace.actualToDateCents)} spent ·{" "}
                  {pace.partlyRead && "at least "}
                  {formatCents(pace.projectedCents)} projected
                </div>
                {/* ⚖️ decision 72: the days the chip calls partly read, in /budgets' words — the line /spending prints
                    under "Where it went" and in its cash-flow readout for the same month. 🔴 On his ledger copy
                    2026-10-21 this read "7 days of October 2026 not imported yet" — the days NO account had read — where
                    /spending read "spending imported through Aug 12 · 21 days of this period unaccounted". */}
                {pace.partlyRead && <div className="mt-0.5 text-[11px] text-ink-faint">{pace.partlyRead.line}</div>}
              </>
            )}
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
        {/* ⚖️ default built, not asked (2026-10-29): this month's paydays Free to spend has in neither leg, in the
            forecast's words and warning tone (`SpendingPace.paydaysLeftOut`) — full width, under the figures it
            qualifies. 🔴 Review of a5ce8b15: Jul 9's $1,000 left both legs on Jul 10 with nothing said. */}
        {pace.paydaysLeftOut && (
          <p
            className={`mt-2 max-w-prose text-[11px] leading-relaxed ${
              pace.paydaysLeftOut.warning ? "text-warning" : "text-ink-faint"
            }`}
          >
            {pace.paydaysLeftOut.text}
          </p>
        )}
      </Link>
    </section>
  );
}
