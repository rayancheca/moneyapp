"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { loadRecurringMonthAction } from "@/app/recurring/actions";
import { Badge } from "@/components/ui/Badge";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import type { CalendarDay } from "@/lib/calendar-math";
import { formatCents } from "@/lib/money";
import type {
  CalendarEntry,
  DayStateKind,
  RecurringCalendarMonth,
} from "@/services/recurring-calendar";
import { KIND_LABEL, longDate } from "./labels";

interface RecurringCalendarProps {
  initialMonth: RecurringCalendarMonth;
  today: string;
}

// Day-state grammar [MM]. The GLYPH (shape) carries the meaning so it survives
// color-blindness (WCAG 1.4.1); color reinforces it. Each day cell's aria-label
// (getCellLabel) already enumerates the state in words for screen readers.
const STATE_GLYPH: Record<DayStateKind, string> = {
  paid: "✓",
  paid_different: "!",
  upcoming: "•",
  missed: "✕",
};
const STATE_MARK_COLOR: Record<DayStateKind, string> = {
  paid: "text-positive",
  paid_different: "text-warning",
  upcoming: "text-info",
  missed: "text-negative",
};
const STATE_WORD: Record<DayStateKind, string> = {
  paid: "paid",
  paid_different: "paid (amount changed)",
  upcoming: "upcoming",
  missed: "missed",
};
/** Contrast-safe tone per state (soft tint + tone text — state-contrast.test). */
const STATE_TONE: Record<DayStateKind, "positive" | "warning" | "info" | "negative"> = {
  paid: "positive",
  paid_different: "warning",
  upcoming: "info",
  missed: "negative",
};

function entrySummary(e: CalendarEntry): string {
  return `${e.name} ${STATE_WORD[e.state]} ${formatCents(e.amountCents)}`;
}

/**
 * Recurring calendar sub-view (ux-overhaul-plan §4.1.3). Wraps the a11y
 * CalendarGrid core with the recurring day-state grammar: colored dots per
 * series, a per-day aria-label enumerating them, a Day Sheet on activation, and
 * a month footer of posted / upcoming totals. Month paging fetches the new
 * month through a server action (the grid never reaches the wall clock itself).
 */
export function RecurringCalendar({ initialMonth, today }: RecurringCalendarProps) {
  const [month, setMonth] = useState(initialMonth);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function changeMonth(monthKey: string): void {
    startTransition(async () => {
      const r = await loadRecurringMonthAction({ monthKey });
      if (r.ok) setMonth(r.data);
      else toast({ title: r.error, tone: "negative" });
    });
  }

  function cellLabel(iso: string): string {
    const entries = month.entriesByDay[iso] ?? [];
    if (entries.length === 0) return longDate(iso);
    return `${longDate(iso)} — ${entries.length} ${entries.length === 1 ? "item" : "items"}: ${entries
      .map(entrySummary)
      .join("; ")}`;
  }

  function renderCell(day: CalendarDay): React.ReactNode {
    const entries = month.entriesByDay[day.iso];
    if (!entries || entries.length === 0) return null;
    return (
      <span className="flex flex-wrap content-start items-center gap-x-1 gap-y-0 leading-none">
        {entries.slice(0, 4).map((e, i) => (
          <span key={`${e.seriesId}-${i}`} className={`text-[11px] font-bold leading-none ${STATE_MARK_COLOR[e.state]}`}>
            {STATE_GLYPH[e.state]}
          </span>
        ))}
        {entries.length > 4 ? <span className="text-[9px] leading-none text-ink-faint">+{entries.length - 4}</span> : null}
      </span>
    );
  }

  const openEntries = openDay ? month.entriesByDay[openDay] ?? [] : [];

  return (
    <div className="rounded-(--radius-card) border border-line bg-surface-raised p-4 sm:p-5">
      <CalendarGrid
        monthKey={month.monthKey}
        today={today}
        onMonthChange={changeMonth}
        getCellLabel={cellLabel}
        renderCell={renderCell}
        onDayActivate={(iso) => setOpenDay(iso)}
        footer={<CalendarFooter month={month} />}
      />

      <Legend />

      <Sheet open={openDay !== null} onClose={() => setOpenDay(null)} title={openDay ? longDate(openDay) : ""}>
        {openEntries.length === 0 ? (
          <p className="text-sm text-ink-muted">No recurring activity on this day.</p>
        ) : (
          <ul className="divide-y divide-line">
            {openEntries.map((e, i) => (
              <li key={`${e.seriesId}-${i}`} className="py-2.5">
                <Link
                  href={`/recurring/${e.seriesId}`}
                  className="flex items-center justify-between gap-3 rounded-md px-1 py-1 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                >
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium">{e.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <Badge tone={STATE_TONE[e.state]}>{STATE_WORD[e.state]}</Badge>
                      <span className="text-[11px] text-ink-faint">{KIND_LABEL[e.kind]}</span>
                    </span>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money cents={e.amountCents} flow className="text-sm" />
                    {e.state === "paid_different" && e.expectedAmountCents !== null ? (
                      <span className="block text-[11px] text-ink-faint">expected {formatCents(e.expectedAmountCents)}</span>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </div>
  );
}

function CalendarFooter({ month }: { month: RecurringCalendarMonth }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line-strong pt-3 text-sm">
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">Posted</span>
        <Money cents={month.postedNetCents} flow className="font-medium" />
      </span>
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">Upcoming</span>
        <Money cents={month.upcomingNetCents} flow className="font-medium" />
      </span>
      {month.missedCount > 0 ? (
        <span className="text-xs font-medium text-negative">
          {month.missedCount} missed
        </span>
      ) : null}
    </div>
  );
}

const LEGEND: { state: DayStateKind; label: string }[] = [
  { state: "paid", label: "Paid" },
  { state: "paid_different", label: "Amount changed" },
  { state: "upcoming", label: "Upcoming" },
  { state: "missed", label: "Missed" },
];

function Legend() {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
      {LEGEND.map((l) => (
        <li key={l.state} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`text-xs font-bold leading-none ${STATE_MARK_COLOR[l.state]}`}>
            {STATE_GLYPH[l.state]}
          </span>
          {l.label}
        </li>
      ))}
    </ul>
  );
}
