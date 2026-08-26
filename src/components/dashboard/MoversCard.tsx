import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCentsSigned } from "@/lib/money";
import type { MoversCard as MoversCardData } from "@/services/movers-card";

/**
 * What changed — and, just as loudly, WHEN.
 *
 * 🔴 The month is not decoration, it is the card. Every figure here describes a
 * month that has closed and been imported, never the one in progress, because
 * the honest version of this card is the one that refuses to describe a month
 * nobody has finished importing: measured 2026-08-26, comparing August-so-far
 * would have published "Food −87%" while Chase Sapphire — a sixth of the
 * spending — had not one August row in the ledger. So the month appears in the
 * headline itself ("less than usual, in Jul 2026"), in the sentence under it,
 * and again in the note at the foot that says what the running month is doing
 * instead. Three statements of one fact, because the fact is the difference
 * between a number and a wrong number.
 *
 * ⛔ Presentation only. `moversCard()` chooses the month, ranks the movers,
 * writes the summary, the thin-usual clauses, the coverage note and every
 * percentage label. This file decides nothing — including which rows are worth
 * showing, which is why the "smaller moves" line exists rather than a `slice`
 * here: the rows on screen have to add up to the headline above them, and that
 * is a property of the data, not of the layout.
 *
 * ## Why the deltas are not tinted
 *
 * `Money flow` paints a positive figure green and a negative one red, which is
 * right for money moving in and out and exactly backwards here: a POSITIVE
 * delta means more went out. Rather than invert the app's one colour rule for a
 * single card — the reader carries that rule from the net-worth chart three
 * inches away — the sign does the work and nothing is tinted. Spending more
 * than usual is also not a fault; it is a fact, and July's biggest riser was a
 * holiday.
 */
export function MoversCard({ data }: { data: MoversCardData }) {
  const { movers, lagging } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">What changed</h3>
        <Link
          href="/spending"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Spending →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {data.headline}
        <span className="ml-1.5 inline-flex items-center gap-1.5 text-base font-normal text-ink-muted">
          {data.headlineNoun}
          <InfoTip term="usual">
            What a category normally costs — its average across the months this card names, with any month still in
            progress left out of it.
          </InfoTip>
        </span>
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {movers.map((m) => (
          <div key={m.categoryId ?? "∅"} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-1.5">
                {/* the drill-down contract: the figure beside this name is a
                    visitable list of the rows it was added up from */}
                <Link
                  href={m.href}
                  className="truncate text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
                >
                  {m.categoryName}
                </Link>
                <Money cents={m.monthCents} className="shrink-0 text-[11px] text-ink-faint" />
              </span>
              {/* a usual built on one or two months is an anecdote, and the row
                  says so rather than being dropped — dropping it would also
                  hide the month the lumpy charge actually lands in */}
              {m.thinNote && <span className="block text-[11px] text-ink-faint">{m.thinNote}</span>}
            </dt>
            <dd className="shrink-0 text-right">
              <span className="figures">{formatCentsSigned(m.deltaCents)}</span>
              {m.pctLabel && <span className="figures ml-1.5 text-[11px] text-ink-faint">{m.pctLabel}</span>}
            </dd>
          </div>
        ))}

        {/* ⛔ Not a footnote — the reconciliation. Without this line the five
            rows above do not add up to the headline, and a card whose own
            arithmetic cannot be checked is asking to be taken on trust. */}
        {data.otherNote && (
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
            <dt className="min-w-0 truncate text-ink-faint">{data.otherNote}</dt>
            <dd className="figures shrink-0 text-ink-faint">{formatCentsSigned(data.otherDeltaCents)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
        {/* the running month, and what is wrong with it — warned only when the
            reason is missing evidence rather than the calendar, because "the
            month is not over" is normal and "a statement is missing" is not */}
        <p className={lagging.length > 0 ? "text-warning" : undefined}>{data.currentMonthNote}</p>

        {lagging.length > 0 && (
          <ul className="space-y-0.5">
            {lagging.map((l) => (
              <li key={l.accountId} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 truncate text-ink-muted">{l.name}</span>
                <span className="shrink-0">
                  imported through <span className="figures">{l.throughLabel}</span> · {l.shareLabel}
                </span>
              </li>
            ))}
          </ul>
        )}

        {data.historyNote && <p>{data.historyNote}</p>}
      </div>
    </SurfaceCard>
  );
}
