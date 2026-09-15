import { InsightList } from "@/components/insights/InsightList";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { YearSpendingView } from "@/services/year-insights";

const HEADING = "What you spent";

/**
 * The one thread of money OUT on `/summary/[year]`, in whichever form the
 * insights switch leaves it.
 *
 * With insights on, the two sentences ARE the figures, and the card is exactly
 * the `InsightList` it always was. With them off, the same figures print as a
 * plain list, each with the proof its sentence carried — "off removes the prose
 * and nothing else" (`InsightsManager`) — under the same heading, so the
 * gambling note's "the figure under What you spent" still points at something.
 *
 * ⛔ The window note stays in both forms. It is not an insight: it says these
 * figures are money out, on a page whose every other total is money in.
 *
 * The badge sits in a `<dd>`, never a `<p>` — `ProvenancePopover` renders a
 * `<div popover>` beside its trigger (see `InsightList`).
 */
export function YearSpendingCard({ view }: { view: YearSpendingView }) {
  if (view.insights !== null) return <InsightList data={view.insights} heading={HEADING} />;
  return (
    <SurfaceCard>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h2 id="year-spending" className="text-sm font-medium">
          {HEADING}
        </h2>
        <span className="text-xs text-ink-faint">{view.windowLabel}</span>
      </div>
      {view.windowNote && <p className="mb-3 text-xs text-ink-muted">{view.windowNote}</p>}
      <dl className="space-y-1.5 text-sm">
        {view.figures.map((figure) => (
          <div key={figure.key} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">{figure.label}</dt>
            <dd className="flex items-center gap-1.5">
              <span className="figures text-ink">
                {figure.kind === "change" ? formatCentsSigned(figure.cents) : formatCents(figure.cents)}
              </span>
              {figure.provenance && <ProvenancePopover label={figure.subject} provenance={figure.provenance} />}
            </dd>
          </div>
        ))}
      </dl>
    </SurfaceCard>
  );
}
