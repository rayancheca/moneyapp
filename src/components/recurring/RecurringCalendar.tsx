"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { loadRecurringMonthAction } from "@/app/recurring/actions";
import { Badge } from "@/components/ui/Badge";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { MerchantMark } from "@/components/ui/MerchantMark";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { compactDayTotal, dayWeight, heaviestDayCents } from "@/lib/calendar-day-weight";
import { heatMixPercent } from "@/lib/calendar-heat";
import { daysInMonthOf, type CalendarDay } from "@/lib/calendar-math";
import { RECURRING_JARGON } from "@/lib/jargon";
import { monthFlow } from "@/lib/month-flow";
import { CALENDAR_DENSITY_CLASS } from "./recurring-view-spec";
import { formatCents } from "@/lib/money";
import type { ForecastConfidence } from "@/lib/occurrence-verdict";
import { SERIES_EVIDENCE_LABEL } from "@/lib/series-evidence";
import type {
  CalendarEntry,
  DayStateKind,
  RecurringCalendarMonth,
} from "@/services/recurring-calendar";
import { KIND_LABEL, longDate, monthLabel, unsettledReasonWord, upcomingEvidenceWord } from "./labels";
import { MonthFlowStrip } from "./MonthFlowStrip";

interface RecurringCalendarProps {
  initialMonth: RecurringCalendarMonth;
  today: string;
  /**
   * How tall a day cell may be: `compact`, `regular` or `tall`. Defaults to
   * `tall`, which is the uncapped square this grid rendered before the option
   * existed — so a caller that does not pass it is unchanged.
   */
  density?: string;
  /**
   * Called after a month is loaded, so the forecast card ABOVE this grid can
   * follow it.
   *
   * ⚠️ The month deliberately stays client state rather than moving into the
   * URL like `?cal=`. Paging is a rapid, repeated action: a navigation per
   * arrow-press would remount `CalendarGrid` and drop its roving-tabindex
   * focus, which is the whole keyboard story of the grid. The density is the
   * opposite — a rare, deliberate choice worth putting in a link.
   */
  onMonthLoaded?: (monthKey: string) => void;
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
  // --ink-muted, not --ink-faint: this glyph lands on a TINTED cell, and faint
  // is the dimmest ink that clears AA on the app's plain surfaces — it has no
  // headroom left once a tone is mixed under it (`calendar-heat.test`).
  unsettled: "text-ink-muted",
};
const STATE_WORD: Record<DayStateKind, string> = {
  paid: "paid",
  paid_different: "paid (amount changed)",
  upcoming: "upcoming",
  missed: "missed",
  unsettled: "not yet known",
};
/**
 * How the magnitude column is FILLED — and the one place this redesign reversed
 * an earlier decision in this same file.
 *
 * The first version spent the fill on STATE: green for paid, red for missed,
 * blue for upcoming. It was defensible and it was wrong for this reader. The
 * owner's verdict on it was *"i can barely understand it"*, and the reason is
 * that state is EPISTEMIC METADATA — how sure the app is — while the thing he
 * opens the page to see is money moving. Metadata had the loudest channel and
 * the content had none: a −$1,800 rent and a +$3,200 paycheque, the two largest
 * and most opposite events of a month, both drew in the same blue because both
 * were merely "upcoming".
 *
 * Direction owns the fill now, at a saturation driven by the day's magnitude, so
 * the grid reads as a heat map: heavy outgoing days deep and warm, quiet ones
 * pale, money in green. State did not lose a channel — it keeps the glyph (what
 * survives colour-blindness, and what the aria-label enumerates) and it keeps
 * the column's TREATMENT: an outline for something ungradeable, a hatch for
 * something merely predicted.
 *
 * ⚠️ `unsettled` stays an OUTLINE, and that was found by screenshotting rather
 * than reasoning. Filled at 45% it still read as a solid mass, and the unsettled
 * marks happen to be the owner's $1,047 paydays — the largest amounts in August.
 * The month drew three big blocks for the things nobody can grade while the two
 * bills that mattered were the faintest marks on the page.
 */
/**
 * The wave. Cells arrive in date order, ~10ms apart, so a month assembles left
 * to right instead of appearing all at once — and so the reader's eye is walked
 * across the very axis the month-flow strip above is drawn on.
 *
 * Capped at 320ms total: past that the last week is still arriving after the
 * page has otherwise settled, which reads as jank rather than as choreography.
 * Derived from the DATE rather than a render index so it is stable across
 * re-renders and identical for the same month every time — a screenshot of it
 * has to be reproducible.
 */
function cellDelayMs(iso: string): number {
  return Math.min(320, (Number(iso.slice(8)) - 1) * 10);
}

function directionTone(netCents: number): string {
  if (netCents > 0) return "var(--positive)";
  if (netCents < 0) return "var(--negative)";
  return "var(--ink-faint)";
}

/** Contrast-safe tone per state (soft tint + tone text — state-contrast.test). */
const STATE_TONE: Record<DayStateKind, "positive" | "warning" | "info" | "negative" | "neutral"> = {
  paid: "positive",
  paid_different: "warning",
  upcoming: "info",
  missed: "negative",
  unsettled: "neutral",
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
  const evidence = upcomingEvidenceWord(e);
  const qualifier = e.unsettledReason
    ? ` (${unsettledReasonWord(e.unsettledReason)})`
    : e.confidence
      ? ` (${CONFIDENCE_WORD[e.confidence]}${evidence ? `, ${evidence}` : ""})`
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
export function RecurringCalendar({ initialMonth, today, density = "tall", onMonthLoaded }: RecurringCalendarProps) {
  const [month, setMonth] = useState(initialMonth);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function changeMonth(monthKey: string): void {
    startTransition(async () => {
      const r = await loadRecurringMonthAction({ monthKey });
      if (r.ok) {
        setMonth(r.data);
        onMonthLoaded?.(monthKey);
      } else {
        toast({ title: r.error, tone: "negative" });
      }
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
  /**
   * A day with money on it gets a surface of its own, tinted by how heavy it is.
   *
   * Three jobs. It bounds the cell, so a magnitude column standing on the bottom
   * edge belongs visibly to THIS square and not to the date printed directly
   * below it — without a boundary the two are indistinguishable, which is how
   * the first version drew Jul 5's bar apparently on top of Jul 12. It gives the
   * month a shape at a glance. And the tint's strength is the day's weight, so
   * the grid reads as a heat map before a single figure is parsed.
   *
   * ⚠️ The tint tops out at 14%. It is behind live text — the date, the amount,
   * the merchant name — and this app verifies its contrast rather than eyeballing
   * it (`color-contrast.ts`, `state-contrast.test`). 14% of `--negative` over
   * `--surface-raised` leaves every foreground on the cell above its AA bar in
   * both themes; the loud channel is the COLUMN, which is opaque and answerable
   * to the 3:1 graphical bar rather than the 4.5:1 text one.
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
     * simply wins, and the aspect keeps applying everywhere it still fits.
     *
     * 4.5rem, raised from 3rem when the merchant tiles arrived. At 440px — the
     * owner's own phone, and above the 400px gate where the tiles appear — the
     * cell's content measured 43px against 30px of square, and the overflow
     * sweep caught every populated day. The tiles are the largest legibility win
     * on this page and the right answer was to make room for them, not to hide
     * them on the device the page is actually read on.
     */
    const fitsFigures = "max-sm:min-h-[4.5rem]";
    // Hover feedback as a LIFT rather than a background change: the tint below
    // is an inline style and would win over any `hover:bg-*` class, so a
    // populated day would have been the one cell in the grid that did not
    // respond to the pointer.
    const responds =
      "group/cell [animation:var(--animate-cell-in)] transition-[transform,box-shadow] duration-(--duration-fast) ease-(--ease-out-expo) hover:-translate-y-px hover:shadow-(--shadow-overlay) motion-reduce:hover:translate-y-0";
    return `${fitsFigures} ${CALENDAR_DENSITY_CLASS[density] ?? ""} ${responds}`;
  }

  function cellStyle(iso: string): React.CSSProperties {
    const w = dayWeight(month.entriesByDay[iso], heaviest);
    const delay: React.CSSProperties = { animationDelay: `${cellDelayMs(iso)}ms` };
    if (!w) return delay;
    const tone = directionTone(w.netCents);
    return {
      ...delay,
      backgroundColor: `color-mix(in oklab, ${tone} ${heatMixPercent(w.weight).toFixed(1)}%, var(--surface-raised))`,
      /*
       * The month's heaviest days lift off the page.
       *
       * Gated at 0.85 of the month's own range rather than at an absolute
       * figure, so a quiet month still has a heaviest day and a month
       * containing rent does not light up half the grid. It is the one purely
       * decorative rule in the cell, and it is spent on the day the reader most
       * needs to find.
       */
      ...(w.weight >= 0.85
        ? {
            boxShadow: `0 6px 18px -8px color-mix(in oklab, ${tone} 55%, transparent)`,
          }
        : null),
    };
  }

  function renderCell(day: CalendarDay): React.ReactNode {
    const entries = month.entriesByDay[day.iso];
    const w = dayWeight(entries, heaviest);
    if (!w || !entries) return null;

    const tone = directionTone(w.netCents);
    // Confidence dims; an unsettled day is dim too, because it is a mark the app
    // is not standing behind either.
    const dimmed =
      w.state === "unsettled" ? "opacity-60" : w.confidence ? CONFIDENCE_OPACITY[w.confidence] : "";
    const hollow = w.state === "unsettled";
    const marks = entries.slice(0, 2);
    /*
     * ⛔ Compact DROPS things; it does not squeeze them.
     *
     * Capping the height alone left the name line and the weight column still
     * in the box, and they simply spilled into the row below — the owner's
     * first compact screenshot has "Breezeline (internet)" sitting on top of
     * the 17th. A cell half the height has to carry half the content, and the
     * half worth keeping is WHO (the tile) and HOW MUCH (the figure); the name
     * is already in the tile's hue and the Day Sheet has all of it.
     */
    const compact = density === "compact";

    return (
      <span className="flex h-full w-full flex-col gap-0.5">
        {/* WHO. The merchant tiles carry the category hue and, where the app has
            one, the brand's own mark — so a charge is identifiable before a word
            of it is read. Hidden below 400px, where a cell is ~38px wide and an
            18px tile would crowd out the figure; the Day Sheet carries them
            there. Two, then a count: three tiles fit at 1440px and nowhere else,
            and a row that reflows by breakpoint reads as a different design at
            each one. */}
        <span className="hidden items-center gap-0.5 min-[400px]:flex">
          {marks.map((e, i) => (
            <MerchantMark
              key={`${e.seriesId}-${i}`}
              name={e.name}
              hue={e.hue}
              size={14}
              muted={e.state === "unsettled"}
              className="transition-transform duration-(--duration-fast) group-hover/cell:scale-110 motion-reduce:group-hover/cell:scale-100 sm:size-[17px]"
            />
          ))}
          {w.count > marks.length ? (
            <span className="figures text-[8px] leading-none text-ink-muted">
              +{w.count - marks.length}
            </span>
          ) : null}
        </span>

        {/* HOW MUCH. The day's signed total, in the app's flow colours, and the
            largest thing in the cell — it is the answer to the question the page
            is opened with. The state glyph rides beside it, small, because it is
            a qualifier on the figure rather than a peer of it.

            `flex-wrap` is doing real work at 320px: a ~38px cell leaves ~21px
            beside the glyph and "-1.8k" needs 30px, so the amount drops to its
            own line there and keeps the cell's full width rather than being
            ellipsised. It re-joins the glyph on one line as soon as there is room. */}
        <span className="flex flex-wrap items-center gap-x-0.5 leading-none">
          <span className={`text-[9px] font-bold leading-none ${STATE_MARK_COLOR[w.state]}`}>
            {STATE_GLYPH[w.state]}
          </span>
          <span
            className={`figures whitespace-nowrap font-semibold leading-none ${
              // the figure is the answer the page is opened with, and in compact
              // it is the ONLY thing left — so it gets the room the name gave up
              compact ? "text-[11px] sm:text-[13px]" : "text-[10px] sm:text-[11px]"
            }`}
            style={{ color: tone }}
          >
            {compactDayTotal(w.netCents)}
          </span>
        </span>

        {/* WHICH BILL. The breakpoint is 400px, NOT Tailwind's `sm` (640px). A
            phone is the device this page gets read on and the owner's is 440px
            logical — below `sm`, so an `sm:` gate would have hidden the names on
            exactly the screen that most needs them.

            The overflow count sits OUTSIDE the truncating span. Inside it, it was
            the first thing the ellipsis ate: 2026-08-10 carries Breezeline and
            FPL and rendered "Breezeline (internet) …", so the cell showed a −$64
            total that its own caption could not account for. */}
        {compact ? null : (
          <span className="hidden w-full items-baseline gap-0.5 text-[9px] leading-tight text-ink-muted min-[400px]:flex">
            <span className="min-w-0 truncate">{w.dominantName}</span>
            {w.count > 1 ? <span className="shrink-0">+{w.count - 1}</span> : null}
          </span>
        )}

        {/* THE WEIGHT. A column standing on the cell's bottom edge, so the whole
            grid shares one baseline and the month reads as a bar chart wrapped by
            weeks. It grows out of that baseline on mount — `scaleY` about the
            bottom, never a height animation, which would relayout every sibling
            on every frame.

            ⚠️ Still a √ scale against the month's heaviest day, NOT
            `magnitudeTiers`. That module answers a different geometry: a list of
            bars sharing one axis, where a tier is magnified and its factor
            printed beside it. A calendar is seven columns by five rows and there
            is nowhere to put three axes or the sentence explaining them. The bar
            answers "is this a heavy day?" and the figure directly above it
            answers "how much?". */}
        {compact ? null : (
        <span className="flex min-h-0 flex-1 items-end pt-0.5">
          <span
            className={`block min-h-[3px] w-full origin-bottom rounded-t-[3px] [animation:var(--animate-bar-grow)] ${dimmed} ${
              hollow ? "border border-dashed bg-transparent" : ""
            }`}
            style={{
              height: `${Math.round(w.weight * 100)}%`,
              animationDelay: `${cellDelayMs(day.iso)}ms`,
              ...(hollow
                ? { borderColor: `color-mix(in oklab, ${tone} 55%, transparent)` }
                : {
                    backgroundImage: `linear-gradient(to top, ${tone}, color-mix(in oklab, ${tone} 45%, transparent))`,
                  }),
              ...(w.confidence === "predicted" ? HATCH : null),
            }}
          />
        </span>
        )}
      </span>
    );
  }

  const openEntries = openDay ? month.entriesByDay[openDay] ?? [] : [];

  /*
   * `settled` is the POSTED flag, not "is it in the past". The two are not the
   * same thing and the difference is the whole point of the second line: August
   * 2026 has three cash paydays behind today that have never reached the ledger,
   * so a line split by date climbed confidently to +$3,141 directly above a
   * footer reading "SETTLED $0.00".
   */
  const flowEntries: Record<string, { amountCents: number; settled: boolean }[]> = {};
  for (const [iso, entries] of Object.entries(month.entriesByDay)) {
    flowEntries[iso] = entries.map((e) => ({
      amountCents: e.amountCents,
      settled: e.transactionId !== null,
    }));
  }
  const flow = monthFlow(daysInMonthOf(month.monthKey), month.monthKey, flowEntries, today);

  return (
    <div className="rounded-(--radius-card) border border-line bg-surface-raised p-4 sm:p-5">
      <MonthFlowStrip flow={flow} monthLabel={monthLabel(`${month.monthKey}-01`)} />

      <CalendarGrid
        monthKey={month.monthKey}
        today={today}
        onMonthChange={changeMonth}
        getCellLabel={cellLabel}
        renderCell={renderCell}
        getCellClassName={cellClassName}
        getCellStyle={cellStyle}
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
                  className="group/row flex items-center gap-3 rounded-md px-1 py-1 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                >
                  {/* The same tile the grid draws, at reading size. It is what
                      makes the sheet and the cell recognisably the same object
                      rather than two views that happen to share a date. */}
                  <MerchantMark
                    name={e.name}
                    hue={e.hue}
                    size={30}
                    muted={e.state === "unsettled"}
                    className="transition-transform duration-(--duration-fast) group-hover/row:scale-105 motion-reduce:group-hover/row:scale-100"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATE_TONE[e.state]}>
                        {/* The state and its qualifier are printed from ONE
                            entry, which carried them out of ONE `settledVerdict`
                            call. A cell can therefore never show "not yet known"
                            beside the wrong reason for it. */}
                        {e.state === "unsettled" && e.unsettledReason
                          ? `${STATE_WORD[e.state]} — ${unsettledReasonWord(e.unsettledReason)}`
                          : STATE_WORD[e.state]}
                      </Badge>
                      {e.confidence ? (
                        <Badge tone="neutral">{CONFIDENCE_WORD[e.confidence]}</Badge>
                      ) : null}
                      {e.isStale ? <Badge tone="warning">evidence stale</Badge> : null}
                      {/* not a warning: nothing is late about a bill the bank has
                          not charged yet — the All tab's "Never billed" */}
                      {e.neverBilled ? <Badge tone="neutral">{SERIES_EVIDENCE_LABEL["never-billed"]}</Badge> : null}
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
                      <span className="block text-[11px] text-ink-faint">
                        expected {formatCents(e.expectedAmountCents)}
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {openEntries.length > 1 ? (
          <p className="mt-3 flex items-baseline justify-between gap-3 border-t border-line-strong pt-3 text-sm">
            <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">
              Day total
            </span>
            <Money
              cents={openEntries.reduce((n, e) => n + e.amountCents, 0)}
              flow
              className="font-semibold"
            />
          </p>
        ) : null}
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
