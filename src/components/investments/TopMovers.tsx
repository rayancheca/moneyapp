"use client";

import { useState } from "react";
import Link from "next/link";
import type { DayChangeLabel } from "@/lib/day-change-label";
import type { Mover } from "@/services/portfolio";

/**
 * Top movers strip (ux-overhaul-plan §6.3 [MO]): a Winners/Losers toggle over
 * the biggest percentage moves between the two newest covered days; each chip
 * opens its holding page.
 *
 * 🔴 NOT "the day's". This strip said "No winners today." and printed undated
 * percentages while the holdings table a few elements BELOW it on the same page
 * already read "Last close · 30 Aug vs 29 Aug" — one page, two answers to when
 * the move happened. The moves are the same `dayChangePct` the header dates, so
 * the strip takes the same `dayChangeLabel` and dates them once, at the top.
 *
 * The empty state then makes no time claim of its own: the header owns the
 * date, so "Nothing rose." stays true whichever branch that header took.
 */
export function TopMovers({
  winners,
  losers,
  dayChange,
}: {
  winners: Mover[];
  losers: Mover[];
  dayChange: DayChangeLabel;
}) {
  const [side, setSide] = useState<"winners" | "losers">("winners");
  const movers = side === "winners" ? winners : losers;

  if (winners.length === 0 && losers.length === 0) return null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            Top movers <span className="text-ink-faint">· {dayChange.label}</span>
          </h2>
          {dayChange.interval !== null && (
            <p className="mt-0.5 text-[11px] text-ink-faint">{dayChange.interval}</p>
          )}
        </div>
        <div role="group" aria-label="Movers side" className="inline-flex rounded-full bg-surface-sunken p-0.5 text-xs">
          {(["winners", "losers"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={side === s}
              onClick={() => setSide(s)}
              className={`rounded-full px-2.5 py-1 font-medium capitalize transition-colors duration-(--duration-fast) ${
                side === s ? "bg-surface-raised text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {movers.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing {side === "winners" ? "rose" : "fell"}.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {movers.map((m) => {
            const up = m.dayChangePct >= 0;
            return (
              <li key={`${m.assetType}-${m.symbol}`}>
                <Link
                  href={`/investments/${m.assetType}/${m.symbol}`}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 transition-colors duration-(--duration-fast) hover:border-line-strong"
                >
                  <span className="text-sm font-medium">{m.symbol}</span>
                  <span className={`figures text-xs font-medium ${up ? "text-positive" : "text-negative"}`}>
                    {up ? "▲" : "▼"} {up ? "+" : ""}
                    {m.dayChangePct.toFixed(2)}%
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
