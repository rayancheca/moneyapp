"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { loadPnlDayAction, loadPnlMonthAction } from "@/app/investments/actions";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import type { CalendarDay } from "@/lib/calendar-math";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { intensityStep, pnlDirection } from "@/lib/pnl-intensity";
import { ledgerHref } from "@/lib/ledger-href";
import type { PnlCalendarMonth, PnlDayCell, PnlDayDetail } from "@/services/portfolio";

/**
 * The P/L calendar (ux-overhaul-plan §6.3 [MO]): daily portfolio P/L cells where
 * hue is direction and saturation is magnitude (scaled to the month), a monthly
 * footer, and a day sheet with per-holding deltas plus that day's investment
 * transactions. Weekend/holiday cells where only crypto moved carry a subtle
 * "markets closed" treatment. The colored fill is decorative; the cell's
 * aria-label states the move in words (WCAG 1.4.1).
 */

const UP = "var(--positive)";
const DOWN = "var(--negative)";

function cellFill(cell: PnlDayCell | undefined, scaleCents: number): string {
  if (!cell) return "transparent";
  const dir = pnlDirection(cell.pnlCents);
  if (dir === "flat") return "transparent";
  const step = intensityStep(cell.pnlCents, scaleCents);
  const token = dir === "up" ? UP : DOWN;
  // no text sits on the tile, so magnitude can range to a vivid saturation
  return `color-mix(in oklab, ${token} ${step * 22}%, transparent)`;
}

export function PnlCalendar({ initialMonth, today }: { initialMonth: PnlCalendarMonth; today: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<PnlDayDetail | null>(null);
  const [, startTransition] = useTransition();
  // latest-request guards: rapid month/day taps must not let a slow earlier
  // fetch resolve last and render stale data under the newer header
  const monthReqRef = useRef(initialMonth.monthKey);
  const dayReqRef = useRef<string | null>(null);

  function changeMonth(monthKey: string): void {
    monthReqRef.current = monthKey;
    startTransition(async () => {
      const r = await loadPnlMonthAction({ monthKey });
      if (monthReqRef.current !== monthKey) return; // superseded by a newer month
      if (r.ok) setMonth(r.data);
      else toast({ title: r.error, tone: "negative" });
    });
  }

  function openDaySheet(iso: string): void {
    dayReqRef.current = iso;
    setOpenDay(iso);
    setDayDetail(null);
    startTransition(async () => {
      const r = await loadPnlDayAction({ day: iso });
      if (dayReqRef.current !== iso) return; // a newer day was tapped
      if (r.ok) setDayDetail(r.data);
      else toast({ title: r.error, tone: "negative" });
    });
  }

  function cellLabel(iso: string): string {
    const cell = month.cellsByDay[iso];
    if (!cell) return formatDayLong(iso);
    const dir = pnlDirection(cell.pnlCents);
    const move =
      dir === "flat"
        ? "flat"
        : `${dir === "up" ? "up" : "down"} ${formatCents(Math.abs(cell.pnlCents))}${cell.pct !== null ? ` (${cell.pct >= 0 ? "+" : ""}${cell.pct.toFixed(1)}%)` : ""}`;
    const closed = cell.marketsClosed ? ", markets closed" : "";
    const approx = cell.exact ? "" : ", approximate";
    return `${formatDayLong(iso)}: portfolio ${move}${closed}${approx}`;
  }

  function renderCell(day: CalendarDay): React.ReactNode {
    const cell = month.cellsByDay[day.iso];
    if (!cell) return null;
    // a decorative heatmap tile — hue is direction, saturation is magnitude
    // (ux-overhaul-plan §6.3). No in-cell number: it can't clear WCAG contrast on
    // a saturated tint in both themes; the exact value lives in the cell's
    // aria-label (getCellLabel) and the day sheet, and a "!" flags an approximate
    // (crypto-trade) day so honesty survives color-blindness.
    return (
      <span
        aria-hidden
        className="flex h-full w-full items-center justify-center rounded-[3px]"
        style={{ backgroundColor: cellFill(cell, month.scaleCents) }}
      >
        {!cell.exact && <span className="text-[9px] font-bold leading-none text-ink-faint">!</span>}
      </span>
    );
  }

  return (
    <div className="rounded-(--radius-card) border border-line bg-surface-raised p-4 sm:p-5">
      <CalendarGrid
        monthKey={month.monthKey}
        today={today}
        onMonthChange={changeMonth}
        getCellLabel={cellLabel}
        renderCell={renderCell}
        onDayActivate={openDaySheet}
        footer={<CalendarFooter month={month} />}
      />
      <Legend />

      <Sheet open={openDay !== null} onClose={() => setOpenDay(null)} title={openDay ? formatDayLong(openDay) : ""}>
        {dayDetail === null ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : (
          <DaySheetBody detail={dayDetail} />
        )}
      </Sheet>
    </div>
  );
}

/**
 * Sheet amounts are neutral ink with a signed value (and a decorative colored
 * arrow) rather than tone-colored text: the sheet's --surface-overlay bg is a
 * touch lighter than cards, so --positive/--negative would fall just under WCAG
 * AA there. The arrow (aria-hidden) carries the color cue; the sign carries the
 * direction for screen readers.
 */
function SignedAmount({ cents, size = "text-sm" }: { cents: number; size?: string }) {
  const arrow = cents > 0 ? "▲" : cents < 0 ? "▼" : "";
  const tone = cents < 0 ? "text-negative" : cents > 0 ? "text-positive" : "text-ink-faint";
  return (
    <span className={`figures ${size} text-ink`}>
      {arrow && (
        <span aria-hidden className={`${tone} mr-1`}>
          {arrow}
        </span>
      )}
      {formatCentsSigned(cents)}
    </span>
  );
}

function DaySheetBody({ detail }: { detail: PnlDayDetail }) {
  return (
    <div className="space-y-5">
      <div>
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink">Portfolio P/L</span>
        <div className="mt-1 flex items-baseline gap-2">
          <SignedAmount cents={detail.pnlCents} size="text-xl font-semibold" />
          {!detail.exact && <span className="text-[11px] text-ink-muted">≈ approximate</span>}
        </div>
      </div>

      {detail.holdings.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.1em] text-ink">By holding</h3>
          <ul className="divide-y divide-line">
            {detail.holdings.map((h) => (
              <li key={`${h.assetType}-${h.symbol}`} className="flex items-center justify-between py-2">
                <Link href={`/investments/${h.assetType}/${h.symbol}`} className="text-sm font-medium hover:text-accent">
                  {h.symbol}
                </Link>
                <SignedAmount cents={h.deltaCents} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.transactions.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.1em] text-ink">Transactions this day</h3>
          <ul className="divide-y divide-line">
            {detail.transactions.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                <Link
                  href={ledgerHref({ account: t.accountId, from: detail.day, to: detail.day })}
                  className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                >
                  {t.description}
                </Link>
                <SignedAmount cents={t.amountCents} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CalendarFooter({ month }: { month: PnlCalendarMonth }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line-strong pt-3 text-sm">
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">Month P/L</span>
        <Money cents={month.monthPnlCents} flow className="font-medium" />
      </span>
      <span className="text-xs text-ink-faint">
        {month.upDays} up · {month.downDays} down
      </span>
    </div>
  );
}

function Legend() {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2.5 rounded-[3px]" style={{ backgroundColor: `color-mix(in oklab, ${UP} 66%, transparent)` }} />
        Gain
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2.5 rounded-[3px]" style={{ backgroundColor: `color-mix(in oklab, ${DOWN} 66%, transparent)` }} />
        Loss
      </li>
      <li className="text-ink-faint">Saturation = size of the move</li>
    </ul>
  );
}
