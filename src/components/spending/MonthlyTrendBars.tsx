import Link from "next/link";
import { formatCents } from "@/lib/money";
import { formatMonthYear } from "@/lib/format-date";
import type { CategoryMonthPoint } from "@/services/category-detail";

/**
 * How tall the tallest bar is — the largest MAGNITUDE in the run, not the
 * largest value.
 *
 * 🔴 `Math.max(m, p.spentCents)` seeded at 0 cannot tell a series that is
 * entirely NEGATIVE from one that is entirely zero, and the component printed
 * "No spending in the last 12 months." for both. A category whose money moves
 * IN — Pass-through, Cash Back, Gifts received — is all-negative in the
 * money-out frame these points arrive in, so every one of them denied a year of
 * its own rows.
 *
 * Measured 2026-09-04 on `/categories/<Pass-through>?period=2026-08`: that
 * sentence sat directly above two rows dated 08-11 and 08-12 inside the same
 * window, +$4,000.00 and +$1,000.00.
 */
export function trendScaleCents(points: readonly CategoryMonthPoint[]): number {
  return points.reduce((m, p) => Math.max(m, Math.abs(p.spentCents)), 0);
}

/**
 * A category's 12-month trend as clickable bars (ux-overhaul-plan §5.4): each
 * month drills to that month's transactions. Pure CSS bars — no chart lib — so
 * it stays light and every bar is a real keyboard-navigable link.
 *
 * ⚠️ `flowLabel` is what the PAGE calls this figure ("Spent", "Received",
 * "Net"). The accessible name was hard-coded to "Monthly spending" on every
 * category page, so a screen reader was told the Salary chart and the
 * Pass-through chart were both spending.
 */
const TREND_NOUN: Record<string, string> = {
  Spent: "spending",
  Received: "money received",
  Net: "net movement",
};

export function MonthlyTrendBars({
  points,
  flowLabel = "Spent",
}: {
  points: CategoryMonthPoint[];
  flowLabel?: string;
}) {
  const max = trendScaleCents(points);
  // "no activity", not "no spending": these points are a NET, and a category
  // whose year nets to nothing is not the same as one with nothing in it — but
  // a run of genuine zeroes is, and that is the only case left here.
  if (max === 0) return <p className="text-sm text-ink-muted">No activity in the last 12 months.</p>;

  return (
    <ul className="flex items-end gap-1" aria-label={`Monthly ${TREND_NOUN[flowLabel] ?? flowLabel.toLowerCase()}, last 12 months`}>
      {points.map((p) => {
        const heightPct = Math.max(2, (Math.abs(p.spentCents) / max) * 100);
        return (
          <li key={p.month} className="flex flex-1 flex-col items-center gap-1">
            <Link
              href={p.href}
              /* 🔴 "1 transactions" — the bar is a sentence a screen reader
                 reads out, and the sibling chart on the same page
                 (`SpendHeatmap`) has pluralised the same noun since it shipped.
                 `countPhrase` is not the tool here: a bar with nothing in it
                 reports "0 transactions", a measured zero, not "no
                 transactions". */
              aria-label={`${formatMonthYear(`${p.month}-01`)}: ${formatCents(p.spentCents)}, ${p.txnCount} ${p.txnCount === 1 ? "transaction" : "transactions"}`}
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
