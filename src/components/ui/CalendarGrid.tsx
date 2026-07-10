"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/Button";
import {
  addMonths,
  monthLabel,
  monthMatrix,
  weekdayLabels,
  type CalendarDay,
  type WeekStart,
} from "@/lib/calendar-math";
import { addDays, compareDates } from "@/lib/dates";

interface CalendarGridProps {
  /** "YYYY-MM" */
  monthKey: string;
  /**
   * Today as "YYYY-MM-DD". This client component never reads the wall clock
   * itself — server callers pass lib/dates todayIso(), which honors
   * MONEYAPP_FAKE_TODAY (the env never reaches client bundles, so a local
   * read would diverge from SSR under the pinned e2e clock).
   */
  today: string;
  onMonthChange: (monthKey: string) => void;
  /** becomes each day button's aria-label — the whole a11y story of a cell */
  getCellLabel: (iso: string) => string;
  /** decorative dots/tints — rendered inside an aria-hidden wrapper */
  renderCell?: (day: CalendarDay) => ReactNode;
  onDayActivate?: (iso: string) => void;
  /** e.g. today ring — defaults to emphasizing the `today` prop */
  isDayEmphasized?: (iso: string) => boolean;
  /** defaults to 1 (Monday), the seeded app setting — callers pass the user setting */
  weekStartsOn?: WeekStart;
  footer?: ReactNode;
}

function initialFocus(monthKey: string, today: string): string {
  return today.slice(0, 7) === monthKey ? today : `${monthKey}-01`;
}

/**
 * Month grid a11y core (Stage 0): date math + roving tabindex + arrow-key 2D
 * nav. Exactly one day button is tabbable at a time; arrows move focus within
 * the visible matrix only (no auto-paging). Paging via the header buttons
 * resets the roving target to day 1 of the new month on the next render —
 * DOM focus stays on the nav button so paging never yanks focus.
 */
export function CalendarGrid({
  monthKey,
  today,
  onMonthChange,
  getCellLabel,
  renderCell,
  onDayActivate,
  isDayEmphasized,
  weekStartsOn = 1,
  footer,
}: CalendarGridProps) {
  const matrix = useMemo(() => monthMatrix(monthKey, weekStartsOn), [monthKey, weekStartsOn]);
  const label = monthLabel(monthKey);
  const emphasizeDay = isDayEmphasized ?? ((iso: string) => iso === today);

  // Roving-tabindex bookkeeping: `focused` is the last-focused day (initially
  // today when visible, else the 1st). Only that button gets tabIndex=0, so
  // Tab enters/leaves the grid in one stop while arrows move within it.
  const [focused, setFocused] = useState(() => initialFocus(monthKey, today));
  const [renderedMonthKey, setRenderedMonthKey] = useState(monthKey);
  if (renderedMonthKey !== monthKey) {
    setRenderedMonthKey(monthKey);
    setFocused(initialFocus(monthKey, today));
  }

  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const gridStart = matrix[0]?.[0]?.iso;
  const gridEnd = matrix[matrix.length - 1]?.[6]?.iso;
  // arrows may land on out-of-month cells, so the roving target can be one;
  // fall back to day 1 if the target left the visible matrix entirely
  const rovingIso =
    gridStart !== undefined &&
    gridEnd !== undefined &&
    compareDates(focused, gridStart) >= 0 &&
    compareDates(focused, gridEnd) <= 0
      ? focused
      : `${monthKey}-01`;

  function focusDay(iso: string) {
    setFocused(iso);
    cellRefs.current.get(iso)?.focus();
  }

  function keyTarget(key: string, iso: string): string | null {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const delta = step[key];
    if (delta !== undefined) {
      const target = addDays(iso, delta);
      const inMatrix =
        gridStart !== undefined &&
        gridEnd !== undefined &&
        compareDates(target, gridStart) >= 0 &&
        compareDates(target, gridEnd) <= 0;
      return inMatrix ? target : null;
    }
    if (key === "Home" || key === "End") {
      const row = matrix.find((week) => week.some((d) => d.iso === iso));
      return row?.[key === "Home" ? 0 : 6]?.iso ?? null;
    }
    return null;
  }

  function handleKeyDown(iso: string): (event: React.KeyboardEvent<HTMLButtonElement>) => void {
    return (event) => {
      const target = keyTarget(event.key, iso);
      if (target === null) return;
      event.preventDefault();
      focusDay(target);
    };
  }

  return (
    <div>
      <header className="mb-2 flex items-center justify-between gap-2">
        {/* polite live region: paging replaces the text, announcing the new
            month while DOM focus stays on the nav button */}
        <span aria-live="polite" aria-atomic="true" className="text-sm font-medium">
          {label}
        </span>
        <div className="flex gap-1">
          <IconButton
            icon="chevron-left"
            size="sm"
            aria-label="Previous month"
            onClick={() => onMonthChange(addMonths(monthKey, -1))}
          />
          <IconButton
            icon="chevron-right"
            size="sm"
            aria-label="Next month"
            onClick={() => onMonthChange(addMonths(monthKey, 1))}
          />
        </div>
      </header>
      <div role="grid" aria-label={label}>
        <div role="row" className="grid grid-cols-7">
          {weekdayLabels(weekStartsOn).map((weekday) => (
            <div
              key={weekday}
              role="columnheader"
              className="py-1.5 text-center text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase"
            >
              {weekday}
            </div>
          ))}
        </div>
        {matrix.map((week) => (
          <div key={week[0]?.iso} role="row" className="grid grid-cols-7">
            {week.map((day) => (
              <div key={day.iso} role="gridcell">
                <button
                  type="button"
                  ref={(el) => {
                    if (el) {
                      cellRefs.current.set(day.iso, el);
                    } else {
                      cellRefs.current.delete(day.iso);
                    }
                  }}
                  tabIndex={day.iso === rovingIso ? 0 : -1}
                  aria-label={getCellLabel(day.iso)}
                  onClick={() => {
                    setFocused(day.iso);
                    onDayActivate?.(day.iso);
                  }}
                  onKeyDown={handleKeyDown(day.iso)}
                  className={`flex aspect-square w-full flex-col items-start gap-0.5 rounded-md p-1 transition-colors duration-(--duration-fast) hover:bg-surface-sunken ${
                    day.inMonth ? "" : "text-ink-faint opacity-60"
                  } ${emphasizeDay(day.iso) ? "ring-1 ring-accent" : ""}`.trim()}
                >
                  <span aria-hidden className="text-xs">
                    {Number(day.iso.slice(8))}
                  </span>
                  {renderCell ? (
                    <span aria-hidden className="min-h-0 w-full flex-1">
                      {renderCell(day)}
                    </span>
                  ) : null}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}
