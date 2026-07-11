import Link from "next/link";
import { formatCents } from "@/lib/money";
import { formatMonthYear } from "@/lib/format-date";
import type { CategoryMonthPoint } from "@/services/category-detail";

/**
 * A category's 12-month spend trend as clickable bars (ux-overhaul-plan §5.4):
 * each month drills to that month's transactions. Pure CSS bars — no chart lib —
 * so it stays light and every bar is a real keyboard-navigable link.
 */
export function MonthlyTrendBars({ points }: { points: CategoryMonthPoint[] }) {
  const max = points.reduce((m, p) => Math.max(m, p.spentCents), 0);
  if (max === 0) return <p className="text-sm text-ink-muted">No spending in the last 12 months.</p>;

  return (
    <ul className="flex items-end gap-1" aria-label="Monthly spending, last 12 months">
      {points.map((p) => {
        const heightPct = max > 0 ? Math.max(2, (p.spentCents / max) * 100) : 2;
        return (
          <li key={p.month} className="flex flex-1 flex-col items-center gap-1">
            <Link
              href={p.href}
              aria-label={`${formatMonthYear(`${p.month}-01`)}: ${formatCents(p.spentCents)}, ${p.txnCount} transactions`}
              className="group flex w-full flex-col items-center gap-1"
            >
              <span className="flex h-28 w-full items-end justify-center">
                <span
                  aria-hidden
                  className="w-full max-w-6 rounded-t-sm bg-accent/60 transition-colors group-hover:bg-accent"
                  style={{ height: `${heightPct}%` }}
                />
              </span>
              <span aria-hidden className="text-[10px] text-ink-faint tabular-nums">
                {p.month.slice(5)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
