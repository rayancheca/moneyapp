"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { loadRecurringMonthAction } from "@/app/recurring/actions";
import { Badge } from "@/components/ui/Badge";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { dayWeight, heaviestDayCents } from "@/lib/calendar-day-weight";
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
/** The magnitude bar's fill — the same grammar as the glyph, as a surface. */
const BAR_TONE: Record<DayStateKind, string> = {
  paid: "bg-positive",
  paid_different: "bg-warning",
  upcoming: "bg-info",
  missed: "bg-negative",
};

/**
 * A day total in the width of a calendar cell: "2.3k", "-499", "0".
 * Cents are dropped on purpose — this is a magnitude for scanning, and the Day
 * Sheet behind the cell carries every exact figure.
 */
function compactCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1000) return `${sign}${(dollars / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(dollars)}`;
}

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

  // scaled against the month, not an absolute ceiling, so a quiet month still
  // shows its own shape instead of flatlining
  const heaviest = heaviestDayCents(month.entriesByDay);

  /**
   * A day cell: the MONEY, then a magnitude bar, then the state glyph.
   *
   * It used to be glyphs alone, which made rent and a $4.99 subscription draw
   * identically — the page could tell you something was due and never how much.
   * The bar is scaled against the heaviest day in the month (calendar-day-weight),
   * so a month reads as a rhythm at a glance: rent is a full bar, a subscription
   * is a hairline, and a heavy week is visible without reading a single number.
   *
   * The glyph stays, small, because it is what survives colour-blindness
   * (WCAG 1.4.1) and it is what the aria-label enumerates.
   */
  function renderCell(day: CalendarDay): React.ReactNode {
    const w = dayWeight(month.entriesByDay[day.iso], heaviest);
    if (!w) return null;
    const upcoming = w.state === "upcoming";
    return (
      <span className="flex flex-col items-stretch gap-0.5 leading-none">
        <span className="flex items-baseline justify-between gap-1">
          <span className={`text-[9px] font-bold leading-none ${STATE_MARK_COLOR[w.state]}`}>
            {STATE_GLYPH[w.state]}
          </span>
          <span
            className={`figures truncate text-[10px] leading-none tabular-nums ${
              upcoming ? "text-ink-muted" : STATE_MARK_COLOR[w.state]
            }`}
          >
            {compactCents(w.netCents)}
          </span>
        </span>
        <span className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
          <span
            className={`block h-full rounded-full ${BAR_TONE[w.state]} ${upcoming ? "opacity-60" : ""}`}
            style={{ width: `${Math.round(w.weight * 100)}%` }}
          />
        </span>
        {w.count > 1 ? (
          <span className="text-[9px] leading-none text-ink-faint">{w.count} items</span>
        ) : null}
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
