import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { FeesCard as FeesCardData } from "@/services/fees-card";

/**
 * What the banks charge you — and what they pay you back.
 *
 * ⛔ Presentation only. The headline, the sentence under it, every row's note,
 * the ratio clause and all three footnotes arrive from `feesCard()` already
 * written. This file formats money and draws rules; it decides nothing —
 * including the word "other way", which is computed from two signs in the
 * service so it cannot keep asserting a reversal after the reversal unwinds.
 *
 * ## 🔴 Two windows, side by side, and neither is allowed to be the card
 *
 * The recent block and the all-time block get the same treatment on purpose.
 * Measured 2026-08-27 they disagree about the direction of the whole
 * relationship — $589.93 out of pocket over six months, $1,013.29 in his favour
 * over the ledger's life — and a card that showed either alone would be true
 * and misleading in the same breath. The headline takes the recent one because
 * that is the figure still running; the all-time block is a peer below it, not
 * a footnote, so it cannot be skimmed past.
 *
 * ## Why the net IS tinted here, where `MoversCard` refuses to tint
 *
 * `MoversCard` leaves its deltas grey because a positive delta there means MORE
 * went out, which is the opposite of what green means everywhere else on this
 * dashboard. Here the app's rule holds without inversion: this net is money
 * moving between him and a bank, positive is money arriving, and green is
 * exactly right. So `Money flow` does the work and the sign never has to be
 * explained twice.
 */
export function FeesCard({ data }: { data: FeesCardData }) {
  const { recent, allTime, lines } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          What the banks charge you
        </h3>
        <Link
          href="/spending"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Spending →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {data.headline}
        <span className="ml-1.5 text-base font-normal text-ink-muted">{data.headlineNoun}</span>
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      {recent.rowCount > 0 && (
        <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
          {lines.map((l) => (
            <div key={l.categoryId} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {/* the drill-down contract: the figure beside this name is a
                      visitable list of the rows it was added up from */}
                  <Link
                    href={l.href}
                    className="truncate text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
                  >
                    {l.name}
                  </Link>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {l.charges} {l.charges === 1 ? "charge" : "charges"}
                  </span>
                </span>
                {/* a bucket the ledger has not described is still real money and
                    still in the total — the note says what is missing is the
                    ledger's word for it, not the charge */}
                {l.note && <span className="block text-[11px] text-ink-faint">{l.note}</span>}
              </dt>
              <dd className="shrink-0">
                <Money cents={l.cents} />
              </dd>
            </div>
          ))}

          {/**
           * ⛔ A `<dt>`, and it matters. `ProvenancePopover` renders its panel as
           * a SIBLING of the trigger and that panel is a `<div popover>`, which a
           * `<p>` may not contain: the parser closes the paragraph where the div
           * opens, the browser's DOM stops matching the server's HTML, and React
           * throws hydration error #418 — which does not warn, it discards the
           * client tree and takes the page's interactivity with it. One such tag
           * failed nine unrelated tests here. `<dt>` takes flow content and is
           * safe. See ProvenancePopover.
           */}
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
            <dt className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="font-medium">Paid to them</span>
              <span className="shrink-0 text-[11px] text-ink-faint">
                {recent.paidCharges} {recent.paidCharges === 1 ? "charge" : "charges"}
              </span>
              {data.paidProvenance && (
                <ProvenancePopover label="the fees you paid" provenance={data.paidProvenance} />
              )}
            </dt>
            <dd className="shrink-0">
              <Money cents={recent.paidCents} className="font-semibold" />
            </dd>
          </div>

          {/* The other side of the relationship, not another fee row. It sits
              inside the same list because the net below subtracts one from the
              other, and a reader has to be able to add the card up.

              It is a LINK where the fee subtotal above is not, and the rule is
              consistent rather than arbitrary: anything that is exactly one
              category's rows carries the drill-down contract, and a subtotal of
              four buckets is not — its links are on the four rows above it. */}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              {data.interestHref ? (
                <Link
                  href={data.interestHref}
                  className="font-medium transition-colors duration-(--duration-fast) hover:text-ink-muted"
                >
                  Paid to you
                </Link>
              ) : (
                <span className="font-medium">Paid to you</span>
              )}
              <span className="shrink-0 text-[11px] text-ink-faint">
                {recent.earnedCredits} {recent.earnedCredits === 1 ? "credit" : "credits"}
              </span>
            </dt>
            <dd className="shrink-0">
              <Money cents={recent.earnedCents} className="font-semibold" />
            </dd>
          </div>

          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
            <dt className="flex min-w-0 items-center gap-1.5 text-ink-muted">
              Where that leaves you
              <InfoTip term="where that leaves you">
                Interest they paid you, less the fees they charged you. A positive figure means the
                banking arrangement made you money over the window named above.
              </InfoTip>
            </dt>
            <dd className="shrink-0">
              <Money cents={recent.netCents} flow className="font-semibold" />
            </dd>
          </div>
        </dl>
      )}

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        <p className="text-[11px] uppercase tracking-[0.1em] text-ink-faint">
          All time, from {data.allTimeFromLabel}
        </p>
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-ink-muted">Paid to them</span>
            <span className="shrink-0 text-[11px] text-ink-faint">{allTime.paidCharges} charges</span>
          </span>
          <Money cents={allTime.paidCents} className="shrink-0" />
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-ink-muted">Paid to you</span>
            <span className="shrink-0 text-[11px] text-ink-faint">{allTime.earnedCredits} credits</span>
          </span>
          <Money cents={allTime.earnedCents} className="shrink-0" />
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <span className="text-ink-muted">Where that leaves you</span>
          <Money cents={allTime.netCents} flow className="shrink-0 font-semibold" />
        </div>
      </div>

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
        {data.ratioNote && <p>{data.ratioNote}</p>}
        {data.interestTrendNote && <p>{data.interestTrendNote}</p>}
        {/* the ledger has not said what these charges are — the one line here a
            reader can act on, so it is the one that is warned */}
        {data.unfiledNote && <p className="text-warning">{data.unfiledNote}</p>}
        {data.earnedNote && <p>{data.earnedNote}</p>}
      </div>
    </SurfaceCard>
  );
}
