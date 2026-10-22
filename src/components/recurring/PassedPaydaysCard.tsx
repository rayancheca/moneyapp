import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatDayLong } from "@/lib/format-date";
import { passedPaydaysWords } from "@/lib/unbanked-income";
import type { SeriesDetail } from "@/services/recurring-detail";
import { longDate } from "./labels";

/**
 * This month's paydays that passed with no deposit against them — a pay series' backward half, laid out as a bill's
 * page lays out what came due (`AlreadyDueCard`), one row a payday.
 *
 * 🔴 `/recurring/<It America LLC (weekly pay)>` on a copy of his ledger 2026-10-12 read "Awaiting statements" and
 * "Next expected Oct 15" and said nothing of Oct 1 or Oct 8, while the forecast on /recurring said "2 paydays worth
 * $2,283.84 already passed this month … so the ledger has not looked for their deposits" and /budgets the same.
 *
 * ⛔ No words of its own: the heading and body are the forecast's (`passedPaydaysWords`), its warning tone too — the
 * clause naming the paydays nobody has looked for, or where the ledger has checked every one the forecast's "Pay that
 * never reaches a bank cannot be projected as arriving" (`notProjected`). 🔴 It printed /budgets' closing sentence
 * there (`IMPORTS_NOT_EARNINGS`) under this same claim, because the forecast's said "Cash pay" of his payroll.
 */
export function PassedPaydaysCard({ passed }: { passed: NonNullable<SeriesDetail["unbankedPaydays"]> }) {
  const words = passedPaydaysWords(passed, formatDayLong);
  return (
    <SurfaceCard>
      <h2 className={words.warning ? "mb-1 text-sm font-medium text-warning" : "mb-1 text-sm font-medium"}>
        {words.count} worth <Money cents={passed.totalCents} /> {words.passed}
      </h2>
      <p className="mb-3 text-xs text-ink-muted">{words.unread ?? `${words.notProjected}.`}</p>
      <ul className="divide-y divide-line">
        {passed.paydays.map((p) => (
          <li key={p.date} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <span className="figures text-ink-muted">{longDate(p.date)}</span>
            <Money cents={p.amountCents} flow />
          </li>
        ))}
      </ul>
    </SurfaceCard>
  );
}
