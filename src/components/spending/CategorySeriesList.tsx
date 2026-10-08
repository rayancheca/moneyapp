import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import { futureDateLabel } from "@/components/recurring/labels";
import { overdueNote } from "@/components/recurring/labels";
import type { CategorySeriesRow } from "@/services/category-detail";

/**
 * Recurring series filed under this category (ux-overhaul-plan §5.4) — the
 * bridge that closes the chain back to the Recurring tab (§4). Each row links to
 * its series detail page.
 */
export function CategorySeriesList({ rows, today }: { rows: CategorySeriesRow[]; today: string }) {
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
                    `listSeries` decides (`seriesIsForecast`): a lapsed series
                    has none, and an ended series keeps its stored date, which is
                    the past — so the status test stays and the lapse test, a
                    second copy of the rule, went to the service. */}
                {s.nextExpectedOn &&
                  (s.status === "detected" || s.status === "confirmed") &&
                  ` · next ${futureDateLabel(s.nextExpectedOn, today)}`}
                {/* 🔴 "next Oct 1", of a bill that came due Sep 1 and never
                    posted — beside a Budget card on the same page grading
                    Sep 1 – Sep 30 with the whole amount still "left".
                    `overdueNote` is the wording /recurring's Next column has
                    used since the same defect was fixed there, and this was its
                    second caller. See `CategorySeriesRow.overdue`. Quiet when no
                    import has reached the day — the runway's split. */}
                {s.overdue && <OverdueNote overdue={s.overdue} />}
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

/** `overdueNote` in its own tone: warning when any of it has been read, the row's own when none of it has. */
function OverdueNote({ overdue }: { overdue: NonNullable<CategorySeriesRow["overdue"]> }) {
  const note = overdueNote(overdue.date, overdue.occurrenceCount, overdue);
  return (
    <span className={note.warning ? "text-warning" : undefined}>
      {" · "}
      {note.text}
    </span>
  );
}
