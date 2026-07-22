"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { Sheet } from "@/components/ui/Sheet";
import { formatCents } from "@/lib/money";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { loadSpendHeatmap } from "@/app/spending/actions";
import { dayLedgerHref, type HeatDay, type SpendHeatmap as SpendHeatmapData } from "@/services/spending";

/**
 * Day-level spending heatmap (ux-overhaul-plan §5.3, enriched in pass 23).
 *
 * Each cell states the day's OUTFLOW as a number plus a magnitude bar, with an
 * income dot when money also came in — the tint used to be the only signal, and
 * a wash of red says "a lot" without ever saying how much. The bar is drawn
 * UNDER the figure rather than behind it: a saturated full-cell tint cannot
 * clear WCAG AA behind small text in both themes (the same finding that keeps
 * numbers out of the P/L calendar's cells), so the colour and the text never
 * overlap here.
 *
 * Tapping a day opens a detail sheet — total, count, where the money went and
 * who it went to — instead of navigating straight off the page; the full ledger
 * is one click further, from inside the sheet. Month ‹ › paging loads a new
 * month through a server action without leaving the page.
 */

const MIN_BAR = 0.08;

interface SpendHeatmapProps {
  initial: SpendHeatmapData;
  today: string;
}

/** Compact enough for a calendar cell: $1.2k, $340, $8. */
function cellAmount(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(dollars)}`;
}

export function SpendHeatmap({ initial, today }: SpendHeatmapProps) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [pending, setPending] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDay = new Map(data.days.map((d) => [d.iso, d]));
  const max = data.maxOutflowCents;
  const detail = openDay === null ? null : (byDay.get(openDay) ?? null);

  async function changeMonth(monthKey: string) {
    setPending(true);
    const res = await loadSpendHeatmap(monthKey);
    if (res.ok) setData(res.data);
    setPending(false);
    // a day from the old month has no meaning in the new one
    setOpenDay(null);
  }

  function cellLabel(iso: string): string {
    const d = byDay.get(iso);
    const day = formatDayShort(iso);
    if (!d || (d.spentCents === 0 && d.incomeCents === 0)) return `${day}: no activity`;
    const parts: string[] = [];
    if (d.spentCents > 0) {
      parts.push(`${formatCents(d.spentCents)} spent across ${d.txnCount} ${d.txnCount === 1 ? "transaction" : "transactions"}`);
      // the biggest destination, so the label is as actionable as the cell
      if (d.topCategories[0]) parts.push(`mostly ${d.topCategories[0].name}`);
    }
    if (d.incomeCents > 0) parts.push(`${formatCents(d.incomeCents)} earned`);
    return `${day}: ${parts.join(", ")}`;
  }

  return (
    <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={pending}>
      <CalendarGrid
        monthKey={data.monthKey}
        today={today}
        onMonthChange={changeMonth}
        getCellLabel={cellLabel}
        // CalendarGrid pads the grid with real, clickable days from the
        // NEIGHBOURING month, and this month's payload contains none of them —
        // opening a sheet there would state "nothing posted" about a date we
        // never queried. Those cells keep the direct ledger drill, which is
        // always ground truth.
        onDayActivate={(iso) =>
          iso.slice(0, 7) === data.monthKey ? setOpenDay(iso) : router.push(dayLedgerHref(iso))
        }
        renderCell={(day) => {
          const d = byDay.get(day.iso);
          if (!d || (d.spentCents === 0 && d.incomeCents === 0)) return null;
          // share of the month's heaviest day — the bar IS the heatmap
          const share = d.spentCents > 0 && max > 0 ? MIN_BAR + (1 - MIN_BAR) * (d.spentCents / max) : 0;
          return (
            // grouped directly UNDER this day's number (not floated to the
            // cell's bottom edge, where it reads as belonging to the next row)
            <span className="flex h-full w-full flex-col items-start gap-1">
              <span className="flex w-full items-center gap-1">
                {d.spentCents > 0 && (
                  <span className="figures truncate text-[10px] leading-none text-ink-muted">
                    {cellAmount(d.spentCents)}
                  </span>
                )}
                {/* beside its OWN amount, not pushed to the cell's right edge —
                    a far-right dot sits closer to the next day's figure than to
                    the day it belongs to */}
                {d.incomeCents > 0 && (
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-positive" />
                )}
              </span>
              {/* no track behind it — an empty rail on every active day reads as
                  a divider rule across the grid, not as a magnitude */}
              {share > 0 && (
                <span
                  aria-hidden
                  className="block h-1 rounded-full bg-negative"
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              )}
            </span>
          );
        }}
        footer={
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-1 w-5 rounded-full bg-negative" />
              spent, relative to the busiest day
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-1.5 rounded-full bg-positive" />
              income
            </span>
            <span>Tap a day for its detail</span>
          </p>
        }
      />

      <Sheet
        open={openDay !== null}
        onClose={() => setOpenDay(null)}
        title={openDay ? formatDayLong(openDay) : ""}
      >
        {openDay && <DaySheetBody iso={openDay} day={detail} />}
      </Sheet>
    </div>
  );
}

/**
 * Amounts are neutral ink with a decorative colored dot rather than tone-colored
 * text: the sheet's --surface-overlay background is lighter than a card, where
 * --positive/--negative fall just under WCAG AA (the same rule the P/L day sheet
 * follows).
 */
function DaySheetBody({ iso, day }: { iso: string; day: HeatDay | null }) {
  const spent = day?.spentCents ?? 0;
  const income = day?.incomeCents ?? 0;

  if (spent === 0 && income === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">Nothing posted on this day.</p>
        <LedgerLink iso={iso} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink">Spent</span>
          <div className="figures mt-1 flex items-center gap-1.5 text-xl font-semibold text-ink">
            <span aria-hidden className="size-2 rounded-full bg-negative" />
            {formatCents(spent)}
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {day!.txnCount} {day!.txnCount === 1 ? "transaction" : "transactions"}
          </p>
        </div>
        {income > 0 && (
          <div>
            <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink">Earned</span>
            <div className="figures mt-1 flex items-center gap-1.5 text-xl font-semibold text-ink">
              <span aria-hidden className="size-2 rounded-full bg-positive" />
              {formatCents(income)}
            </div>
          </div>
        )}
      </div>

      <EntryList title="Where it went" entries={day!.topCategories} total={spent} />
      <EntryList title="Who it went to" entries={day!.topMerchants} total={spent} />
      <LedgerLink iso={iso} />
    </div>
  );
}

/**
 * The list is capped at the top few, so it is shown WITH its residual: a
 * truncated breakdown sitting under an exact total otherwise reads as the whole
 * story. Same rule as the spending chart's "Other" bucket — the visible rows
 * plus the remainder always reconcile to the day's spend.
 */
function EntryList({
  title,
  entries,
  total,
}: {
  title: string;
  entries: { name: string; cents: number }[];
  total: number;
}) {
  if (entries.length === 0) return null;
  const shown = entries.reduce((sum, e) => sum + e.cents, 0);
  const rest = total - shown;
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-ink">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {entries.map((e) => (
          <li key={e.name} className="flex items-baseline justify-between gap-4 text-sm">
            <span className="truncate text-ink">{e.name}</span>
            <span className="figures shrink-0 text-ink-muted">{formatCents(e.cents)}</span>
          </li>
        ))}
        {rest > 0 && (
          <li className="flex items-baseline justify-between gap-4 text-sm text-ink-faint">
            <span className="truncate">Everything else</span>
            <span className="figures shrink-0">{formatCents(rest)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function LedgerLink({ iso }: { iso: string }) {
  return (
    <Link
      href={dayLedgerHref(iso)}
      className="inline-flex text-sm font-medium text-accent transition-colors duration-(--duration-fast) hover:underline"
    >
      All transactions for this day →
    </Link>
  );
}
