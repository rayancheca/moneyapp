import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatMonthYear } from "@/lib/format-date";
import type { CardsOwedCard as CardsOwedCardData } from "@/services/cards-owed";

/**
 * What you owe on cards.
 *
 * 🔴 The dates are the card, not decoration. The three balances were last
 * checked twelve, seventeen and twenty-four days ago, so one figure over a
 * single "as of" would read as a number you could act on today. Every row
 * therefore carries its own date — unless they all agree, in which case the
 * sentence under the headline says it once and the rows stay quiet. That split
 * is decided in the service (`priceColumnAge`'s rule), not here.
 *
 * Every word on this card leaves `cardsOwedCard()` with the figure it
 * describes: the headline, the sentence, each row's date phrase, each fee
 * summary, the interest note and the sign convention. Nothing is templated
 * here, so a sentence saying "annual fee" cannot end up over a charge the
 * ledger never filed as one.
 *
 * The "prove it" badge sits on the headline rather than on each row — the rule
 * CarCostCard states for tooltips and `priceColumnAge` states for dates: one
 * annotation for a fact about the whole column. Its panel lists all three cards
 * with their own verdicts, which is where a per-card answer belongs.
 */
export function CardsOwedCard({ data }: { data: CardsOwedCardData }) {
  const { cards, fees, provenance } = data;
  // narrowed rather than asserted with `!`, so a fee row cannot be rendered
  // for a card that has none
  const withFees = cards.flatMap((c) => (c.fees === null ? [] : [{ ...c, fees: c.fees }]));

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">On your cards</h3>
        <Link
          href="/accounts"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Accounts →
        </Link>
      </div>

      <p
        className={`figures mt-2 text-3xl font-semibold tracking-tight ${
          data.nothingOwed ? "text-positive" : "text-ink"
        }`}
      >
        {data.headline}
        <ProvenancePopover label="what you owe" provenance={provenance} />
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.explanation}</p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {cards.map((c) => (
          <div key={c.accountId} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="truncate text-ink-muted">{c.name}</span>
                {c.last4 && <span className="shrink-0 text-[11px] text-ink-faint">····{c.last4}</span>}
              </span>
              {c.asOfLabel && <span className="block text-[11px] text-ink-faint">{c.asOfLabel}</span>}
              {/* a caveat is a SECOND line, never a substitute for the date: a
                  card can add up through a real day and stop adding up after
                  it, and one field would have hidden the second fact. */}
              {c.caveat && <span className="block text-[11px] text-warning">{c.caveat}</span>}
            </dt>
            <dd className="shrink-0">
              {/* three states, not two. A card with no recorded balance is not a
                  card you owe nothing on, and rendering it as $0.00 would fold
                  a hole into the total silently. */}
              {c.owedCents === null ? (
                <span className="text-[11px] text-ink-faint">not in the total</span>
              ) : c.owedCents < 0 ? (
                <>
                  <Money cents={-c.owedCents} className="text-positive" />
                  <span className="ml-1 text-[11px] text-ink-faint">in credit</span>
                </>
              ) : (
                <>
                  <Money cents={c.owedCents} />
                  {/* the guarded division, on screen. Absent — never "0%" —
                      when there is no debt to take a share of. */}
                  {c.shareLabel && <span className="ml-1 text-[11px] text-ink-faint">{c.shareLabel}</span>}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {fees && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            What they cost
            {/* ONE tip for the whole block. A tooltip body is live DOM text even
                while closed, so one per row would say the same sentence three
                times and break somebody else's exact-count locator. */}
            <InfoTip term="what they cost">
              Charges the ledger has filed under fees on these cards, with any refund of one already taken off.
              Interest is counted separately so the two never stand for the same money.
            </InfoTip>
          </p>

          {/* the SAME order as the rows above, deliberately: the reader is
              tracking one list of cards, not two rankings of it */}
          {withFees.map((c) => (
            <div key={c.accountId} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-ink-muted">{c.name}</span>
                <span className="block text-[11px] text-ink-faint">{c.fees.summary}</span>
              </span>
              <Money cents={c.fees.totalCents} className="shrink-0" />
            </div>
          ))}

          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
            <span className="font-medium">Charged since {formatMonthYear(fees.firstOn)}</span>
            <Money cents={fees.totalCents} className="font-semibold" />
          </div>

          {data.interestNote && <p className="text-[11px] text-ink-faint">{data.interestNote}</p>}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{data.convention}</p>
    </SurfaceCard>
  );
}
