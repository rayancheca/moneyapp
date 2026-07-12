import Link from "next/link";
import type { UpcomingBills } from "@/services/dashboard";
import { KIND_LABEL, shortDate } from "@/components/recurring/labels";
import { Money } from "@/components/ui/Money";
import { formatCents } from "@/lib/money";

/**
 * The upcoming-bills strip (ux-overhaul-plan §7.1): the next 14 days of projected
 * occurrences as a horizontal rail of chips, each linking to its series page.
 * When income series exist it leads with "$X due before your next paycheck"
 * [RM-S]. Empty stays a live handoff to /recurring, never a dead-end.
 */
export function UpcomingBillsStrip({ data }: { data: UpcomingBills }) {
  return (
    <section aria-labelledby="upcoming-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="upcoming-heading" className="text-sm font-medium">
          Upcoming <span className="text-ink-faint">· next {data.windowDays} days</span>
        </h2>
        {data.beforePaycheck && data.beforePaycheck.cents < 0 && (
          <p className="text-xs text-ink-muted">
            <span className="figures font-medium text-ink">
              {formatCents(-data.beforePaycheck.cents)}
            </span>{" "}
            due before your next paycheck{" "}
            <span className="text-ink-faint">({shortDate(data.beforePaycheck.date)})</span>
          </p>
        )}
      </div>

      {data.items.length === 0 ? (
        <div className="rounded-(--radius-card) border border-line bg-surface-raised px-4 py-5 text-sm text-ink-muted">
          No bills projected in the next {data.windowDays} days.{" "}
          <Link
            href="/recurring"
            className="font-medium text-accent underline decoration-line underline-offset-4 transition-colors duration-(--duration-fast) hover:decoration-accent"
          >
            Review recurring →
          </Link>
        </div>
      ) : (
        <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
          {data.items.map((item) => (
            <li key={`${item.seriesId}-${item.date}`} className="snap-start">
              <Link
                href={item.href}
                className="group flex h-full w-40 flex-col gap-1 rounded-(--radius-card) border border-line bg-surface-raised p-3 transition-colors duration-(--duration-fast) hover:border-line-strong"
              >
                <span className="figures text-[11px] text-ink-faint">{shortDate(item.date)}</span>
                <span className="truncate text-[13px] font-medium group-hover:text-accent">{item.name}</span>
                <span className="mt-auto flex items-baseline justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                    {KIND_LABEL[item.kind]}
                  </span>
                  <Money cents={item.amountCents} flow className="text-sm" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
