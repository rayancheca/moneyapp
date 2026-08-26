import Link from "next/link";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents } from "@/lib/money";
import type { IncomeCard as IncomeCardData } from "@/services/income-card";

/**
 * Am I actually being paid, and how much of it ever reaches a bank?
 *
 * ⛔ Presentation only. The summary, every verdict, the word for which way the
 * difference runs and the note under the posted figure all arrive from
 * `incomeCard()` already written. That is deliberate rather than tidy: this
 * card's whole reason to exist is the distinction between "you earned nothing"
 * and "the ledger has not seen it", and that distinction is measured — from
 * `accountCoverage`'s verified-through date against the schedule's own paydays.
 * A component that reworded the outcome would be a second author for a verdict
 * whose evidence it cannot see.
 *
 * The headline is the SAME monthly figure `/budgets` grades against, taken from
 * `incomeBasis` unchanged, so the two surfaces cannot publish different answers
 * to "what do you earn a month". Its explanation is not repeated here: the
 * runway card three inches away already mounts that exact sentence in a
 * tooltip, and a tooltip body is live DOM text even while closed.
 *
 * ⛔ No tooltip and no popover anywhere in this card. The headline is a <div>
 * rather than a <p> for the same reason — a popover panel is a <div>, a <p> may
 * not contain one, and the parser closing the tag early throws hydration #418,
 * which discards the client tree and silently kills the whole page's
 * interactivity. One such tag failed nine unrelated tests on this dashboard.
 */
export function IncomeCard({ data }: { data: IncomeCardData }) {
  const { pay, totals } = data;
  const named = pay.length > 1;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">Earned vs banked</h3>
        <Link
          href="/recurring"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Schedule →
        </Link>
      </div>

      <div className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {formatCents(data.monthlyRateCents)}
        <span className="ml-1.5 text-base font-normal text-ink-muted">a month</span>
      </div>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {pay.map((l) => (
          <div key={l.seriesId} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-ink-muted">
              <span className="truncate">{l.name}</span>
              <span className="block text-[11px] text-ink-faint">
                {l.paydays} {l.paydays === 1 ? "payday" : "paydays"} in this window
              </span>
            </dt>
            <dd className="shrink-0 text-right">
              <Money cents={l.bankedCents} />
              <span className="block text-[11px] text-ink-faint">
                of {formatCents(l.impliedCents)} implied
              </span>
            </dd>
          </div>
        ))}

        {/* Only when there is more than one schedule to add up. With a single
            series the subtotal is the row above it repeated, and a total that
            restates its only operand teaches the reader nothing while looking
            like a second measurement. */}
        {named && (
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
            <dt className="font-medium">Reached a bank</dt>
            <dd className="shrink-0 text-right">
              <Money cents={totals.bankedCents} className="font-semibold" />
              <span className="block text-[11px] text-ink-faint">
                of {formatCents(totals.impliedCents)} implied
              </span>
            </dd>
          </div>
        )}

        {/* The card's point, so it gets the rule above it and the weight.
            `gapMagnitudeCents` is already positive and `gapLabel` already says
            which way it runs — the component never flips a sign, because −0
            formats as "-$0.00" and a schedule banked exactly on time is the
            common case that produces it. */}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="min-w-0">
            <span className="font-medium">The difference</span>
            <span className="block text-[11px] text-ink-faint">{totals.gapLabel}</span>
          </dt>
          <dd className="shrink-0">
            <Money cents={totals.gapMagnitudeCents} className="font-semibold" />
          </dd>
        </div>
      </dl>

      <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
        {pay.map((l) => (
          <p key={l.seriesId} className="max-w-prose">
            {named && <span className="text-ink">{l.name}. </span>}
            {l.verdict}
          </p>
        ))}
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-3 text-sm">
        <span className="min-w-0 truncate text-ink-muted">Income recorded in {data.postedMonth}</span>
        <Money cents={data.postedThisMonthCents} className="shrink-0" />
      </div>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-ink-faint">{data.postedNote}</p>

      <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-ink-faint">{data.caveat}</p>
    </SurfaceCard>
  );
}
