import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { PerformanceCard as PerformanceCardData } from "@/services/performance-card";

/**
 * How the investments are actually doing — and, above everything else, BY WHICH
 * MEASURE.
 *
 * 🔴 The scale words are the card. `performanceCard()` welds them into the
 * percentages themselves ("+30.42% in total", "+28.56% a year") because without
 * them the two rates read as one league table with a winner. Measured
 * 2026-08-27 the ranking a reader would take from the bare numbers is inverted:
 * the time-weighted 30% is a total across two years and the money-weighted 28%
 * is a rate for each one, so per year the first is less than half the second.
 * Nothing in this file may split a percentage from its scale word, and nothing
 * here re-orders the rows — the order is the service's, and it is deliberately
 * not by size.
 *
 * ⛔ Presentation only. Every figure, sentence, clause and caveat arrives
 * written. This file decides no absence, grades no measure and computes no
 * return; `portfolioOverview` owns all four, and the service owns the words.
 *
 * ## Why the percentages are not tinted and the dollars are
 *
 * The app's colour rule (`Money flow`: green up, red down) is right for money
 * and applied here unchanged — this card, unlike `MoversCard`, is about gains
 * where up really is up. The PERCENTAGES are deliberately left in plain ink,
 * which is a departure from the identical stat row on /investments: four green
 * percentages stacked in one column is a scoreboard, and a scoreboard is
 * exactly the reading this card exists to prevent. The sign carries a negative
 * rate perfectly well without help.
 *
 * ## The headline carries no sign
 *
 * `headlineCents` is a magnitude and the direction is a word in the noun
 * beside it, so no sign flip happens on this screen at all — the route by which
 * "-$0.00" once shipped to this dashboard.
 */
export function PerformanceCard({ data }: { data: PerformanceCardData }) {
  const { measures, notes } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          How the investments are doing
        </h3>
        <Link
          href="/investments"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Portfolio →
        </Link>
      </div>

      {/* A <p> is safe for the headline here: `InfoTip` renders its panel as a
          <span popover>, phrasing content that the parser leaves inside the
          paragraph (its own docstring records the measurement). The tag that
          may not go here is a <div>-based popover, which the parser hoists out
          and which closes the <p> — hydration #418, and an inert page. */}
      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {data.headline}
        <span className="ml-1.5 text-base font-normal text-ink-muted">{data.headlineNoun}</span>
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <dl className="mt-4 space-y-2.5 border-t border-line pt-3 text-sm">
        {measures.map((m) => (
          <div key={m.key} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`truncate ${m.isHeadline ? "font-medium text-ink" : "text-ink-muted"}`}>
                  {m.label}
                </span>
                {/* ONE tip on this card, on the one term the reader cannot
                    infer from the clause under it. A tooltip body is live DOM
                    text even while closed, so a second one repeating a phrase
                    the rows already print would say it twice in two voices and
                    break an exact-count locator elsewhere. */}
                {m.key === "twr" && (
                  <InfoTip term={m.label}>
                    A measure of the investments alone: adding or withdrawing money on a good or a bad day can
                    neither flatter it nor spoil it.
                  </InfoTip>
                )}
              </span>
              <span className="block text-[11px] leading-relaxed text-ink-faint">{m.meaning}</span>
            </dt>
            <dd className="shrink-0 text-right">
              {/* the scale word travels inside `pctLabel` and can never be
                  dropped separately from the number it qualifies */}
              {m.pctLabel && <span className="figures block text-ink-muted">{m.pctLabel}</span>}
              {m.cents !== null && (
                <span className="block">
                  {m.approximate && <span aria-hidden>≈ </span>}
                  <Money cents={m.cents} flow className="text-[13px]" />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {/* ⛔ Not a footnote — the whole argument. Without it the rows above are a
          ranking, and the reader keeps the largest. Null only when there is
          exactly one measure, i.e. nothing to rank. */}
      {data.scaleNote && (
        <p className="mt-3 max-w-prose border-t border-line pt-3 text-[11px] leading-relaxed text-ink-muted">
          {data.scaleNote}
        </p>
      )}

      <div className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-ink-faint">
        {notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
        {/* the value the teaser on this same page prints, from the same call —
            here only so the gain has something to be a gain of */}
        <p>{data.footer}</p>
      </div>
    </SurfaceCard>
  );
}
