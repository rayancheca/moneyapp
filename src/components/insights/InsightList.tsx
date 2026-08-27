import { Icon } from "@/components/shell/Icon";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { SurfaceInsights } from "@/services/insights";

/**
 * Sentences the app wrote about itself, each standing on a proof.
 *
 * Every line here came out of `checkClaim`: the words are from a closed
 * vocabulary, every figure in them is a `Fact` the services measured, and a
 * claim its facts do not support never reached this component. So there is no
 * confidence badge, no hedging language and no "AI generated" disclaimer —
 * those are what a surface needs when it cannot tell you whether a sentence is
 * true, and this one can.
 *
 * ## ⛔ The badge is a sibling, and never inside a `<p>`
 *
 * `ProvenancePopover` renders a `<div popover>` next to its trigger, and a
 * paragraph may not contain a div: HTML parsing closes the `<p>` where the div
 * begins, the browser's DOM stops matching the server's string, and React
 * throws hydration #418 — which discards the client tree for that subtree and
 * takes its interactivity with it. Exactly one tag did this on the dashboard
 * last session and it failed nine tests that never mention the card it was in.
 * The sentence therefore lives in a `<span>` inside an `<li>`, both of which
 * are flow containers a popover may sit beside.
 */
export function InsightList({ data, heading = "What the ledger says" }: { data: SurfaceInsights; heading?: string }) {
  return (
    <SurfaceCard>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h2 id="ledger-insights" className="text-sm font-medium">
          {heading}
        </h2>
        <span className="text-xs text-ink-faint">{data.windowLabel}</span>
      </div>
      {/* the window is not the period selector's, so it says why in words as
          well as inside each sentence's own frame of reference */}
      {data.windowNote && <p className="mb-3 text-xs text-ink-muted">{data.windowNote}</p>}
      <ul className="space-y-2.5">
        {data.insights.map((insight) => (
          <li key={insight.id} className="flex items-start gap-2 text-sm text-ink">
            <Icon name="sparkles" className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
            <span>{insight.text}</span>
            <ProvenancePopover label={insight.text} provenance={insight.provenance} />
          </li>
        ))}
      </ul>
    </SurfaceCard>
  );
}
