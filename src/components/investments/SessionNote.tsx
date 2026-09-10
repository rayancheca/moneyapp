"use client";

import { useTransition } from "react";
import { refreshIntradayAction } from "@/app/investments/actions";
import { toast } from "@/components/ui/Toast";
import { SESSION_TZ_LABEL, type SessionChartView } from "@/lib/intraday-axis";
import { formatDayLong } from "@/lib/format-date";

/**
 * The one line under the 1D chart that says what the day's move is measured
 * FROM, how much of the book is actually priced, and in whose clock.
 *
 * A bare "▲ $312" on a day view implies a baseline. When the previous close is
 * unknown for even one holding, the line starts at the first print instead and
 * that number silently means something narrower — so the basis is stated in
 * words rather than left to be inferred from the shape of the line.
 *
 * When there is no session at all this becomes the seam that gets one: nothing
 * schedules `refreshIntraday`, so without an explicit control the 1D view would
 * be a permanent empty state on a table that never fills.
 */
/**
 * Which close the 1D figure is measured against, said in words.
 *
 * 🔴 The note asserted "the change since yesterday's close" whatever the newest
 * close actually was. Measured 2026-09-10: `price_cache`'s newest quote is
 * 2026-09-03 and `price_intraday` holds zero rows, so there is no yesterday
 * close and none for the six days before it — while the same page's scrub
 * readout says "carried forward from the close on Thu, Sep 3, 2026" and its
 * section note says "still carries its close from Thu, Sep 3, 2026 — 7 days
 * ago". `dayChangeLabel` states the rule for this figure two files over:
 * "naming a date the figure was not measured over would be worse than the
 * vaguer word."
 */
export function sinceCloseClause(closeOn: string | null, today: string, formatDay: (iso: string) => string): string {
  if (closeOn === null) return "there is no stored close to measure against yet";
  if (closeOn === today) return "this is the change within today's own close";
  return `this is the change since the close on ${formatDay(closeOn)}`;
}

interface SessionNoteProps {
  session: SessionChartView | null;
  pricedSymbols: number;
  /** the newest STORED close the 1D figure is measured against — see `sinceCloseClause` */
  closeOn: string | null;
  today: string;
  totalSymbols: number;
}

export function SessionNote({ session, pricedSymbols, totalSymbols, closeOn, today }: SessionNoteProps) {
  const [pending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      const res = await refreshIntradayAction();
      if (!res.ok) {
        toast({ title: "Couldn't load today's session", description: res.error, tone: "negative" });
        return;
      }
      const { ticks, errors } = res.data;
      if (ticks > 0) {
        toast({
          title: "Today's session loaded",
          description: `${ticks} ${ticks === 1 ? "price" : "prices"} across the day`,
          tone: "positive",
        });
      } else if (errors.length > 0) {
        toast({
          title: "Couldn't reach the price provider",
          description: "No intraday prices were stored.",
          tone: "negative",
        });
      } else {
        toast({
          title: "No intraday prices for today",
          description: "The market may be closed.",
          tone: "neutral",
        });
      }
    });
  }

  if (session === null) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-xs text-ink-faint">
          No intraday prices for today yet — {sinceCloseClause(closeOn, today, formatDayLong)}.
        </p>
        <button
          type="button"
          onClick={load}
          disabled={pending}
          aria-busy={pending}
          className="rounded-md border border-line bg-surface-raised px-2.5 py-1 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-accent active:bg-surface-sunken disabled:cursor-progress disabled:opacity-60"
        >
          {pending ? "Loading…" : "Load today's session"}
        </button>
      </div>
    );
  }

  const coverage =
    pricedSymbols === totalSymbols
      ? null
      : `${pricedSymbols} of ${totalSymbols} holdings priced`;

  return (
    <p className="mt-2 text-xs text-ink-faint">
      {[
        `Today's session · ${session.fromLabel} – ${session.toLabel} ${SESSION_TZ_LABEL}`,
        coverage,
        session.opensAtPrevClose
          ? "measured from yesterday's close"
          : "measured from the first print",
      ]
        .filter(Boolean)
        .join(" · ")}
      .
    </p>
  );
}
