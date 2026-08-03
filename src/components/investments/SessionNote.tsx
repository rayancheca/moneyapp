"use client";

import { useTransition } from "react";
import { refreshIntradayAction } from "@/app/investments/actions";
import { toast } from "@/components/ui/Toast";
import { SESSION_TZ_LABEL, type SessionChartView } from "@/lib/intraday-axis";

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
interface SessionNoteProps {
  session: SessionChartView | null;
  pricedSymbols: number;
  totalSymbols: number;
}

export function SessionNote({ session, pricedSymbols, totalSymbols }: SessionNoteProps) {
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
          No intraday prices for today yet — this is the change since yesterday&rsquo;s close.
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
