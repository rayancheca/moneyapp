import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { TransfersCard as TransfersCardData } from "@/services/transfers-card";

/**
 * Money moving between your own accounts — and whether the app can prove it
 * landed.
 *
 * 🔴 The headline is the largest figure on this dashboard that means NOTHING
 * about how the owner is doing, and the whole design is arranged around not
 * letting it read as income or as spending. It gets the neutral ink, never the
 * flow colours: `Money flow` paints an inflow green and an outflow red, which
 * is exactly right for money entering and leaving a life and exactly wrong for
 * money changing pockets inside one. So every figure here is untinted, and the
 * sentence directly under the headline says what it is not, before any of the
 * rows are read.
 *
 * ⛔ Presentation only. `transfersCard()` chooses the window, counts the
 * departures, ranks the routes, writes the proof verdict, the churn clause, the
 * arrival clause and the excluded-rows clause. This file decides nothing — not
 * even which routes are worth showing, which is why the "smaller routes" line
 * exists rather than a `slice` here: the rows on screen have to add up to the
 * routed total printed beside them, and that is a property of the data.
 *
 * ## Why the caveats are not a footnote
 *
 * Two thirds of this card is the part the app CANNOT account for, and it sits
 * above the fold of the block rather than under a rule at the bottom: the
 * unpaired departures, the money that arrived from nowhere the ledger records,
 * and the transfer rows this card deliberately does not count. A card that
 * printed $74,980.12 and stopped would be claiming to have followed money it
 * has only half followed. The mirror clause is the one line here a reader can
 * act on — the counterpart is already in the ledger, unlinked — so it stays
 * beside the count it belongs to rather than being demoted to the fine print.
 */
export function TransfersCard({ data }: { data: TransfersCardData }) {
  const { proof } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">Your own money, moving</h3>
        <Link
          href="/flow"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Money flow →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {data.headline}
        <span className="ml-1.5 inline-flex items-center gap-1.5 text-base font-normal text-ink-muted">
          {data.headlineNoun}
          <InfoTip term="left one account for another">
            A transfer writes a row in each account it touches. Only the row where money leaves is added up here, so a
            pair of rows never becomes a pair of figures.
          </InfoTip>
        </span>
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {data.routes.map((r) => (
          <div key={r.id} className="flex items-baseline justify-between gap-3">
            <dt className="flex min-w-0 items-baseline gap-1.5">
              {/* the arrow is the whole row: which way the money went. It has to
                  survive truncation, so the account names shrink around it
                  rather than the pair being clipped from the right. */}
              <span className="truncate text-ink-muted">{r.fromLabel}</span>
              <span className="shrink-0 text-ink-faint">→</span>
              <span className="truncate text-ink-muted">{r.toLabel}</span>
            </dt>
            <dd className="shrink-0 text-right">
              <Money cents={r.cents} />
              <span className="ml-1.5 text-[11px] text-ink-faint">{r.countLabel}</span>
            </dd>
          </div>
        ))}

        {/* ⛔ Not a footnote — the reconciliation. Without it the routes above
            do not add up to the total beside them, and a card whose own
            arithmetic cannot be checked is asking to be taken on trust. */}
        {data.otherRouteNote && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 truncate text-ink-faint">{data.otherRouteNote}</dt>
            <dd className="shrink-0">
              <Money cents={data.otherRouteCents} className="text-ink-faint" />
            </dd>
          </div>
        )}

        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="min-w-0 truncate font-medium">Followed from one account to another</dt>
          <dd className="shrink-0">
            <Money cents={data.routedCents} className="font-semibold" />
          </dd>
        </div>
      </dl>

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
        {/* the unpaired money is the point of the card, so it is the one clause
            that can wear the warning tone — and only when there is some */}
        <p className={proof.unpairedCount > 0 ? "text-warning" : undefined}>{proof.sentence}</p>
        {proof.mirrorNote && <p>{proof.mirrorNote}</p>}
        {proof.strandedNote && <p>{proof.strandedNote}</p>}
        {data.churnNote && <p>{data.churnNote}</p>}
        {data.arrivalNote && <p>{data.arrivalNote}</p>}
        {data.cancelledNote && <p>{data.cancelledNote}</p>}
        {data.otherPartyNote && <p>{data.otherPartyNote}</p>}
      </div>
    </SurfaceCard>
  );
}
