"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { formatCents } from "@/lib/money";
import { formatDayShort } from "@/lib/format-date";
import { loadSpendHeatmap } from "@/app/spending/actions";
import { dayLedgerHref, type SpendHeatmap as SpendHeatmapData } from "@/services/spending";

/**
 * Day-level spending heatmap (ux-overhaul-plan §5.3): CalendarGrid cells tinted
 * by the day's outflow (saturation = magnitude, hue = money-out red), an income
 * corner dot when money came in, and — the literal "tap any day" ask — each cell
 * navigates to `/transactions?from=D&to=D`. Month ‹ › paging loads a new month
 * through a server action without leaving the page.
 */

const MIN_TINT = 0.12;
const MAX_TINT = 0.82;

interface SpendHeatmapProps {
  initial: SpendHeatmapData;
  today: string;
}

export function SpendHeatmap({ initial, today }: SpendHeatmapProps) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [pending, setPending] = useState(false);

  const byDay = new Map(data.days.map((d) => [d.iso, d]));
  const max = data.maxOutflowCents;

  async function changeMonth(monthKey: string) {
    setPending(true);
    const res = await loadSpendHeatmap(monthKey);
    if (res.ok) setData(res.data);
    setPending(false);
  }

  function cellLabel(iso: string): string {
    const d = byDay.get(iso);
    const day = formatDayShort(iso);
    if (!d || (d.spentCents === 0 && d.incomeCents === 0)) return `${day}: no activity`;
    const parts: string[] = [];
    if (d.spentCents > 0) parts.push(`${formatCents(d.spentCents)} spent`);
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
        onDayActivate={(iso) => router.push(dayLedgerHref(iso))}
        renderCell={(day) => {
          const d = byDay.get(day.iso);
          if (!d || (d.spentCents === 0 && d.incomeCents === 0)) return null;
          const intensity =
            d.spentCents > 0 && max > 0 ? MIN_TINT + (MAX_TINT - MIN_TINT) * (d.spentCents / max) : 0;
          return (
            <span className="relative flex h-full w-full items-end justify-end">
              {intensity > 0 && (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-[4px]"
                  style={{ backgroundColor: `color-mix(in oklab, var(--negative) ${Math.round(intensity * 100)}%, transparent)` }}
                />
              )}
              {d.incomeCents > 0 && (
                <span aria-hidden className="relative m-0.5 size-1.5 rounded-full bg-positive" />
              )}
            </span>
          );
        }}
        footer={
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2.5 rounded-[3px]" style={{ backgroundColor: "color-mix(in oklab, var(--negative) 60%, transparent)" }} />
              more spent
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-1.5 rounded-full bg-positive" />
              income
            </span>
            <span>Tap a day to see its transactions</span>
          </p>
        }
      />
    </div>
  );
}
