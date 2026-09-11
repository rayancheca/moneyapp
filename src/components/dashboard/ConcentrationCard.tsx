import Link from "next/link";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { sharePercent } from "@/lib/insight-facts";
import type { ConcentrationCard as ConcentrationCardData } from "@/services/concentration-card";

/**
 * What the portfolio is riding on.
 *
 * ⛔ Presentation only. Every sentence here — the headline, the line under it,
 * the fund note, the rest-of-net-worth note, the price note — arrives from
 * `concentrationCard()` already written. The card formats money and rounds a
 * percentage; it decides nothing. That is not ceremony: the one judgement this
 * card makes (a fund is not the same risk as a company) has to be made in ONE
 * place, or the ranking and the sentence explaining the ranking drift apart.
 *
 * The fund is deliberately still IN the list, wearing what it is, rather than
 * hidden below it. Removing it would make the column stop adding up to the
 * portfolio total printed beside it, and a reader who could not find his
 * biggest ETF on a card about concentration would reasonably conclude the card
 * had missed it.
 *
 * ⛔ The headline is a `<div>`, not a `<p>`. See the badge note below it.
 */
export function ConcentrationCard({ data }: { data: ConcentrationCardData }) {
  const { positions, remainder, byKind } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          What you are riding on
        </h3>
        <Link
          href="/investments"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Investments →
        </Link>
      </div>

      {/**
       * ⛔ A `<div>`, and only because of what it carries. `ProvenancePopover`
       * renders its panel as a SIBLING of the trigger, and that panel is a
       * `<div popover>` — which a `<p>` may not contain. The parser closes the
       * paragraph where the div opens, the browser's DOM stops matching the
       * server's HTML, and React throws hydration error #418, which does not
       * warn but discards the client tree and takes the page's interactivity
       * with it. One such tag failed nine unrelated tests. See ProvenancePopover.
       */}
      <div className="figures mt-2 flex flex-wrap items-baseline gap-x-1.5 text-3xl font-semibold tracking-tight text-ink">
        {data.headline}
        <span className="text-base font-normal text-ink-muted">{data.headlineNoun}</span>
        {/* the badge belongs to net worth, so it appears only when the headline
            is actually a share of it — with no positive net worth the service
            falls back to a portfolio share, which this badge does not describe */}
        {data.portfolioSharePct !== null && data.netWorthProvenance && (
          <ProvenancePopover label="the net worth this is measured against" provenance={data.netWorthProvenance} />
        )}
      </div>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {positions.map((p) => (
          <div key={`${p.assetType}-${p.symbol}`} className="flex items-baseline justify-between gap-3">
            <dt className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-ink">{p.symbol}</span>
              {p.spreadNote && <span className="shrink-0 text-[11px] text-ink-faint">{p.spreadNote}</span>}
            </dt>
            <dd className="flex shrink-0 items-baseline gap-2">
              <span className="figures text-xs text-ink-muted">{sharePercent(p.portfolioPct)}</span>
              <Money cents={p.valueCents} />
            </dd>
          </div>
        ))}

        {remainder && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 truncate text-ink-faint">
              {remainder.count} smaller position{remainder.count === 1 ? "" : "s"}
            </dt>
            <dd className="flex shrink-0 items-baseline gap-2 text-ink-faint">
              <span className="figures text-xs">{sharePercent(remainder.portfolioPct)}</span>
              <Money cents={remainder.valueCents} />
            </dd>
          </div>
        )}

        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="font-medium">Everything invested</dt>
          <dd className="shrink-0">
            <Money cents={data.portfolioCents} className="font-semibold" />
          </dd>
        </div>
      </dl>

      {data.topTwoNote && <p className="mt-3 text-xs leading-relaxed text-ink-muted">{data.topTwoNote}</p>}

      <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
        {byKind.map((k) => (
          <div key={k.assetType} className="flex items-baseline justify-between gap-3">
            <dt className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-ink-muted">{k.label}</span>
              {!k.isSingleName && <span className="shrink-0 text-[11px] text-ink-faint">spread</span>}
            </dt>
            <dd className="flex shrink-0 items-baseline gap-2">
              <span className="figures text-xs text-ink-muted">{sharePercent(k.portfolioPct)}</span>
              <Money cents={k.valueCents} />
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
        <p className="text-ink-muted">{data.restNote}</p>
        {data.fundNote && <p>{data.fundNote}</p>}
        {/* both are real holes in the figures above, so they get the loud tone —
            a stale close makes every share as old as the price, and an unpriced
            holding is money none of these percentages can see */}
        {data.priceNote && <p className="text-warning">{data.priceNote}</p>}
        {data.unpricedNote && <p className="text-warning">{data.unpricedNote}</p>}
      </div>
    </SurfaceCard>
  );
}
