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
   * A day with money on it gets a surface of its own.
   *
   * Two jobs. It bounds the cell, so a magnitude column standing on the bottom
   * edge belongs visibly to THIS square and not to the date printed directly
   * below it — without a boundary the two are indistinguishable, which is how
   * the first version of this grid drew Jul 5's bar apparently on top of Jul 12.
   * And it gives the month a shape at a glance: the days that cost something are
   * raised, so a quiet week reads as a quiet week rather than as a rendering
   * failure.
   */
  function cellClassName(iso: string): string {
    /*
     * A calendar cell does not have to be square, and below ~48px wide it must
     * not be. `CalendarGrid` sizes days with `aspect-square`, which at 320px is
     * a 30px box: the date alone takes 16 of it, leaving 10px for figures that
     * measured 13–22. Everything under the date silently overflowed.
     *
     * `min-height` rather than an override of `aspect-ratio` — the two are not
     * in conflict, because a min-height larger than the aspect-derived height
     * simply wins, and the aspect keeps applying everywhere it still fits. At
     * 440px (the owner's phone) a cell is already ~52px and this is inert.
     */
    const fitsFigures = "max-sm:min-h-12";
    const tint = (month.entriesByDay[iso]?.length ?? 0) > 0 ? " bg-surface-sunken" : "";
    return fitsFigures + tint;
  }

  /**
   * A day cell: the MONEY, the series that owns it, and a magnitude COLUMN
   * standing on the bottom edge of the cell.
   *
   * Three things about the previous version were wrong once it was screenshotted
   * rather than reasoned about:
   *
   * 1. It laid the figures out `justify-between`, which pushed the glyph and the
   *    amount to opposite edges of the cell. At 320px that left about 22px for
   *    the amount and every one of them ellipsised — the grid rendered `-...`
   *    and `3...` where the money was supposed to be. They sit adjacent now, so
   *    the pair reads as one thing and fits.
   * 2. The bar was a 4px horizontal rule pinned to the TOP of a cell that is a
   *    square — on a 1024px viewport roughly 25px of content above 75px of
   *    nothing. A month of that reads as empty, which is exactly the complaint
   *    the redesign started from. The magnitude is now a vertical column that
   *    stands in that space, so the grid reads as a bar chart wrapped by weeks.
   * 3. The amount took the STATE's colour, so a −$1,800 rent and a +$3,200
   *    paycheque — the two biggest marks in the month, and opposite in meaning —
   *    drew in the same blue. It takes the app's flow colour now (the same
   *    green/red `Money flow` uses everywhere else), which puts direction on the
   *    figure and leaves state to the glyph and the column.
   *
   * The glyph stays, small, because it is what survives colour-blindness
   * (WCAG 1.4.1) and it is what the aria-label enumerates.
   */
  function renderCell(day: CalendarDay): React.ReactNode {
    const w = dayWeight(month.entriesByDay[day.iso], heaviest);
    if (!w) return null;
    const upcoming = w.state === "upcoming";
    const flowTone =
      w.netCents < 0 ? "text-negative" : w.netCents > 0 ? "text-positive" : "text-ink-muted";
    return (
      <span className="flex h-full w-full flex-col gap-0.5">
        {/* `flex-wrap` is doing real work at 320px: a ~38px cell leaves ~21px
            beside the glyph, and "-1.8k" needs 30px — so the amount drops to its
            own line there and keeps the cell's full width, rather than being
            ellipsised (what `truncate` did) or spilling over the neighbouring
            day (what removing `truncate` did instead). It re-joins the glyph on
            one line as soon as there is room. */}
        <span className="flex flex-wrap items-center gap-x-0.5 leading-none">
          <span className={`text-[9px] font-bold leading-none ${STATE_MARK_COLOR[w.state]}`}>
            {STATE_GLYPH[w.state]}
          </span>
          <span
            className={`figures whitespace-nowrap text-[9px] font-semibold leading-none tabular-nums sm:text-[10px] ${flowTone}`}
          >
            {compactCents(w.netCents)}
          </span>
        </span>

        {/* Which bill this is — the question a heavy day raises and the grid
            could not answer without being opened.

            The breakpoint is 400px, NOT Tailwind's `sm` (640px). A phone is the
            device this page gets read on, and the owner's is 440px logical —
            which is below `sm`, so an `sm:` gate would have hidden the names on
            exactly the screen that most needs them. 400px is where a cell first
            gets wide enough (~46px) for a name to be worth truncating; at 320 it
            would be an ellipsis and the Day Sheet carries it instead. */}
        <span className="hidden w-full truncate text-[9px] leading-tight text-ink-muted min-[400px]:block">
          {w.count > 1 ? `${w.dominantName} +${w.count - 1}` : w.dominantName}
        </span>

        {/* The magnitude column. `items-end` stands it on the cell's bottom edge
            so the whole grid shares one baseline; `min-h-[2px]` keeps the
            smallest bill visible in a short cell, where 4% of ~11px rounds to
            nothing. */}
        <span className="flex min-h-0 flex-1 items-end pt-0.5">
          <span
            className={`block min-h-[2px] w-full rounded-t-[2px] ${BAR_TONE[w.state]} ${
              upcoming ? "opacity-55" : ""
            }`}
            style={{ height: `${Math.round(w.weight * 100)}%` }}
          />
        </span>
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
        getCellClassName={cellClassName}
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
