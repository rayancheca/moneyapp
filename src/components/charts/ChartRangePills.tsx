"use client";

import { CHART_RANGES, rangeLabel, type ChartRange } from "@/lib/chart-range";

/**
 * The 1M/3M/YTD/1Y/ALL range pills — extracted from ScrubChart (chart-parity
 * pass 23) so the TABLE lens can offer the same range control the chart does.
 * In table mode the ScrubChart unmounts and takes its pills with it; a table
 * that respects the active range but cannot change it is a dead end, and a
 * second hand-rolled pill row is exactly the drift this shares away.
 *
 * A `role="group"` of `aria-pressed` buttons, matching ViewSwitcher's keyboard
 * model: every pill stays tabbable and arrows do nothing (arrow keys belong to
 * the plot's `role="slider"`). `className` carries the caller's own container
 * spacing, so ScrubChart's two call sites keep their exact layout.
 */
export function ChartRangePills({
  /** the pressed pill — pass null under a custom drag window, where no pill
   *  describes the visible rows */
  active,
  onSelect,
  className,
  /** the vivid press-scale (the dashboard hero); siblings stay byte-identical */
  press = false,
}: {
  active: ChartRange | null;
  onSelect: (range: ChartRange) => void;
  className: string;
  press?: boolean;
}) {
  return (
    <div role="group" aria-label="Chart range" className={className}>
      {CHART_RANGES.map((r) => {
        const isActive = r === active;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={isActive}
            aria-label={rangeLabel(r)}
            onClick={() => onSelect(r)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors duration-(--duration-fast) ${press ? "active:scale-95 " : ""}${
              isActive ? "bg-accent-soft text-accent" : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
            }`}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}
