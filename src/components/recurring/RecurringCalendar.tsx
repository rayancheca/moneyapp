"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { loadRecurringMonthAction } from "@/app/recurring/actions";
import { Badge } from "@/components/ui/Badge";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { compactDayTotal, dayWeight, heaviestDayCents } from "@/lib/calendar-day-weight";
import type { CalendarDay } from "@/lib/calendar-math";
import { RECURRING_JARGON } from "@/lib/jargon";
import { formatCents } from "@/lib/money";
import type { ForecastConfidence, UnsettledReason } from "@/lib/occurrence-verdict";
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

/**
 * Day-state grammar [MM]. The GLYPH (shape) carries the meaning so it survives
 * colour-blindness (WCAG 1.4.1); colour reinforces it. Each day cell's aria-label
 * (getCellLabel) already enumerates the state in words for screen readers.
 *
 * ## Why `unsettled` is the one state with no colour
 *
 * Four of the five states are verdicts: it was paid, it was paid differently, it
 * is coming, it did not happen. `unsettled` is the absence of a verdict — the
 * ledger has not been shown the day, or the money is cash he has not banked yet.
 * Spending a hue on it would put it in the same grammar as the four claims and
 * invite the reader to treat "we do not know" as a finding.
 *
 * So it takes the page's faintest ink and a question mark, and it recedes. That
 * is the whole design argument for the palette: **absence of evidence gets
 * absence of colour.** It also keeps the swatch count at four, which is what
 * makes a five-state legend readable at all.
 */
const STATE_GLYPH: Record<DayStateKind, string> = {
  paid: "✓",
  paid_different: "!",
  upcoming: "•",
  missed: "✕",
  unsettled: "?",
};
const STATE_MARK_COLOR: Record<DayStateKind, string> = {
  paid: "text-positive",
  paid_different: "text-warning",
  upcoming: "text-info",
  missed: "text-negative",
  unsettled: "text-ink-faint",
};
const STATE_WORD: Record<DayStateKind, string> = {
  paid: "paid",
  paid_different: "paid (amount changed)",
  upcoming: "upcoming",
  missed: "missed",
  unsettled: "not yet known",
};
/**
 * The magnitude bar's fill — the same grammar as the glyph, as a surface.
 *
 * ⚠️ `unsettled` is an OUTLINE, not a tint, and this was found by screenshotting
 * rather than by reasoning. Filled grey at 45% still reads as a solid mass, and
 * the unsettled marks happen to be the owner's $1,047 paydays — the largest
 * amounts in August. The month therefore drew three big grey blocks for the
 * things nobody can grade, while the two genuinely missed bills ($50 and $14.21)
 * were the faintest marks on the page. Attention ran exactly backwards.
 *
 * A hollow bar keeps the magnitude — the rhythm the grid exists to show is still
 * honest, and $1,047 still stands tall — while spending almost no ink on it. It
 * is also the right metaphor: the space is reserved and not yet filled in.
 */
const BAR_TONE: Record<DayStateKind, string> = {
  paid: "bg-positive",
  paid_different: "bg-warning",
  upcoming: "bg-info",
  missed: "bg-negative",
  unsettled: "border border-dashed border-ink-faint bg-transparent",
};

/** Contrast-safe tone per state (soft tint + tone text — state-contrast.test). */
const STATE_TONE: Record<DayStateKind, "positive" | "warning" | "info" | "negative" | "neutral"> = {
  paid: "positive",
  paid_different: "warning",
  upcoming: "info",
  missed: "negative",
  unsettled: "neutral",
};

/**
 * Why an occurrence could not be graded — the sentence that belongs beside the
 * "?" so it never reads as a shrug.
 */
const REASON_WORD: Record<UnsettledReason, string> = {
  not_imported: "not imported yet",
  unbanked: "not banked yet",
  schedule_unproven: "due date not established",
};

/**
 * The FUTURE half's second channel, which the owner asked for by name.
 *
 * Confidence is deliberately NOT a colour. State already owns the palette, and
 * crossing five states with three confidences would be fifteen swatches — the
 * rainbow this redesign exists to avoid. It rides on the two channels colour is
 * not using: **fill density and opacity**, both of which survive greyscale, a
 * monochrome print, and every form of colour-blindness.
 *
 * A hatched bar reads as provisional in every charting tradition there is, which
 * is exactly what `predicted` means: the app noticed a pattern and nobody has
 * agreed to it.
 */
const CONFIDENCE_WORD: Record<ForecastConfidence, string> = {
  scheduled: "scheduled",
  expected: "expected",
  predicted: "predicted",
};
const CONFIDENCE_HINT: Record<ForecastConfidence, string> = {
  scheduled: "you set this amount or date",
  expected: "confirmed by you, amount from history",
  predicted: "detected by the app, not confirmed",
};
/**
 * Widened from 100/70/50 after looking at it: at legend-swatch size the first
 * two steps were indistinguishable, which makes a three-rung ladder a two-rung
 * one. The hatch carries the rung that matters most — agreed to versus guessed —
 * and opacity separates the two the owner HAS agreed to.
 */
const CONFIDENCE_OPACITY: Record<ForecastConfidence, string> = {
  scheduled: "opacity-100",
  expected: "opacity-60",
  predicted: "opacity-40",
};

/** Surface-coloured stripes punched through the tone — see CONFIDENCE_WORD. */
const HATCH: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent 0 2px, var(--color-surface-raised) 2px 4px)",
};

function entrySummary(e: CalendarEntry): string {
  const qualifier = e.unsettledReason
    ? ` (${REASON_WORD[e.unsettledReason]})`
    : e.confidence
      ? ` (${CONFIDENCE_WORD[e.confidence]}${e.isStale ? ", evidence stale" : ""})`
      : "";
  return `${e.name} ${STATE_WORD[e.state]}${qualifier} ${formatCents(e.amountCents)}`;
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
   *    amount to opposite edges of the cell. At 320px that left the amount
   *    17–21px for text needing 24–30, and all six ellipsised — the grid
   *    rendered `-...` and `3...` where the money was supposed to be. They sit
   *    adjacent now, so the pair reads as one thing and fits.
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
    // Confidence dims and hatches the bar; an unsettled day is dimmed too,
    // because it is a mark the app is not standing behind either.
    // Unsettled carries its uncertainty in the outline, so it needs no dimming
    // on top — dimming a hairline border only makes it disappear.
    const dimmed = w.confidence !== null ? CONFIDENCE_OPACITY[w.confidence] : "";
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
            {compactDayTotal(w.netCents)}
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
        {/* The overflow count sits OUTSIDE the truncating span. Inside it, it was
            the first thing the ellipsis ate: 2026-08-10 carries Breezeline and
            FPL and rendered "Breezeline (internet) …", so the cell showed a −$64
            total that its own caption could not account for. The name is the
            part that degrades gracefully; "+1" is four pixels that must not. */}
        <span className="hidden w-full items-baseline gap-0.5 text-[9px] leading-tight text-ink-muted min-[400px]:flex">
          <span className="min-w-0 truncate">{w.dominantName}</span>
          {w.count > 1 ? <span className="shrink-0">+{w.count - 1}</span> : null}
        </span>

        {/* The magnitude column. `items-end` stands it on the cell's bottom edge
            so the whole grid shares one baseline; `min-h-[2px]` keeps the
            smallest bill visible in a short cell, where 4% of ~11px rounds to
            nothing.

            ⚠️ Still a √ scale against the month's heaviest day, NOT
            `magnitudeTiers`. That module answers a different geometry: a list of
            bars sharing one axis, where a tier can be magnified and its factor
            printed beside it. A calendar is seven columns by five rows and there
            is nowhere to put three axes or the sentence explaining them. The
            honest trade here is the one `barWeight` already documents — the bar
            answers "is this a heavy day?" and the figure printed directly above
            it answers "how much?". */}
        <span className="flex min-h-0 flex-1 items-end pt-0.5">
          <span
            className={`block min-h-[2px] w-full rounded-t-[2px] ${BAR_TONE[w.state]} ${dimmed}`}
            style={{
              height: `${Math.round(w.weight * 100)}%`,
              ...(w.confidence === "predicted" ? HATCH : null),
            }}
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
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATE_TONE[e.state]}>
                        {/* The state and its qualifier are printed from ONE
                            entry, which carried them out of ONE `settledVerdict`
                            call. A cell can therefore never show "not yet known"
                            beside the wrong reason for it. */}
                        {e.state === "unsettled" && e.unsettledReason
                          ? `${STATE_WORD[e.state]} — ${REASON_WORD[e.unsettledReason]}`
                          : STATE_WORD[e.state]}
                      </Badge>
                      {e.confidence ? (
                        <Badge tone="neutral">{CONFIDENCE_WORD[e.confidence]}</Badge>
                      ) : null}
                      {e.isStale ? <Badge tone="warning">evidence stale</Badge> : null}
                      <span className="text-[11px] text-ink-faint">{KIND_LABEL[e.kind]}</span>
                    </span>
                    {e.confidence ? (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        {CONFIDENCE_HINT[e.confidence]}
                        {e.isStale ? " · evidence has gone quiet" : ""}
                      </span>
                    ) : null}
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

/**
 * The month's ledger, in the order a reader asks for it: what settled, what is
 * still coming, and then — separately — what the app could not grade.
 *
 * The old footer printed "Posted $0.00" beside a bare "6 missed", which on
 * August 2026 was the page saying nothing happened and six things failed. Both
 * halves were misleading and they reinforced each other: the money was not zero,
 * it was unmeasured, and four of the six failures were unimported days. Pass 62
 * shipped a total drawn as a 77.97px bar labelled "$0.00" and this is the same
 * error in text — a figure that is only true because the evidence is missing
 * must say so where the figure is.
 *
 * So "not yet known" carries its own AMOUNT, not just a count. `$0.00 settled ·
 * $3,147.00 not yet known` is a sentence about an unfinished import. `$0.00
 * settled` alone is a false claim about a month.
 *
 * That amount is a GROSS magnitude rather than a net — see
 * `unsettledGrossCents`. A net of unknowns can cancel to zero, which would
 * reintroduce the very reading this footer was rewritten to remove.
 */
function CalendarFooter({ month }: { month: RecurringCalendarMonth }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-line-strong pt-3 text-sm">
      <FooterFigure label="Settled">
        <Money cents={month.postedNetCents} flow className="font-medium" />
      </FooterFigure>
      <FooterFigure label="Expected">
        <Money cents={month.upcomingNetCents} flow className="font-medium" />
      </FooterFigure>
      {month.unsettledCount > 0 ? (
        <FooterFigure label="Not yet known">
          <span className="figures font-medium tabular-nums text-ink-muted">
            {formatCents(month.unsettledGrossCents)}
          </span>
          <span className="ml-1 text-[11px] text-ink-faint">
            ({month.unsettledCount})
          </span>
        </FooterFigure>
      ) : null}
      {month.missedCount > 0 ? (
        <span className="text-xs font-medium text-negative">{month.missedCount} missed</span>
      ) : null}
    </div>
  );
}

function FooterFigure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">{label}</span>
      {children}
    </span>
  );
}

const LEGEND: { state: DayStateKind; label: string; tip: string }[] = [
  { state: "paid", label: "Paid", tip: RECURRING_JARGON.paid },
  { state: "paid_different", label: "Amount changed", tip: RECURRING_JARGON.paidDifferent },
  { state: "missed", label: "Missed", tip: RECURRING_JARGON.missed },
  { state: "upcoming", label: "Upcoming", tip: RECURRING_JARGON.upcoming },
  { state: "unsettled", label: "Not yet known", tip: RECURRING_JARGON.notYetKnown },
];

const CONFIDENCE_LEGEND: { key: ForecastConfidence; tip: string }[] = [
  { key: "scheduled", tip: RECURRING_JARGON.scheduled },
  { key: "expected", tip: RECURRING_JARGON.expected },
  { key: "predicted", tip: RECURRING_JARGON.predicted },
];

/**
 * Two rows, because the grid now carries two channels and collapsing them into
 * one list would imply they are alternatives. State is what happened; confidence
 * is how firmly the app is claiming what WILL happen, and only future marks
 * carry it — so its row is labelled for the future rather than left to be
 * inferred.
 */
function Legend() {
  return (
    <div className="mt-3 space-y-1.5">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        {LEGEND.map((l) => (
          <li key={l.state} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`text-xs font-bold leading-none ${STATE_MARK_COLOR[l.state]}`}>
              {STATE_GLYPH[l.state]}
            </span>
            {l.label}
            <InfoTip term={l.label}>{l.tip}</InfoTip>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <li className="uppercase tracking-[0.08em]">Ahead</li>
        {CONFIDENCE_LEGEND.map((c) => (
          <li key={c.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className={`h-2.5 w-4 rounded-[2px] bg-info ${CONFIDENCE_OPACITY[c.key]}`}
              style={c.key === "predicted" ? HATCH : undefined}
            />
            {CONFIDENCE_WORD[c.key]}
            <InfoTip term={CONFIDENCE_WORD[c.key]}>{c.tip}</InfoTip>
          </li>
        ))}
      </ul>
    </div>
  );
}
