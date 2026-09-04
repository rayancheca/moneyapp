import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import { formatDayShort } from "@/lib/format-date";
import type { CategorySeriesRow } from "@/services/category-detail";

/**
 * Recurring series filed under this category (ux-overhaul-plan §5.4) — the
 * bridge that closes the chain back to the Recurring tab (§4). Each row links to
 * its series detail page.
 */
export function CategorySeriesList({ rows }: { rows: CategorySeriesRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-muted">No recurring series detected in this category yet.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {rows.map((s) => (
        <li key={s.id}>
          <Link
            href={s.href}
            className="group flex items-center gap-3 rounded-md px-1.5 py-2 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
          >
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
              <Icon name="repeat" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{s.name}</span>
              <span className="block text-xs text-ink-faint">
                {s.cadence}
                {/* a late or never-billed series is still forecast, so it still
                    has a next date — one the app is not projecting does not.
                    `listSeries` only rolls the date forward for detected and
                    confirmed, so an ended series' stored date is the past. */}
                {s.nextExpectedOn &&
                  s.evidence !== "lapsed" &&
                  (s.status === "detected" || s.status === "confirmed") &&
                  ` · next ${formatDayShort(s.nextExpectedOn)}`}
                {/* ⛔ The word is chosen WITH the row, in `lib/series-evidence`.
                    Chosen here from `evidence` alone, it read "lapsed" over five
                    series the owner had DISMISSED — a page headed "Recurring
                    series" printing his own rejections back as bills that had
                    gone quiet. */}
                {s.label && ` · ${s.label}`}
              </span>
            </span>
            <Money cents={Math.abs(s.amountCents)} className="shrink-0 text-sm" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
