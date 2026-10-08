import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { SeriesDetail } from "@/services/recurring-detail";
import { alreadyDueWords, longDate } from "./labels";

/**
 * What this series already owed this month and nothing has covered — the backward half of "Next expected".
 *
 * 🔴 THE BACKWARD HALF. The page jumped straight to "Next expected — Oct 1, 2026" for a rent charge that came due on
 * 2026-09-01 and never posted — while the forecast counted it as a component, /budgets said "2 bills totalling
 * $2,291.21 due by today and no import has covered them yet", the runway said "came due earlier this month and never
 * posted", and the calendar marked Sep 1 with a "?". Every surface but the bill's own page.
 *
 * 🔴 …AND THEN IT SAID "not posted" OF A DAY NO IMPORT HAD REACHED. On a copy of his ledger 2026-10-08 this card read
 * "Already due, and not posted" in warning colour over rent's Oct 1 (Wells Fargo read through Sep 24) while the runway
 * said "no import has covered it yet" of the same money. The heading follows the runway's split — `alreadyDueWords`.
 */
export function AlreadyDueCard({
  overdue,
  toleranceDays,
}: {
  overdue: NonNullable<SeriesDetail["overdue"]>;
  toleranceDays: number;
}) {
  const words = alreadyDueWords({ owedCents: -overdue.amountCents, unreadCents: overdue.unreadCents }, toleranceDays);
  return (
    <SurfaceCard>
      <h2 className={words.warning ? "mb-1 text-sm font-medium text-warning" : "mb-1 text-sm font-medium"}>
        {words.heading}
      </h2>
      <p className="mb-3 text-xs text-ink-muted">{words.body}</p>
      <ul className="divide-y divide-line">
        <li className="flex items-baseline justify-between gap-3 py-2 text-sm">
          <span className="figures text-ink-muted">
            {longDate(overdue.date)}
            {overdue.occurrenceCount > 1 ? ` and ${overdue.occurrenceCount - 1} more` : ""}
          </span>
          <Money cents={overdue.amountCents} flow />
        </li>
      </ul>
    </SurfaceCard>
  );
}
