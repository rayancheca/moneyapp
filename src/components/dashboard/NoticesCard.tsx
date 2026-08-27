import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { NoticesCard as NoticesCardData } from "@/services/notices-card";

/**
 * PASS 69 — things that happened, described and never judged.
 *
 * ⛔ Presentation only. Every sentence arrives from `noticesCard()` already
 * written, through the same closed vocabulary as every other insight — which
 * carries a sweep test refusing "should", "unusual", "suspicious" and the rest.
 * Nothing here chooses a word.
 *
 * ## ⛔ Why nothing on this card is tinted a warning colour
 *
 * The owner travels and drives an EV, and three charges once flagged as
 * "card-testing probes" were every one of them legitimate. A notice is a
 * DESCRIPTION — a first sighting at a merchant, a charge above what he usually
 * pays there, a bill that posted differently — and every one of those has an
 * ordinary explanation far more often than not. Amber would be the app forming
 * an opinion it has no basis for, so the card is the same neutral surface as
 * the rest and the reader draws their own conclusion.
 *
 * The summary line is deliberately as prominent as the notices: what was looked
 * at is half of what a notice means.
 */
export function NoticesCard({ data }: { data: NoticesCardData }) {
  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">Worth a look</h3>
        <Link
          href="/transactions"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Transactions →
        </Link>
      </div>

      <p className="mt-3 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <ul className="mt-4 divide-y divide-line">
        {data.notices.map((notice) => (
          <li key={notice.id} className="flex items-start gap-3 py-2.5 text-sm">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
            <span className="min-w-0 flex-1">
              {notice.href ? (
                <Link
                  href={notice.href}
                  className="underline decoration-line underline-offset-2 transition-colors duration-(--duration-fast) hover:decoration-ink"
                >
                  {notice.text}
                </Link>
              ) : (
                notice.text
              )}
            </span>
            <ProvenancePopover label={notice.text} provenance={notice.provenance} placement="bottom-end" />
            <span className="figures shrink-0 text-xs text-ink-faint">{notice.dayLabel}</span>
          </li>
        ))}
      </ul>
    </SurfaceCard>
  );
}
